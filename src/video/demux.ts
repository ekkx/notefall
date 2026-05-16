/**
 * MP4/MOV demux helpers built on `mp4box`, used by:
 *  - the import-time codec probe (decide whether to transcode), and
 *  - the offline exporter's frame-accurate hand-video source.
 *
 * The exporter advances a virtual clock forward monotonically, so the
 * frame source streams samples into a `VideoDecoder` on demand and keeps
 * a small bounded ring of decoded frames — never the whole video in
 * memory.
 */
import { createFile, DataStream, type MP4File, type MP4Sample } from 'mp4box'

type Mp4ArrayBuffer = ArrayBuffer & { fileStart: number }

export interface ProbedTrack {
  codec: string
  width: number
  height: number
  durationSec: number
}

/**
 * Reads the first video track's codec + dimensions, or null if the
 * container isn't ISO-BMFF (mp4/mov) or carries no video. WebM/MKV/AVI
 * fall through as null → the caller transcodes them.
 */
export function probeFirstVideoTrack(
  bytes: ArrayBuffer,
): Promise<ProbedTrack | null> {
  return new Promise((resolve) => {
    let settled = false
    const done = (v: ProbedTrack | null) => {
      if (settled) return
      settled = true
      resolve(v)
    }
    let file: MP4File
    try {
      file = createFile(false)
    } catch {
      done(null)
      return
    }
    file.onError = () => done(null)
    file.onReady = (info) => {
      const t = info.videoTracks?.[0]
      if (!t) {
        done(null)
        return
      }
      done({
        codec: t.codec,
        width: t.track_width,
        height: t.track_height,
        durationSec: t.timescale > 0 ? t.duration / t.timescale : 0,
      })
    }
    const copy = bytes.slice(0) as Mp4ArrayBuffer
    copy.fileStart = 0
    try {
      file.appendBuffer(copy)
      file.flush()
    } catch {
      done(null)
    }
    // mp4box parses synchronously inside appendBuffer; if onReady never
    // fired the moov box wasn't found in the buffer (rare for the small
    // clips we expect, but guard anyway).
    done(null)
  })
}

/** Extracts the codec-config box (`avcC` / `hvcC` / …) as the
 *  `decoderConfig.description` WebCodecs wants. Returns undefined for
 *  codecs that don't need it. */
function codecDescription(file: MP4File, trackId: number): Uint8Array | undefined {
  const trak = file.getTrackById(trackId)
  const entries = trak?.mdia?.minf?.stbl?.stsd?.entries ?? []
  for (const entry of entries) {
    const box = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C
    if (box) {
      const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN)
      box.write(stream)
      // Skip the 8-byte box header (size + type).
      return new Uint8Array(stream.buffer, 8)
    }
  }
  return undefined
}

export interface HandVideoFrameSource {
  /** Native aspect ratio (display width / height). */
  readonly aspect: number
  /** Source duration in seconds. */
  readonly durationSec: number
  /**
   * Returns the decoded frame whose presentation time is the latest
   * one ≤ `timeSec`. Times must be requested non-decreasing (the
   * exporter steps forward). The returned VideoFrame is owned by the
   * source — do NOT close it; it stays valid until the next call.
   * Returns null before the first frame / after the last.
   */
  frameAt(timeSec: number): Promise<VideoFrame | null>
  close(): void
}

/**
 * Builds a forward-only frame source over an H.264/HEVC MP4. Throws if
 * the codec can't be WebCodecs-decoded in this browser (the caller
 * gates on this before relying on it for export).
 */
export async function createHandVideoFrameSource(
  bytes: ArrayBuffer,
): Promise<HandVideoFrameSource> {
  const file = createFile(false)

  const ready = new Promise<{
    trackId: number
    codec: string
    width: number
    height: number
    timescale: number
    durationSec: number
  }>((resolve, reject) => {
    file.onError = (e) => reject(new Error(e))
    file.onReady = (info) => {
      const t = info.videoTracks?.[0]
      if (!t) {
        reject(new Error('No video track found in the file'))
        return
      }
      resolve({
        trackId: t.id,
        codec: t.codec,
        width: t.track_width,
        height: t.track_height,
        timescale: t.timescale,
        durationSec: t.timescale > 0 ? t.duration / t.timescale : 0,
      })
    }
  })

  const copy = bytes.slice(0) as Mp4ArrayBuffer
  copy.fileStart = 0
  file.appendBuffer(copy)
  file.flush()
  const meta = await ready

  const description = codecDescription(file, meta.trackId)

  const config: VideoDecoderConfig = {
    codec: meta.codec,
    codedWidth: meta.width,
    codedHeight: meta.height,
    ...(description ? { description } : {}),
    optimizeForLatency: true,
  }
  const support = await VideoDecoder.isConfigSupported(config).catch(() => null)
  if (!support || !support.supported) {
    file.stop()
    throw new Error(
      `This video's codec (${meta.codec}) can't be decoded in this browser`,
    )
  }

  // Decoded-frame ring. Frames arrive in presentation order; we keep a
  // few around so a small backward jitter in requested time still hits.
  const RING_MAX = 8
  const ring: VideoFrame[] = []
  let decodeError: Error | null = null

  const decoder = new VideoDecoder({
    output: (frame) => {
      ring.push(frame)
      while (ring.length > RING_MAX) {
        ring.shift()!.close()
      }
    },
    error: (e) => {
      decodeError = e instanceof Error ? e : new Error(String(e))
    },
  })
  decoder.configure(config)

  // Pull every encoded sample up front (encoded H.264 is ~compact; the
  // memory-heavy part is decoded RGBA frames, which stay bounded by the
  // ring). Samples come in decode order — exactly what the decoder
  // wants; it reorders to presentation order on output.
  const samples: MP4Sample[] = []
  file.onSamples = (_id, _user, s) => {
    for (const smp of s) samples.push(smp)
  }
  file.setExtractionOptions(meta.trackId, null, { nbSamples: Infinity })
  file.start()
  file.flush()

  let fed = 0
  let flushed = false
  const lastSample = samples[samples.length - 1]
  const computedDuration = lastSample
    ? (lastSample.cts + lastSample.duration) / lastSample.timescale
    : 0

  const yieldTick = () =>
    new Promise<void>((r) => {
      setTimeout(r, 0)
    })

  // Feed encoded chunks in decode order until we've pushed a sample
  // whose presentation time is past the target (so the decoder has all
  // the data — incl. reordered B-frames — needed to emit the covering
  // frame), then drain the async output queue. We deliberately do NOT
  // flush() between requests: VideoDecoder.flush() drops decoder state
  // and demands a fresh keyframe to continue, which would corrupt
  // delta-frame decoding on every subsequent GOP. flush() runs once,
  // only at end-of-stream.
  const ensureDecodedUpTo = async (targetSec: number) => {
    while (fed < samples.length) {
      const smp = samples[fed]
      decoder.decode(
        new EncodedVideoChunk({
          type: smp.is_sync ? 'key' : 'delta',
          timestamp: (smp.cts / smp.timescale) * 1_000_000,
          duration: (smp.duration / smp.timescale) * 1_000_000,
          data: smp.data,
        }),
      )
      fed++
      if (smp.cts / smp.timescale > targetSec + 0.0005) break
    }

    const covered = () =>
      ring.some((f) => f.timestamp / 1_000_000 >= targetSec - 1e-6)

    // Drain the decoder's async output until the covering frame lands.
    // Bounded by a stall guard so a pathological clip can't hang the
    // export forever.
    let stall = 0
    while (!covered() && !decodeError) {
      if (decoder.decodeQueueSize > 0) {
        await yieldTick()
        stall = 0
        continue
      }
      if (fed < samples.length) return // need to push more — caller loops
      // All samples fed, queue empty: flush once to extract the tail.
      if (!flushed) {
        flushed = true
        await decoder.flush().catch(() => {})
        continue
      }
      if (++stall > 4) break
      await yieldTick()
    }
  }

  const source: HandVideoFrameSource = {
    aspect: meta.height > 0 ? meta.width / meta.height : 16 / 9,
    durationSec: meta.durationSec || computedDuration,
    async frameAt(timeSec: number): Promise<VideoFrame | null> {
      if (decodeError) throw decodeError
      const ringCovers =
        ring.length > 0 &&
        ring[ring.length - 1].timestamp / 1_000_000 >= timeSec - 1e-6
      // Keep pushing until the ring brackets the target (ensure… may
      // return early when it still has samples left to feed).
      let guard = samples.length + 8
      while (!ringCovers && fed < samples.length && guard-- > 0) {
        await ensureDecodedUpTo(timeSec)
        if (decodeError) throw decodeError
        if (
          ring.length > 0 &&
          ring[ring.length - 1].timestamp / 1_000_000 >= timeSec - 1e-6
        )
          break
      }
      if (!ringCovers && fed >= samples.length) {
        await ensureDecodedUpTo(timeSec)
      }
      if (decodeError) throw decodeError
      // Latest frame with presentation time ≤ target; fall back to the
      // earliest still in the ring if the target precedes it.
      let pick: VideoFrame | null = null
      for (const f of ring) {
        if (f.timestamp / 1_000_000 <= timeSec + 1e-6) pick = f
      }
      if (!pick && ring.length > 0) pick = ring[0]
      return pick
    },
    close() {
      try {
        decoder.close()
      } catch {
        /* already closed */
      }
      for (const f of ring) f.close()
      ring.length = 0
    },
  }
  return source
}

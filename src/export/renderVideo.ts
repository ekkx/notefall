import * as THREE from 'three'
import { ArrayBufferTarget, Muxer } from 'mp4-muxer'
import type { ParsedSong } from '../midi/types'
import { buildSpeedMap, midiToTimeline } from '../midi/speedMap'
import type { Settings } from '../store'
import { VirtualClock, resetActiveClock, setActiveClock } from '../audio/clock'
import { audioEngine } from '../audio/engine'
import { getR3FState } from '../scene/exportBridge'
import { AudioRenderAborted, renderSongAudio } from './renderAudio'
import { useHandVideo } from '../notes/handVideo'
import { createHandVideoFrameSource, type HandVideoFrameSource } from '../video/demux'

/**
 * Match the audio render's tail. Falling notes already past the hit
 * line still rise (history mode), landing flashes finish, and the
 * reverb wash fades.
 */
const TAIL_SECONDS = 5

/** AAC-LC codec string for the AudioEncoder configure() call. */
const AAC_CODEC_STRING = 'mp4a.40.2'

/** Samples per AAC encoder frame. AAC's natural frame size is 1024. */
const AUDIO_CHUNK_SAMPLES = 1024

/** Encoder backpressure threshold. */
const MAX_ENCODE_QUEUE = 4

/** 1 keyframe per second is a comfortable seeking interval. */
const KEYFRAME_INTERVAL_SECONDS = 1

/**
 * Weights for combining audio and video into one progress bar. The
 * audio path runs in parallel with the video path (OfflineAudioContext
 * renders off the main thread; sample fetches happen in the background)
 * so this is just a UX hint — neither finishes "first" in any
 * deterministic way. The audio side covers loading + render + AAC
 * encode; the video side is the dominant frame loop, so it gets the
 * larger share.
 */
const AUDIO_PROGRESS_WEIGHT = 0.4
const VIDEO_PROGRESS_WEIGHT = 0.6

export type VideoRenderProgress =
  | { phase: 'preparing' }
  | { phase: 'rendering'; progress: number }
  | { phase: 'finalizing' }
  | { phase: 'done' }

/**
 * Optional audio track config. `null` produces a silent video — the
 * mp4-muxer is built without an audio track, the offline audio
 * render is skipped entirely (saves the ~60 MB sample fetch + the
 * convolution-reverb cost), and the progress bar reflects video
 * work only.
 */
export type AudioTrackConfig = {
  sampleRate: number
  bitrateKbps: number
} | null

export type VideoRenderOptions = {
  width: number
  height: number
  fps: number
  videoBitrateKbps: number
  /** `null` to omit the audio track entirely. */
  audio: AudioTrackConfig
  /**
   * Optional user-provided accompaniment buffer to mix alongside the
   * sampled piano. Routed through `renderSongAudio` only — the video
   * pass doesn't see the audio buffer directly. Ignored when
   * `audio === null` (no audio track wanted).
   */
  userAudio?: {
    buffer: AudioBuffer
    offsetSec: number
    volume: number
    trimStartSec: number
    trimEndSec: number | null
  } | null
  signal?: AbortSignal
  onProgress?: (p: VideoRenderProgress) => void
}

export class VideoRenderAborted extends Error {
  constructor() {
    super('Video render aborted')
    this.name = 'VideoRenderAborted'
  }
}

export function isVideoExportSupported(): boolean {
  return (
    typeof VideoEncoder !== 'undefined' &&
    typeof AudioEncoder !== 'undefined' &&
    typeof VideoFrame !== 'undefined' &&
    typeof AudioData !== 'undefined' &&
    typeof EncodedVideoChunk !== 'undefined'
  )
}

/**
 * H.264 codec string for a given resolution × fps. Levels:
 *   4.0 → 1080p30, 4.1 → 1080p60, 5.0 → 4K30, 5.1 → 4K60
 */
function pickAvcCodecString(width: number, height: number, fps: number): string {
  const macroblocksPerSec = ((width * height) / 256) * fps
  if (macroblocksPerSec <= 245_760) return 'avc1.640028'
  if (macroblocksPerSec <= 491_520) return 'avc1.640029'
  if (macroblocksPerSec <= 589_824) return 'avc1.640032'
  return 'avc1.640033'
}

/**
 * Race a promise against an AbortSignal so that long awaits become
 * cancellable. Symmetric with the helper inside renderAudio.ts —
 * duplicated here so each module's failure-mode error type stays
 * local.
 */
function raceWithAbort<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p
  if (signal.aborted) return Promise.reject(new VideoRenderAborted())
  return new Promise<T>((resolve, reject) => {
    p.then(resolve, reject)
    signal.addEventListener('abort', () => reject(new VideoRenderAborted()), {
      once: true,
    })
  })
}

/**
 * Yield to the event loop so DOM events (notably the Cancel button's
 * click) can be processed mid-render. Uses MessageChannel rather than
 * `setTimeout(0)` because the HTML spec clamps nested setTimeouts at
 * ≥4 ms after 5 levels of nesting — adds up to many seconds across an
 * 18 000-frame render. MessageChannel-postMessage has no such clamp
 * and runs in the next macrotask. The channel + handler are reused
 * across calls so we don't allocate per frame.
 */
const _yieldChannel = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null
function yieldToEventLoop(): Promise<void> {
  if (!_yieldChannel) {
    return new Promise<void>((r) => setTimeout(r, 0))
  }
  return new Promise<void>((resolve) => {
    _yieldChannel.port1.onmessage = () => {
      _yieldChannel.port1.onmessage = null
      resolve()
    }
    _yieldChannel.port2.postMessage(null)
  })
}

/**
 * Offline-render the loaded song's visualizer + sampled audio into a
 * single MP4 (H.264 video + AAC-LC audio). Audio and video render in
 * parallel — the offline AudioContext processes off the main thread
 * while the video frame loop steps R3F on the main thread — so total
 * wall-clock time ≈ max(audio_time, video_time) instead of the sum.
 *
 * Pipeline:
 *   1. Save R3F renderer / clock / camera / frameloop state for
 *      restoration. Disarm `THREE.Clock.autoStart` so its `getDelta()`
 *      doesn't pollute `state.clock.elapsedTime` with wall-clock
 *      seconds in the override path.
 *   2. Install a `VirtualClock` and put the audio engine into silent
 *      export mode.
 *   3. Kick off `renderSongAudio` — runs in its own
 *      `OfflineAudioContext`, doesn't touch the realtime engine.
 *   4. Configure VideoEncoder, switch R3F to `frameloop="never"`, and
 *      step `(totalDuration * fps)` frames in parallel with (3).
 *   5. After the video loop finishes, await the audio buffer (likely
 *      already done by then), encode it as AAC chunks into the same
 *      muxer.
 *   6. Flush both encoders, finalize the muxer, restore R3F state.
 */
export async function renderSongVideo(
  song: ParsedSong,
  settings: Settings,
  options: VideoRenderOptions,
): Promise<Blob> {
  if (!isVideoExportSupported()) {
    throw new Error(
      'Video export requires a browser with WebCodecs (Chrome / Edge / Safari 16.4+).',
    )
  }
  const { width, height, fps, videoBitrateKbps, audio, userAudio, signal, onProgress } = options
  if (signal?.aborted) throw new VideoRenderAborted()

  const r3f = getR3FState()
  if (!r3f) {
    throw new Error('The 3D scene is not mounted yet. Try again in a moment.')
  }
  const { gl, camera } = r3f

  onProgress?.({ phase: 'preparing' })

  // Snapshot R3F state for restoration.
  const prevSize = new THREE.Vector2()
  gl.getSize(prevSize)
  const prevPixelRatio = gl.getPixelRatio()
  const prevFrameloop = r3f.frameloop
  const isPerspective = (camera as THREE.PerspectiveCamera).isPerspectiveCamera === true
  const prevAspect = isPerspective ? (camera as THREE.PerspectiveCamera).aspect : 1

  const prevClockAutoStart = r3f.clock.autoStart
  const prevClockRunning = r3f.clock.running
  const prevClockElapsed = r3f.clock.elapsedTime
  const prevClockOldTime = r3f.clock.oldTime
  r3f.clock.stop()
  r3f.clock.autoStart = false
  r3f.clock.elapsedTime = 0
  r3f.clock.oldTime = 0

  const clock = new VirtualClock()
  setActiveClock(clock)
  audioEngine.beginExportPlayback()

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width, height, frameRate: fps },
    // Omit the audio track entirely when audio is disabled — passing
    // `audio: undefined` produces a silent MP4 with just the video
    // stream, which is what the "no audio" preset wants.
    ...(audio
      ? {
          audio: { codec: 'aac' as const, numberOfChannels: 2, sampleRate: audio.sampleRate },
        }
      : {}),
    fastStart: 'in-memory',
  })

  let videoEncoderError: Error | null = null
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      videoEncoderError = e instanceof Error ? e : new Error(String(e))
    },
  })

  // The audio encoder is only constructed when an audio track is
  // wanted. Lazy-construction lets the no-audio path skip
  // `new AudioEncoder({...})` and `audioEncoder.close()` entirely so
  // there's no chance of an unused encoder leaking warnings.
  let audioEncoderError: Error | null = null
  const audioEncoder = audio
    ? new AudioEncoder({
        output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
        error: (e) => {
          audioEncoderError = e instanceof Error ? e : new Error(String(e))
        },
      })
    : null

  // ──────────────────────────────────────────────────────────────────
  // Combined progress. Audio and video render concurrently when both
  // tracks are wanted. The bar is a weighted sum of two independent
  // fractions; in the audio-disabled case, the audio weight collapses
  // to 0 and the bar is pure video progress.
  // ──────────────────────────────────────────────────────────────────
  const audioWeight = audio ? AUDIO_PROGRESS_WEIGHT : 0
  const videoWeight = audio ? VIDEO_PROGRESS_WEIGHT : 1
  let audioFraction = audio ? 0 : 1
  let videoFraction = 0
  // Hand-video overlay: a forward-only decoded-frame source the loop
  // steps in lockstep with the virtual clock, and the store hook that
  // swaps the overlay's texture to a canvas we draw those frames into.
  // Declared out here so the `finally` can always tear them down.
  let handSource: HandVideoFrameSource | null = null
  let handDraw: ((frame: VideoFrame | null) => void) | null = null
  let lastEmitted = -1
  const emitOverall = () => {
    const overall = audioWeight * audioFraction + videoWeight * videoFraction
    if (overall - lastEmitted > 0.005 || overall === 1) {
      lastEmitted = overall
      onProgress?.({ phase: 'rendering', progress: overall })
    }
  }

  // Within the audio path: loading 35% / offline render 55% / AAC encode 10%.
  const setAudioFraction_loading = (f: number) => {
    audioFraction = 0.35 * f
    emitOverall()
  }
  const setAudioFraction_render = (f: number) => {
    audioFraction = 0.35 + 0.55 * f
    emitOverall()
  }
  const setAudioFraction_encode = (f: number) => {
    audioFraction = 0.9 + 0.1 * f
    emitOverall()
  }

  try {
    // Kick off the audio render IN PARALLEL with the video pass when
    // audio is wanted. Skipped entirely otherwise — saves ~60 MB
    // sample fetch + offline render time.
    const audioRenderPromise: Promise<AudioBuffer> | null = audio
      ? renderSongAudio(
          song,
          settings,
          audio.sampleRate,
          (p) => {
            if (p.phase === 'loading') {
              setAudioFraction_loading(p.total > 0 ? p.loaded / p.total : 0)
            } else if (p.phase === 'rendering') {
              setAudioFraction_render(p.progress)
            }
          },
          signal,
          userAudio ?? null,
        )
      : null
    // Attach a no-op rejection handler so an early abort doesn't
    // surface as an unhandled rejection before we await it.
    audioRenderPromise?.catch(() => undefined)

    // Configure the video encoder + R3F renderer for the video pass.
    gl.setSize(width, height, false)
    gl.setPixelRatio(1)
    if (isPerspective) {
      const cam = camera as THREE.PerspectiveCamera
      cam.aspect = width / height
      cam.updateProjectionMatrix()
    }
    r3f.set({ frameloop: 'never' })

    videoEncoder.configure({
      codec: pickAvcCodecString(width, height, fps),
      width,
      height,
      bitrate: videoBitrateKbps * 1000,
      framerate: fps,
      avc: { format: 'avc' },
    })

    // Effective end-of-timeline mirrors the audio render: when the
    // user-provided accompaniment extends past the MIDI we render
    // additional frames so the final visual still matches the audio
    // tail (otherwise the video would freeze on its last MIDI frame
    // while the audio kept playing).
    const audioTrimEnd = userAudio
      ? Math.min(userAudio.buffer.duration, userAudio.trimEndSec ?? userAudio.buffer.duration)
      : 0
    const audioEnd = userAudio ? userAudio.offsetSec + audioTrimEnd : 0
    const midiTrimEnd = settings.midiTrimEndSec ?? song.duration
    // Speed automation can stretch the MIDI past its natural length;
    // walk the map to get the actual timeline end.
    const speedMap = buildSpeedMap(settings.midiSpeedAutomation)
    const midiTrimEndTimeline = midiToTimeline(speedMap, midiTrimEnd)
    // Mirror renderAudio: MIDI is shifted by `settings.midiOffsetSec`
    // on the export timeline so the rendered video extends past the
    // delayed song end. Trim ends shrink the rendered window so we
    // don't burn frames on a silent tail.
    const totalDuration =
      Math.max(midiTrimEndTimeline + settings.midiOffsetSec, audioEnd) + TAIL_SECONDS
    const totalFrames = Math.max(1, Math.ceil(totalDuration * fps))
    const usPerFrame = Math.round(1_000_000 / fps)
    const keyframeInterval = Math.max(1, Math.round(KEYFRAME_INTERVAL_SECONDS * fps))

    // Hand-video setup. We only touch the store / build a decoder when
    // the overlay is actually enabled and a clip is attached. The bytes
    // are already H.264-normalised at import, so the source build
    // should succeed; if it doesn't we still swap to the (blank) canvas
    // so the overlay stays deterministic instead of freezing on a
    // stale VideoTexture frame.
    const hv = useHandVideo.getState()
    const wantHandVideo = settings.handVideoEnabled && !!hv.fileBytes
    if (wantHandVideo) {
      handDraw = useHandVideo.getState().beginExport()
      try {
        handSource = await createHandVideoFrameSource(hv.fileBytes!)
      } catch {
        handSource = null
      }
    }
    const hvOffset = settings.handVideoOffsetSec
    const hvTrimStart = settings.handVideoTrimStartSec
    const hvDur = handSource?.durationSec ?? hv.duration
    const hvTrimEnd = settings.handVideoTrimEndSec ?? hvDur

    for (let n = 0; n < totalFrames; n++) {
      if (signal?.aborted) throw new VideoRenderAborted()
      if (videoEncoderError) throw videoEncoderError

      const t = n / fps
      clock.setTime(t)

      // Step the hand video to the frame covering this instant before
      // the scene renders. `srcSec` mirrors the realtime overlay:
      // song-time minus the clip offset, gated by the trim window.
      if (handDraw) {
        const srcSec = t - hvOffset
        const within =
          srcSec >= hvTrimStart &&
          srcSec < hvTrimEnd &&
          srcSec >= 0 &&
          (hvDur === 0 || srcSec <= hvDur)
        if (handSource && within) {
          let vf: VideoFrame | null = null
          try {
            vf = await handSource.frameAt(srcSec)
          } catch {
            vf = null
          }
          handDraw(vf)
        } else {
          handDraw(null)
        }
      }

      // Pass SECONDS to advance — see the autoStart=false comment
      // above. delta in useFrame becomes 1/fps in seconds.
      r3f.advance(t, true)

      const frame = new VideoFrame(gl.domElement, {
        timestamp: n * usPerFrame,
        duration: usPerFrame,
      })

      while (videoEncoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
        await yieldToEventLoop()
        if (signal?.aborted) {
          frame.close()
          throw new VideoRenderAborted()
        }
        if (videoEncoderError) {
          frame.close()
          throw videoEncoderError
        }
      }

      videoEncoder.encode(frame, { keyFrame: n % keyframeInterval === 0 })
      frame.close()

      // Yield once per frame so DOM events (Cancel click) get
      // processed and the video encoder's output handler can run
      // between our encode calls. MessageChannel-postMessage is
      // ~zero-overhead; setTimeout(0) would compound to many seconds
      // across an 18 000-frame render due to the spec's nested-
      // timeout clamp.
      await yieldToEventLoop()

      videoFraction = (n + 1) / totalFrames
      emitOverall()
    }

    await raceWithAbort(videoEncoder.flush(), signal)
    if (videoEncoderError) throw videoEncoderError

    // Audio AAC encode pass. Skipped entirely when audio is disabled.
    if (audioEncoder && audioRenderPromise && audio) {
      // Now await the audio buffer (might already be done from the
      // parallel render). The race makes Cancel responsive even if the
      // audio side is still inside `startRendering()`.
      const audioBuffer = await raceWithAbort(
        audioRenderPromise.catch((e) => {
          if (e instanceof AudioRenderAborted) throw new VideoRenderAborted()
          throw e
        }),
        signal,
      )

      audioEncoder.configure({
        codec: AAC_CODEC_STRING,
        sampleRate: audioBuffer.sampleRate,
        numberOfChannels: audioBuffer.numberOfChannels,
        bitrate: audio.bitrateKbps * 1000,
      })

      const numChannels = audioBuffer.numberOfChannels
      const totalSamples = audioBuffer.length
      const channelData: Float32Array[] = []
      for (let c = 0; c < numChannels; c++) {
        channelData.push(audioBuffer.getChannelData(c))
      }
      for (let off = 0; off < totalSamples; off += AUDIO_CHUNK_SAMPLES) {
        if (signal?.aborted) throw new VideoRenderAborted()
        if (audioEncoderError) throw audioEncoderError
        const chunkLen = Math.min(AUDIO_CHUNK_SAMPLES, totalSamples - off)
        const planar = new Float32Array(chunkLen * numChannels)
        for (let c = 0; c < numChannels; c++) {
          planar.set(channelData[c].subarray(off, off + chunkLen), c * chunkLen)
        }
        const audioData = new AudioData({
          format: 'f32-planar',
          sampleRate: audioBuffer.sampleRate,
          numberOfFrames: chunkLen,
          numberOfChannels: numChannels,
          timestamp: Math.round((off / audioBuffer.sampleRate) * 1_000_000),
          data: planar,
        })
        audioEncoder.encode(audioData)
        audioData.close()

        while (audioEncoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
          await yieldToEventLoop()
          if (signal?.aborted) throw new VideoRenderAborted()
          if (audioEncoderError) throw audioEncoderError
        }

        setAudioFraction_encode((off + chunkLen) / totalSamples)
      }
      await raceWithAbort(audioEncoder.flush(), signal)
      if (audioEncoderError) throw audioEncoderError
    }

    onProgress?.({ phase: 'finalizing' })
    muxer.finalize()

    const target = muxer.target as ArrayBufferTarget
    const blob = new Blob([target.buffer], { type: 'video/mp4' })
    onProgress?.({ phase: 'done' })
    return blob
  } finally {
    try {
      if (videoEncoder.state !== 'closed') videoEncoder.close()
    } catch {
      /* ignore */
    }
    try {
      if (audioEncoder && audioEncoder.state !== 'closed') audioEncoder.close()
    } catch {
      /* ignore */
    }
    try {
      audioEngine.endExportPlayback()
    } catch {
      /* ignore */
    }
    try {
      handSource?.close()
    } catch {
      /* ignore */
    }
    try {
      // Only restore the realtime VideoTexture if we actually swapped
      // it (handDraw is set iff beginExport ran).
      if (handDraw) useHandVideo.getState().endExport()
    } catch {
      /* ignore */
    }
    resetActiveClock()
    try {
      if (isPerspective) {
        const cam = camera as THREE.PerspectiveCamera
        cam.aspect = prevAspect
        cam.updateProjectionMatrix()
      }
      gl.setPixelRatio(prevPixelRatio)
      gl.setSize(prevSize.x, prevSize.y, false)
      r3f.clock.elapsedTime = prevClockElapsed
      r3f.clock.oldTime = prevClockOldTime
      r3f.clock.autoStart = prevClockAutoStart
      if (prevClockRunning) {
        r3f.clock.oldTime = performance.now()
        r3f.clock.running = true
      }
      r3f.set({ frameloop: prevFrameloop })
      r3f.invalidate()
    } catch {
      /* ignore */
    }
  }
}

import type { ParsedSong } from '../midi/types'
import type { Settings } from '../store'
import { VirtualClock, resetActiveClock, setActiveClock } from '../audio/clock'
import { audioEngine } from '../audio/engine'
import { getR3FState, setExportFps } from '../scene/exportBridge'
import { AudioRenderAborted, VideoRenderAborted } from './errors'
import { renderSongAudio } from './renderAudio'
import { MAX_ENCODE_QUEUE, raceWithAbort, yieldToEventLoop } from './async'
import { encodeAudioBuffer } from './codec/audio'
import { computeExportTimeline } from './timeline'
import type { UserAudioTrack } from './synth/types'
import { VIDEO_CODECS } from './codec/codecs'
import { isVideoExportSupported, probeVideoCodecs, videoEncoderConfig } from './codec/video'
import { createMuxer } from './codec/muxer'
import { assertEncodersSupported } from './codec/preflight'
import type { AudioTrackConfig, VideoCodec } from './codec/types'
import { createAvRenderProgress } from './progress'
import { enterSceneExportMode } from './sceneExportMode'
import { handsSettled } from '../hands/motion'

export { VIDEO_CODECS, isVideoExportSupported, probeVideoCodecs }
export type { AudioTrackConfig }

/** 1 keyframe per second is a comfortable seeking interval. */
const KEYFRAME_INTERVAL_SECONDS = 1

export type VideoRenderProgress =
  | { phase: 'preparing' }
  | { phase: 'rendering'; progress: number }
  | { phase: 'finalizing' }
  | { phase: 'done' }

export type VideoRenderOptions = {
  codec: VideoCodec
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
  userAudio?: UserAudioTrack | null
  signal?: AbortSignal
  onProgress?: (p: VideoRenderProgress) => void
}

/**
 * Offline-render the loaded song's visualizer + sampled audio into a
 * single video file — MP4 (H.264 + AAC) or WebM (VP9 / AV1 + Opus),
 * per `VIDEO_CODECS[codec]`. Audio and video render in
 * parallel — the offline AudioContext processes off the main thread
 * while the video frame loop steps R3F on the main thread — so total
 * wall-clock time ≈ max(audio_time, video_time) instead of the sum.
 *
 * Pipeline:
 *   1. Put the R3F scene into export mode (`enterSceneExportMode`:
 *      export resolution, `frameloop="never"`, disarmed `THREE.Clock`).
 *   2. Install a `VirtualClock` and put the audio engine into silent
 *      export mode.
 *   3. Kick off `renderSongAudio` — runs in its own
 *      `OfflineAudioContext`, doesn't touch the realtime engine.
 *   4. Configure VideoEncoder and step `(totalDuration * fps)` frames
 *      in parallel with (3).
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
  const { codec, width, height, fps, videoBitrateKbps, audio, userAudio, signal, onProgress } = options
  if (signal?.aborted) throw new VideoRenderAborted()
  const onAbort = () => new VideoRenderAborted()

  await assertEncodersSupported(
    { codec, width, height, fps, bitrateKbps: videoBitrateKbps },
    audio,
  )

  const codecInfo = VIDEO_CODECS[codec].config
  // Built before any R3F / clock state is touched: the WebM muxer
  // lazy-loads its library, and a failed load must not leave the
  // scene in export mode.
  const muxer = await createMuxer({ config: codecInfo, fps, audio })

  const r3f = getR3FState()
  if (!r3f) {
    throw new Error('The 3D scene is not mounted yet. Try again in a moment.')
  }

  onProgress?.({ phase: 'preparing' })
  // The hands (when on) must have the current song's motion and their meshes before frame 0.
  await raceWithAbort(handsSettled(), signal, onAbort)

  const restoreScene = enterSceneExportMode(r3f, width, height)
  setExportFps(fps) // nominal frame duration for the hands' motion blur
  const clock = new VirtualClock()
  setActiveClock(clock)
  audioEngine.beginExportPlayback()


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

  const progress = createAvRenderProgress(audio !== null, (overall) =>
    onProgress?.({ phase: 'rendering', progress: overall }),
  )

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
              progress.audioLoading(p.total > 0 ? p.loaded / p.total : 0)
            } else if (p.phase === 'rendering') {
              progress.audioRender(p.progress)
            }
          },
          signal,
          userAudio ?? null,
        )
      : null
    // Attach a no-op rejection handler so an early abort doesn't
    // surface as an unhandled rejection before we await it.
    audioRenderPromise?.catch(() => undefined)

    videoEncoder.configure(videoEncoderConfig(codec, width, height, fps, videoBitrateKbps))

    // Same window as the audio render (MIDI offset / trim / speed
    // automation / accompaniment tail + TAIL_SECONDS) so the final
    // visual matches the audio tail instead of freezing on the last
    // MIDI frame while the audio keeps playing.
    const { totalDuration } = computeExportTimeline(song, settings, userAudio ?? null)
    const totalFrames = Math.max(1, Math.ceil(totalDuration * fps))
    const usPerFrame = Math.round(1_000_000 / fps)
    const keyframeInterval = Math.max(1, Math.round(KEYFRAME_INTERVAL_SECONDS * fps))

    for (let n = 0; n < totalFrames; n++) {
      if (signal?.aborted) throw new VideoRenderAborted()
      if (videoEncoderError) throw videoEncoderError

      const t = n / fps
      clock.setTime(t)
      // Pass SECONDS to advance — see `enterSceneExportMode`'s clock
      // disarm. delta in useFrame becomes 1/fps in seconds.
      r3f.advance(t, true)

      const frame = new VideoFrame(r3f.gl.domElement, {
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

      progress.video((n + 1) / totalFrames)
    }

    await raceWithAbort(videoEncoder.flush(), signal, onAbort)
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
        onAbort,
      )

      audioEncoder.configure({
        codec: codecInfo.audioCodec,
        sampleRate: audioBuffer.sampleRate,
        numberOfChannels: audioBuffer.numberOfChannels,
        bitrate: audio.bitrateKbps * 1000,
      })

      await encodeAudioBuffer({
        encoder: audioEncoder,
        buffer: audioBuffer,
        assertAlive: () => {
          if (signal?.aborted) throw new VideoRenderAborted()
          if (audioEncoderError) throw audioEncoderError
        },
        signal,
        onAbort,
        onProgress: progress.audioEncode,
      })
    }

    onProgress?.({ phase: 'finalizing' })
    const blob = await muxer.finalize()
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
    resetActiveClock()
    setExportFps(null)
    restoreScene()
  }
}

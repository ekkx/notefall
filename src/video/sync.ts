import { audioEngine } from '../audio/engine'
import { useStore } from '../store'
import { handVideoTimeAt } from './time'

// Beyond this the element is re-seeked; below it playbackRate nudges it back.
const SEEK_DRIFT_SEC = 0.15
const NUDGE_DRIFT_SEC = 0.02
// Paused: re-seek when the target moved by more than about a frame.
const PAUSED_EPS_SEC = 1 / 120

let pendingSeek: number | null = null

function seekTo(el: HTMLVideoElement, t: number): void {
  // One seek in flight at a time: scrubbing would otherwise queue dozens
  // and the picture would trail the playhead. The latest target wins.
  if (el.seeking) {
    pendingSeek = t
    return
  }
  pendingSeek = null
  el.currentTime = t
}

const onSeeked = (e: Event) => {
  const el = e.target as HTMLVideoElement
  if (pendingSeek !== null) seekTo(el, pendingSeek)
}
const wired = new WeakSet<HTMLVideoElement>()

/**
 * Keep the live <video> on the engine's clock. Called once per rendered
 * frame by the scene layer (never during an export: the exporter decodes
 * frames itself, see `exportFrames.ts`). The element is muted (the video's
 * sound is never used), so only its picture has to follow.
 * `hold` leaves the element alone: the setup view plays and seeks it itself.
 */
export function syncHandVideo(el: HTMLVideoElement, duration: number, hold = false): void {
  if (!wired.has(el)) {
    el.addEventListener('seeked', onSeeked)
    wired.add(el)
  }
  if (hold) return
  const { settings } = useStore.getState()
  const { time, inside } = handVideoTimeAt(audioEngine.currentSongTime(), settings, duration)
  const rate = Math.max(0.25, Math.min(4, settings.playbackRate))

  if (audioEngine.isPlaying() && inside) {
    if (el.paused) {
      seekTo(el, time)
      el.playbackRate = rate
      void el.play().catch(() => {
        /* autoplay of a muted element is allowed; a refusal just leaves the frame still */
      })
      return
    }
    if (el.seeking) return
    const drift = el.currentTime - time
    if (Math.abs(drift) > SEEK_DRIFT_SEC) {
      seekTo(el, time)
      el.playbackRate = rate
    } else if (Math.abs(drift) > NUDGE_DRIFT_SEC) {
      // Ahead → slow down a little, behind → speed up; at most ±10 %.
      el.playbackRate = rate * (1 - Math.max(-0.1, Math.min(0.1, drift * 2)))
    } else if (el.playbackRate !== rate) {
      el.playbackRate = rate
    }
    return
  }

  if (!el.paused) el.pause()
  if (Math.abs(el.currentTime - time) > PAUSED_EPS_SEC || pendingSeek !== null) seekTo(el, time)
}

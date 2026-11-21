import type { Settings } from '../store'

/**
 * Timeline time → time inside the hand video. `handVideoOffsetSec` puts
 * video t = 0 on the timeline and the clip's trim is the shown window.
 * Outside the window the nearest edge frame is held, so the keyboard area
 * never goes empty while the virtual keyboard is hidden.
 */
export function handVideoTimeAt(
  timelineSec: number,
  settings: Pick<Settings, 'handVideoOffsetSec' | 'handVideoTrimStartSec' | 'handVideoTrimEndSec'>,
  duration: number,
): { time: number; inside: boolean } {
  const rel = timelineSec - settings.handVideoOffsetSec
  const start = Math.max(0, settings.handVideoTrimStartSec)
  // Stay a hair before the end: seeking a <video> to exactly `duration` shows nothing in some browsers.
  const last = Math.max(start, duration - 0.001)
  const end = Math.min(last, settings.handVideoTrimEndSec ?? last)
  return { time: Math.min(end, Math.max(start, rel)), inside: rel >= start && rel < end }
}

/** Where the hand video's shown window ends on the timeline (0 when there is no video / it is switched off). */
export function handVideoEndOnTimeline(
  settings: Pick<Settings, 'handVideoEnabled' | 'handVideoOffsetSec' | 'handVideoTrimStartSec' | 'handVideoTrimEndSec'>,
  duration: number,
  loaded: boolean,
): number {
  if (!loaded || !settings.handVideoEnabled || duration <= 0) return 0
  const start = Math.max(0, settings.handVideoTrimStartSec)
  const end = Math.max(start, Math.min(duration, settings.handVideoTrimEndSec ?? duration))
  return Math.max(0, settings.handVideoOffsetSec + end)
}

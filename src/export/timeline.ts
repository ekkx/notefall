import type { ParsedSong } from '../midi/types'
import { buildSpeedMap, midiToTimeline, type SpeedMap } from '../midi/speedMap'
import type { Settings } from '../store'
import type { UserAudioTrack } from './synth/types'
import { useHandVideo } from '../video/handVideo'
import { handVideoEndOnTimeline } from '../video/time'

// Same SONG_TAIL_SECONDS as the engine — the visual layer's reverb wash
// + landing flashes need this window to play out, and offline audio
// must match so the wash isn't trimmed mid-decay. The video pass uses
// the same tail so both tracks end together.
export const TAIL_SECONDS = 5

export type ExportTimeline = {
  speedMap: SpeedMap
  /** MIDI shift on the export timeline (`settings.midiOffsetSec`). */
  midiOffset: number
  /** Trim window in MIDI-time. */
  midiTrimStart: number
  midiTrimEnd: number
  /** Trim window in the user audio buffer's own time (0 when absent). */
  audioTrimStart: number
  audioTrimEnd: number
  /** Rendered length in seconds, tail included. */
  totalDuration: number
}

/**
 * Effective end is the later of the MIDI end and (when present) the
 * user-provided accompaniment's tail, so the render captures the
 * whole sync window even when the audio extends past the song. The
 * MIDI is shifted by `midiOffsetSec` so its end on the export
 * timeline is `song.duration + midiOffsetSec`. Trim ends collapse
 * the timeline to the trimmed window so we don't render silent
 * padding. Shared by the audio and video passes so both tracks span
 * the exact same window.
 */
export function computeExportTimeline(
  song: ParsedSong,
  settings: Settings,
  userAudio: UserAudioTrack | null,
): ExportTimeline {
  const midiOffset = settings.midiOffsetSec
  const midiTrimStart = settings.midiTrimStartSec
  const midiTrimEnd = settings.midiTrimEndSec ?? song.duration
  // Speed automation maps MIDI-time to a stretched / compressed
  // timeline. Apply the same mapping the realtime engine uses so an
  // export comes out sample-identical to live playback.
  const speedMap = buildSpeedMap(settings.midiSpeedAutomation)
  const midiTrimEndTimeline = midiToTimeline(speedMap, midiTrimEnd)
  const audioTrimStart = userAudio ? Math.max(0, userAudio.trimStartSec) : 0
  const audioTrimEnd = userAudio
    ? Math.min(userAudio.buffer.duration, userAudio.trimEndSec ?? userAudio.buffer.duration)
    : 0
  const audioEnd = userAudio ? userAudio.offsetSec + audioTrimEnd : 0
  // The hand video is a third clip: the window covers it too (and is just its length when there is no song at all).
  const video = useHandVideo.getState()
  const videoEnd = handVideoEndOnTimeline(settings, video.duration, video.element !== null)
  const hasSound = song.duration > 0 || userAudio !== null
  const songEnd = Math.max(hasSound ? midiTrimEndTimeline + midiOffset : 0, audioEnd, videoEnd)
  return {
    speedMap,
    midiOffset,
    midiTrimStart,
    midiTrimEnd,
    audioTrimStart,
    audioTrimEnd,
    totalDuration: songEnd + (hasSound ? TAIL_SECONDS : 0),
  }
}

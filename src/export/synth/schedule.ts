import type { ParsedSong } from '../../midi/types'
import { midiToTimeline, timelineToMidi } from '../../midi/speedMap'
import type { Settings } from '../../store'
import { evaluateVelocityCurve } from '../../audio/velocityCurve'
import { LOOKAHEAD, STOP_BUFFER } from './consts'
import { dampTc, liftAt, pedalLift, SILENT_TCS } from '../../audio/pedalDepth'
import { holdRelease } from '../../audio/smoothRelease'
import type { ExportTimeline } from '../timeline'
import type { OfflinePiano, UserAudioTrack } from './types'

/**
 * Schedule the user-provided accompaniment alongside the piano. Goes
 * through its own GainNode so the mix volume is independent of the
 * sampler's. Negative offsets aren't supported in the MVP, so the
 * start time is always ≥ 0; if the offset overshoots the rendered
 * window the source simply never fires.
 */
export function scheduleUserAudio(
  ctx: OfflineAudioContext,
  userAudio: UserAudioTrack,
  settings: Settings,
  timeline: ExportTimeline,
): void {
  const { audioTrimStart, audioTrimEnd, totalDuration } = timeline
  if (userAudio.offsetSec >= totalDuration || audioTrimEnd <= audioTrimStart) return
  const src = ctx.createBufferSource()
  src.buffer = userAudio.buffer
  const gain = ctx.createGain()
  // Master × per-track stacking so the export tracks live playback.
  gain.gain.value = settings.volume * userAudio.volume
  src.connect(gain)
  gain.connect(ctx.destination)
  // Schedule with `(when, offset, duration)` so the trim window is
  // honoured by the audio graph itself rather than us needing to
  // pre-slice the buffer.
  const startTime = Math.max(0, userAudio.offsetSec + audioTrimStart)
  src.start(startTime, audioTrimStart, audioTrimEnd - audioTrimStart)
}

/**
 * Schedule every song note's on/off on the offline piano, with the
 * same trim, transpose, velocity-curve and pedal-sustain semantics as
 * the realtime engine's tick.
 */
export function scheduleSongNotes(
  piano: OfflinePiano,
  song: ParsedSong,
  settings: Settings,
  timeline: ExportTimeline,
): void {
  const { speedMap, midiOffset, midiTrimStart, midiTrimEnd, totalDuration } = timeline

  // Pedal handling. Mirror the engine: when settings.pedalEnabled is off,
  // ignore the song's pedal track entirely (notes release at their
  // natural offTime). Pedal events are stored in MIDI-time, so the
  // pedal walk runs in MIDI-time and each step is mapped to timeline-time.
  // The walk stops at the end of the rendered window, converted to MIDI-time
  // through the speed map (the window end is timeline-time: comparing it to
  // MIDI-time directly lifted the pedal seconds early when the song was sped
  // up). Like the engine, the pedal is NOT cut at the song's / trim's end:
  // its events keep sustaining the last notes through the tail.
  const pedalEnd = timelineToMidi(speedMap, totalDuration - midiOffset)
  const tl = (midiT: number) => midiOffset + midiToTimeline(speedMap, midiT) + STOP_BUFFER
  const releaseTime = settings.releaseTime
  const releaseTc = releaseTime / 5

  for (const n of song.notes) {
    // Trim filter — match the engine's tick semantics so a rendered
    // export sounds the same as live playback under the same trim.
    if (n.time < midiTrimStart) continue
    if (n.time >= midiTrimEnd) continue
    const playedMidi = n.midi + settings.transpose
    if (playedMidi < 0 || playedMidi > 127) continue

    const shaped = evaluateVelocityCurve(settings.velocityCurve, n.velocity)
    // n.time is MIDI-time; map through the speed curve and shift by
    // `midiOffset` to land on the export timeline. Without
    // automation `midiToTimeline` is the identity, so this collapses
    // to the linear `n.time + midiOffset` of before.
    const onTime = midiOffset + midiToTimeline(speedMap, n.time) + LOOKAHEAD
    // Clamp the natural note-off to the trim end (MIDI-time). Under a
    // lifted pedal the voice is kept and faded at the depth's rate, re-targeted
    // at every later pedal event, like the engine's `updatePedalHeld`.
    const naturalOff = Math.min(n.time + n.duration, midiTrimEnd)
    const stopFn = piano.start(playedMidi, shaped, onTime, `s${n.id}`)
    const start = settings.pedalEnabled ? liftAt(song.pedals, naturalOff) : { lift: 0, next: 0 }
    if (start.lift <= 0 || naturalOff >= pedalEnd) {
      stopFn(tl(naturalOff))
      continue
    }
    const voice = holdRelease(stopFn, tl(naturalOff))
    let lift = start.lift
    let at = tl(naturalOff)
    let faded = 0
    voice.decay(at, dampTc(lift, releaseTc))
    for (let i = start.next; ; i++) {
      // Next pedal event, or the end of the rendered window (a release).
      const ev = i < song.pedals.length && song.pedals[i].time < pedalEnd ? song.pedals[i] : null
      const nextAt = tl(ev ? ev.time : pedalEnd)
      const tc = dampTc(lift, releaseTc)
      if (faded + (nextAt - at) / tc >= SILENT_TCS) {
        voice.end(at + (SILENT_TCS - faded) * tc)
        break
      }
      faded += (nextAt - at) / tc
      at = nextAt
      const nextLift = ev ? pedalLift(ev.value) : 0
      if (nextLift <= 0) {
        voice.decay(at, releaseTc)
        voice.end(at + releaseTime)
        break
      }
      if (nextLift !== lift) voice.decay(at, dampTc(nextLift, releaseTc))
      lift = nextLift
    }
  }
}

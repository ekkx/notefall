import type { NoteEvent } from '../midi/types'
import { defaultSettings, type Settings } from '../store'
import { midiToTimeline, timelineToMidi, type SpeedMap } from '../midi/speedMap'
import { KEYBOARD_LAYOUT, KEY_COUNT, MIDI_MIN, NOTE_HIT_Y } from '../keyboard/layout'
import { getLensWindow } from '../scene/framing'
import { noteLabelMinLengthAt } from './pitchLabels'

// Falling notes render on the z = NOTE_PLANE_Z plane so they sit in front
// of the 3D key caps (white at z=0, black tops at z=0.09) instead of
// intersecting them as they cross the hit line. But the keyboard surface
// a note must visually land on is at z = 0. Under perspective the two
// depths project to different screen-x for the same world-x, so off-centre
// notes drift outward — the further from centre, the larger the gap.
//
// Pre-scale every note's x about the camera's x so its z = NOTE_PLANE_Z
// projection coincides with the key's z = 0 projection:
//   x' = camX + (x - camX) · (camZ - NOTE_PLANE_Z) / camZ
// Frozen to the *default* camera framing (like FALL_DISTANCE) so orbiting
// / zoom never shifts the keyboard alignment.
export const NOTE_PLANE_Z = 0.1
const CAM_X = defaultSettings.cameraPos[0]
const CAM_Z = Math.abs(defaultSettings.cameraPos[2])
export const NOTE_PARALLAX_SCALE =
  CAM_Z > NOTE_PLANE_Z ? (CAM_Z - NOTE_PLANE_Z) / CAM_Z : 1

/** Perspective-compensated world-x for a raw keyboard-plane x. */
export function parallaxX(rawX: number): number {
  return CAM_X + (rawX - CAM_X) * NOTE_PARALLAX_SCALE
}

/**
 * Shared context for the geometry helpers below. With speed automation,
 * a note's screen Y depends on its FIRE TIME on the audio timeline
 * (`midiOffset + midiToTimeline(map, n.time)`), not its raw MIDI-time.
 * Passing the speed map + offset around (instead of going through the
 * engine each call) keeps these helpers pure and testable.
 *
 * `currentAudioTime` is in TL_audio coords (= engine.currentSongTime),
 * the same axis that `(midiOffset + map(n.time))` lives on. Without
 * automation `map` is the identity and `currentAudioTime` collapses
 * to the legacy "currentTime in MIDI-time" — passing an empty map +
 * 0 offset reproduces the old single-arg behaviour.
 */
export type TimeContext = {
  speedMap: SpeedMap
  midiOffset: number
}

function noteFireAudio(note: NoteEvent, ctx: TimeContext): number {
  return ctx.midiOffset + midiToTimeline(ctx.speedMap, note.time)
}

/**
 * Shared geometry between the renderer (FallingNotes) and the editor
 * (selection / drag / range-select / new-note placement). Keeping the
 * forward equation here means the visual position the user clicks on is
 * exactly the position the editor reasons about — no drift, no transform
 * rounding mismatches.
 *
 * Forward equation (matches FallingNotes' useFrame):
 *   For 'down' fall direction:
 *     headY = hitY + ((note.time - currentTime) / fall) * FALL_DISTANCE
 *   For 'up':
 *     headY = hitY + ((currentTime - note.time) / fall) * FALL_DISTANCE
 *
 * FALL_DISTANCE = `fallDistance()`.
 */

// Buffer (world units) above the visible top edge where a note's spawn
// position sits — keeps a note off-screen the moment before it slides in.
export const SPAWN_BUFFER = 1.0

/**
 * Fall length at scale 1, frozen against the *default* camera framing so
 * orbiting / dollying never resizes the notes.
 */
export const FALL_REFERENCE_DISTANCE =
  Math.max(
    0.5,
    defaultSettings.cameraLookAt[1] + CAM_Z * Math.tan((defaultSettings.cameraFov * Math.PI) / 360) - NOTE_HIT_Y,
  ) + SPAWN_BUFFER

/**
 * World units a note falls in `fallDurationSec` this frame. Grows with the
 * lens window (video shape, camera follow), so a zoom changes only how wide
 * the notes look: on screen they keep their length and their speed.
 */
export function fallDistance(): number {
  return FALL_REFERENCE_DISTANCE * getLensWindow().scale
}

/**
 * World Y of a click → MIDI-time the click corresponds to, accounting
 * for fall direction. Used by "double-click empty space to add a
 * note" so the new note lands exactly where the user pointed. With
 * speed automation, the click position maps to a TL_audio moment
 * first; we then invert through the speed map to get the MIDI-time
 * that, when fired, would visually land at the click Y.
 */
export function clickYToTime(
  y: number,
  currentAudioTime: number,
  settings: Settings,
  ctx: TimeContext,
): number {
  const hitY = NOTE_HIT_Y
  const headT = ((y - hitY) / fallDistance()) * settings.fallDurationSec
  const audioAtClick =
    settings.fallDirection === 'down'
      ? currentAudioTime + headT
      : currentAudioTime - headT
  return timelineToMidi(ctx.speedMap, audioAtClick - ctx.midiOffset)
}

/**
 * World X of a click → MIDI pitch. Returns the displayed midi WITHOUT the
 * transpose applied, so storing it in `note.midi` and adding `transpose`
 * back at render time reproduces the clicked X. Picks the nearest key by
 * absolute X distance — black keys are narrower so the threshold naturally
 * favors them when the click is near their center.
 */
export function clickXToMidi(x: number, transpose: number): number {
  // `x` is sampled on the falling-note plane (where the user clicks the
  // visible note), so it lives in the parallax-compensated space — match
  // it against the keys' compensated centres, not their raw layout x.
  let bestMidi = MIDI_MIN
  let bestDist = Infinity
  for (let i = 0; i < KEY_COUNT; i++) {
    const k = KEYBOARD_LAYOUT.keys[i]
    const d = Math.abs(parallaxX(k.x) - x)
    if (d < bestDist) {
      bestDist = d
      bestMidi = k.midi
    }
  }
  return bestMidi - transpose
}

/**
 * Inverse of clickYToTime — given a MIDI-time, return the screen Y
 * where that note's HEAD currently sits. Routes through the speed
 * map so the head lands on screen at its actual fire moment.
 */
export function timeToHeadY(
  time: number,
  currentAudioTime: number,
  settings: Settings,
  ctx: TimeContext,
): number {
  const hitY = NOTE_HIT_Y
  const fd = fallDistance()
  const fireAudio = ctx.midiOffset + midiToTimeline(ctx.speedMap, time)
  const headT =
    settings.fallDirection === 'down'
      ? fireAudio - currentAudioTime
      : currentAudioTime - fireAudio
  return hitY + (headT / settings.fallDurationSec) * fd
}

/**
 * World X for a given displayed midi (i.e. `note.midi + transpose`). Returns
 * null when the midi is outside the keyboard so callers can skip drawing.
 */
export function midiToX(displayedMidi: number): number | null {
  const idx = displayedMidi - MIDI_MIN
  if (idx < 0 || idx >= KEY_COUNT) return null
  return parallaxX(KEYBOARD_LAYOUT.keys[idx].x)
}

/**
 * Axis-aligned world bounds of a note's *visible* rectangle at `currentTime`,
 * exactly mirroring the geometry FallingNotes assembles per frame. Returns
 * null when the note is outside the keyboard or has scrolled fully past
 * the hit line / hasn't yet appeared. Used by range-select to test
 * rectangle overlap against the same shape the user sees.
 *
 * Mirroring the renderer is critical: the renderer applies a `noteMinLength`
 * floor so very short notes stay visible, which means a note's visual
 * bounds are not always its natural bounds. A naive (head, head + duration)
 * test would miss those puffed-up bars.
 */
export function noteVisualBounds(
  note: NoteEvent,
  currentAudioTime: number,
  settings: Settings,
  ctx: TimeContext,
): { xMin: number; xMax: number; yMin: number; yMax: number } | null {
  const idx = note.midi + settings.transpose - MIDI_MIN
  if (idx < 0 || idx >= KEY_COUNT) return null
  const key = KEYBOARD_LAYOUT.keys[idx]
  const width = key.width * settings.noteWidthScale
  const halfWidth = width / 2

  const hitY = NOTE_HIT_Y
  const fd = fallDistance()
  const fall = settings.fallDurationSec
  // the renderer draws labelled notes at least as long as their label
  const minLength = Math.max(
    0.01,
    settings.noteMinLength,
    noteLabelMinLengthAt(settings, settings.noteWidthScale, idx),
  )

  // Note's head + tail fire moments in TL_audio. Both ends go through
  // the speed map so a note that spans a non-unity-speed region has
  // its visual length match what the audio will produce.
  const headFire = noteFireAudio(note, ctx)
  const tailFire =
    ctx.midiOffset + midiToTimeline(ctx.speedMap, note.time + note.duration)

  let bottomY: number
  let topY: number
  if (settings.fallDirection === 'down') {
    const headT = headFire - currentAudioTime
    const tailT = tailFire - currentAudioTime
    if (headT > fall) return null
    const headY = hitY + (headT / fall) * fd
    const tailY = hitY + (tailT / fall) * fd
    const visualLength = Math.max(minLength, tailY - headY)
    bottomY = headY
    topY = bottomY + visualLength
    if (topY <= hitY) return null
  } else {
    const headT = currentAudioTime - headFire
    if (headT < 0) return null
    const tailT = currentAudioTime - tailFire
    const headY = hitY + (headT / fall) * fd
    const tailY = hitY + (tailT / fall) * fd
    topY = headY
    const visualLength = Math.max(minLength, headY - tailY)
    bottomY = topY - visualLength
    if (topY <= hitY) return null
  }

  // Mirror the renderer's parallax compensation (applied as a mesh-level
  // x-affine, so the ±halfWidth extents scale with the centre too).
  return {
    xMin: parallaxX(key.x - halfWidth),
    xMax: parallaxX(key.x + halfWidth),
    yMin: bottomY,
    yMax: topY,
  }
}

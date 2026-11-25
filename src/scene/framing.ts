// The picture's framing on top of the camera: the keyboard's place on screen (Keyboard Y), the video's shape, and the
// camera follow. All of it is one lens window (zoom + shift of the frustum, `camera.view`), so the camera itself never
// moves: no extra perspective, and the notes stay on their keys.
import * as THREE from 'three'
import { audioEngine } from '../audio/engine'
import { clockEpoch, now } from '../audio/clock'
import { songHandNotes } from '../hands/motion'
import { KEYBOARD_LAYOUT, KEYBOARD_Y, NOTE_HIT_Y, WHITE_KEY_WIDTH } from '../keyboard/layout'
import { buildSpeedMap } from '../midi/speedMap'
import type { ParsedSong } from '../midi/types'
import { useStore, type Settings } from '../store'
import { useHandVideo } from '../video/handVideo'
import { buildFollowPath, followAt, minKeysForAspect, type FollowPath, type KeyFrame } from './cameraFollow'
import { cameraNdc, keyboardViewShift, type LensWindow, type ViewShiftInput } from './visibleTop'

const DESIGN_ASPECT = 16 / 9
/** Seconds the picture takes to a new framing when the song or a setting changes under it. */
const EASE_SEC = 0.5

let current: LensWindow = { scale: 1, x: 0, y: 0, fall: 1 }
/** The lens window this frame is drawn with (set by `CameraSync`, before every consumer). */
export const getLensWindow = (): LensWindow => current

// ---- the song's path, remade when anything it depends on changes --------------------------------------------------

const PATH_KEYS = [
  'midiOffsetSec',
  'midiSpeedAutomation',
  'midiTrimStartSec',
  'midiTrimEndSec',
  'transpose',
  'cameraFollowMinKeys',
  'cameraFollowMargin',
  'cameraFollowSmooth',
] as const satisfies readonly (keyof Settings)[]

let path: FollowPath | null = null
let pathInputs: unknown[] = []

let pointerDown = false
if (typeof window !== 'undefined') {
  const read = (e: PointerEvent) => (pointerDown = e.buttons !== 0)
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'] as const)
    window.addEventListener(type, read, true)
}

function followPath(song: ParsedSong, s: Settings, aspect: number, hold: boolean): FollowPath | null {
  const minKeys = Math.max(s.cameraFollowMinKeys, Math.round(minKeysForAspect(aspect)))
  const inputs = [song, minKeys, ...PATH_KEYS.map((k) => s[k])]
  const same = inputs.length === pathInputs.length && inputs.every((v, i) => v === pathInputs[i])
  // A note being dragged must not move the picture under the pointer: the new path waits for the release.
  if (same || (hold && path)) return path
  pathInputs = inputs
  const notes = songHandNotes(song, {
    speedMap: buildSpeedMap(s.midiSpeedAutomation),
    midiOffsetSec: s.midiOffsetSec,
    trimStartSec: s.midiTrimStartSec,
    trimEndSec: s.midiTrimEndSec ?? song.duration,
    transpose: s.transpose,
  })
  path = buildFollowPath(notes, {
    minKeys,
    margin: s.cameraFollowMargin,
    smoothSec: s.cameraFollowSmooth,
  })
  ease.restart = true
  return path
}

// ---- the window ---------------------------------------------------------------------------------------------------

/** The framing with no follow: the camera as set, the 16:9 picture's whole width in any shape. */
function baseWindow(cam: ViewShiftInput, aspect: number): LensWindow {
  const scale = Math.max(1, DESIGN_ASPECT / aspect)
  return { scale, x: 0, y: anchoredY(cam, scale), fall: scale }
}

/** Window centre that leaves the keyboard's front edge at the screen height the unscaled picture has it. */
function anchoredY(cam: ViewShiftInput, scale: number): number {
  const front = cameraNdc(cam, 0, KEYBOARD_Y).y
  return front - scale * (front + 2 * keyboardViewShift(cam))
}

/**
 * `stretch`: how much of the zoom the notes' length makes up for. 1 = all of it (the same length on screen), 0 = none
 * (they scale with the keys). Measured from the song's typical zoom, so it never changes the fall speed as a whole.
 */
function followWindow(
  cam: ViewShiftInput,
  aspect: number,
  { centre, half }: KeyFrame,
  typical: number,
  stretch: number,
): LensWindow {
  const x = (key: number) =>
    cameraNdc(cam, key * WHITE_KEY_WIDTH - KEYBOARD_LAYOUT.totalWidth / 2, NOTE_HIT_Y).x / aspect
  const l = x(centre - half)
  const r = x(centre + half)
  const scale = Math.max(1e-3, (r - l) / 2)
  return { scale, x: (l + r) / 2, y: anchoredY(cam, scale), fall: scale * Math.pow(typical / half, 1 - stretch) }
}

const ease = {
  from: current,
  start: -Infinity,
  restart: false,
  mode: '',
  epoch: clockEpoch(),
}

/** Works out this frame's window and puts it on the camera. */
export function applyFraming(camera: THREE.PerspectiveCamera, cam: ViewShiftInput): void {
  const { settings: s, song, transport } = useStore.getState()
  const aspect = camera.aspect
  const follow =
    s.cameraFollowEnabled && song && useHandVideo.getState().editing === null
      ? followPath(song, s, aspect, transport !== 'playing' && pointerDown)
      : null
  let target: LensWindow
  if (follow) {
    const f = followAt(follow, audioEngine.currentSongTime())
    target = followWindow(cam, aspect, f, follow.typical, s.cameraFollowNoteStretch)
  } else {
    target = baseWindow(cam, aspect)
  }

  const t = now()
  const mode = follow ? 'follow' : 'base'
  if (ease.epoch !== clockEpoch()) {
    // An export starts or ends: the first frame is already the right one.
    ease.epoch = clockEpoch()
    ease.start = -Infinity
  } else if (ease.restart || ease.mode !== mode) {
    ease.from = current
    ease.start = t
  }
  ease.restart = false
  ease.mode = mode

  const u = (t - ease.start) / EASE_SEC
  if (u >= 0 && u < 1) {
    const e = u * u * (3 - 2 * u)
    const f = ease.from
    target = {
      scale: f.scale * Math.pow(target.scale / f.scale, e),
      x: f.x + (target.x - f.x) * e,
      y: f.y + (target.y - f.y) * e,
      fall: f.fall * Math.pow(target.fall / f.fall, e),
    }
  }
  current = target
  setLensWindow(camera, target)
}

/** Puts a window on `camera.view`, which `updateProjectionMatrix` honours, so R3F resizes and the export keep it. */
function setLensWindow(camera: THREE.PerspectiveCamera, w: LensWindow): void {
  const offsetX = (1 + w.x - w.scale) / 2
  const offsetY = (1 - w.y - w.scale) / 2
  const v = camera.view
  if (v && v.offsetX === offsetX && v.offsetY === offsetY && v.width === w.scale) return
  camera.view = {
    enabled: true,
    fullWidth: 1,
    fullHeight: 1,
    offsetX,
    offsetY,
    width: w.scale,
    height: w.scale,
  }
  camera.updateProjectionMatrix()
}

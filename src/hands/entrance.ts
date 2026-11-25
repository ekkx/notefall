import * as THREE from 'three'
import { KEYBOARD_Y } from '../keyboard/layout'
import { getLensWindow } from '../scene/framing'
import type { Settings } from '../store'
import type { HandPose, HandPoses, Vec3 } from './types'

// The motion brings a hand in from about 20 cm in front of the keys and takes it back there. A tall or zoomed-out picture
// shows that far down, so the end of that way is stretched until it lies below the picture: hands come in and go out
// through its bottom edge. Nothing changes where they play.

/** Wrists never go further back than this while playing. */
const PLAY_BACK_Y = KEYBOARD_Y - 1.05
/** How much further back than that the motion's way in starts (it ends a little further). */
const ENTRY_DEPTH = 1.1
/** Wrist to fingertips, with some room. */
const HAND_REACH = 2.1

/** World y of the bottom of the picture on the key plane. */
function pictureBottom(s: Settings): number {
  const w = getLensWindow()
  const half = Math.abs(s.cameraPos[2]) * Math.tan(THREE.MathUtils.degToRad(s.cameraFov) / 2)
  return s.cameraLookAt[1] + (w.y - w.scale) * half
}

function lowered(p: HandPose | null | undefined, bottom: number): HandPose | null | undefined {
  if (!p) return p
  const depth = PLAY_BACK_Y - p.wrist[1]
  if (depth <= 0) return p
  const needed = Math.max(0, PLAY_BACK_Y - ENTRY_DEPTH - (bottom - HAND_REACH))
  const dy = needed * (depth / ENTRY_DEPTH) ** 2
  const at = (v: Vec3): Vec3 => [v[0], v[1] - dy, v[2]]
  return {
    ...p,
    elbow: at(p.elbow),
    wrist: at(p.wrist),
    bases: p.bases.map(at) as HandPose['bases'],
    fingers: p.fingers.map((f) => f.map(at)) as HandPose['fingers'],
  }
}

export function withEntrance(poses: HandPoses, s: Settings): HandPoses {
  const bottom = pictureBottom(s)
  return { ...poses, L: lowered(poses.L, bottom), R: lowered(poses.R, bottom) } as HandPoses
}

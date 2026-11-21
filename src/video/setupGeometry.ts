import { KEYBOARD_Y, WHITE_KEY_WIDTH } from '../keyboard/layout'
import type { HandVideoKey } from '../store'
import {
  PLANE_KEY_COUNT,
  PLANE_KEY_LENGTH,
  applyH,
  defaultH,
  distort,
  homography,
  invert3,
  keyIndexAt,
  planeToPictureAt,
  type Mat3,
  type Vec2,
} from './geometry'

/**
 * Pure helpers of the hand video setup UI (`ui/HandVideoSetup.tsx`): the placement in effect at a
 * video time, which white keys the picture shows in full, the four key-corner pins and the refit of
 * the placement from them, and the octave shift. Plane units are white-key widths (`geometry.ts`).
 */

/** One octave in plane x: seven white keys. */
export const OCTAVE = 7

const EPS = 1e-4

/** corrected → plane for the key in effect at video time `t` (the default placement with no key). */
export function currentH(keys: readonly HandVideoKey[], t: number, aspect: number): Mat3 {
  const inv = planeToPictureAt(keys, t)
  return (inv && invert3(inv)) ?? defaultH(aspect)
}

/** Plane → world (x, y). */
export function planeToWorld(p: Vec2): Vec2 {
  return [(p[0] - PLANE_KEY_COUNT / 2) * WHITE_KEY_WIDTH, KEYBOARD_Y + p[1] * WHITE_KEY_WIDTH]
}

/** World (x, y) → plane. */
export function worldToPlane(w: Vec2): Vec2 {
  return [w[0] / WHITE_KEY_WIDTH + PLANE_KEY_COUNT / 2, (w[1] - KEYBOARD_Y) / WHITE_KEY_WIDTH]
}

/** Plane point → corrected picture, or null behind the projection. */
function toCorrected(hInv: Mat3, p: Vec2): Vec2 | null {
  return applyH(hInv, p)
}

/** Whether a corrected-picture point lies inside the recorded picture (through the lens bend). */
function inPicture(c: Vec2, bend: number, aspect: number): boolean {
  const r = distort(c, bend, aspect)
  return r[0] > -EPS && r[0] < 1 + EPS && r[1] > -EPS && r[1] < 1 + EPS
}

/**
 * The leftmost and rightmost white keys (0 = A0) the picture shows in full under `h`, looking at
 * key indices `min..max` (the real keyboard is 0..51; the octave stepper looks beyond it to know
 * how far a shift can go). Null when none is whole in the picture.
 */
export function visibleKeys(h: Mat3, bend: number, aspect: number, min = 0, max = PLANE_KEY_COUNT - 1): { lo: number; hi: number } | null {
  const inv = invert3(h)
  if (!inv) return null
  let lo = -1
  let hi = -1
  for (let i = min; i <= max; i++) {
    const whole = ([[i, 0], [i + 1, 0], [i, PLANE_KEY_LENGTH], [i + 1, PLANE_KEY_LENGTH]] as Vec2[]).every((p) => {
      const c = toCorrected(inv, p)
      return c !== null && inPicture(c, bend, aspect)
    })
    if (whole) {
      if (lo < 0) lo = i
      hi = i
    }
  }
  return lo < 0 ? null : { lo, hi }
}

const LETTERS = 'ABCDEFG'

/** White key index (0 = A0) → its name: 2 → C1, 8 → B1. */
export function whiteKeyName(i: number): string {
  const k = ((i % 7) + 7) % 7
  return `${LETTERS[k]}${Math.floor((i + 5) / 7)}`
}

/** The placement moved sideways by `dx` white keys. */
export function shiftH(h: Mat3, dx: number): Mat3 {
  return [h[0] + dx * h[6], h[1] + dx * h[7], h[2] + dx * h[8], h[3], h[4], h[5], h[6], h[7], h[8]]
}

/** Whether shifting by `dx` keeps every key the picture shows on the real keyboard. */
export function shiftFits(h: Mat3, bend: number, aspect: number, dx: number): boolean {
  const range = visibleKeys(shiftH(h, dx), bend, aspect, -60, 112)
  return range !== null && range.lo >= 0 && range.hi <= PLANE_KEY_COUNT - 1
}

export type Pin = {
  /** The picture point (corrected coords) the pin is fixed to. */
  src: Vec2
  /** Where the pin starts, on the keyboard plane. */
  plane: Vec2
}

/**
 * Four pins on key corners of the video: the front and back corners, on the outer edges, of the
 * leftmost and rightmost white keys shown whole under `h`. Without such keys (nothing detected) the
 * pins sit in the middle of the keyboard-wide frame.
 */
export function makePins(h: Mat3, bend: number, aspect: number): Pin[] {
  const inv = invert3(h)
  const whole = visibleKeys(h, bend, aspect)
  // Inset from the ends of a wide view, so the pins stay clear of the screen's edges.
  const inset = whole ? Math.min(Math.floor((whole.hi - whole.lo) * 0.08), Math.max(0, Math.floor((whole.hi - whole.lo - 3) / 2))) : 0
  const range = whole && { lo: whole.lo + inset, hi: whole.hi - inset }
  const planePts: Vec2[] = range
    ? [
        [range.lo, 0],
        [range.hi + 1, 0],
        [range.hi + 1, PLANE_KEY_LENGTH],
        [range.lo, PLANE_KEY_LENGTH],
      ]
    : [
        [PLANE_KEY_COUNT * 0.2, 0],
        [PLANE_KEY_COUNT * 0.8, 0],
        [PLANE_KEY_COUNT * 0.8, PLANE_KEY_LENGTH],
        [PLANE_KEY_COUNT * 0.2, PLANE_KEY_LENGTH],
      ]
  return planePts.map((plane) => ({ plane, src: (inv && applyH(inv, plane)) ?? ([0.5, 0.5] as Vec2) }))
}

/** The placement that carries each pin's picture point to `targets` (plane); null when degenerate. */
export function refit(pins: readonly Pin[], targets: readonly Vec2[]): Mat3 | null {
  const h = homography(pins.map((p) => p.src), targets)
  if (!h || !invert3(h)) return null
  return h
}

/** The keys with the one at video time `t` replaced (or added), sorted. A lone key moves to `t`. */
export function withKeyAt(keys: readonly HandVideoKey[], t: number, key: Omit<HandVideoKey, 't'>): HandVideoKey[] {
  const next: HandVideoKey = { t, ...key }
  const i = keyIndexAt(keys, t)
  if (i >= 0) return keys.map((k, j) => (j === i ? next : k))
  if (keys.length <= 1) return [next]
  return [...keys, next].sort((a, b) => a.t - b.t)
}

export type DisplayRange = { left: number; right: number; front: number }

/** The farthest the front edge of the display range can go below the keys' front edge (white-key widths). */
export const MAX_RANGE_FRONT = 12

/**
 * What the picture covers on the keyboard: its extent along the keys' front edge (clamped to the
 * keyboard, 0..52) and how far toward the player it reaches below it. The display range starts from
 * this, so the first drag begins at what is visible.
 */
export function pictureExtent(h: Mat3, bend: number, aspect: number): DisplayRange {
  const inv = invert3(h)
  const whole: DisplayRange = { left: 0, right: PLANE_KEY_COUNT, front: 3 }
  if (!inv) return whole
  const inside = (x: number, y: number) => {
    const c = toCorrected(inv, [x, y])
    return c !== null && inPicture(c, bend, aspect)
  }
  let left = Infinity
  let right = -Infinity
  for (let x = 0; x <= PLANE_KEY_COUNT; x += 0.25) {
    if (inside(x, 0)) {
      left = Math.min(left, x)
      right = Math.max(right, x)
    }
  }
  if (!(right > left)) return whole
  let front = 0
  for (let y = 0; y >= -MAX_RANGE_FRONT; y -= 0.25) {
    for (let x = left; x <= right; x += 0.5) {
      if (inside(x, y)) {
        front = -y
        break
      }
    }
  }
  return { left: Math.round(left), right: Math.round(right) > Math.round(left) ? Math.round(right) : right, front: Math.max(0.5, front) }
}

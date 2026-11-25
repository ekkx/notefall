// Camera follow: which part of the keyboard the picture shows over the song, worked out ahead from the notes. Pure (no
// React, no clock), so a seek, the live preview and the export all show the same frame at the same time.
import { KEYBOARD_LAYOUT, MIDI_MIN, WHITE_KEY_LENGTH, WHITE_KEY_WIDTH } from '../keyboard/layout'

/** What is shown: centre and half width along the keyboard, in white-key widths from A0's left edge (0..52). */
export type KeyFrame = { centre: number; half: number }

export type FollowOptions = {
  /** The closest the camera gets: white keys across the picture. */
  minKeys: number
  /** Room kept beside the outermost notes, in white keys. */
  margin: number
  /** Seconds the sideways movement is spread over, ahead of and behind each change; the zoom takes twice that. */
  smoothSec: number
}

/** `typical` = the song's median half width. */
export type FollowPath = { t0: number; centre: Float32Array; half: Float32Array; typical: number }

type TimedNote = { midi: number; on: number; off: number }

const KEYS = KEYBOARD_LAYOUT.whiteCount
const STEP = 0.05
/** How far past the keyboard's ends the picture may reach. */
const END_ROOM = 0.5
/** The centre is kept on the keyboard by a clamp; this rounds off its corners. */
const CLAMP_SMOOTH_SEC = 0.6
/** The keyboard never fills more of the picture's height than this. */
const MAX_KEYBOARD_SHARE = 0.4

/** Fewest white keys across a picture of this aspect before the keyboard would fill too much of its height. */
export function minKeysForAspect(aspect: number): number {
  return (WHITE_KEY_LENGTH / WHITE_KEY_WIDTH / MAX_KEYBOARD_SHARE) * aspect
}

/** Smallest (sign 1) / largest (sign -1) value within ±r samples. */
function windowMin(src: Float32Array, r: number, sign: 1 | -1): Float32Array {
  const n = src.length
  const out = new Float32Array(n)
  const queue = new Int32Array(n)
  let head = 0
  let tail = 0
  for (let i = 0, next = 0; i < n; i++) {
    for (; next < n && next <= i + r; next++) {
      while (tail > head && src[queue[tail - 1]] * sign >= src[next] * sign) tail--
      queue[tail++] = next
    }
    while (queue[head] < i - r) head++
    out[i] = src[queue[head]]
  }
  return out
}

/** Weighted mean over ±r samples (triweight: smooth to the second derivative, nothing outside the window). */
function smooth(src: Float32Array, r: number): Float32Array {
  const n = src.length
  if (r < 1) return src.slice()
  const kernel = new Float32Array(2 * r + 1)
  let sum = 0
  for (let j = -r; j <= r; j++) {
    const u = j / (r + 1)
    sum += kernel[j + r] = (1 - u * u) ** 3
  }
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let a = 0
    for (let j = -r; j <= r; j++) a += kernel[j + r] * src[Math.min(n - 1, Math.max(0, i + j))]
    out[i] = a / sum
  }
  return out
}

/** Samples with no note (NaN) go straight from the last value to the next one. */
function fillGaps(a: Float32Array): void {
  let last = -1
  for (let i = 0; i < a.length; i++) {
    if (Number.isNaN(a[i])) continue
    for (let j = last + 1; j < i; j++) a[j] = last < 0 ? a[i] : a[last] + ((a[i] - a[last]) * (j - last)) / (i - last)
    last = i
  }
  for (let j = last + 1; j < a.length; j++) a[j] = a[last]
}

/**
 * Widest extent over a window, then a weighted mean over the same window: every sample of that mean saw the extent at
 * its centre, so what is played is always inside the frame, and the window's length is how far ahead the camera moves
 * and how softly. Done twice: the sideways movement over `smoothSec`, the zoom over twice that, so the picture follows
 * the hands while its scale changes only from passage to passage.
 */
export function buildFollowPath(notes: readonly TimedNote[], o: FollowOptions): FollowPath | null {
  if (!notes.length) return null
  let first = Infinity
  let end = -Infinity
  for (const n of notes) {
    first = Math.min(first, n.on)
    end = Math.max(end, n.off)
  }
  const count = Math.ceil((end - first) / STEP) + 1
  const lo = new Float32Array(count).fill(NaN)
  const hi = new Float32Array(count).fill(NaN)
  for (const n of notes) {
    const k = KEYBOARD_LAYOUT.keys[n.midi - MIDI_MIN]
    if (!k) continue
    const x = (k.x + KEYBOARD_LAYOUT.totalWidth / 2) / WHITE_KEY_WIDTH
    const l = Math.max(0, x - k.width / WHITE_KEY_WIDTH / 2 - o.margin)
    const r = Math.min(KEYS, x + k.width / WHITE_KEY_WIDTH / 2 + o.margin)
    const i1 = Math.min(count - 1, Math.ceil((n.off - first) / STEP))
    for (let i = Math.floor((n.on - first) / STEP); i <= i1; i++) {
      if (!(lo[i] <= l)) lo[i] = l
      if (!(hi[i] >= r)) hi[i] = r
    }
  }
  fillGaps(lo)
  fillGaps(hi)

  const pan = Math.round(o.smoothSec / STEP)
  const left = smooth(windowMin(lo, pan, 1), pan)
  const right = smooth(windowMin(hi, pan, -1), pan)
  const logHalf = new Float32Array(count)
  for (let i = 0; i < count; i++) logHalf[i] = Math.log(Math.max(right[i] - left[i], o.minKeys) / 2)
  const zoomed = smooth(windowMin(logHalf, 2 * pan, -1), 2 * pan)

  const half = new Float32Array(count)
  const centre = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    const h = Math.min(Math.exp(zoomed[i]), KEYS / 2 + END_ROOM)
    half[i] = h
    centre[i] = Math.min(KEYS + END_ROOM - h, Math.max(h - END_ROOM, (left[i] + right[i]) / 2))
  }
  const typical = half.slice().sort()[count >> 1]
  return { t0: first, centre: smooth(centre, Math.round(CLAMP_SMOOTH_SEC / STEP)), half, typical }
}

function sample(a: Float32Array, x: number): number {
  const n = a.length
  const at = (i: number) => a[Math.min(n - 1, Math.max(0, i))]
  const c = Math.min(n - 1, Math.max(0, x))
  const i = Math.floor(c)
  const f = c - i
  const [p, q, r, s] = [at(i - 1), at(i), at(i + 1), at(i + 2)]
  return q + 0.5 * f * (r - p + f * (2 * p - 5 * q + 4 * r - s + f * (3 * (q - r) + s - p)))
}

export function followAt(path: FollowPath, t: number): KeyFrame {
  const x = (t - path.t0) / STEP
  return { centre: sample(path.centre, x), half: sample(path.half, x) }
}

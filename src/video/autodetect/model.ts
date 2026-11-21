// Keyboard model plane (kbd.py): x in white-key widths from the left edge of A0 (0..52), y from the front edge.
// The lengths come from the 3D keyboard (`keyboard/layout.ts`, a pure module) so the detector's plane and the
// scene's keys cannot drift apart. Black keys here carry the real-piano offsets (OFFS); the virtual ones sit on
// the white-key boundaries, which is the same thing for the key edges the video is placed by.
import { BLACK_KEY_LENGTH, WHITE_KEY_LENGTH, WHITE_KEY_WIDTH } from '../../keyboard/layout'

export const WL = WHITE_KEY_LENGTH / WHITE_KEY_WIDTH
export const BL = BLACK_KEY_LENGTH / WHITE_KEY_WIDTH
export const Y_TIP = WL - BL
export const Y_TAIL = WL
const OFFS: Record<number, number> = { 1: -0.09, 3: 0.09, 6: -0.14, 8: 0.0, 10: 0.14 }

function build() {
  const whites: number[] = []
  for (let m = 21; m < 109; m++) if (![1, 3, 6, 8, 10].includes(m % 12)) whites.push(m)
  const wi = new Map<number, number>(); whites.forEach((m, i) => wi.set(m, i))
  const blacks: Array<[number, number]> = []
  for (let m = 21; m < 109; m++) if ([1, 3, 6, 8, 10].includes(m % 12)) blacks.push([m, wi.get(m - 1)! + 1.0 + OFFS[m % 12]])
  return { whites, blacks }
}
const B = build()
export const WHITES = B.whites
export const BLACK_X = B.blacks.map((b) => b[1])
export const CORN: Array<[number, number]> = [[0, 0], [52, 0], [52, WL], [0, WL]] // FL FR BR BL

export const median = (a: ArrayLike<number>): number => {
  const s = Array.from(a).sort((x, y) => x - y), n = s.length
  return n === 0 ? NaN : n & 1 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2
}
/** numpy percentile, linear interpolation */
export const percentile = (a: ArrayLike<number>, q: number): number => {
  const s = Array.from(a).sort((x, y) => x - y), n = s.length
  if (!n) return NaN
  const pos = (q / 100) * (n - 1), lo = Math.floor(pos), hi = Math.min(n - 1, lo + 1)
  return s[lo] + (s[hi] - s[lo]) * (pos - lo)
}

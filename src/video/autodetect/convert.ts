// Detector model → notefall's keyboard fit. DOM-free.
//
// The detector works on a gray image of W×H px: u = (P − c) / s with c = the image centre and
// s = half the diagonal, then the lens `undistortN` (r + k·r³ = r_raw, r in units of s), then H → plane.
// notefall's lens (`video/geometry.ts` distort / undistort) is the same formula with the picture in
// 0..1 and r in units of half the diagonal in picture heights, so `k` carries over unchanged; only
// the normalisation of the point differs, which is a fixed matrix T: corrected picture → u.
import type { Model } from './fit'

/** Row-major 3×3 H (corrected picture 0..1 → plane) from a detector model on a W×H image. */
export function modelToPictureH(m: Model, w: number, h: number): number[] {
  const aspect = w / h
  const sc = 0.5 * Math.sqrt(aspect * aspect + 1)
  // corrected picture p → u:  ux = (px − ½)·aspect / sc,  uy = (py − ½) / sc
  const T = [aspect / sc, 0, -0.5 * aspect / sc, 0, 1 / sc, -0.5 / sc, 0, 0, 1]
  const H = m.H
  const out = new Array<number>(9).fill(0)
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) out[i * 3 + j] += H[i * 3 + k] * T[k * 3 + j]
  const z = out[8] || 1
  return out.map((v) => v / z)
}

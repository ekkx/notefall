import { KEYBOARD_Y, WHITE_KEY_LENGTH, WHITE_KEY_WIDTH } from '../keyboard/layout'
import type { HandVideoKey } from '../store'

/**
 * Geometry of the hand video.
 *
 * Spaces, from the file to the keyboard:
 * - **picture**: the frame as a <video> shows it (the file's rotation
 *   applied), 0..1, x right, y down. Aspect `A` = width / height.
 * - **corrected**: picture with the lens bend removed (`undistort`).
 * - **plane**: the keyboard's own plane in white-key widths: x 0..52 from
 *   A0's left edge, y from the keys' front edge toward the back
 *   (0..`PLANE_KEY_LENGTH`). World x / y follow by `worldToPlaneMatrix`.
 *
 * A key's `H` maps corrected → plane (a homography, so the video stays
 * locked to the keyboard whatever the camera did). The scene shader
 * (`FRAME_GLSL`) runs the chain backwards: world → plane → H⁻¹ → corrected
 * → bend → picture. The detector (`video/autodetect/`) produces `H` and the
 * bend in exactly this convention.
 */

export type Vec2 = [number, number]
/** Row-major 3×3. */
export type Mat3 = [number, number, number, number, number, number, number, number, number]

/** z of the video plane: just over the black-key tops so nothing of the hidden keyboard pokes through. */
export const HAND_VIDEO_PLANE_Z = 0.1

/** White keys across the 88-key keyboard, and a white key's length, in plane units. */
export const PLANE_KEY_COUNT = 52
export const PLANE_KEY_LENGTH = WHITE_KEY_LENGTH / WHITE_KEY_WIDTH

// ── Lens ──────────────────────────────────────────────────────────────
// Normalised so the frame corner sits at radius 1 whatever the aspect:
// the same slider value bends a portrait and a landscape clip alike.

function lensScale(aspect: number): number {
  return 0.5 * Math.sqrt(aspect * aspect + 1)
}

/** Corrected → raw (what the camera recorded). k < 0 models barrel footage. */
export function distort(p: Vec2, k: number, aspect: number): Vec2 {
  if (k === 0) return p
  const s = lensScale(aspect)
  const qx = ((p[0] - 0.5) * aspect) / s
  const qy = (p[1] - 0.5) / s
  const f = 1 + k * (qx * qx + qy * qy)
  return [0.5 + (qx * f * s) / aspect, 0.5 + qy * f * s]
}

/**
 * Raw → corrected (inverse of `distort`). Solves r + k·r³ = r_raw for the
 * radius by Newton's method. With k < 0 the map folds back beyond
 * r = 1/√(−3k); points past the fold have no inverse and are clamped to it.
 */
export function undistort(p: Vec2, k: number, aspect: number): Vec2 {
  if (k === 0) return p
  const s = lensScale(aspect)
  const dx = ((p[0] - 0.5) * aspect) / s
  const dy = (p[1] - 0.5) / s
  const rd = Math.hypot(dx, dy)
  if (rd < 1e-9) return p
  const rMax = k < 0 ? 1 / Math.sqrt(-3 * k) : Infinity
  let r = Math.min(rd, rMax)
  for (let i = 0; i < 30; i++) {
    const g = r + k * r * r * r - rd
    const dg = 1 + 3 * k * r * r
    if (Math.abs(dg) < 1e-9) break
    const next = Math.max(0, Math.min(rMax, r - g / dg))
    if (Math.abs(next - r) < 1e-12) break
    r = next
  }
  const f = r / rd
  return [0.5 + (dx * f * s) / aspect, 0.5 + dy * f * s]
}

// ── Homography ────────────────────────────────────────────────────────

/** H with H·src_i ∝ dst_i for four point pairs (direct linear transform). Null when degenerate. */
export function homography(src: readonly Vec2[], dst: readonly Vec2[]): Mat3 | null {
  // Unknowns h0..h7 (h8 = 1); two rows per pair.
  const a: number[][] = []
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i]
    const [u, v] = dst[i]
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u])
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y, v])
  }
  // Gaussian elimination with partial pivoting on the 8×9 augmented matrix.
  for (let c = 0; c < 8; c++) {
    let piv = c
    for (let r = c + 1; r < 8; r++) if (Math.abs(a[r][c]) > Math.abs(a[piv][c])) piv = r
    if (Math.abs(a[piv][c]) < 1e-12) return null
    ;[a[c], a[piv]] = [a[piv], a[c]]
    for (let r = 0; r < 8; r++) {
      if (r === c) continue
      const f = a[r][c] / a[c][c]
      if (f === 0) continue
      for (let k = c; k < 9; k++) a[r][k] -= f * a[c][k]
    }
  }
  const h = a.map((row, i) => row[8] / row[i])
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1]
}

export function invert3(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  if (Math.abs(det) < 1e-15) return null
  const r = 1 / det
  return [
    A * r, -(b * i - c * h) * r, (b * f - c * e) * r,
    B * r, (a * i - c * g) * r, -(a * f - c * d) * r,
    C * r, -(a * h - b * g) * r, (a * e - b * d) * r,
  ]
}

/** Apply H to a point; null when it lands behind the projection (w ≤ 0). */
export function applyH(m: Mat3, p: Vec2): Vec2 | null {
  const w = m[6] * p[0] + m[7] * p[1] + m[8]
  if (w <= 1e-9) return null
  return [(m[0] * p[0] + m[1] * p[1] + m[2]) / w, (m[3] * p[0] + m[4] * p[1] + m[5]) / w]
}


const mul3 = (a: readonly number[], b: readonly number[]): Mat3 => {
  const o = new Array<number>(9).fill(0)
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j]
  return o as Mat3
}

/** World (x, y) → plane (white-key widths). */
export function worldToPlaneMatrix(): Mat3 {
  return [1 / WHITE_KEY_WIDTH, 0, PLANE_KEY_COUNT / 2, 0, 1 / WHITE_KEY_WIDTH, -KEYBOARD_Y / WHITE_KEY_WIDTH, 0, 0, 1]
}

/** Plane corners the interpolation follows (the keyboard's own rectangle), in order. */
const PLANE_CORNERS: Vec2[] = [
  [0, 0],
  [PLANE_KEY_COUNT, 0],
  [PLANE_KEY_COUNT, PLANE_KEY_LENGTH],
  [0, PLANE_KEY_LENGTH],
]

/** A first placement: the picture as wide as the keyboard, centred on the keys. Corrected → plane. */
export function defaultH(aspect: number): Mat3 {
  const w = PLANE_KEY_COUNT
  const h = w / Math.max(0.1, aspect)
  return [w, 0, 0, 0, -h, PLANE_KEY_LENGTH / 2 + h / 2, 0, 0, 1]
}

function isMat(h: unknown): h is Mat3 {
  return Array.isArray(h) && h.length === 9 && h.every((v) => typeof v === 'number' && Number.isFinite(v))
}

/** Keys that carry a usable H (projects saved in an older format are skipped), by time. */
export function validKeys(keys: readonly HandVideoKey[]): HandVideoKey[] {
  return keys.filter((k) => Number.isFinite(k.t) && isMat(k.H) && invert3(k.H)).sort((a, b) => a.t - b.t)
}

/** Where the plane's corners lie in the corrected picture for one key's H; null when one is behind the camera. */
function cornersInPicture(h: Mat3): Vec2[] | null {
  const inv = invert3(h)
  if (!inv) return null
  const out: Vec2[] = []
  for (const c of PLANE_CORNERS) {
    const p = applyH(inv, c)
    if (!p) return null
    out.push(p)
  }
  return out
}

/**
 * plane → corrected picture at video time `t`, or null with no usable key (the caller
 * shows `defaultH`). Between two keys the plane's four corners move linearly through the
 * picture and the homography is refitted to them, rather than blending matrices (which
 * passes through degenerate ones); held outside the first / last key.
 */
export function planeToPictureAt(keys: readonly HandVideoKey[], t: number): Mat3 | null {
  const ks = validKeys(keys)
  if (ks.length === 0) return null
  const hold = (k: HandVideoKey) => invert3(k.H as Mat3)
  if (ks.length === 1 || t <= ks[0].t) return hold(ks[0])
  const last = ks[ks.length - 1]
  if (t >= last.t) return hold(last)
  let i = 0
  while (i < ks.length - 2 && ks[i + 1].t <= t) i++
  const a = ks[i]
  const b = ks[i + 1]
  const ca = cornersInPicture(a.H as Mat3)
  const cb = cornersInPicture(b.H as Mat3)
  if (!ca || !cb) return hold(t - a.t < b.t - t ? a : b)
  const f = (t - a.t) / Math.max(1e-6, b.t - a.t)
  const at = ca.map((p, j) => [p[0] + (cb[j][0] - p[0]) * f, p[1] + (cb[j][1] - p[1]) * f] as Vec2)
  return homography(PLANE_CORNERS, at) ?? hold(a)
}

/** world (x, y) → corrected picture for the shader: `planeToPictureAt` ∘ `worldToPlaneMatrix`; default placement with no key. */
export function worldToPictureAt(keys: readonly HandVideoKey[], t: number, aspect: number): Mat3 {
  const p2c = planeToPictureAt(keys, t) ?? (invert3(defaultH(aspect)) as Mat3)
  const m = mul3(p2c, worldToPlaneMatrix())
  // A homography is only defined up to sign: keep w > 0 over the keys so the shader can drop the mirrored half beyond the horizon.
  const w = m[7] * (KEYBOARD_Y + 0.7) + m[8]
  return w < 0 ? (m.map((v) => -v) as Mat3) : m
}

/** Two keys closer than this (s) are the same moment. */
export const KEY_EPS = 0.04

/** The key to edit at video time `t` (within `KEY_EPS`), or -1. */
export function keyIndexAt(keys: readonly HandVideoKey[], t: number): number {
  return keys.findIndex((k) => Math.abs(k.t - t) < KEY_EPS)
}

/**
 * GLSL: corrected picture uv → picture uv (the frame as a <video> shows it).
 * Needs the uniforms uBend, uAspect (picture) and uTurns (int: the file's own
 * clockwise quarter turns, export frames only — a <video> applies them
 * itself). False outside the recorded picture and past the lens fold (where
 * a barrel `uBend < 0` doubles back and has no inverse).
 */
export const FRAME_GLSL = /* glsl */ `
uniform float uBend;
uniform float uAspect;
uniform int uTurns;
bool correctedToDisplay(vec2 p, out vec2 uv) {
  float sc = 0.5 * sqrt(uAspect * uAspect + 1.0);
  vec2 n = vec2((p.x - 0.5) * uAspect, p.y - 0.5) / sc;
  float r2 = dot(n, n);
  if (uBend < 0.0 && r2 > -1.0 / (3.0 * uBend)) return false;
  n *= 1.0 + uBend * r2;
  uv = vec2(0.5 + n.x * sc / uAspect, 0.5 + n.y * sc);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return false;
  // picture → stored frame: undo the file's clockwise quarter turns
  for (int i = 0; i < 3; i++) {
    if (i >= uTurns) break;
    uv = vec2(uv.y, 1.0 - uv.x);
  }
  return true;
}
`

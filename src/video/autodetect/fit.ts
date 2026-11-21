// Homography RANSAC + robust LM fit of homography + radial bend, and the seam check. DOM-free.
import { BLACK_X, WL, Y_TIP, Y_TAIL, median } from './model'
import { Gray, blur8, newGray } from './imgops'

export type Pt = [number, number]
export interface Model { H: number[]; k: number; c: Pt; s: number } // H: 3x3 row-major, acts on normalised undistorted coords u=(P-c)/s

// ---- small dense helpers
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length, M = A.map((r, i) => [...r, b[i]])
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r
    if (Math.abs(M[p][c]) < 1e-14) return null
    ;[M[c], M[p]] = [M[p], M[c]]
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; if (f) for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j] }
  }
  const x = new Array(n).fill(0)
  for (let i = n - 1; i >= 0; i--) { let s = M[i][n]; for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j]; x[i] = s / M[i][i] }
  return x
}
const mul3 = (a: number[], b: number[]): number[] => {
  const o = new Array(9).fill(0)
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j]
  return o
}
export function inv3(m: number[]): number[] | null {
  const [a, b, c, d, e, f, g, h, i] = m
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g
  const det = a * A + b * B + c * C
  if (Math.abs(det) < 1e-300) return null
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det]
}
export const proj = (H: number[], x: number, y: number): Pt => {
  const w = H[6] * x + H[7] * y + H[8]
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w]
}

// ---- DLT with Hartley normalisation on index subset
function normT(p: Pt[], idx: number[]): number[] {
  let mx = 0, my = 0; for (const i of idx) { mx += p[i][0]; my += p[i][1] }
  mx /= idx.length; my /= idx.length
  let d = 0; for (const i of idx) d += Math.hypot(p[i][0] - mx, p[i][1] - my)
  d /= idx.length; const s = d > 1e-12 ? Math.SQRT2 / d : 1
  return [s, 0, -s * mx, 0, s, -s * my, 0, 0, 1]
}
function dlt(src: Pt[], dst: Pt[], idx: number[]): number[] | null {
  const Ts = normT(src, idx), Td = normT(dst, idx)
  const AtA: number[][] = Array.from({ length: 8 }, () => new Array(8).fill(0)), Atb = new Array(8).fill(0)
  const add = (r: number[], b: number) => { for (let i = 0; i < 8; i++) { Atb[i] += r[i] * b; for (let j = 0; j < 8; j++) AtA[i][j] += r[i] * r[j] } }
  for (const i of idx) {
    const [x, y] = proj(Ts, src[i][0], src[i][1]), [u, v] = proj(Td, dst[i][0], dst[i][1])
    add([x, y, 1, 0, 0, 0, -u * x, -u * y], u)
    add([0, 0, 0, x, y, 1, -v * x, -v * y], v)
  }
  const h = solve(AtA, Atb); if (!h) return null
  const Hn = [...h, 1], Tdi = inv3(Td); if (!Tdi) return null
  const H = mul3(mul3(Tdi, Hn), Ts)
  const s = H[8]; if (Math.abs(s) < 1e-300) return null
  return H.map((v) => v / s)
}
function mulberry(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }

/** cv2.findHomography(RANSAC, thr) equivalent: threshold on reprojection error in dst units. */
export function findHomographyRansac(src: Pt[], dst: Pt[], thr: number): number[] | null {
  const n = src.length; if (n < 4) return null
  const rnd = mulberry(12345)
  const err = (H: number[], i: number) => { const p = proj(H, src[i][0], src[i][1]); return Math.hypot(p[0] - dst[i][0], p[1] - dst[i][1]) }
  let bestH: number[] | null = null, bestIn = 0, bestSum = Infinity
  let maxIt = 1000
  for (let it = 0; it < maxIt; it++) {
    const s = new Set<number>(); while (s.size < 4) s.add((rnd() * n) | 0)
    const idx = [...s]
    // reject near-collinear triples (degenerate): quick area test on any triple
    let degenerate = false
    for (let a = 0; a < 4 && !degenerate; a++) for (let b = a + 1; b < 4 && !degenerate; b++) for (let c = b + 1; c < 4; c++) {
      const A = src[idx[a]], B = src[idx[b]], C = src[idx[c]]
      const area = Math.abs((B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]))
      if (area < 1e-3) { degenerate = true; break }
    }
    if (degenerate) continue
    const H = dlt(src, dst, idx); if (!H) continue
    let cnt = 0, sum = 0
    for (let i = 0; i < n; i++) { const e = err(H, i); if (e <= thr) { cnt++; sum += e } }
    if (cnt > bestIn || (cnt === bestIn && sum < bestSum)) {
      bestIn = cnt; bestH = H; bestSum = sum
      const w = cnt / n, p = Math.max(1e-9, 1 - Math.pow(w, 4))
      maxIt = Math.min(1000, Math.ceil(Math.log(1 - 0.995) / Math.log(p)))
    }
  }
  if (!bestH || bestIn < 4) return null
  for (let round = 0; round < 3; round++) {
    const inl: number[] = []; for (let i = 0; i < n; i++) if (err(bestH!, i) <= thr) inl.push(i)
    if (inl.length < 4) break
    const H = dlt(src, dst, inl); if (!H) break
    bestH = H
  }
  return bestH
}

// ---- lens model (notefall convention: raw = c + q(1 + k r^2), r in units of half-diagonal)
export function undistortN(ux: number, uy: number, k: number): Pt {
  const rr = Math.hypot(ux, uy); let rc = rr
  for (let i = 0; i < 6; i++) { const f = rc + k * rc ** 3 - rr, df = 1 + 3 * k * rc * rc; rc -= f / df }
  const sc = rr > 1e-9 ? rc / Math.max(rr, 1e-9) : 1
  return [ux * sc, uy * sc]
}
export function toPlane(m: Model, P: Pt): Pt {
  const u = undistortN((P[0] - m.c[0]) / m.s, (P[1] - m.c[1]) / m.s, m.k)
  return proj(m.H, u[0], u[1])
}
export function makeToImg(m: Model): (Q: Pt) => Pt {
  const Hi = inv3(m.H)!
  return (Q) => {
    const u = proj(Hi, Q[0], Q[1]); const r2 = u[0] * u[0] + u[1] * u[1]
    return [m.c[0] + u[0] * (1 + m.k * r2) * m.s, m.c[1] + u[1] * (1 + m.k * r2) * m.s]
  }
}

// ---- Levenberg-Marquardt with soft-L1 (IRLS weights), box bounds
function robustLM(res: (p: number[]) => number[], p0: number[], lb: number[], ub: number[], f: number, maxIter = 60): number[] {
  const m = p0.length
  const clamp = (p: number[]) => p.map((v, i) => Math.min(ub[i], Math.max(lb[i], v)))
  const rcost = (r: number[]) => { let c = 0; for (const v of r) c += f * f * 2 * (Math.sqrt(1 + (v / f) ** 2) - 1); return c }
  let p = clamp(p0), r = res(p), cost = rcost(r), lam = 1e-3
  for (let it = 0; it < maxIter; it++) {
    const n = r.length, J: number[][] = []
    for (let j = 0; j < m; j++) {
      const e = 1e-6 * Math.max(1, Math.abs(p[j]))
      const pp = p.slice(); pp[j] += e; const rp = res(pp)
      J.push(rp.map((v, i) => (v - r[i]) / e))
    }
    const A: number[][] = Array.from({ length: m }, () => new Array(m).fill(0)), g = new Array(m).fill(0)
    for (let i = 0; i < n; i++) {
      const w = 1 / Math.sqrt(1 + (r[i] / f) ** 2)
      for (let a = 0; a < m; a++) { const ja = J[a][i] * w; g[a] += ja * r[i]; for (let b = a; b < m; b++) A[a][b] += ja * J[b][i] }
    }
    for (let a = 0; a < m; a++) for (let b = 0; b < a; b++) A[a][b] = A[b][a]
    let accepted = false, step = 0
    for (let tr = 0; tr < 12; tr++) {
      const Ad = A.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lam) + 1e-12 : v)))
      const d = solve(Ad, g.map((v) => -v)); if (!d) { lam *= 10; continue }
      const pn = clamp(p.map((v, i) => v + d[i])), rn = res(pn), cn = rcost(rn)
      if (cn < cost) { step = Math.max(...d.map((_v, i) => Math.abs(pn[i] - p[i]))); const dc = cost - cn; p = pn; r = rn; cost = cn; lam = Math.max(lam / 3, 1e-9); accepted = true; if (dc < 1e-12 * (1 + cost)) step = 0; break }
      lam *= 4
    }
    if (!accepted || step < 1e-9) break
  }
  return p
}

/** Fit homography + radial bend (fit_model in kbd.py). tips/tails/fe in ORIGINAL image px. */
export interface SeamPoint { P: Pt; x: number; wt: number }
/** `init` (a previous fit) skips the RANSAC start; `seams` add white-key seam constraints: image point P (px) must land on plane x. */
export function fitModel(tips: Pt[], tails: Pt[], labels: number[], fe: Pt[], w: number, h: number, init?: Model, seams?: SeamPoint[], kLimit = 0.2): Model | null {
  const c: Pt = [w / 2, h / 2], s = 0.5 * Math.hypot(w, h)
  const Xs = labels.map((l) => BLACK_X[l])
  const src: Pt[] = [...tips, ...tails]
  const dst: Pt[] = [...Xs.map((x): Pt => [x, Y_TIP]), ...Xs.map((x): Pt => [x, Y_TAIL])]
  let hn: number[]
  if (init) hn = init.H.slice(0, 8)
  else {
    const H0 = findHomographyRansac(src, dst, 0.15); if (!H0) return null
    const Hn0 = mul3(H0, [s, 0, c[0], 0, s, c[1], 0, 0, 1]); const z = Hn0[8]
    hn = Hn0.map((v) => v / z).slice(0, 8)
  }
  const sm = seams ?? []
  const su = sm.map((q): Pt => [(q.P[0] - c[0]) / s, (q.P[1] - c[1]) / s])
  const tu = tips.map((P): Pt => [(P[0] - c[0]) / s, (P[1] - c[1]) / s]), au = tails.map((P): Pt => [(P[0] - c[0]) / s, (P[1] - c[1]) / s]), fu = fe.map((P): Pt => [(P[0] - c[0]) / s, (P[1] - c[1]) / s])
  const nB = Xs.length
  const res = (p: number[]): number[] => {
    const H = [...p.slice(0, 8), 1], k = p[8], out = new Array(3 * nB + fu.length + 1 + sm.length)
    for (let i = 0; i < nB; i++) {
      const a = undistortN(tu[i][0], tu[i][1], k), b = undistortN(au[i][0], au[i][1], k)
      const pt = proj(H, a[0], a[1]), pl = proj(H, b[0], b[1])
      out[i] = pt[0] - Xs[i]; out[nB + i] = pl[0] - Xs[i]; out[2 * nB + i] = pl[1] - Y_TAIL
    }
    for (let i = 0; i < fu.length; i++) { const a = undistortN(fu[i][0], fu[i][1], k); out[3 * nB + i] = 0.5 * proj(H, a[0], a[1])[1] }
    out[3 * nB + fu.length] = 0.02 * k
    for (let i = 0; i < sm.length; i++) { const a = undistortN(su[i][0], su[i][1], k); out[3 * nB + fu.length + 1 + i] = sm[i].wt * (proj(H, a[0], a[1])[0] - sm[i].x) }
    return out
  }
  const p0 = [...hn, init ? init.k : 0]
  const lb = [...new Array(8).fill(-Infinity), -kLimit], ub = [...new Array(8).fill(Infinity), kLimit]
  const sol = robustLM(res, p0, lb, ub, 0.1)
  return { H: [...sol.slice(0, 8), 1], k: sol[8], c, s }
}

/** warp image to the model plane (24 px / white key) and measure white-key seam errors (seam_errors2). */
export function seamErrors(g: Gray, mdl: Model, ytip: number, ppu = 24, za = 0.15, zb = 0.85): { k: number; err: number; depth: number }[] {
  const x0 = -1.0, x1 = 53.0, y1 = WL + 0.5
  const W = Math.trunc((x1 - x0) * ppu), Hh = Math.trunc((y1 + 0.5) * ppu)
  const toImg = makeToImg(mdl), rect = newGray(W, Hh)
  const gw = g.w, gh = g.h, gd = g.d
  // only the front-zone rows (+ blur margin) are needed
  const ya = za * ytip, yb = zb * ytip
  const r0 = Math.trunc((y1 - yb) * ppu), r1 = Math.trunc((y1 - ya) * ppu)
  if (!(r0 >= 0 && r1 <= Hh && r1 - r0 >= 2)) return []
  const m0 = Math.max(0, r0 - 6), m1 = Math.min(Hh, r1 + 6)
  for (let v = m0; v < m1; v++) for (let u = 0; u < W; u++) {
    const P = toImg([x0 + u / ppu, y1 - v / ppu])
    const sx = P[0], sy = P[1], xf = Math.floor(sx), yf = Math.floor(sy), fx = sx - xf, fy = sy - yf
    const px = (xx: number, yy: number) => (xx < 0 || yy < 0 || xx >= gw || yy >= gh ? 0 : gd[yy * gw + xx])
    if (!(sx > -1 && sy > -1 && sx < gw && sy < gh)) continue
    const a = px(xf, yf), b = px(xf + 1, yf), c = px(xf, yf + 1), d = px(xf + 1, yf + 1)
    rect.d[v * W + u] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy + 0.5
  }
  const sub = newGray(W, m1 - m0); sub.d.set(rect.d.subarray(m0 * W, m1 * W))
  const bl = blur8(sub, 0.8)
  const nr = r1 - r0, prof = new Float64Array(W), valid = new Uint8Array(W), col = new Array(nr)
  for (let x = 0; x < W; x++) {
    let nz = 0
    for (let i = 0; i < nr; i++) { col[i] = bl.d[(r0 - m0 + i) * W + x]; if (rect.d[(r0 + i) * W + x] > 0) nz++ }
    prof[x] = median(col); valid[x] = nz / nr > 0.9 ? 1 : 0
  }
  const out: { k: number; err: number; depth: number }[] = []
  for (let k = 1; k < 52; k++) {
    const cc = (k + 1.0) * ppu, a = Math.trunc(cc - 0.42 * ppu), b = Math.trunc(cc + 0.42 * ppu)
    if (a < 2 || b >= W - 2) continue
    let ok = true; for (let x = a; x < b; x++) if (!valid[x]) { ok = false; break }
    if (!ok) continue
    let i = 0; for (let x = 1; x < b - a; x++) if (prof[a + x] < prof[a + i]) i = x
    const len = b - a
    if (!(i > 0 && i < len - 1)) continue
    const y0_ = prof[a + i - 1], y1_ = prof[a + i], y2_ = prof[a + i + 1], den = y0_ - 2 * y1_ + y2_
    const subp = den > 1e-6 ? 0.5 * (y0_ - y2_) / den : 0
    const ends = [prof[a], prof[a + 1], prof[a + 2], prof[b - 3], prof[b - 2], prof[b - 1]]
    out.push({ k, err: (a + i + subp) / ppu - 1.0 - k, depth: median(ends) - y1_ })
  }
  return out
}

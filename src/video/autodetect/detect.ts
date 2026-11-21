// Port of proto/kbd.py + proto/detect.py: key-axis -> black-key tracks -> DP labelling -> homography + bend fit.
import { BLACK_X, median, percentile } from './model'
import { Gray, blur8, edgeOrientation, rotateKeep, morphH, otsuHist, newGray } from './imgops'
import { Model, Pt, fitModel, inv3, proj } from './fit'

export const WGRID = [11, 13, 15, 17.5, 20, 23, 26.5, 30, 34, 39, 45, 52, 60, 70]

export interface Geo { tip: Pt; tail: Pt; w: number; xm: number; tip_o?: Pt; tail_o?: Pt }

// ---------- polyfit helpers
function polyfit(x: number[], y: number[], deg: number): number[] {
  const m = deg + 1, A = Array.from({ length: m }, () => new Array(m).fill(0)), b = new Array(m).fill(0)
  for (let i = 0; i < x.length; i++) {
    const pw = [1]; for (let j = 1; j < 2 * m; j++) pw.push(pw[j - 1] * x[i])
    for (let a = 0; a < m; a++) { b[a] += pw[a] * y[i]; for (let c = 0; c < m; c++) A[a][c] += pw[a + c] }
  }
  // gaussian elimination (small, standardised x)
  for (let c = 0; c < m; c++) {
    let p = c; for (let r = c + 1; r < m; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r
    ;[A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]]
    for (let r = c + 1; r < m; r++) { const f = A[r][c] / (A[c][c] || 1e-300); for (let j = c; j < m; j++) A[r][j] -= f * A[c][j]; b[r] -= f * b[c] }
  }
  const co = new Array(m).fill(0)
  for (let i = m - 1; i >= 0; i--) { let s = b[i]; for (let j = i + 1; j < m; j++) s -= A[i][j] * co[j]; co[i] = s / (A[i][i] || 1e-300) }
  return co // ascending powers
}
const pv = (co: number[], x: number) => { let s = 0; for (let i = co.length - 1; i >= 0; i--) s = s * x + co[i]; return s }

// ---------- black_blobs mask (comps=False) from the 0.8-blurred rotated image
// Opening / closing of a binary mask by a flat 1-D rect are done on runs (exactly equal to
// erode+dilate with OpenCV's border semantics): a run of length < k disappears, except next to the image border.

/** horizontal opening of a 0/1 mask by a (k x 1) rect */
function openRowsBinary(src: Uint8Array, W: number, H: number, k: number, out: Uint8Array): void {
  const r = k >> 1
  out.fill(0, 0, W * H)
  for (let y = 0; y < H; y++) {
    const o = y * W
    let x = 0
    while (x < W) {
      if (!src[o + x]) { x++; continue }
      let e = x; while (e < W && src[o + e]) e++
      const sa = x === 0 ? 0 : x + r, sb = e === W ? W - 1 : e - 1 - r
      if (sa <= sb) { const lo = Math.max(0, sa - r), hi = Math.min(W - 1, sb + r); out.fill(1, o + lo, o + hi + 1) }
      x = e
    }
  }
}
/** vertical closing of a 0/1 mask by a (1 x k) rect: zero-runs shorter than the window are filled (unless at the border) */
function closeColsBinary(m: Uint8Array, W: number, H: number, k: number): void {
  const r = k >> 1
  const start = new Int32Array(W).fill(-1)
  const fill = (x: number, a: number, b: number) => { for (let y = a; y < b; y++) m[y * W + x] = 1 }
  const decide = (x: number, a: number, b: number) => { // zero-run [a,b)
    const sa = a === 0 ? 0 : a + r, sb = b === H ? H - 1 : b - 1 - r
    if (!(sa <= sb)) fill(x, a, b)
  }
  for (let y = 0; y < H; y++) {
    const o = y * W
    for (let x = 0; x < W; x++) {
      if (m[o + x] === 0) { if (start[x] < 0) start[x] = y }
      else if (start[x] >= 0) { decide(x, start[x], y); start[x] = -1 }
    }
  }
  for (let x = 0; x < W; x++) if (start[x] >= 0) decide(x, start[x], H)
}

export function blackMask(gb: Gray, w: number): Uint8Array {
  const { w: W, h: H } = gb, n = W * H
  const kw = Math.round(w * 1.1) | 1
  const t1 = new Uint8Array(n), t2 = new Uint8Array(n)
  morphH(gb.d, W, H, kw, true, t1); morphH(t1, W, H, kw, false, t2) // closing
  const hist = new Uint32Array(256)
  for (let i = 0; i < n; i++) { const v = t2[i] - gb.d[i]; t2[i] = v; hist[v]++ } // black-hat
  const t = otsuHist(hist, n), thr = Math.max(t * 0.8, 25)
  for (let i = 0; i < n; i++) t2[i] = t2[i] > thr ? 1 : 0
  openRowsBinary(t2, W, H, Math.max(3, Math.trunc(w * 0.28)) | 1, t1)
  closeColsBinary(t1, W, H, Math.max(3, Math.trunc(w * 0.8)) | 1)
  return t1
}

// ---------- trace_keys
export function traceKeys(m: Uint8Array, W: number, H: number, w: number): Geo[] {
  type Tr = { last: number; ys: number[]; xs: number[]; ws: number[]; gap: number }
  const tracks: Tr[] = []; let active: Tr[] = []
  let y0 = -1, y1 = -1
  const hasRow = new Uint8Array(H)
  for (let y = 0; y < H; y++) { const o = y * W; for (let x = 0; x < W; x++) if (m[o + x]) { hasRow[y] = 1; break } }
  for (let y = 0; y < H; y++) if (hasRow[y]) { if (y0 < 0) y0 = y; y1 = y }
  if (y0 < 0) return []
  for (let y = y0; y <= y1; y++) {
    const runs: Array<[number, number]> = []
    const o = y * W
    let x = 0
    while (x < W) {
      if (m[o + x]) { let e = x; while (e < W && m[o + e]) e++; const rw = e - x; if (rw >= 0.22 * w && rw <= 1.15 * w) runs.push([(x + e - 1) / 2, rw]); x = e } else x++
    }
    const used = new Set<number>()
    for (const tr of active) {
      let best = -1
      for (let i = 0; i < runs.length; i++) {
        if (used.has(i)) continue
        const pred = tr.last
        if (Math.abs(runs[i][0] - pred) < 0.35 * w && (best < 0 || Math.abs(runs[i][0] - pred) < Math.abs(runs[best][0] - pred))) best = i
      }
      if (best >= 0) { used.add(best); const [cx, rw] = runs[best]; tr.ys.push(y); tr.xs.push(cx); tr.ws.push(rw); tr.last = cx; tr.gap = 0 } else tr.gap++
    }
    for (let i = 0; i < runs.length; i++) if (!used.has(i)) { const t: Tr = { last: runs[i][0], ys: [y], xs: [runs[i][0]], ws: [runs[i][1]], gap: 0 }; tracks.push(t); active.push(t) }
    active = active.filter((t) => t.gap <= 3)
  }
  const geo: Geo[] = []
  for (const t of tracks) {
    const ymin = t.ys[0], ymax = t.ys[t.ys.length - 1]
    if (ymax - ymin < 1.8 * w || t.ys.length < 0.7 * (ymax - ymin)) continue
    // linear fit x = a + s*y (centre y for conditioning)
    const ym = (ymin + ymax) / 2, co = polyfit(t.ys.map((v) => v - ym), t.xs, 1)
    const a = co[0] - co[1] * ym, s = co[1]
    geo.push({ tip: [a + s * ymin, ymin], tail: [a + s * ymax, ymax], w: median(t.ws), xm: a + s * (ymin + ymax) / 2 })
  }
  return geo
}

export function filterGeo2(geo: Geo[]): Geo[] {
  if (geo.length < 5) return geo
  const xr = geo.map((g) => g.xm), mean = xr.reduce((a, b) => a + b, 0) / xr.length
  const sd = Math.sqrt(xr.reduce((a, b) => a + (b - mean) ** 2, 0) / xr.length)
  const xs = xr.map((v) => (v - mean) / (sd + 1e-9))
  const keep = new Array(geo.length).fill(true)
  const cnt = () => keep.filter(Boolean).length
  const Lmed = median(geo.map((g) => Math.abs(g.tail[1] - g.tip[1])))
  for (let it = 0; it < 3; it++) {
    if (cnt() < 4) return []
    for (const which of ['tip', 'tail'] as const) {
      const ys = geo.map((g) => g[which][1]), deg = cnt() > 8 ? 2 : 1
      const kx = xs.filter((_, i) => keep[i]), ky = ys.filter((_, i) => keep[i])
      const co = polyfit(kx, ky, deg)
      const res = ys.map((y, i) => y - pv(co, xs[i]))
      const thr = Math.max(0.12 * Lmed + 3, 1.5 * median(res.filter((_, i) => keep[i]).map(Math.abs)))
      for (let i = 0; i < geo.length; i++) keep[i] = keep[i] && Math.abs(res[i]) < thr
    }
  }
  return geo.filter((_, i) => keep[i])
}

// ---------- label_blobs (DP against the 36-black-key layout)
export function labelBlobs(geo: Geo[]): { labels: number[]; cost: number; amb: number } {
  const xm = geo.map((g) => g.xm), n = xm.length
  if (n < 5) return { labels: new Array(n).fill(-1), cost: 9, amb: 0 }
  const d: number[] = []; for (let i = 1; i < n; i++) d.push(xm[i] - xm[i - 1])
  const q = d.map((v, j) => v / percentile(d.slice(Math.max(0, j - 5), j + 6), 25))
  const R = BLACK_X.length, small = 1.17, INF = 1e9
  const cost = Array.from({ length: n }, (_, j) => new Float64Array(R).fill(j === 0 ? 0 : INF))
  const back = Array.from({ length: n }, () => new Int32Array(R).fill(-1))
  for (let j = 1; j < n; j++) for (let r = 0; r < R; r++) for (let k = 0; k < 3; k++) {
    const rp = r - 1 - k; if (rp < 0) continue
    const span = (BLACK_X[r] - BLACK_X[rp]) / small
    const c = cost[j - 1][rp] + Math.abs(q[j - 1] - span) + 0.6 * k
    if (c < cost[j][r]) { cost[j][r] = c; back[j][r] = rp }
  }
  let r = 0; for (let i = 1; i < R; i++) if (cost[n - 1][i] < cost[n - 1][r]) r = i
  const am = r, tot = cost[n - 1][r], labels = new Array(n).fill(-1)
  for (let j = n - 1; j >= 0; j--) { labels[j] = r; r = j > 0 ? back[j][r] : r }
  const alt: number[] = []
  for (let rr = 0; rr < R; rr++) if (rr !== am && (((rr - am) % 5) + 5) % 5 === 0 && cost[n - 1][rr] < INF / 2) alt.push(cost[n - 1][rr])
  return { labels, cost: tot / n, amb: alt.length ? (Math.min(...alt) - tot) / n : 9.0 }
}

// ---------- orientation / front edge helpers
function beyondBrightness(r: Gray, geo: Geo[]): [number, number] {
  const ty = median(geo.map((g) => g.tip[1])), by = median(geo.map((g) => g.tail[1]))
  const top = Math.min(ty, by), bot = Math.max(ty, by), L = bot - top
  const xs = geo.map((g) => g.xm).sort((a, b) => a - b), mids: number[] = []
  for (let i = 0; i < xs.length - 1; i++) mids.push((xs[i] + xs[i + 1]) / 2)
  const band = (y0: number, sgn: number) => {
    let s = 0, n = 0
    for (const x of mids) {
      const xi = Math.trunc(x); if (xi < 0 || xi >= r.w) continue
      for (let dy = Math.trunc(0.1 * L); dy < Math.trunc(0.4 * L); dy++) { const yy = Math.trunc(y0 + sgn * dy); if (yy >= 0 && yy < r.h) { s += r.d[yy * r.w + xi]; n++ } }
    }
    return n ? s / n : 0
  }
  return [band(top, -1), band(bot, +1)]
}

/** geo: tip = front end (larger y), tail = back end. front edge lies below tip. */
function frontEdgePointsDown(r: Gray, geo: Geo[], nseg = 16): Pt[] {
  const ty = median(geo.map((g) => g.tip[1])), by = median(geo.map((g) => g.tail[1])), L = ty - by
  const xs = geo.map((g) => g.xm), x0 = Math.min(...xs), x1 = Math.max(...xs)
  const lo = Math.trunc(ty + 0.12 * L), hi = Math.trunc(Math.min(r.h - 2, ty + 0.9 * L))
  if (hi - lo < 6) return []
  // blur only a crop that holds every row/column we read (+margin) -> identical values
  const cy0 = Math.max(0, lo - 8), cy1 = Math.min(r.h, hi + 8), cx0 = Math.max(0, Math.floor(x0) - 8), cx1 = Math.min(r.w, Math.ceil(x1) + 8)
  const crop = newGray(cx1 - cx0, cy1 - cy0)
  for (let y = cy0; y < cy1; y++) crop.d.set(r.d.subarray(y * r.w + cx0, y * r.w + cx1), (y - cy0) * crop.w)
  const gs = blur8(crop, 1.5)
  const pts: Pt[] = []
  for (let i = 0; i < nseg; i++) {
    const a = x0 + (x1 - x0) * i / nseg, b = x0 + (x1 - x0) * (i + 1) / nseg
    const ia = Math.trunc(a), ib = Math.trunc(b); if (ib <= ia) continue
    const prof = (y: number) => { let s = 0; for (let x = ia; x < ib; x++) s += gs.d[(y - cy0) * gs.w + (x - cx0)]; return s / (ib - ia) }
    let bestK = -1, bestD = Infinity
    for (let y = lo; y < hi; y++) { const d = (prof(y + 1) - prof(y - 1)) / 2; if (d < bestD) { bestD = d; bestK = y } }
    if (bestD > -4) continue
    pts.push([(a + b) / 2, bestK])
  }
  return pts
}

export interface Detection {
  mdl: Model; M: number[]; tips_o: Pt[]; tails_o: Pt[]; fe_o: Pt[]; w: number; h: number
  geo: Geo[]; labels: number[]; cost: number; amb: number; flip: boolean; hyp: number; scale: number; nFe: number
  ms: number
}

type Best = { score: number; geo: Geo[]; lab: number[]; cost: number; amb: number; w: number }
function sweepScales(gb: Gray, scales: number[]): Best | null {
  let best: Best | null = null
  for (const w of scales) {
    const m = blackMask(gb, w)
    const geo = filterGeo2(traceKeys(m, gb.w, gb.h, w))
    if (geo.length < 6) continue
    geo.sort((a, b) => a.xm - b.xm)
    const { labels, cost, amb } = labelBlobs(geo)
    const score = geo.length - 60 * cost - 40 * Math.max(0, 0.02 - amb * 0)
    if (!best || score > best.score) best = { score, geo, lab: labels, cost, amb, w }
  }
  return best
}
function analyseRot(g: Gray, hyp: number, flip: boolean, scales: number[]) {
  const { img: r, M } = rotateKeep(g, hyp, flip)
  const best = sweepScales(blur8(r, 0.8), scales)
  return { r, M, best }
}

/** common tail of detect(): swap tip/tail, front edge, back-project, fit. */
function finish(g: Gray, r: Gray, M: number[], best: Best, flip: boolean, hyp: number, t0: number): Detection | null {
  const geo = best.geo
  for (const q of geo) { const t = q.tip; q.tip = q.tail; q.tail = t }
  const fePts = frontEdgePointsDown(r, geo)
  const Mi = inv3(M)!
  const back = (P: Pt): Pt => proj(Mi, P[0], P[1])
  const tips_o = geo.map((q) => back(q.tip)), tails_o = geo.map((q) => back(q.tail)), fe_o = fePts.map(back)
  const mdl = fitModel(tips_o, tails_o, best.lab, fe_o, g.w, g.h)
  if (!mdl) return null
  geo.forEach((q, i) => { q.tip_o = tips_o[i]; q.tail_o = tails_o[i] })
  return { mdl, M, tips_o, tails_o, fe_o, w: g.w, h: g.h, geo, labels: best.lab, cost: best.cost, amb: best.amb, flip, hyp, scale: best.w, nFe: fePts.length, ms: performance.now() - t0 }
}

/** Full detection (edge orientation, both rotations, full scale sweep, flip test). */
export function detect(g: Gray): Detection | null {
  const t0 = performance.now()
  const hist = edgeOrientation(g)
  let p = 0; for (let i = 1; i < 180; i++) if (hist[i] > hist[p]) p = i
  const cands: Array<{ score: number; hyp: number; r: Gray; M: number[]; best: Best }> = []
  for (const hyp of [p, (p + 90) % 180]) {
    const a = analyseRot(g, hyp, false, WGRID)
    if (a.best) cands.push({ score: a.best.score, hyp, r: a.r, M: a.M, best: a.best })
  }
  if (!cands.length) return null
  cands.sort((a, b) => b.score - a.score) // stable
  let { hyp, r, M, best } = cands[0]
  let flip = false
  const [topB, botB] = beyondBrightness(r, best.geo)
  if (topB > botB + 5) {
    const a = analyseRot(g, hyp, true, WGRID)
    if (!a.best) return null
    r = a.r; M = a.M; best = a.best; flip = true
  }
  return finish(g, r, M, best, flip, hyp, t0)
}

/** Tracking detection: orientation, flip and scale are known from a previous lock -> one scale, one rotation. */
export function detectTracked(g: Gray, hyp: number, flip: boolean, scale: number): Detection | null {
  const t0 = performance.now()
  const i = WGRID.indexOf(scale)
  const scales = i < 0 ? [scale] : WGRID.slice(Math.max(0, i - 1), i + 2) // the locked scale and its grid neighbours
  const a = analyseRot(g, hyp, flip, scales)
  if (!a.best) return null
  return finish(g, a.r, a.M, a.best, flip, hyp, t0)
}

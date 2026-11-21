// Hand-written image ops on typed arrays (no DOM). Gray = 8-bit single channel.
export interface Gray { w: number; h: number; d: Uint8Array }

export const newGray = (w: number, h: number): Gray => ({ w, h, d: new Uint8Array(w * h) })

function reflect101(i: number, n: number): number {
  if (n === 1) return 0
  while (i < 0 || i >= n) { if (i < 0) i = -i; if (i >= n) i = 2 * n - 2 - i }
  return i
}

function gaussKernel(sigma: number, is8u: boolean): Float32Array {
  const ks = (Math.round(sigma * (is8u ? 3 : 4) * 2 + 1)) | 1
  const r = ks >> 1, k = new Float32Array(ks)
  let s = 0
  for (let i = 0; i < ks; i++) { const x = i - r; k[i] = Math.exp(-(x * x) / (2 * sigma * sigma)); s += k[i] }
  for (let i = 0; i < ks; i++) k[i] /= s
  return k
}

/** cv2.GaussianBlur(u8, (0,0), sigma) equivalent (reflect-101 border, rounded back to u8). */
export function blur8(src: Gray, sigma: number): Gray {
  const { w, h } = src, k = gaussKernel(sigma, true), r = k.length >> 1
  const tmp = new Float32Array(w * h), out = newGray(w, h)
  const row = new Float32Array(w + 2 * r)
  for (let y = 0; y < h; y++) {
    const o = y * w
    for (let x = 0; x < w; x++) row[x + r] = src.d[o + x]
    for (let i = 1; i <= r; i++) { row[r - i] = src.d[o + reflect101(-i, w)]; row[r + w - 1 + i] = src.d[o + reflect101(w - 1 + i, w)] }
    for (let x = 0; x < w; x++) { let s = 0; for (let j = 0; j < k.length; j++) s += k[j] * row[x + j]; tmp[o + x] = s }
  }
  for (let y = 0; y < h; y++) {
    const ys: number[] = []
    for (let j = 0; j < k.length; j++) ys.push(reflect101(y - r + j, h) * w)
    const o = y * w
    for (let x = 0; x < w; x++) { let s = 0; for (let j = 0; j < k.length; j++) s += k[j] * tmp[ys[j] + x]; out.d[o + x] = s + 0.5 }
  }
  return out
}

/** Sobel 3x3 on u8 -> gx, gy as Float32 (reflect-101). */
export function sobel(src: Gray): { gx: Float32Array; gy: Float32Array } {
  const { w, h, d } = src
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const ym = reflect101(y - 1, h) * w, y0 = y * w, yp = reflect101(y + 1, h) * w
    for (let x = 0; x < w; x++) {
      const xm = reflect101(x - 1, w), xp = reflect101(x + 1, w)
      const a = d[ym + xm], b = d[ym + x], c = d[ym + xp]
      const dd = d[y0 + xm], f = d[y0 + xp]
      const g = d[yp + xm], hh = d[yp + x], i = d[yp + xp]
      gx[y0 + x] = (c - a) + 2 * (f - dd) + (i - g)
      gy[y0 + x] = (g - a) + 2 * (hh - b) + (i - c)
    }
  }
  return { gx, gy }
}

/** Dominant edge-direction histogram (180 bins), as edge_orientation() in kbd.py. 90th percentile via fine histogram. */
export function edgeOrientation(g: Gray): Float64Array {
  const b = blur8(g, 1.2)
  const { gx, gy } = sobel(b), n = g.w * g.h
  const mag = new Float32Array(n)
  const NB = 16384, MAXM = 1500, hist = new Uint32Array(NB)
  for (let i = 0; i < n; i++) { const m = Math.hypot(gx[i], gy[i]); mag[i] = m; hist[Math.min(NB - 1, (m / MAXM * NB) | 0)]++ }
  const target = 0.9 * (n - 1) // numpy linear percentile rank
  let acc = 0, bin = 0
  for (; bin < NB; bin++) { acc += hist[bin]; if (acc > target) break }
  const thr = (bin + 0.5) / NB * MAXM
  const h = new Float64Array(180)
  for (let i = 0; i < n; i++) {
    const m = mag[i]; if (m <= thr) continue
    let a = (Math.atan2(gy[i], gx[i]) * 180 / Math.PI + 90) % 180
    if (a < 0) a += 180
    h[Math.min(179, a | 0)] += m
  }
  const sm = new Float64Array(180)
  for (let i = 0; i < 180; i++) { let s = 0; for (let j = -2; j <= 2; j++) s += h[(i + j + 180) % 180]; sm[i] = s / 5 }
  return sm
}

export type Aff = [number, number, number, number, number, number] // [a b tx; c d ty]

/** rotate so edge direction angDeg becomes vertical. returns image + 3x3 (row-major, 9) orig->rotated. */
export function rotateKeep(g: Gray, angDeg: number, flip180: boolean): { img: Gray; M: number[] } {
  const { w, h } = g
  let rot = 90 - angDeg
  if (flip180) rot += 180
  const th = -rot * Math.PI / 180, al = Math.cos(th), be = Math.sin(th)
  const cx = w / 2, cy = h / 2
  let m0 = al, m1 = be, m2 = (1 - al) * cx - be * cy
  let m3 = -be, m4 = al, m5 = be * cx + (1 - al) * cy
  const cs = Math.abs(m0), sn = Math.abs(m1)
  const nw = Math.trunc(h * sn + w * cs), nh = Math.trunc(h * cs + w * sn)
  m2 += nw / 2 - cx; m5 += nh / 2 - cy
  const det = m0 * m4 - m1 * m3
  const i0 = m4 / det, i1 = -m1 / det, i3 = -m3 / det, i4 = m0 / det
  const i2 = -(i0 * m2 + i1 * m5), i5 = -(i3 * m2 + i4 * m5)
  const out = newGray(nw, nh), d = g.d
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      let sx = i0 * x + i1 * y + i2, sy = i3 * x + i4 * y + i5
      if (sx < 0) sx = 0; else if (sx > w - 1) sx = w - 1
      if (sy < 0) sy = 0; else if (sy > h - 1) sy = h - 1
      const x0 = sx | 0, y0 = sy | 0, x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0
      const fx = sx - x0, fy = sy - y0
      const a = d[y0 * w + x0], b = d[y0 * w + x1], c = d[y1 * w + x0], e = d[y1 * w + x1]
      out.d[y * nw + x] = (a + (b - a) * fx) * (1 - fy) + (c + (e - c) * fx) * fy + 0.5
    }
  }
  return { img: out, M: [m0, m1, m2, m3, m4, m5, 0, 0, 1] }
}

// ---------- 1-D flat-rect min/max (van Herk / Gil-Werman), neutral (non-binding) borders ----------
let scr: Uint8Array[] = [new Uint8Array(0), new Uint8Array(0), new Uint8Array(0)]
function scratch(i: number, n: number): Uint8Array { if (scr[i].length < n) scr[i] = new Uint8Array(n); return scr[i] }

/** horizontal: out[y][x] = max/min of src[y][x-r..x+r] */
export function morphH(src: Uint8Array, w: number, h: number, k: number, isMax: boolean, out: Uint8Array): void {
  if (k <= 1) { out.set(src.subarray(0, w * h)); return }
  const r = k >> 1, np = w + 2 * r, neutral = isMax ? 0 : 255
  const p = scratch(0, np), g = scratch(1, np), hh = scratch(2, np)
  p.fill(neutral, 0, r); p.fill(neutral, r + w, np)
  for (let y = 0; y < h; y++) {
    const o = y * w
    p.set(src.subarray(o, o + w), r)
    if (isMax) {
      for (let b = 0; b < np; b += k) {
        const e = b + k < np ? b + k : np
        let m = p[b]; g[b] = m
        for (let i = b + 1; i < e; i++) { const v = p[i]; if (v > m) m = v; g[i] = m }
        m = p[e - 1]; hh[e - 1] = m
        for (let i = e - 2; i >= b; i--) { const v = p[i]; if (v > m) m = v; hh[i] = m }
      }
      for (let x = 0; x < w; x++) { const a = hh[x], c = g[x + k - 1]; out[o + x] = a > c ? a : c }
    } else {
      for (let b = 0; b < np; b += k) {
        const e = b + k < np ? b + k : np
        let m = p[b]; g[b] = m
        for (let i = b + 1; i < e; i++) { const v = p[i]; if (v < m) m = v; g[i] = m }
        m = p[e - 1]; hh[e - 1] = m
        for (let i = e - 2; i >= b; i--) { const v = p[i]; if (v < m) m = v; hh[i] = m }
      }
      for (let x = 0; x < w; x++) { const a = hh[x], c = g[x + k - 1]; out[o + x] = a < c ? a : c }
    }
  }
}

let vg = new Uint8Array(0), vh = new Uint8Array(0)
/** vertical: out[y][x] = max/min of src[y-r..y+r][x]; processes whole rows at a time (cache friendly). */
export function morphV(src: Uint8Array, w: number, h: number, k: number, isMax: boolean, out: Uint8Array): void {
  if (k <= 1) { out.set(src.subarray(0, w * h)); return }
  const r = k >> 1, np = h + 2 * r, neutral = isMax ? 0 : 255
  if (vg.length < np * w) { vg = new Uint8Array(np * w); vh = new Uint8Array(np * w) }
  const rowAt = (i: number): number => (i - r >= 0 && i - r < h) ? (i - r) * w : -1
  // prefix g
  for (let i = 0; i < np; i++) {
    const so = rowAt(i), o = i * w
    if (i % k === 0) { if (so < 0) vg.fill(neutral, o, o + w); else vg.set(src.subarray(so, so + w), o) }
    else {
      const po = o - w
      if (so < 0) { for (let x = 0; x < w; x++) vg[o + x] = vg[po + x] }
      else if (isMax) for (let x = 0; x < w; x++) { const a = src[so + x], b = vg[po + x]; vg[o + x] = a > b ? a : b }
      else for (let x = 0; x < w; x++) { const a = src[so + x], b = vg[po + x]; vg[o + x] = a < b ? a : b }
    }
  }
  for (let i = np - 1; i >= 0; i--) {
    const so = rowAt(i), o = i * w
    if (i === np - 1 || (i + 1) % k === 0) { if (so < 0) vh.fill(neutral, o, o + w); else vh.set(src.subarray(so, so + w), o) }
    else {
      const no = o + w
      if (so < 0) { for (let x = 0; x < w; x++) vh[o + x] = vh[no + x] }
      else if (isMax) for (let x = 0; x < w; x++) { const a = src[so + x], b = vh[no + x]; vh[o + x] = a > b ? a : b }
      else for (let x = 0; x < w; x++) { const a = src[so + x], b = vh[no + x]; vh[o + x] = a < b ? a : b }
    }
  }
  for (let y = 0; y < h; y++) {
    const ao = y * w, bo = (y + k - 1) * w, o = y * w
    if (isMax) for (let x = 0; x < w; x++) { const a = vh[ao + x], b = vg[bo + x]; out[o + x] = a > b ? a : b }
    else for (let x = 0; x < w; x++) { const a = vh[ao + x], b = vg[bo + x]; out[o + x] = a < b ? a : b }
  }
}

/** Otsu threshold level as cv2.threshold(THRESH_OTSU) on 8-bit data. */
export function otsu(d: Uint8Array): number {
  const hist = new Uint32Array(256)
  for (let i = 0; i < d.length; i++) hist[d[i]]++
  return otsuHist(hist, d.length)
}
export function otsuHist(hist: Uint32Array, n: number): number {
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i]
  let sumB = 0, wB = 0, best = -1, thr = 0
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (wB === 0) continue
    const wF = n - wB; if (wF === 0) break
    sumB += t * hist[t]
    const mB = sumB / wB, mF = (sum - sumB) / wF
    const s = wB * wF * (mB - mF) * (mB - mF)
    if (s > best) { best = s; thr = t }
  }
  return thr
}

/** per-pixel median of n gray frames (even n averages the middle two; truncates like astype(uint8)). */
export function medianStack(frames: Gray[]): Gray {
  const n = frames.length, { w, h } = frames[0], out = newGray(w, h)
  if (n === 1) { out.d.set(frames[0].d); return out }
  const buf = new Array<number>(n)
  const N = w * h
  if (n === 3) {
    const a = frames[0].d, b = frames[1].d, c = frames[2].d
    for (let i = 0; i < N; i++) { const x = a[i], y = b[i], z = c[i]; out.d[i] = x < y ? (y < z ? y : (x < z ? z : x)) : (x < z ? x : (y < z ? z : y)) }
    return out
  }
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < n; j++) buf[j] = frames[j].d[i]
    // insertion sort (n <= 5)
    for (let a = 1; a < n; a++) { const v = buf[a]; let b = a - 1; while (b >= 0 && buf[b] > v) { buf[b + 1] = buf[b]; b-- } buf[b + 1] = v }
    out.d[i] = n & 1 ? buf[n >> 1] : Math.floor((buf[n / 2 - 1] + buf[n / 2]) / 2)
  }
  return out
}

// Drift tracking, main-thread half: turn the worker's raw per-second fits into framing keys. Pure, DOM-free.
//
// Pipeline:  samples → `cleanTrack` (outlier gate) → `planKeys` (where the camera really moved → keys).
//
// A sample is compared with the others through PROBES: a fixed grid of picture points, each mapped to the
// keyboard plane by the sample's own fit. The distance between two samples is then how far the keys moved
// under the same picture pixels, in white-key widths: independent of each sample's own lens bend and of
// how far the extrapolated keyboard corners lie outside the picture.
import { applyH, invert3, undistort, type Mat3, type Vec2 } from '../geometry'
import { PLANE_KEY_LENGTH } from '../geometry'
import type { HandVideoKey } from '../../store'
import type { TrackSample } from './protocol'

/** The gate: a sample further than this from its state's reference is a candidate outlier / move (white-key widths). */
export const GATE_DIST = 0.06
/** The lens is the camera's: a sample whose bend is further than this from the video's median bend is a bad fit, not a move. */
export const GATE_BEND = 0.025
/** A move is believed when this many consecutive samples agree with each other on the new position. */
export const GATE_RUN = 4
/** A key is written only where the straight line between its neighbours would be off by more than this (white-key widths, ≈ 3.5 px on a 36-key view). */
export const KEY_EPS = 0.04
/** A white key's width in plane units is 1; an octave is 7 of them (the detector's octave-alias error). */
const OCTAVE = 7

type Pt = { t: number; v: Float64Array }

export interface CleanTrack {
  /** Picture points every sample is mapped through (raw picture coords 0..1): a spread grid, so a homography can be refitted from them. */
  probes: Vec2[]
  /** The probes that lie on the keyboard: only these decide how far apart two samples are. */
  sel: number[]
  /** Samples that survived the gate, in time order; `v` = the probes' plane positions, x then y per probe. */
  points: Pt[]
  total: number
  good: number
  /** Samples whose placement was thrown away as an outlier (good by the detector's gate, rejected by ours). */
  rejected: number
}

/** Mean plane distance (white-key widths) over the probes in `sel` (all when null). */
const dist = (a: Float64Array, b: Float64Array, sel: number[] | null): number => {
  let s = 0
  const n = sel ? sel.length : a.length >> 1
  for (let k = 0; k < n; k++) {
    const i = sel ? sel[k] : k
    s += Math.hypot(a[2 * i] - b[2 * i], a[2 * i + 1] - b[2 * i + 1])
  }
  return s / n
}

const medianOf = (xs: number[]): number => {
  const s = xs.slice().sort((x, y) => x - y)
  const n = s.length
  return n === 0 ? NaN : n & 1 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2
}

function medianVec(vs: Float64Array[]): Float64Array {
  const out = new Float64Array(vs[0].length)
  for (let i = 0; i < out.length; i++) out[i] = medianOf(vs.map((v) => v[i]))
  return out
}

/** v shifted along x by an integer number of octaves, whichever is closest to `ref` (the detector's alias error). */
function aliasToward(v: Float64Array, ref: Float64Array, sel: number[]): Float64Array {
  let best = v
  let bd = dist(v, ref, sel)
  for (const s of [OCTAVE, -OCTAVE, 2 * OCTAVE, -2 * OCTAVE, 3 * OCTAVE, -3 * OCTAVE]) {
    const w = v.slice()
    for (let i = 0; i < w.length; i += 2) w[i] -= s
    const d = dist(w, ref, sel)
    if (d < bd - 1e-9) {
      bd = d
      best = w
    }
  }
  return best
}

/** Plane positions of the probes under one sample's fit; null when one lies behind the camera. */
function planeVector(s: TrackSample, probes: Vec2[], aspect: number): Float64Array | null {
  if (!s.H || s.bend === undefined) return null
  const v = new Float64Array(probes.length * 2)
  for (let i = 0; i < probes.length; i++) {
    const p = applyH(s.H as Mat3, undistort(probes[i], s.bend, aspect))
    if (!p) return null
    v[2 * i] = p[0]
    v[2 * i + 1] = p[1]
  }
  return v
}

function chooseProbes(samples: TrackSample[], aspect: number): { probes: Vec2[]; sel: number[] } {
  const good = samples.filter((s) => s.good && s.H)
  const grid: Vec2[] = []
  for (let j = 0; j < 6; j++) for (let i = 0; i < 9; i++) grid.push([0.03 + (0.94 * i) / 8, 0.03 + (0.94 * j) / 5])
  // Only points in front of the camera under every sample's fit (a point past the horizon has no plane position).
  const probes = grid.filter((p) => good.every((s) => applyH(s.H as Mat3, undistort(p, s.bend ?? 0, aspect))))
  const s0 = good[Math.floor(good.length / 2)]
  const sel: number[] = []
  if (s0)
    probes.forEach((p, i) => {
      const q = applyH(s0.H as Mat3, undistort(p, s0.bend ?? 0, aspect))
      if (q && q[0] > -1 && q[0] < 53 && q[1] > -0.5 && q[1] < PLANE_KEY_LENGTH + 0.8) sel.push(i)
    })
  return { probes, sel: sel.length >= 8 ? sel : probes.map((_, i) => i) }
}

/**
 * The outlier gate. Candidates are the samples the detector itself calls good. The track is a sequence
 * of STATES (the camera holds still); a sample far from its state's reference is not believed on its
 * own: it only starts a new state when the next `GATE_RUN` samples agree with it (a lit key, a hand
 * over the keys or a wrong lock gives scattered values, a real move gives a lasting one). A run of
 * bad samples of any length shorter than that is dropped, so it cannot make a jump; samples of the
 * detector's octave alias (a whole octave off along x) are mapped back first.
 */
export function cleanTrack(samples: TrackSample[], aspect: number): CleanTrack {
  const { probes, sel } = chooseProbes(samples, aspect)
  const cand: Pt[] = []
  const bends = samples.filter((s) => s.good && s.bend !== undefined).map((s) => s.bend as number)
  const bendMed = bends.length ? medianOf(bends) : 0
  for (const s of samples) {
    if (!s.good || Math.abs((s.bend ?? 0) - bendMed) > GATE_BEND) continue
    const v = planeVector(s, probes, aspect)
    if (v) cand.push({ t: s.t, v })
  }
  const total = samples.length
  const good = samples.filter((s) => s.good).length
  const kept: Pt[] = []
  let ref: Float64Array | null = null
  let i = 0

  // `agree(j)` = candidates j..j+GATE_RUN-1 all lie within GATE_DIST of their own median (their octave aliases mapped to the first one's).
  const agree = (j: number): { med: Float64Array; vs: Float64Array[] } | null => {
    if (j + GATE_RUN > cand.length) return null
    const vs = [cand[j].v]
    for (let k = 1; k < GATE_RUN; k++) vs.push(aliasToward(cand[j + k].v, vs[0], sel))
    const med = medianVec(vs)
    return vs.every((v) => dist(v, med, sel) <= GATE_DIST) ? { med, vs } : null
  }

  while (i < cand.length) {
    if (!ref) {
      const a = agree(i)
      if (!a) {
        i++
        continue
      }
      ref = a.med
      for (let k = 0; k < GATE_RUN; k++) kept.push({ t: cand[i + k].t, v: a.vs[k] })
      i += GATE_RUN
      continue
    }
    const v = aliasToward(cand[i].v, ref, sel)
    if (dist(v, ref, sel) <= GATE_DIST) {
      kept.push({ t: cand[i].t, v })
      const tail = kept.slice(-8).map((p) => p.v)
      ref = medianVec(tail)
      i++
      continue
    }
    const a = agree(i)
    if (a && dist(a.med, ref, sel) > GATE_DIST) {
      for (let k = 0; k < GATE_RUN; k++) kept.push({ t: cand[i + k].t, v: a.vs[k] })
      ref = a.med
      i += GATE_RUN
    } else {
      i++ // an outlier: dropped
    }
  }
  return { probes, sel, points: kept, total, good, rejected: good - kept.length }
}

// ── Homography fit (least squares) ────────────────────────────────────

/** Row-major 3×3 H with H·src ≈ dst over many pairs (normalised DLT with h8 = 1). Null when degenerate. */
export function fitHomography(src: readonly Vec2[], dst: readonly Vec2[]): Mat3 | null {
  const n = src.length
  const norm = (pts: readonly Vec2[]): { T: Mat3; q: Vec2[] } => {
    let cx = 0
    let cy = 0
    for (const p of pts) {
      cx += p[0]
      cy += p[1]
    }
    cx /= pts.length
    cy /= pts.length
    let d = 0
    for (const p of pts) d += Math.hypot(p[0] - cx, p[1] - cy)
    d /= pts.length
    const s = d > 1e-12 ? Math.SQRT2 / d : 1
    return { T: [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1], q: pts.map((p) => [(p[0] - cx) * s, (p[1] - cy) * s] as Vec2) }
  }
  const a = norm(src)
  const b = norm(dst)
  const ata = Array.from({ length: 8 }, () => new Array<number>(9).fill(0))
  const add = (row: number[], rhs: number) => {
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) ata[i][j] += row[i] * row[j]
      ata[i][8] += row[i] * rhs
    }
  }
  for (let i = 0; i < n; i++) {
    const [x, y] = a.q[i]
    const [u, v] = b.q[i]
    add([x, y, 1, 0, 0, 0, -u * x, -u * y], u)
    add([0, 0, 0, x, y, 1, -v * x, -v * y], v)
  }
  for (let c = 0; c < 8; c++) {
    let piv = c
    for (let r = c + 1; r < 8; r++) if (Math.abs(ata[r][c]) > Math.abs(ata[piv][c])) piv = r
    if (Math.abs(ata[piv][c]) < 1e-12) return null
    ;[ata[c], ata[piv]] = [ata[piv], ata[c]]
    for (let r = 0; r < 8; r++) {
      if (r === c) continue
      const f = ata[r][c] / ata[c][c]
      if (f === 0) continue
      for (let k = c; k < 9; k++) ata[r][k] -= f * ata[c][k]
    }
  }
  const h = ata.map((row, i) => row[8] / row[i])
  const Hn: Mat3 = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1]
  const Tbi = invert3(b.T)
  if (!Tbi) return null
  const mul = (x: readonly number[], y: readonly number[]): Mat3 => {
    const o = new Array<number>(9).fill(0)
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += x[i * 3 + k] * y[k * 3 + j]
    return o as Mat3
  }
  const H = mul(Tbi, mul(Hn, a.T))
  const z = H[8] || 1
  return H.map((v) => v / z) as Mat3
}

export const mul3 = (x: readonly number[], y: readonly number[]): Mat3 => {
  const o = new Array<number>(9).fill(0)
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += x[i * 3 + k] * y[k * 3 + j]
  return o as Mat3
}

// ── Keys ──────────────────────────────────────────────────────────────

function valueAt(pts: Pt[], t: number): Float64Array {
  if (t <= pts[0].t) return pts[0].v
  const last = pts[pts.length - 1]
  if (t >= last.t) return last.v
  let i = 0
  while (i < pts.length - 2 && pts[i + 1].t <= t) i++
  const a = pts[i]
  const b = pts[i + 1]
  const f = (t - a.t) / Math.max(1e-9, b.t - a.t)
  const o = new Float64Array(a.v.length)
  for (let k = 0; k < o.length; k++) o[k] = a.v[k] + (b.v[k] - a.v[k]) * f
  return o
}

/** Ramer–Douglas–Peucker over time: indices of the points the polyline needs (ends always kept), error measured at the dropped samples. */
function simplify(pts: Pt[], eps: number, sel: number[]): number[] {
  const keep = new Set<number>([0, pts.length - 1])
  const stack: Array<[number, number]> = [[0, pts.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()!
    let worst = -1
    let wd = eps
    for (let i = a + 1; i < b; i++) {
      const f = (pts[i].t - pts[a].t) / Math.max(1e-9, pts[b].t - pts[a].t)
      const p = pts[i].v
      let s = 0
      for (const k of sel) {
        const x = pts[a].v[2 * k] + (pts[b].v[2 * k] - pts[a].v[2 * k]) * f
        const y = pts[a].v[2 * k + 1] + (pts[b].v[2 * k + 1] - pts[a].v[2 * k + 1]) * f
        s += Math.hypot(p[2 * k] - x, p[2 * k + 1] - y)
      }
      s /= sel.length
      if (s > wd) {
        wd = s
        worst = i
      }
    }
    if (worst >= 0) {
      keep.add(worst)
      stack.push([a, worst], [worst, b])
    }
  }
  return [...keep].sort((x, y) => x - y)
}

export interface KeyPlan {
  /** Keys to put in the settings (manual keys and the anchor included, previous auto keys gone). */
  keys: HandVideoKey[]
  /** Video times where the camera moved (the later key of each move), with how far (white-key widths). */
  moves: Array<{ t: number; size: number }>
  /** Largest distance (white-key widths) any written key sits from the placement it started from: how far the camera wandered, moves and slow drift together. */
  drift: number
  /** False when the track could not be trusted (nothing written). */
  reliable: boolean
}

/** A key step bigger than this (white-key widths) is a move of the camera; smaller keys only follow slow drift. */
export const MOVE_MIN = 0.15

/** The track has to cover most of the video or it is not believed. */
export const MIN_COVERAGE = 0.5

/**
 * Keys for the whole video from a cleaned track, anchored on the user's confirmed placement.
 *
 * Anchors = the user's manual keys, or (none) the earliest key (the confirmed detection). Every other
 * auto key goes. At an anchor a (time ta, H_conf) the detector's fit there is H_det(ta); a later key is
 * `H(t) = C · H_det(t)` with `C = H_conf · H_det(ta)⁻¹`, so the octave the user chose and any hand
 * correction carry forward. H_det is refitted at the video's bend `bend0` (the settings'), so a sample's
 * own lens estimate cannot leak in. Keys appear where the picture-vs-keys relation moved by more than
 * `KEY_EPS` from what the neighbouring keys predict (a step gets two keys one sample apart: the old
 * place is held to the last sample that saw it).
 */
export function planKeys(existing: readonly HandVideoKey[], track: CleanTrack, aspect: number, bend0: number): KeyPlan {
  const sorted = existing.slice().sort((a, b) => a.t - b.t)
  const manual = sorted.filter((k) => k.source === 'manual')
  const anchors = manual.length ? manual : sorted.slice(0, 1)
  const none: KeyPlan = { keys: existing.filter((k) => anchors.includes(k) || k.source === 'manual'), moves: [], drift: 0, reliable: false }
  if (!anchors.length || track.points.length < GATE_RUN || track.points.length < MIN_COVERAGE * track.total) return none

  const pts = track.points
  const corr0 = track.probes.map((p) => undistort(p, bend0, aspect))
  const toH = (v: Float64Array): Mat3 | null => {
    const plane: Vec2[] = []
    for (let i = 0; i < v.length; i += 2) plane.push([v[i], v[i + 1]])
    return fitHomography(corr0, plane)
  }

  const out: HandVideoKey[] = [...anchors]
  const moves: KeyPlan['moves'] = []
  let drift = 0
  for (let ai = 0; ai < anchors.length; ai++) {
    const a = anchors[ai]
    const next = anchors[ai + 1]
    const Hd = toH(valueAt(pts, a.t))
    const Hdi = Hd && invert3(Hd)
    if (!Hdi) continue
    const C = mul3(a.H, Hdi)
    // The stretch this anchor governs: from its time to the next anchor (the anchor itself is series[0], already a key).
    const hi = next ? next.t : Infinity
    const series: Pt[] = [{ t: a.t, v: valueAt(pts, a.t) }, ...pts.filter((p) => p.t > a.t + 1e-6 && p.t < hi)]
    if (series.length < 2 && ai > 0) continue
    let idx = series.length < 2 ? [] : simplify(series, KEY_EPS, track.sel).slice(1)
    // A flat tail needs no key; before another anchor one is kept so the old place is held up to it.
    if (!next && idx.length) {
      const l = series[idx[idx.length - 1]]
      const p = idx.length > 1 ? series[idx[idx.length - 2]] : series[0]
      if (dist(l.v, p.v, track.sel) <= KEY_EPS) idx = idx.slice(0, -1)
    }
    if (ai === 0) {
      // Before the first anchor the same way, backwards: the anchor's place is held back to wherever the camera was last seen to move.
      const head: Pt[] = [...pts.filter((p) => p.t < a.t - 1e-6), { t: a.t, v: valueAt(pts, a.t) }]
      if (head.length >= 2) {
        let hidx = simplify(head, KEY_EPS, track.sel).slice(0, -1)
        if (hidx.length) {
          const f = head[hidx[0]]
          const nx = hidx.length > 1 ? head[hidx[1]] : head[head.length - 1]
          if (dist(f.v, nx.v, track.sel) <= KEY_EPS) hidx = hidx.slice(1)
        }
        let nextV = valueAt(pts, a.t)
        for (const i of hidx.slice().reverse()) {
          const p = head[i]
          const H = toH(p.v)
          if (!H) continue
          out.push({ t: round(p.t), H: mul3(C, H), source: 'auto' })
          const d = dist(p.v, nextV, track.sel)
          if (d > MOVE_MIN) moves.push({ t: p.t, size: d })
          drift = Math.max(drift, dist(p.v, valueAt(pts, a.t), track.sel))
          nextV = p.v
        }
      }
    }
    let prevV = valueAt(pts, a.t)
    for (const i of idx) {
      const p = series[i]
      const H = toH(p.v)
      if (!H) continue
      out.push({ t: round(p.t), H: mul3(C, H), source: 'auto' })
      const d = dist(p.v, prevV, track.sel)
      if (d > MOVE_MIN) moves.push({ t: p.t, size: d })
      drift = Math.max(drift, dist(p.v, valueAt(pts, a.t), track.sel))
      prevV = p.v
    }
  }
  out.sort((x, y) => x.t - y.t)
  return { keys: out, moves: mergeMoves(moves), drift, reliable: true }
}

const round = (t: number) => Math.round(t * 1000) / 1000

/** Moves closer than 3 s are one move (a step is two keys; a slow drift is several). */
function mergeMoves(ms: KeyPlan['moves']): KeyPlan['moves'] {
  const out: KeyPlan['moves'] = []
  for (const m of ms) {
    const l = out[out.length - 1]
    if (l && m.t - l.t < 3) {
      l.t = m.t
      l.size += m.size
    } else out.push({ ...m })
  }
  return out
}

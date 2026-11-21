// Per-sample processing as in proto/run_video.py run(): detect, octave-alias shift vs previous good quad, seam check, gates.
import { Gray } from './imgops'
import { Detection, detect, detectTracked } from './detect'
import { Model, Pt, SeamPoint, fitModel, makeToImg, seamErrors, toPlane } from './fit'
import { CORN, percentile } from './model'

export interface SampleResult {
  ok: boolean; t: number
  quad?: Pt[]; keys?: number; cost?: number; amb?: number; k?: number
  seam_mean?: number | null; seam_p90?: number | null; seam_max?: number | null; seam_n?: number
  lo?: number; hi?: number; good?: boolean; shift?: number
  detMs?: number; why?: string; totalMs?: number; path?: 'full' | 'tracked' | 'fallback'
  model?: { H: number[]; k: number; c: Pt; s: number }
}

const SEAM_ITERS = 2
const SEAM_MIN = 12
const SEAM_WEIGHT = 3

export class Tracker {
  hint: Pt[] | null = null
  nkRef = 0
  costRun = 0
  why = ''
  lock: { hyp: number; flip: boolean; scale: number } | null = null
  constructor(public useTracking: boolean) {}

  private quadOf(m: Model): Pt[] { const f = makeToImg(m); return CORN.map((c) => f(c)) }

  private refit(d: Detection, shift: number): Model | null {
    const lab = d.labels.map((l) => l + shift)
    if (Math.min(...lab) < 0 || Math.max(...lab) >= 36) return null
    return fitModel(d.tips_o, d.tails_o, lab, d.fe_o, d.w, d.h)
  }

  process(g: Gray, t: number): SampleResult {
    const t0 = performance.now()
    let d: Detection | null = null, path: SampleResult['path'] = 'full'
    if (this.useTracking && this.lock) {
      d = detectTracked(g, this.lock.hyp, this.lock.flip, this.lock.scale)
      path = 'tracked'
      // A lone high-cost sample is a hand or a lit key, not a lost lock: keep it (not "good") and move on; two in a row
      // (or too few keys, or a wild bend) earn the full sweep. This spares most fallbacks, each worth ~10 tracked samples.
      const costOnly = !!d && d.cost >= 0.12 && d.geo.length >= 0.7 * this.nkRef && Math.abs(d.mdl.k) < 0.19
      this.costRun = costOnly ? this.costRun + 1 : 0
      const bad = !d || (d.cost >= 0.12 && !(costOnly && this.costRun === 1)) || d.geo.length < 0.7 * this.nkRef || Math.abs(d.mdl.k) >= 0.19
      if (bad) { this.why = !d ? 'null' : d.cost >= 0.12 ? 'cost ' + d.cost.toFixed(2) : d.geo.length < 0.7 * this.nkRef ? 'keys ' + d.geo.length + '/' + this.nkRef : 'k'; d = detect(g); path = 'fallback' }
    } else d = detect(g)
    if (!d) return { ok: false, t, totalMs: performance.now() - t0, path }
    const detMs = d.ms
    let shift = 0, mdl = d.mdl, labels = d.labels
    if (this.hint) {
      let best: { dist: number; s: number; m: Model } | null = null
      for (const s of [0, 5, -5, 10, -10, 15, -15]) {
        const mm = s === 0 ? d.mdl : this.refit(d, s); if (!mm) continue
        const q = this.quadOf(mm); let dist = 0
        for (let i = 0; i < 4; i++) dist += Math.hypot(q[i][0] - this.hint[i][0], q[i][1] - this.hint[i][1])
        dist /= 4
        if (!best || dist < best.dist - 1e-6) best = { dist, s, m: mm }
      }
      if (best && best.s !== 0) { mdl = best.m; shift = best.s; labels = labels.map((l) => l + best!.s) }
    }
    let Y = 0; for (const p of d.tips_o) Y += toPlane(mdl, p)[1]; Y /= d.tips_o.length
    let se = seamErrors(g, mdl, Y)
    // The black-key fit leaves a smooth, repeatable error along the keys (the lens is not a pure r³ bend, black and white keys differ in height):
    // pull the model onto the white-key seams too, which are what the eye judges the overlay by.
    const meanAbs = (q: { err: number }[]) => q.reduce((a, b) => a + Math.abs(b.err), 0) / q.length
    for (let it = 0; it < SEAM_ITERS && se.length >= SEAM_MIN; it++) {
      const toImg = makeToImg(mdl), pts: SeamPoint[] = []
      for (const q of se) for (const f of [0.3, 0.7]) pts.push({ P: toImg([q.k + 1 + q.err, f * Y]), x: q.k + 1, wt: SEAM_WEIGHT })
      const m2 = fitModel(d.tips_o, d.tails_o, labels, d.fe_o, d.w, d.h, mdl, pts)
      if (!m2) break
      const se2 = seamErrors(g, m2, Y)
      if (se2.length < SEAM_MIN || meanAbs(se2) >= meanAbs(se)) break // only ever a better fit
      mdl = m2
      se = se2
    }
    const e = se.map((x) => Math.abs(x.err))
    const quad = this.quadOf(mdl)
    const r: SampleResult = {
      ok: true, t, quad, keys: d.geo.length, cost: d.cost, amb: d.amb, k: mdl.k,
      seam_mean: e.length ? e.reduce((a, b) => a + b, 0) / e.length : null, seam_p90: e.length ? percentile(e, 90) : null, seam_max: e.length ? Math.max(...e) : null, seam_n: e.length,
      lo: Math.min(...labels), hi: Math.max(...labels), shift, detMs, path, why: path === 'fallback' ? this.why : undefined,
      model: { H: mdl.H, k: mdl.k, c: mdl.c, s: mdl.s },
    }
    this.nkRef = Math.max(this.nkRef, d.geo.length)
    r.good = d.cost < 0.12 && d.geo.length >= 0.7 * this.nkRef && Math.abs(mdl.k) < 0.19
    if (r.good) { this.hint = quad; if (path !== 'tracked') this.lock = { hyp: d.hyp, flip: d.flip, scale: d.scale } }
    r.totalMs = performance.now() - t0
    return r
  }
}

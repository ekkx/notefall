// Keyboard detection worker: decode a few frames with mediabunny → gray → median → detection core.
// See protocol.ts for the messages. Nothing here touches the DOM.
import { BlobSource, CanvasSink, EncodedPacketSink, ALL_FORMATS, Input } from 'mediabunny'
import { makeToImg, type Model } from './fit'
import { Gray, medianStack, newGray } from './imgops'
import { Tracker, SampleResult } from './track'
import { modelToPictureH } from './convert'
import type { DetectOutcome, TrackOutcome, TrackSample, WorkerRequest, WorkerResponse } from './protocol'

/** Working size: as large as 1280×720 allows at the video's own aspect (the lens model needs the true aspect). */
const WORK_W = 960
const WORK_H = 540
const WINDOW_FRAMES = 5

const post = (m: WorkerResponse) => (self as unknown as Worker).postMessage(m)
const cancelled = new Set<number>()

class Cancelled extends Error {}
const check = (id: number) => {
  if (cancelled.has(id)) throw new Cancelled()
}

function toGray(canvas: OffscreenCanvas | HTMLCanvasElement): Gray {
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const im = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  const g = newGray(canvas.width, canvas.height)
  const n = g.w * g.h
  for (let i = 0, j = 0; i < n; i++, j += 4) g.d[i] = (299 * im[j] + 587 * im[j + 1] + 114 * im[j + 2] + 500) / 1000
  return g
}

/** Times of the frames in one window: `WINDOW_FRAMES` spaced up to 2 s apart, all inside the video. */
function windowTimes(start: number, duration: number): number[] {
  const t0 = Math.max(0, Math.min(start, duration - 0.2))
  const room = Math.max(0, duration - 0.05 - t0)
  const step = Math.min(2, room / (WINDOW_FRAMES - 1))
  return Array.from({ length: WINDOW_FRAMES }, (_, i) => t0 + i * step)
}

/** The gate for a first placement (looser than the tracker's `good`: the user confirms the result). */
function acceptable(r: SampleResult): boolean {
  return !!(r.ok && r.model && (r.cost ?? 9) < 0.12 && Math.abs(r.k ?? 9) < 0.19 && (r.keys ?? 0) >= 10 && (r.seam_mean ?? 0) < 0.2)
}

async function detect(id: number, blob: Blob, at: number | undefined): Promise<DetectOutcome> {
  const t0 = performance.now()
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) return { ok: false, reason: 'no video track', ms: performance.now() - t0 }
    if (!(await track.canDecode())) return { ok: false, reason: `cannot decode ${track.codec}`, ms: performance.now() - t0 }
    check(id)
    const duration = await input.computeDuration()
    const dw = await track.getDisplayWidth()
    const dh = await track.getDisplayHeight()
    const scale = Math.min(WORK_W / dw, WORK_H / dh)
    const w = Math.max(64, Math.round(dw * scale))
    const h = Math.max(64, Math.round(dh * scale))
    const sink = new CanvasSink(track, { width: w, height: h, fit: 'fill', poolSize: 2 })

    // Where to look: near the start (or `at`); a second window further in when the first one finds nothing.
    const starts = at !== undefined ? [at, at + duration * 0.3] : [Math.min(1, duration * 0.1), duration * 0.4]
    let last: SampleResult | null = null
    for (let wi = 0; wi < starts.length; wi++) {
      const frames: Gray[] = []
      const times = windowTimes(starts[wi] % Math.max(duration, 0.1), duration)
      for await (const f of sink.canvasesAtTimestamps(times)) {
        check(id)
        if (f) frames.push(toGray(f.canvas))
      }
      post({ type: 'progress', id, fraction: (wi + 0.5) / starts.length })
      if (!frames.length) continue
      const g = medianStack(frames)
      const r = new Tracker(false).process(g, times[Math.floor(times.length / 2)])
      last = r
      if (acceptable(r)) {
        const m = r.model!
        return {
          ok: true,
          ms: performance.now() - t0,
          fit: {
            H: modelToPictureH({ H: m.H, k: m.k, c: m.c, s: m.s }, w, h),
            bend: m.k,
            octaveKnown: (r.amb ?? 0) > 0.3,
            t: r.t,
            keys: r.keys ?? 0,
            cost: r.cost ?? 9,
            seam: r.seam_mean ?? null,
            lo: r.lo ?? 0,
            hi: r.hi ?? 0,
          },
        }
      }
    }
    const reason = last
      ? last.ok
        ? `weak fit (cost ${(last.cost ?? 0).toFixed(2)}, ${last.keys} keys)`
        : 'no keyboard found'
      : 'no frames decoded'
    return { ok: false, reason, ms: performance.now() - t0 }
  } finally {
    input.dispose()
  }
}

/**
 * Drift tracking. Frames sit on a 2 s grid (the nearest keyframe at or before each grid time when the file has
 * them every ≤ 1.5 s, so no P/B frame is decoded). A SAMPLE is the median of up to 5 consecutive grid frames
 * around its centre (hands move, the keys do not) fitted by the detector. The coarse pass samples every
 * second grid frame (a sample each 4 s); where two neighbours differ by more than `REFINE_PX` the midpoint
 * is sampled too (down to 1 s), so steps are located and slow drift costs nothing extra.
 * With `parts > 1` this worker handles one contiguous slice of the centres (+ the first of the next, so
 * the seam between slices can be refined too); the main thread runs the parts on separate workers.
 */
const GRID = 2
const WINDOW_HALF = 2
const COARSE = 2 // grid frames between coarse samples
const REFINE_PX = 1.4 // working-size px
const MIN_STEP = 1 // s, finest sample spacing

/** Mean image-px distance between two fits, over a grid of plane points on the keys. */
function fitDistance(a: Model, b: Model): number {
  const fa = makeToImg(a)
  const fb = makeToImg(b)
  let s = 0
  let n = 0
  for (const x of [6, 14, 22, 30, 38, 46]) {
    for (const y of [0.6, 1.8]) {
      const p = fa([x, y])
      const q = fb([x, y])
      s += Math.hypot(p[0] - q[0], p[1] - q[1])
      n++
    }
  }
  return s / n
}

async function track(id: number, blob: Blob, part: number, parts: number): Promise<TrackOutcome> {
  const t0 = performance.now()
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const vt = await input.getPrimaryVideoTrack()
    if (!vt) return { ok: false, reason: 'no video track', ms: performance.now() - t0 }
    if (!(await vt.canDecode())) return { ok: false, reason: `cannot decode ${vt.codec}`, ms: performance.now() - t0 }
    const duration = await input.computeDuration()
    const dw = await vt.getDisplayWidth()
    const dh = await vt.getDisplayHeight()
    const scale = Math.min(WORK_W / dw, WORK_H / dh)
    const w = Math.max(64, Math.round(dw * scale))
    const h = Math.max(64, Math.round(dh * scale))
    const sink = new CanvasSink(vt, { width: w, height: h, fit: 'fill', poolSize: 2 })
    const packets = new EncodedPacketSink(vt)
    const G = Math.floor((duration - 0.1) / GRID) + 1 // grid frames
    if (G < 5) return { ok: false, reason: 'video too short', ms: performance.now() - t0 }

    // Keyframes close enough to the grid? Then ask for them: the decoder starts and ends on the keyframe.
    const k0 = await packets.getFirstPacket({ metadataOnly: true })
    const k1 = k0 ? await packets.getNextKeyPacket(k0, { metadataOnly: true }) : null
    const k2 = k1 ? await packets.getNextKeyPacket(k1, { metadataOnly: true }) : null
    const keyed = !!(k1 && k2 && k2.timestamp - k1.timestamp <= 1.5)
    const gridTime = async (g: number): Promise<number> => {
      const t = g * GRID
      if (!keyed) return t
      const kp = await packets.getKeyPacket(t, { metadataOnly: true })
      return kp ? kp.timestamp : t
    }

    const centres: number[] = []
    for (let c = 0; c < G; c += COARSE) centres.push(c)
    if (centres[centres.length - 1] !== G - 1 && G - 1 - centres[centres.length - 1] >= 1) centres.push(G - 1)
    const lo = Math.floor((part * centres.length) / parts)
    const hi = Math.min(centres.length, Math.floor(((part + 1) * centres.length) / parts) + (part < parts - 1 ? 1 : 0))
    const mine = centres.slice(lo, hi)
    if (!mine.length) return { ok: true, samples: [], aspect: w / h, duration, ms: performance.now() - t0 }

    const st: Record<string, number> = { setupMs: 0, decodeMs: 0, grayMs: 0, medianMs: 0, fitMs: 0, detMs: 0, n: 0, tracked: 0, fallback: 0, full: 0, refined: 0 }
    const tracker = new Tracker(true)
    const samples: TrackSample[] = []
    const models = new Map<number, Model | null>() // by centre grid index
    let lastPost = 0
    let done = 0
    const total = mine.length
    const report = () => {
      const now = performance.now()
      if (now - lastPost > 250) {
        lastPost = now
        post({ type: 'progress', id, fraction: Math.min(0.99, done / total) })
      }
    }

    /** Fit one sample from its gray frames; `tc` = the centre frame's time. */
    const fitSample = (frames: Gray[], tc: number, key: number): void => {
      let a = performance.now()
      const med = frames.length === 1 ? frames[0] : medianStack(frames)
      st.medianMs += performance.now() - a
      a = performance.now()
      const r = tracker.process(med, tc)
      st.fitMs += performance.now() - a
      st.detMs += r.detMs ?? 0
      st.n++
      if (r.path) st[r.path]++
      if (r.why) st['why_' + r.why.split(' ')[0]] = (st['why_' + r.why.split(' ')[0]] ?? 0) + 1
      const s: TrackSample = { t: r.t, ok: r.ok, good: !!r.good }
      if (r.ok && r.model) {
        s.H = modelToPictureH({ H: r.model.H, k: r.model.k, c: r.model.c, s: r.model.s }, w, h)
        s.bend = r.model.k
        s.keys = r.keys
        s.cost = r.cost
        s.seam = r.seam_mean ?? null
        models.set(key, r.good ? (r.model as Model) : null)
      } else models.set(key, null)
      samples.push(s)
    }

    // ── coarse pass: one decoder run over the grid frames this part needs
    const g0 = Math.max(0, mine[0] - WINDOW_HALF)
    const g1 = Math.min(G - 1, mine[mine.length - 1] + WINDOW_HALF)
    const times: number[] = []
    const gi: number[] = []
    let lastT = -1
    for (let g = g0; g <= g1; g++) {
      const t = await gridTime(g)
      if (t <= lastT + 1e-6) continue // two grid times on one keyframe (sparse keyframes): one frame
      lastT = t
      times.push(t)
      gi.push(g)
    }
    st.setupMs = performance.now() - t0
    const ring = new Map<number, Gray>() // grid index → gray
    const stamp = new Map<number, number>()
    let mi = 0
    let mark = performance.now()
    let idx = 0
    for await (const f of sink.canvasesAtTimestamps(times)) {
      st.decodeMs += performance.now() - mark
      check(id)
      const g = gi[idx++]
      if (f) {
        const a = performance.now()
        ring.set(g, toGray(f.canvas))
        stamp.set(g, f.timestamp)
        st.grayMs += performance.now() - a
      }
      // Every centre whose window is complete (all frames ≤ g decoded, or the last frame).
      while (mi < mine.length && (mine[mi] + WINDOW_HALF <= g || g === g1)) {
        const c = mine[mi++]
        const fr: Gray[] = []
        for (let j = c - WINDOW_HALF; j <= c + WINDOW_HALF; j++) {
          const q = ring.get(j)
          if (q) fr.push(q)
        }
        if (fr.length >= 3) fitSample(fr, stamp.get(c) ?? c * GRID, c * GRID)
        done++
        report()
        await new Promise((r) => setTimeout(r, 0)) // let a cancel message in
        check(id)
      }
      for (const k of [...ring.keys()]) if (k < g - 2 * WINDOW_HALF - 1) (ring.delete(k), stamp.delete(k))
      mark = performance.now()
    }

    const coarseEnd = performance.now()

    // ── refinement: where two neighbouring GOOD samples differ, bisect the stretch between them (bad samples in
    // between are usually windows that straddle the move). Refinement samples use 3 frames 1 s apart, so they are local.
    const frameAt = async (t: number): Promise<{ g: Gray; t: number } | null> => {
      let ts = t
      if (keyed) {
        const kp = await packets.getKeyPacket(Math.max(0, t), { metadataOnly: true })
        if (kp) ts = kp.timestamp
      }
      const wf = await sink.getCanvas(ts)
      return wf ? { g: toGray(wf.canvas), t: wf.timestamp } : null
    }
    /** Sample at nominal time m; returns its model when it is a good fit. */
    const refineAt = async (m: number): Promise<Model | null> => {
      const fr: Gray[] = []
      let tc = m
      for (let j = -1; j <= 1; j++) {
        const tt = m + j
        if (tt < 0 || tt > duration - 0.1) continue
        const f = await frameAt(tt)
        check(id)
        if (f) {
          fr.push(f.g)
          if (j === 0) tc = f.t
        }
      }
      if (fr.length < 2) return null
      fitSample(fr, tc, m)
      st.refined++
      await new Promise((r) => setTimeout(r, 0))
      check(id)
      return models.get(m) ?? null
    }
    const goodAt = new Map<number, Model>()
    for (const c of mine) {
      const m = models.get(c * GRID)
      if (m) goodAt.set(c * GRID, m)
    }
    const order = [...goodAt.keys()].sort((x, y) => x - y)
    const queue: Array<[number, number]> = []
    for (let i = 0; i + 1 < order.length; i++) {
      if (fitDistance(goodAt.get(order[i])!, goodAt.get(order[i + 1])!) > REFINE_PX) queue.push([order[i], order[i + 1]])
    }
    let budget = Math.max(40, Math.floor(mine.length * 0.6))
    while (queue.length && budget > 0) {
      const [a, b] = queue.shift()!
      if (b - a < 2 * MIN_STEP + 1e-6) continue
      const tries = [(a + b) / 2, a + (b - a) / 4, a + (3 * (b - a)) / 4]
      for (const m of tries) {
        if (budget-- <= 0) break
        const mm = await refineAt(m)
        if (!mm) continue
        goodAt.set(m, mm)
        if (fitDistance(goodAt.get(a)!, mm) > REFINE_PX) queue.push([a, m])
        if (fitDistance(mm, goodAt.get(b)!) > REFINE_PX) queue.push([m, b])
        break
      }
    }
    st.coarseEndMs = coarseEnd - t0
    samples.sort((x, y) => x.t - y.t)
    return { ok: true, samples, aspect: w / h, duration, ms: performance.now() - t0, stats: st }
  } finally {
    input.dispose()
  }
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const m = e.data
  if (m.type === 'cancel') {
    cancelled.add(m.id)
    return
  }
  if (m.type === 'track') {
    track(m.id, m.blob, m.part ?? 0, m.parts ?? 1)
      .then((outcome) => post({ type: 'tracked', id: m.id, outcome }))
      .catch((err) => {
        if (!(err instanceof Cancelled)) post({ type: 'error', id: m.id, message: String(err?.message ?? err) })
      })
      .finally(() => cancelled.delete(m.id))
    return
  }
  if (m.type === 'detect') {
    detect(m.id, m.blob, m.at)
      .then((outcome) => post({ type: 'detected', id: m.id, outcome }))
      .catch((err) => {
        if (!(err instanceof Cancelled)) post({ type: 'error', id: m.id, message: String(err?.message ?? err) })
      })
      .finally(() => cancelled.delete(m.id))
  }
}

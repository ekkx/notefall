// Main-thread side of the detection worker: one lazily created module worker, request ids, abort.
import type { DetectOutcome, TrackOutcome, WorkerRequest, WorkerResponse } from './protocol'

type Pending = {
  resolve: (r: WorkerResponse) => void
  reject: (e: Error) => void
  onProgress?: (fraction: number) => void
  /** The reply type that settles this request. */
  done: WorkerResponse['type']
}

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, Pending>()

function ensureWorker(): Worker {
  if (worker) return worker
  const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  w.onmessage = (e: MessageEvent<WorkerResponse>) => {
    const m = e.data
    const p = pending.get(m.id)
    if (!p) return
    if (m.type === 'progress') p.onProgress?.(m.fraction)
    else if (m.type === 'error') settle(m.id, () => p.reject(new Error(m.message)))
    else if (m.type === p.done) settle(m.id, () => p.resolve(m))
  }
  w.onerror = (e) => {
    for (const id of [...pending.keys()]) settle(id, () => pending.get(id)?.reject(new Error(e.message || 'The analysis worker failed')))
    stop()
  }
  worker = w
  return w
}

function stop(): void {
  worker?.terminate()
  worker = null
}

/** Settle a request and shut the worker down once nothing is running (it restarts in a few ms when needed). */
function settle(id: number, fn: () => void): void {
  fn()
  pending.delete(id)
  if (pending.size === 0) stop()
}

function request(
  msg: WorkerRequest & { id: number },
  done: WorkerResponse['type'],
  opts: { signal?: AbortSignal; onProgress?: (f: number) => void },
): Promise<WorkerResponse> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'))
    pending.set(msg.id, { resolve, reject, onProgress: opts.onProgress, done })
    opts.signal?.addEventListener(
      'abort',
      () => {
        if (!pending.has(msg.id)) return
        worker?.postMessage({ type: 'cancel', id: msg.id } satisfies WorkerRequest)
        settle(msg.id, () => reject(new DOMException('Aborted', 'AbortError')))
      },
      { once: true },
    )
    ensureWorker().postMessage(msg)
  })
}

/** Find the keyboard in a video (≈1 s). Rejects with an AbortError when `signal` aborts. */
export async function detectKeyboard(
  blob: Blob,
  opts: { at?: number; signal?: AbortSignal; onProgress?: (fraction: number) => void } = {},
): Promise<DetectOutcome> {
  const id = nextId++
  const r = await request({ type: 'detect', id, blob, at: opts.at }, 'detected', opts)
  if (r.type !== 'detected') throw new Error('unexpected reply')
  return r.outcome
}

/** How many workers share a track run: leave cores for the app (and the audio) on small machines. */
export function trackWorkerCount(): number {
  const hc = navigator.hardwareConcurrency || 4
  return hc >= 12 ? 4 : hc >= 8 ? 3 : hc >= 4 ? 2 : 1
}

/**
 * Follow the keyboard through the whole video in the background: the samples are split over a few
 * workers of their own (not the detection worker). Rejects with an AbortError when `signal` aborts.
 */
export async function trackKeyboard(
  blob: Blob,
  opts: { signal?: AbortSignal; onProgress?: (fraction: number) => void; workers?: number } = {},
): Promise<TrackOutcome> {
  const parts = Math.max(1, opts.workers ?? trackWorkerCount())
  const ws: Worker[] = []
  const frac = new Array<number>(parts).fill(0)
  try {
    const outcomes = await new Promise<TrackOutcome[]>((resolve, reject) => {
      if (opts.signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'))
      const out: TrackOutcome[] = new Array(parts)
      let left = parts
      opts.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      for (let i = 0; i < parts; i++) {
        const id = nextId++
        const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
        ws.push(w)
        w.onmessage = (e: MessageEvent<WorkerResponse>) => {
          const m = e.data
          if (m.id !== id) return
          if (m.type === 'progress') {
            frac[i] = m.fraction
            opts.onProgress?.(frac.reduce((a, b) => a + b, 0) / parts)
          } else if (m.type === 'error') reject(new Error(m.message))
          else if (m.type === 'tracked') {
            out[i] = m.outcome
            frac[i] = 1
            if (--left === 0) resolve(out)
          }
        }
        w.onerror = (e) => reject(new Error(e.message || 'The analysis worker failed'))
        w.postMessage({ type: 'track', id, blob, part: i, parts } satisfies WorkerRequest)
      }
    })
    const bad = outcomes.find((o) => !o.ok)
    if (bad && !bad.ok) return bad
    const oks = outcomes.filter((o): o is Extract<TrackOutcome, { ok: true }> => o.ok)
    // Neighbouring slices share one sample at their seam: keep one of each time.
    const seen = new Set<number>()
    const samples = oks
      .flatMap((o) => o.samples)
      .sort((a, b) => a.t - b.t)
      .filter((s) => (seen.has(s.t) ? false : (seen.add(s.t), true)))
    const stats: Record<string, number> = {}
    oks.forEach((o, i) => ((stats[`part${i}Ms`] = o.ms), (stats[`part${i}N`] = o.samples.length)))
    for (const o of oks) for (const [k, v] of Object.entries(o.stats ?? {})) stats[k] = (stats[k] ?? 0) + v
    return { ok: true, samples, aspect: oks[0].aspect, duration: oks[0].duration, ms: Math.max(...oks.map((o) => o.ms)), stats }
  } finally {
    ws.forEach((w) => w.terminate())
  }
}

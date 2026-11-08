// Hand motion for the loaded song, from the hand runtime in ./runtime (a WebAssembly module, its Worker and a small client;
// built artifacts, see runtime/README.md). The motion data is a separate ~22 MB download, fetched by the Worker only while
// hands are on and kept in Cache Storage, like the piano samples.
import { MIDI_MAX, MIDI_MIN } from '../keyboard/layout'
import { midiToTimeline, type SpeedMap } from '../midi/speedMap'
import type { ParsedSong } from '../midi/types'
import { HandsRuntime, type HandsMotion, type HandsNote } from './runtime/hands'
import workerUrl from './runtime/hands-worker.js?url'
import wasmUrl from './runtime/hands.wasm?url'

export type { HandsMotion }

/** The motion data on the sample CDN under a content-hashed name (immutable). `VITE_HANDS_DB_URL` overrides; `npm run dev`
 *  goes through Vite's `/samples-cdn` proxy (the bucket's CORS allows only notefall.app, see audio/sampler.ts). */
const DB_FILE = 'motion.82cbd97028.bin'
const DB_URL =
  (import.meta.env.VITE_HANDS_DB_URL as string | undefined) ??
  (import.meta.env.DEV ? `/samples-cdn/hands/${DB_FILE}` : `https://samples.notefall.app/hands/${DB_FILE}`)

/** How the app places the song on the timeline (the same inputs FallingNotes uses). */
export type HandsTimeMap = {
  speedMap: SpeedMap
  midiOffsetSec: number
  trimStartSec: number
  trimEndSec: number
  transpose: number
}

/**
 * The song's notes on the TIMELINE clock (`audioEngine.currentSongTime()`): note times go through the speed map and the
 * clip offset, notes outside the trim window are dropped, pitches get the global transpose. A note's own hand / finger
 * (selection card) is passed on and kept; the rest are planned by the runtime.
 */
export function songHandNotes(song: ParsedSong, map: HandsTimeMap): HandsNote[] {
  const tl = (t: number) => map.midiOffsetSec + midiToTimeline(map.speedMap, t)
  const notes: HandsNote[] = []
  for (const n of song.notes) {
    if (n.time < map.trimStartSec || n.time >= map.trimEndSec) continue
    const midi = n.midi + map.transpose
    if (midi < MIDI_MIN || midi > MIDI_MAX) continue
    const on = tl(n.time)
    const off = Math.max(on, tl(Math.min(n.time + n.duration, map.trimEndSec)))
    notes.push({ midi, on, off, hand: n.hand ?? null, finger: n.finger ?? null })
  }
  notes.sort((a, b) => a.on - b.on || a.midi - b.midi)
  return notes
}

// ---- status, for the Inspector -------------------------------------------------------------------------------------

export type HandsStatus =
  | { state: 'idle' }
  /** downloading / unpacking the motion data (fraction 0..1 of that stage) */
  | { state: 'loading'; stage: 'download' | 'prepare'; fraction: number }
  /** making the motion for the song */
  | { state: 'working'; fraction: number }
  | { state: 'ready' }
  | { state: 'error' }

let status: HandsStatus = { state: 'idle' }
const listeners = new Set<() => void>()
function setStatus(s: HandsStatus): void {
  status = s
  for (const l of listeners) l()
}
export const getHandsStatus = (): HandsStatus => status
export function subscribeHandsStatus(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

// ---- the runtime: one per page, created on first use, released a while after hands are turned off ------------------

let runtime: Promise<HandsRuntime> | null = null
let users = 0
let releaseTimer = 0
/** The Worker holds ~300 MB once the data is loaded; keep it through quick off / on toggles, free it after this. */
const RELEASE_AFTER_MS = 20_000

function startRuntime(): Promise<HandsRuntime> {
  const p = (async () => {
    setStatus({ state: 'loading', stage: 'download', fraction: 0 })
    const rt = await HandsRuntime.create({ worker: workerUrl, wasm: wasmUrl })
    try {
      await rt.load(DB_URL, (stage, f) =>
        setStatus({ state: 'loading', stage: stage === 'download' ? 'download' : 'prepare', fraction: stage === 'download' ? f : stage === 'decode' ? 0.15 * f : f }),
      )
    } catch (e) {
      rt.dispose()
      throw e
    }
    return rt
  })()
  p.catch((e) => {
    console.error('hands: the motion runtime failed to load', e)
    if (runtime === p) runtime = null // a later attempt starts over
    setStatus({ state: 'error' })
  })
  return p
}

/** Hands mounted: keeps the runtime alive. Returns the release function. */
export function retainHandsRuntime(): () => void {
  users++
  window.clearTimeout(releaseTimer)
  return () => {
    users--
    if (users > 0) return
    releaseTimer = window.setTimeout(() => {
      const r = runtime
      runtime = null
      r?.then((rt) => rt.dispose()).catch(() => {})
      setStatus({ state: 'idle' })
    }, RELEASE_AFTER_MS)
  }
}

export type ReadyMotion = { motion: HandsMotion; poseAt: HandsRuntime['poseAt'] }

/** Work the export must wait for: motion being made, the hand meshes loading. */
const pending = new Set<Promise<unknown>>()
/** Registers `p` as work `handsSettled` waits for. */
export function trackHandsWork(p: Promise<unknown>): void {
  const q = p.catch(() => {}).finally(() => pending.delete(q))
  pending.add(q)
}

/** The motion of `notes`; rejects with an AbortError when `signal` aborts (a newer request replaced it). */
export function synthHandMotion(notes: HandsNote[], signal: AbortSignal): Promise<ReadyMotion> {
  const job = (async () => {
    runtime ??= startRuntime()
    const rt = await runtime
    if (signal.aborted) throw new DOMException('aborted', 'AbortError')
    setStatus({ state: 'working', fraction: 0 })
    try {
      const motion = await rt.synth(notes, { signal, onProgress: (_stage, f) => setStatus({ state: 'working', fraction: f }) })
      setStatus({ state: 'ready' })
      return { motion, poseAt: rt.poseAt.bind(rt) }
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        if (status.state === 'working') setStatus({ state: 'ready' }) // a newer request sets its own
      } else {
        console.error('hands: making the motion failed', e)
        setStatus({ state: 'error' })
      }
      throw e
    }
  })()
  trackHandsWork(job)
  return job
}

/** Resolves once no hand work is in flight (the export waits for it, so the video has the current song's hands). */
export async function handsSettled(): Promise<void> {
  while (pending.size) await Promise.all(pending)
}

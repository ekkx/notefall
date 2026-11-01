import { Midi } from '@tonejs/midi'
import { audioEngine } from './engine'
import {
  clearAllRecordingsFromDb,
  deleteRecordingFromDb,
  loadAllRecordings,
  saveRecording,
} from './recordingStore'

/**
 * Captures the user's live input (PC keyboard, on-screen keyboard, physical
 * MIDI device) into a list of recordings that can be loaded back into the
 * player or exported as Standard MIDI Files.
 *
 * Song playback is intentionally NOT captured — recording while a backing
 * track plays gives you just your performance, not a mash-up.
 *
 * Singleton; only one recording is in progress at a time. Stopped
 * recordings stay in `recordings[]` until explicitly deleted, so the user
 * can take multiple takes and pick which one to keep.
 */
type RecState = 'idle' | 'recording'

type RecEvent =
  | { type: 'noteOn'; midi: number; velocity: number; t: number }
  | { type: 'noteOff'; midi: number; t: number }
  // Sustain. `value` 0..1 (half pedal kept); takes stored before it existed
  // only have `down`.
  | { type: 'pedal'; value?: number; down?: boolean; t: number }
  // Sostenuto (66) / soft (67).
  | { type: 'cc'; number: number; value: number; t: number }

export type Recording = {
  id: string
  name: string
  /** Unix ms — used to sort + format display timestamps. */
  createdAt: number
  /** Length in seconds (recorder stop time minus start time). */
  duration: number
  /** Captured events in their original order. */
  events: RecEvent[]
  /**
   * Has the user seen this recording in the popover yet? Drives the
   * "unread badge" on the recordings list button. Set false on
   * finalize, flipped to true en-masse when the popover closes (we
   * pick close, not open, so the unread row indicators stay visible
   * while the user is actually reading the list).
   *
   * Optional in the type so older entries persisted before this field
   * existed parse cleanly; the hydrate path defaults missing values to
   * `true` so the deploy doesn't surface every prior recording as new.
   */
  read?: boolean
}

class RecorderManager {
  private state: RecState = 'idle'
  private startWall = 0
  private currentEvents: RecEvent[] = []
  private off: (() => void) | null = null
  private recordings: Recording[] = []
  private listeners = new Set<() => void>()
  // Fires when stop() finalizes a non-empty take. Distinct from the
  // generic `listeners` (which fire on every state change including
  // empty-stop and rename) so subscribers can react specifically to
  // "a new recording just appeared" — used by the toolbar to auto-load
  // the take into the player.
  private finalizedListeners = new Set<(r: Recording) => void>()

  constructor() {
    // Hydrate from IndexedDB on first construction. Fire-and-forget — the
    // recorder is usable in-memory immediately, the list just fills in
    // when the async load resolves and the UI re-renders via notify().
    void this.hydrate()
  }

  private async hydrate(): Promise<void> {
    const stored = await loadAllRecordings()
    if (stored.length === 0) return
    // Sort newest-first to match the in-session ordering (unshift on stop).
    stored.sort((a, b) => b.createdAt - a.createdAt)
    // Backfill `read` for entries persisted before the field existed —
    // treat them as already-seen so the unread badge doesn't suddenly
    // light up with every prior recording on first deploy of this
    // feature.
    for (const r of stored) if (r.read === undefined) r.read = true
    this.recordings = stored
    this.notify()
  }

  start(): void {
    if (this.state === 'recording') return
    this.currentEvents = []
    this.state = 'recording'
    this.startWall = performance.now() / 1000
    this.off = audioEngine.addLiveListener((e) => {
      const t = Math.max(0, e.time - this.startWall)
      if (e.type === 'noteOn') {
        this.currentEvents.push({ type: 'noteOn', midi: e.midi, velocity: e.velocity, t })
      } else if (e.type === 'noteOff') {
        this.currentEvents.push({ type: 'noteOff', midi: e.midi, t })
      } else if (e.type === 'pedal') {
        this.currentEvents.push({ type: 'pedal', value: e.value, t })
      } else {
        this.currentEvents.push({ type: 'cc', number: e.number, value: e.value, t })
      }
    })
    this.notify()
  }

  /**
   * End the recording. If anything was captured, a new entry is added to
   * the recordings list (newest first). Empty recordings are silently
   * discarded so the list isn't cluttered with no-op takes.
   */
  stop(): void {
    if (this.state !== 'recording') return
    this.off?.()
    this.off = null
    const duration = performance.now() / 1000 - this.startWall
    let finalized: Recording | null = null
    if (this.currentEvents.length > 0) {
      const id = `rec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      const createdAt = Date.now()
      finalized = {
        id,
        name: defaultFilename(createdAt),
        createdAt,
        duration,
        events: this.currentEvents,
        read: false,
      }
      this.recordings.unshift(finalized)
      saveRecording(finalized)
    }
    this.currentEvents = []
    this.state = 'idle'
    this.notify()
    // Fire the dedicated channel AFTER the generic notify so subscribers
    // that handle the auto-load see the new recording in `getRecordings()`
    // if they ever need to read it back.
    if (finalized) this.finalizedListeners.forEach((fn) => fn(finalized!))
  }

  /** Cancel an in-progress recording without saving it. */
  cancel(): void {
    if (this.state !== 'recording') return
    this.off?.()
    this.off = null
    this.currentEvents = []
    this.state = 'idle'
    this.notify()
  }

  delete(id: string): void {
    const before = this.recordings.length
    this.recordings = this.recordings.filter((r) => r.id !== id)
    if (this.recordings.length !== before) {
      deleteRecordingFromDb(id)
      this.notify()
    }
  }

  /** Put a deleted recording back (Undo after a delete), in its place by date. */
  restore(r: Recording): void {
    if (this.recordings.some((x) => x.id === r.id)) return
    this.recordings = [...this.recordings, r].sort((a, b) => b.createdAt - a.createdAt)
    saveRecording(r)
    this.notify()
  }

  rename(id: string, name: string): void {
    const r = this.recordings.find((r) => r.id === id)
    if (!r) return
    r.name = name
    saveRecording(r)
    this.notify()
  }

  clearAll(): void {
    if (this.recordings.length === 0) return
    this.recordings = []
    clearAllRecordingsFromDb()
    this.notify()
  }

  /**
   * Flip every recording's `read` flag to true. Called by the toolbar
   * when the recordings popover closes — by the time the popover went
   * down, the user has had a chance to scan the list, so the badge can
   * drop to zero. Persists each changed entry so the cleared state
   * survives a reload.
   */
  markAllRead(): void {
    let changed = false
    for (const r of this.recordings) {
      if (!r.read) {
        r.read = true
        saveRecording(r)
        changed = true
      }
    }
    if (changed) this.notify()
  }

  getUnreadCount(): number {
    let n = 0
    for (const r of this.recordings) if (!r.read) n++
    return n
  }

  getState(): RecState {
    return this.state
  }

  /** Number of events captured so far in the in-progress recording. 0 when idle. */
  getCurrentEventCount(): number {
    return this.currentEvents.length
  }

  /** Seconds since the in-progress recording began. 0 when idle. */
  getElapsedSec(): number {
    if (this.state !== 'recording') return 0
    return performance.now() / 1000 - this.startWall
  }

  getRecordings(): readonly Recording[] {
    return this.recordings
  }

  /** Build a Standard MIDI File for the given recording, in memory. */
  toArrayBuffer(id: string): ArrayBuffer | null {
    const r = this.recordings.find((r) => r.id === id)
    if (!r) return null
    const midi = new Midi()
    const track = midi.addTrack()

    const open = new Map<number, { vel: number; t: number }>()
    const finishNote = (m: number, vel: number, start: number, end: number) => {
      track.addNote({
        midi: m,
        time: start,
        duration: Math.max(0.01, end - start),
        velocity: vel,
      })
    }

    for (const e of r.events) {
      if (e.type === 'noteOn') {
        const existing = open.get(e.midi)
        if (existing) finishNote(e.midi, existing.vel, existing.t, e.t)
        open.set(e.midi, { vel: e.velocity, t: e.t })
      } else if (e.type === 'noteOff') {
        const existing = open.get(e.midi)
        if (existing) {
          finishNote(e.midi, existing.vel, existing.t, e.t)
          open.delete(e.midi)
        }
      } else if (e.type === 'pedal') {
        track.addCC({ number: 64, time: e.t, value: e.value ?? (e.down ? 1 : 0) })
      } else {
        track.addCC({ number: e.number, time: e.t, value: e.value })
      }
    }
    for (const [m, { vel, t }] of open) {
      finishNote(m, vel, t, r.duration)
    }

    // toArray() returns Uint8Array<ArrayBufferLike>; copy into a fresh
    // ArrayBuffer so callers (Blob, parseMidi) get a guaranteed plain
    // ArrayBuffer regardless of platform-specific lib typings.
    const arr = midi.toArray()
    const buf = new ArrayBuffer(arr.length)
    new Uint8Array(buf).set(arr)
    return buf
  }

  download(id: string): void {
    const buf = this.toArrayBuffer(id)
    if (!buf) return
    const r = this.recordings.find((r) => r.id === id)
    if (!r) return
    const blob = new Blob([buf], { type: 'audio/midi' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = r.name.endsWith('.mid') ? r.name : `${r.name}.mid`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  addListener(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  /**
   * Subscribe to "a new recording was just finalized". Fires once per
   * non-empty `stop()`. Empty stops do NOT fire this — they're surfaced
   * via `addEmptyStopListener` in `recordControl.ts` instead, since the
   * recorder discards them with no payload to hand out.
   */
  addFinalizedListener(fn: (r: Recording) => void): () => void {
    this.finalizedListeners.add(fn)
    return () => {
      this.finalizedListeners.delete(fn)
    }
  }

  private notify(): void {
    this.listeners.forEach((l) => l())
  }
}

function defaultFilename(epochMs: number = Date.now()): string {
  const d = new Date(epochMs)
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
    d.getHours(),
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return `notefall-${stamp}.mid`
}

export const recorder = new RecorderManager()

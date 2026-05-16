import * as Tone from 'tone'
import type { ParsedSong } from '../midi/types'
import {
  buildSpeedMap,
  EMPTY_SPEED_MAP,
  midiToTimeline,
  timelineToMidi,
  type SpeedMap,
  type SpeedPoint,
} from '../midi/speedMap'
import {
  createPiano,
  type PianoInstrument,
  type LoadProgress,
} from './sampler'
import { now } from './clock'
import {
  DEFAULT_VELOCITY_CURVE,
  clampVelocityCurve,
  evaluateVelocityCurve,
  type VelocityCurve,
} from './velocityCurve'
import { DEFAULT_VELOCITY_COMPENSATION } from './salamanderDescriptor'

type ActiveNote = {
  id: number
  midi: number
  endTime: number
  stop: (time?: number) => void
}

/**
 * Buffer in seconds added when calling `stop` so it always lands after the
 * scheduled `start` time (which uses a 15 ms lookahead). Without this,
 * `voice.stop()` defaults to `ctx.currentTime` and — if the note's start was
 * scheduled in the future — the source is cancelled before it ever plays.
 * Symptom: silently dropped notes at high playback speed when many notes
 * collapse into a single frame.
 */
const STOP_BUFFER = 0.02

/**
 * Background-tab ticking. `requestAnimationFrame` (which drives `useFrame`
 * → `tick()`) is paused while `document.hidden = true`, so notes scheduled
 * during the hidden period pile up and burst at once on return. A Web Worker
 * timer is exempt from main-thread throttling and keeps the scheduler running.
 * 25 ms gives ~40 Hz tick rate, well within the 15 ms audio lookahead window.
 */
const TICK_INTERVAL_MS = 25

/**
 * Tail of song time we keep ticking after the last MIDI event before stopping
 * playback (when loop is off). Lets the in-flight visuals — falling notes
 * still rising/landing, hit-line particles (~2.5s lifetime by default),
 * landing flashes — and the reverb wash play out instead of getting cut
 * off. Tuned to be just longer than the longest natural decay so the player
 * doesn't feel stuck waiting at 100%. Loop mode bypasses this so the loop
 * point is exactly the song end with no audible gap.
 */
const SONG_TAIL_SECONDS = 5

/** Note triggered live by the user (touch/click), independent of song timeline. */
export type LiveNote = {
  id: number
  midi: number
  velocity: number
  startTime: number // clock.now() at trigger
  endTime: number | null // null while still held
}

export type KeyEventListener = (
  event:
    | {
        type: 'on'
        midi: number
        velocity: number
        songTime: number
        /** Source track index for song-driven notes; undefined for
         *  live input (touch / MIDI device / PC keyboard) and previews.
         *  Visual subsystems (particles, key glow) use this to resolve
         *  the per-track colour from settings.trackColors. */
        track?: number
      }
    | { type: 'off'; midi: number; songTime: number },
) => void

/**
 * Subscriber for "live" input events — fires only for user-initiated input
 * (PC keyboard, on-screen keyboard, physical MIDI device), NOT for song
 * playback. `time` is `clock.now()` at the moment the event
 * was generated. The recorder uses this to capture only what the user
 * actually played.
 */
export type LiveInputListener = (
  event:
    | { type: 'noteOn'; midi: number; velocity: number; time: number }
    | { type: 'noteOff'; midi: number; time: number }
    | { type: 'pedal'; down: boolean; time: number },
) => void

/**
 * Self-driven scheduler. Visual layer reads currentSongTime() each frame and
 * also calls tick() to push due events to the sampler.
 */
export class AudioEngine {
  private piano: PianoInstrument | null = null
  private song: ParsedSong | null = null

  private playing = false
  private startedAt = 0 // clock.now() at last play
  private offsetAtStart = 0 // song time at startedAt

  private rate = 1
  private pedalEnabled = true
  // Master gain — multiplies both sampler and user-audio output.
  private masterVolume = 0.5
  // MIDI sampler-only gain. Applied as `master × midi × (enabled?1:0)`
  // before reaching `piano.setVolume`.
  private midiVolume = 1.0
  private midiEnabled = true
  private loop = false
  private reverbEnabled = true
  private reverbDry = 1.0
  private reverbWet = 1.0
  private reverbSize = 3.0
  private reverbDecayTime = 2.2
  private reverbDecay = 1.0
  private reverbPreDelay = 0.03
  private reverbDamping = 0.4
  private reverbHiCut = 6000
  private reverbLowCut = 100
  private releaseTime = 0.3
  private detuneCents = 0
  private eqBandsDb: number[] = [0, 0, 0, 0, 0, 0]
  // Velocity shaping applied to every triggered note (song + live + touch).
  // See `audio/velocityCurve.ts` for the curve format.
  private velocityCurve: VelocityCurve = DEFAULT_VELOCITY_CURVE
  // How much of smplr's built-in quadratic velocity-to-gain we cancel
  // out via per-layer group volume. See
  // `salamanderDescriptor.applyVelocityCompensation`.
  private velocityCompensation = DEFAULT_VELOCITY_COMPENSATION
  // Pitch shift in semitones. Applied to song notes here; live MIDI input
  // applies its own copy in midiInput.ts before calling triggerKey, and
  // screen-keyboard touches stay un-shifted (the user clicks visible keys).
  private transpose = 0

  private noteIdx = 0
  private pedalIdx = 0
  private pedalDown = false // raw MIDI pedal state at current song time
  // Live pedal from the user's physical MIDI device. Independent of the
  // song's pedal events and of `pedalEnabled` (the user's physical pedal
  // should always work even when the song's pedal track is muted).
  private livePedalDown = false

  // notes currently sounding (key still held)
  private active = new Map<number, ActiveNote>()
  // notes whose key was released but a pedal is holding the dampers up.
  // `source` records WHICH pedal is sustaining the note so we can release
  // only the right entries when one of the pedals goes up while the other
  // stays down.
  private pedalHeld: Array<{
    midi: number
    stop: (time?: number) => void
    source: 'song' | 'live'
  }> = []

  private listeners = new Set<KeyEventListener>()
  private liveListeners = new Set<LiveInputListener>()

  // Silent / export-only playback. When true, `tick()` emits keyboard
  // listener events (so the visual layer paints the same scene it
  // would during live playback at this song time) but never touches
  // the sampler, AudioContext, or pedal-held audio queue. The video
  // exporter sets this between `beginExportPlayback` and
  // `endExportPlayback`. End-of-song auto-stop is also skipped — the
  // export driver decides when the timeline ends.
  private silent = false
  // Saved values needed to restore the engine after an export pass.
  // Populated by beginExportPlayback, drained by endExportPlayback.
  private savedExportState: {
    rate: number
  } | null = null

  // user-triggered notes (touch/click on the keyboard)
  private liveNotes: LiveNote[] = []
  private liveIdCounter = 0
  // map liveNote.id → its smplr stop fn
  private liveStops = new Map<number, () => void>()

  // Worker-driven ticker that keeps scheduling alive in background tabs
  private tickWorker: Worker | null = null
  private tickWorkerUrl: string | null = null

  // Cached in-flight init. Concurrent callers (e.g. one click triggers
  // a preview while another click triggers another preview before the
  // sampler finishes loading) all share this single promise instead of
  // each kicking off their own ~60 MB sample download.
  private initPromise: Promise<void> | null = null

  // ── User-provided accompaniment audio (WAV / MP3 / etc.) ──
  // The decoded buffer + sync offset + volume; the buffer is also used by
  // the offline export pipeline. Realtime playback is wired through a
  // dedicated GainNode so volume changes don't restart the source.
  private userAudioBuffer: AudioBuffer | null = null
  private userAudioOffsetSec = 0
  private userAudioVolume = 1
  // Sync offset for the MIDI track. Shifts the entire song forward in
  // timeline-time so the user can drag the MIDI clip relative to the
  // accompaniment audio. Notes still compare against MIDI-time
  // internally (`n.time` is unchanged); the offset is applied only at
  // the timeline-time ↔ MIDI-time boundary in `tick()`, `seek()`, and
  // `recomputeIndices()`.
  private midiOffsetSec = 0
  private userAudioGain: GainNode | null = null
  private userAudioSource: AudioBufferSourceNode | null = null
  // Non-destructive trim — `[start, end]` window into the underlying
  // MIDI / audio. `end = null` means "use natural end". Trim is in the
  // respective source's own time coordinate: MIDI-time for the MIDI
  // trim, buffer-time (seconds into the decoded AudioBuffer) for the
  // audio trim.
  private midiTrimStart = 0
  private midiTrimEnd: number | null = null
  private userAudioTrimStart = 0
  private userAudioTrimEnd: number | null = null
  // End of any non-audio external media on the timeline (currently the
  // hand video) in song-time seconds. Lets the timeline be scrubbed /
  // played to that extent even with no MIDI and no user audio loaded —
  // otherwise `seek()` clamps to 0 and the playhead sticks at the
  // start. 0 = nothing extra. Set from the Layout sync effect.
  private externalMediaEndSec = 0
  // Speed automation curve. Only affects MIDI playback / scheduling;
  // user audio plays at constant rate. See `midi/speedMap.ts` for the
  // coordinate-mapping conventions.
  private speedMap: SpeedMap = EMPTY_SPEED_MAP

  async init(onProgress?: (p: LoadProgress) => void): Promise<void> {
    if (this.piano) return
    if (this.initPromise) return this.initPromise
    this.initPromise = (async () => {
      try {
        this.piano = await createPiano(undefined, onProgress)
        this.piano.setVolume(this.effectiveSamplerVolume())
        this.piano.setReverbSize(this.reverbSize)
        this.piano.setReverbDecayTime(this.reverbDecayTime)
        this.piano.setReverbDecay(this.reverbDecay)
        this.piano.setReverbPreDelay(this.reverbPreDelay)
        this.piano.setReverbDamping(this.reverbDamping)
        this.piano.setReverbHiCut(this.reverbHiCut)
        this.piano.setReverbLowCut(this.reverbLowCut)
        this.piano.setReverbDry(this.reverbDry)
        this.piano.setReverbWet(this.effectiveWet())
        this.piano.setReleaseTime(this.releaseTime)
        this.piano.setDetune(this.detuneCents)
        this.piano.setVelocityCompensation(this.velocityCompensation)
        this.eqBandsDb.forEach((db, i) => this.piano!.setEqBand(i, db))
      } finally {
        this.initPromise = null
      }
    })()
    return this.initPromise
  }

  isReady(): boolean {
    return this.piano !== null
  }

  /**
   * Master volume — multiplies both the MIDI sampler and the user
   * accompaniment. Equivalent to a "main fader" the user can pull
   * down to silence the whole mix without losing per-source levels.
   */
  setVolume(value: number): void {
    this.masterVolume = value
    this.applyVolumes()
  }

  /** MIDI-only volume. Stacks with master before reaching the sampler. */
  setMidiVolume(value: number): void {
    this.midiVolume = Math.max(0, value)
    this.applyVolumes()
  }

  /**
   * Mute / unmute the MIDI sampler without touching its volume value
   * — toggling back keeps the previously-set midi gain intact. The
   * visual layer (falling notes, key glow, particles) continues to
   * fire either way; only the sampler audio is gated.
   */
  setMidiEnabled(enabled: boolean): void {
    this.midiEnabled = enabled
    this.applyVolumes()
  }

  private effectiveSamplerVolume(): number {
    return this.midiEnabled ? this.masterVolume * this.midiVolume : 0
  }

  /**
   * Recompute and push down the per-source effective gains. Cheap
   * (just a few multiplies + property writes) so we run it on every
   * volume / mute change instead of caching.
   */
  private applyVolumes(): void {
    this.piano?.setVolume(this.effectiveSamplerVolume())
    if (this.userAudioGain) {
      const ctx = this.userAudioGain.context
      const target = this.masterVolume * this.userAudioVolume
      this.userAudioGain.gain.setTargetAtTime(target, ctx.currentTime, 0.01)
    }
  }

  setReverbEnabled(enabled: boolean): void {
    this.reverbEnabled = enabled
    this.piano?.setReverbWet(this.effectiveWet())
  }

  setReverbDry(level: number): void {
    this.reverbDry = level
    this.piano?.setReverbDry(level)
  }

  setReverbWet(level: number): void {
    this.reverbWet = level
    this.piano?.setReverbWet(this.effectiveWet())
  }

  private effectiveWet(): number {
    return this.reverbEnabled ? this.reverbWet : 0
  }

  setReverbSize(seconds: number): void {
    this.reverbSize = seconds
    this.piano?.setReverbSize(seconds)
  }

  setReverbDecayTime(seconds: number): void {
    this.reverbDecayTime = seconds
    this.piano?.setReverbDecayTime(seconds)
  }

  setReverbDecay(decay: number): void {
    this.reverbDecay = decay
    this.piano?.setReverbDecay(decay)
  }

  setReverbPreDelay(seconds: number): void {
    this.reverbPreDelay = seconds
    this.piano?.setReverbPreDelay(seconds)
  }

  setReverbDamping(amount: number): void {
    this.reverbDamping = amount
    this.piano?.setReverbDamping(amount)
  }

  setReverbHiCut(hz: number): void {
    this.reverbHiCut = hz
    this.piano?.setReverbHiCut(hz)
  }

  setReverbLowCut(hz: number): void {
    this.reverbLowCut = hz
    this.piano?.setReverbLowCut(hz)
  }

  setReleaseTime(seconds: number): void {
    this.releaseTime = seconds
    this.piano?.setReleaseTime(seconds)
  }

  setDetune(cents: number): void {
    this.detuneCents = cents
    this.piano?.setDetune(cents)
  }

  setEqBand(index: number, db: number): void {
    if (index < 0 || index >= this.eqBandsDb.length) return
    this.eqBandsDb[index] = db
    this.piano?.setEqBand(index, db)
  }

  setVelocityCurve(curve: VelocityCurve): void {
    this.velocityCurve = clampVelocityCurve(curve)
  }
  setVelocityCompensation(c: number): void {
    this.velocityCompensation = Math.max(0, Math.min(1, c))
    this.piano?.setVelocityCompensation(this.velocityCompensation)
  }
  setTranspose(semitones: number): void {
    this.transpose = Math.round(semitones)
  }
  getTranspose(): number {
    return this.transpose
  }

  /**
   * Apply the user's velocity curve to a 0..1 velocity. The curve's
   * endpoints are fixed at (0,0) and (1,1); interior control points
   * shape the response (low-end lift, high-end ceiling, mid-range
   * compression/expansion).
   */
  private shapeVelocity(velocity: number): number {
    return evaluateVelocityCurve(this.velocityCurve, velocity)
  }

  setRate(rate: number): void {
    const t = this.currentSongTime()
    this.rate = Math.max(0.25, Math.min(4, rate))
    this.startedAt = now()
    this.offsetAtStart = t
    // Rate change must rebuild the user-audio source — `playbackRate` is
    // a constructor-time-stable AudioParam on AudioBufferSourceNode but
    // we restart anyway so the in-flight render stays sample-aligned
    // with the new rate from the current playhead. Cheap (just creates
    // a new source pointing at the same buffer).
    if (this.playing) this.restartUserAudioFromCurrent()
  }

  // ─────────── User audio (accompaniment track) ───────────

  /**
   * Attach (or detach with `null`) a decoded accompaniment buffer. The
   * buffer was decoded against a separate `AudioContext` in
   * `userAudio.ts` — `AudioBuffer` is portable across contexts so we
   * can schedule it against Tone's rawContext without a re-decode.
   * Restarts any in-flight playback so the new buffer becomes audible
   * from the current playhead.
   */
  setUserAudio(buffer: AudioBuffer | null): void {
    if (this.userAudioBuffer === buffer) return
    this.userAudioBuffer = buffer
    this.stopUserAudioSource()
    if (this.playing) this.startUserAudioFromCurrent()
  }

  /** Sync offset in seconds — audio's t=0 corresponds to this song time. */
  setUserAudioOffset(seconds: number): void {
    if (this.userAudioOffsetSec === seconds) return
    this.userAudioOffsetSec = seconds
    if (this.playing) this.restartUserAudioFromCurrent()
  }

  /**
   * Sync offset in seconds for the MIDI track — the song's t=0 plays
   * at this many seconds into the timeline. Mirror semantics of
   * `setUserAudioOffset`: timeline-time stays the canonical clock,
   * the MIDI is shifted relative to it.
   */
  setMidiOffset(seconds: number): void {
    if (this.midiOffsetSec === seconds) return
    this.midiOffsetSec = seconds
    // Re-walk indices so the next tick's `n.time <= midiSongTime`
    // comparison aligns to the new offset. Without this, dragging the
    // clip during pause would emit stale notes when play resumes.
    if (this.song) this.recomputeIndices(this.currentSongTime())
  }

  /**
   * Set the MIDI trim window. `start` / `end` are in MIDI-time
   * (matching `n.time`); `end = null` defers to `song.duration`.
   * Notes at `n.time < start` or `n.time >= end` are silenced (and
   * hidden by the visual layer). Notes that span `end` have their
   * note-off clamped to `end` so we don't get hanging sustain.
   * Re-walks the scheduling cursor so a change made mid-play is
   * picked up by the next tick.
   */
  setMidiTrim(start: number, end: number | null): void {
    if (this.midiTrimStart === start && this.midiTrimEnd === end) return
    this.midiTrimStart = start
    this.midiTrimEnd = end
    if (this.song) this.recomputeIndices(this.currentSongTime())
    // Active notes may now span the new trim end — clamp their
    // endTime so the next tick releases them on time. We don't emit
    // 'off' immediately; the tick's existing endTime≤songTime path
    // will, mirroring the normal note-off lifecycle.
    const effEnd = this.effectiveMidiTrimEnd()
    for (const a of this.active.values()) {
      if (a.endTime > effEnd) a.endTime = effEnd
    }
  }

  /**
   * Set the user-audio trim window. `start` / `end` are in
   * buffer-time (seconds into the decoded AudioBuffer); `end = null`
   * defers to `buffer.duration`. Restarts the source so the new
   * window takes effect immediately.
   */
  setUserAudioTrim(start: number, end: number | null): void {
    if (this.userAudioTrimStart === start && this.userAudioTrimEnd === end) return
    this.userAudioTrimStart = start
    this.userAudioTrimEnd = end
    if (this.playing) this.restartUserAudioFromCurrent()
  }

  private effectiveMidiTrimEnd(): number {
    return this.midiTrimEnd ?? (this.song?.duration ?? Number.POSITIVE_INFINITY)
  }

  private effectiveUserAudioTrimEnd(): number {
    return this.userAudioTrimEnd ?? (this.userAudioBuffer?.duration ?? 0)
  }

  /**
   * Replace the MIDI speed automation curve. Empty `points` resets to
   * constant 1.0. Active scheduling cursor is re-walked so the next
   * tick lands on the right note for the new curve. Note: changing
   * the curve during playback can cause the MIDI playhead to jump in
   * MIDI-time (user audio stays put, since timeline-time is the
   * shared anchor); minor edits near the playhead produce near-zero
   * jumps, so this only matters for sweeping mid-play edits.
   */
  setSpeedAutomation(points: readonly SpeedPoint[]): void {
    this.speedMap = buildSpeedMap(points)
    if (this.song) this.recomputeIndices(this.currentSongTime())
  }

  setUserAudioVolume(linear: number): void {
    this.userAudioVolume = Math.max(0, linear)
    // Stacks with masterVolume — `applyVolumes` does the multiply and
    // the smooth setTargetAtTime ramp.
    this.applyVolumes()
  }

  /**
   * End time of the user audio in song-time coordinates. 0 when no
   * buffer is loaded. Used by the UI to decide the timeline's right
   * edge (= max(song.duration, userAudioEnd)) and by `tick()` to
   * extend the auto-stop window past the audio's tail.
   */
  userAudioEndSec(): number {
    if (!this.userAudioBuffer) return 0
    return this.userAudioOffsetSec + this.effectiveUserAudioTrimEnd()
  }

  /** Timeline extent of external media (hand video). See the field
   *  comment. Drives `seek()`'s clamp and the auto-stop window so the
   *  timeline is navigable with only a hand video loaded. */
  setExternalMediaEndSec(sec: number): void {
    this.externalMediaEndSec = Math.max(0, sec)
  }

  private ensureUserAudioGain(): GainNode | null {
    if (this.userAudioGain) return this.userAudioGain
    // Tone's raw AudioContext is the only running context once the user
    // has triggered Tone.start(); reuse it so the user audio mixes
    // alongside the sampler. Before Tone is started there's nothing
    // playing yet — bail out and let the next `play()` call retry.
    const ctx = Tone.getContext().rawContext as AudioContext
    if (!ctx) return null
    const gain = ctx.createGain()
    gain.gain.value = this.masterVolume * this.userAudioVolume
    gain.connect(ctx.destination)
    this.userAudioGain = gain
    return gain
  }

  private stopUserAudioSource(): void {
    if (!this.userAudioSource) return
    try {
      this.userAudioSource.stop()
    } catch {
      /* already stopped — ignore */
    }
    this.userAudioSource.disconnect()
    this.userAudioSource = null
  }

  /**
   * Schedule the user audio source so that `currentSongTime()` already
   * reflects the playback position. Handles three regimes:
   *   - audio hasn't started yet (relPos < 0): delay source.start by |relPos|
   *   - audio is in-flight (0 ≤ relPos < duration): start now, seeking into the buffer
   *   - audio is past its end (relPos ≥ duration): nothing to play
   */
  private startUserAudioFromCurrent(): void {
    if (!this.userAudioBuffer) return
    const gain = this.ensureUserAudioGain()
    if (!gain) return
    const ctx = gain.context as AudioContext
    const songTime = this.currentSongTime()
    const relPos = songTime - this.userAudioOffsetSec
    // Trim defines the audible window into the buffer. Outside the
    // window the source produces silence — by passing `duration` to
    // `source.start` we let the audio graph stop the source for us
    // when the trim end is reached.
    const trimStart = Math.max(0, this.userAudioTrimStart)
    const trimEnd = Math.min(this.userAudioBuffer.duration, this.effectiveUserAudioTrimEnd())
    if (trimEnd <= trimStart) return
    if (relPos >= trimEnd) return

    const src = ctx.createBufferSource()
    src.buffer = this.userAudioBuffer
    // Match the song's playback rate so the accompaniment stays in
    // sync at non-1× speeds. Pitch will shift — that's expected for
    // a generic playbackRate slider; users who care about pitch can
    // export at 1× or use a future rubberband-style stretcher.
    src.playbackRate.value = this.rate
    src.connect(gain)
    if (relPos < trimStart) {
      // Trimmed-in head hasn't reached its in-point yet. Delay start
      // by the remaining gap (scaled by rate so a 1.5× tempo
      // proportionally shortens the wait) and play the whole trim
      // window from its in-point.
      const delay = (trimStart - relPos) / this.rate
      src.start(ctx.currentTime + delay, trimStart, trimEnd - trimStart)
    } else {
      // Inside the trim window. Buffer offset = current playhead
      // position; remaining duration = trimEnd - relPos.
      src.start(ctx.currentTime, relPos, trimEnd - relPos)
    }
    this.userAudioSource = src
  }

  private restartUserAudioFromCurrent(): void {
    this.stopUserAudioSource()
    this.startUserAudioFromCurrent()
  }

  setPedalEnabled(enabled: boolean): void {
    this.pedalEnabled = enabled
    // Only release song-pedal-held notes — the user's physical pedal still
    // governs live notes regardless of this song-side toggle.
    if (!enabled) this.flushPedalHeld('song')
  }

  /**
   * Live pedal state from the user's MIDI device. Calls from the MIDI input
   * layer when CC#64 crosses the 64-value threshold.
   */
  setLivePedalDown(down: boolean): void {
    if (this.livePedalDown === down) return
    this.livePedalDown = down
    if (!down) this.flushPedalHeld('live')
    this.emitLive({ type: 'pedal', down, time: now() })
  }

  setLoop(loop: boolean): void {
    this.loop = loop
  }

  loadSong(song: ParsedSong): void {
    this.releaseAll()
    this.stopUserAudioSource()
    this.song = song
    this.noteIdx = 0
    this.pedalIdx = 0
    this.pedalDown = false
    this.offsetAtStart = 0
    this.startedAt = now()
    this.playing = false
  }

  /**
   * Replace the current song with an edited version while preserving the
   * playhead. Used by the in-app MIDI editor: the user mutates the loaded
   * song in place (delete / move / add notes) and we need the engine's
   * scheduling cursor to track the new note array.
   *
   * Active-note handling is selective on purpose: editing an unrelated
   * note shouldn't kill the visualizer state of an in-flight note. We
   * keep active entries whose corresponding note in the new song is
   * structurally unchanged (same id, same playedMidi, same endTime),
   * and only emit off + drop entries whose note was deleted or whose
   * timing/pitch changed. The engine's tick then naturally fires
   * note-off when each surviving in-flight note's endTime passes —
   * exactly as it would have if the user hadn't edited at all.
   */
  updateSong(song: ParsedSong): void {
    const t = this.currentSongTime()
    const newById = new Map<number, ParsedSong['notes'][number]>()
    for (const n of song.notes) newById.set(n.id, n)
    for (const a of Array.from(this.active.values())) {
      const next = newById.get(a.id)
      const unchanged =
        next !== undefined &&
        next.midi + this.transpose === a.midi &&
        next.time + next.duration === a.endTime
      if (!unchanged) {
        this.emit({ type: 'off', midi: a.midi, songTime: t })
        this.active.delete(a.id)
      }
    }
    // Pedal-held entries don't carry a note id, so we can't filter them
    // by what changed in the edit. Leave them — they'll release when
    // the pedal flips or when the song's pedal track is muted.
    this.song = song
    this.recomputeIndices(t)
  }

  /**
   * Clear the loaded song so the visual layer (falling notes) draws nothing
   * and the engine has no scheduled events. Used when starting a fresh
   * recording — the previously-loaded MIDI shouldn't sit on screen as an
   * implicit backing track.
   */
  unloadSong(): void {
    this.releaseAll()
    this.stopUserAudioSource()
    this.song = null
    this.noteIdx = 0
    this.pedalIdx = 0
    this.pedalDown = false
    this.offsetAtStart = 0
    this.startedAt = now()
    this.playing = false
  }

  async play(): Promise<void> {
    // Playable with no MIDI when there's external media (hand video) to
    // run the clock against — the tick loop's note scan is already
    // song-guarded, so it's a no-op then and only the visual clock
    // advances.
    if (!this.song && this.externalMediaEndSec <= 0) return
    if (Tone.getContext().state !== 'running') {
      await Tone.start()
    }
    this.startedAt = now()
    this.playing = true
    this.startBackgroundTicker()
    this.startUserAudioFromCurrent()
  }

  pause(): void {
    if (!this.playing) return
    const t = this.currentSongTime()
    this.offsetAtStart = t
    this.playing = false
    // Audio off, but visualizer state (key glow, landing flash, hit
    // particles) is intentionally preserved — pausing should freeze
    // the moment, not wipe the on-screen state. The "stuck forever"
    // bug after pause + edit + resume is handled inside updateSong
    // (which emits off for the in-flight notes when the song
    // structure changes underneath them).
    this.releaseAllSounding()
    this.stopBackgroundTicker()
    this.stopUserAudioSource()
  }

  stop(): void {
    this.playing = false
    this.offsetAtStart = 0
    this.noteIdx = 0
    this.pedalIdx = 0
    this.pedalDown = false
    this.releaseAll()
    this.stopBackgroundTicker()
    this.stopUserAudioSource()
  }

  seek(tlAudio: number): void {
    const wasPlaying = this.playing
    // `tlAudio` is the engine's INTERNAL time axis (wall-clock × rate
    // since playback start). Aligned with the AudioContext schedule
    // and what the SeekBar shows as "elapsed time". For the diff-
    // based release/retrigger logic below we also need the
    // corresponding MIDI-time, which goes through the inverse speed
    // map.
    const songDur = this.song?.duration ?? 0
    const midiEndTimeline = midiToTimeline(this.speedMap, songDur)
    const dur = Math.max(
      midiEndTimeline + this.midiOffsetSec,
      this.userAudioEndSec(),
      this.externalMediaEndSec,
    )
    const clamped = Math.max(0, Math.min(dur, tlAudio))
    const midiClamped = timelineToMidi(
      this.speedMap,
      clamped - this.midiOffsetSec,
    )

    // Diff-based release/retrigger so notes that span the new playback
    // position stay sounding (and stay represented in the visual layer's
    // listeners — particles, key glow, landing flash). A naive
    // releaseAll-then-recompute would silently drop spanning notes from
    // `active`, never emit 'on' for them, and leave the visualisations
    // empty until the next song-event cursor. Diffing also avoids
    // re-attacking those same notes on every drag-tick during a live
    // seek-bar drag (no audible attack-spam).
    const newActiveIds = new Set<number>()
    const seekTrimStart = this.midiTrimStart
    const seekTrimEnd = this.effectiveMidiTrimEnd()
    if (this.song) {
      for (const n of this.song.notes) {
        if (n.time > midiClamped) break
        if (n.time < seekTrimStart) continue
        if (n.time >= seekTrimEnd) continue
        // Use the trim-clamped end so a note whose natural release
        // sits past trimEnd doesn't get re-triggered for the silent
        // tail. Touching boundaries (`>` not `>=`) keeps spanning
        // notes sounding consistently with the normal tick path.
        const effEnd = Math.min(n.time + n.duration, seekTrimEnd)
        if (effEnd > midiClamped) newActiveIds.add(n.id)
      }
    }

    const ctxNow = this.piano?.context.currentTime ?? 0
    const stopAt = ctxNow + STOP_BUFFER
    const audioBase = ctxNow + 0.015

    // Release active notes no longer sounding at the new position.
    for (const a of [...this.active.values()]) {
      if (!newActiveIds.has(a.id)) {
        a.stop(stopAt)
        this.emit({ type: 'off', midi: a.midi, songTime: clamped })
        this.active.delete(a.id)
      }
    }

    // Pedal-held notes: always cleared on seek (they were tied to the
    // pedal-on context at the previous time, which no longer applies).
    for (const h of this.pedalHeld) {
      h.stop(stopAt)
      this.emit({ type: 'off', midi: h.midi, songTime: clamped })
    }
    this.pedalHeld = []

    // Live (user-played) notes: always cleared on seek.
    const liveNow = now()
    for (const n of this.liveNotes) {
      if (n.endTime === null) {
        n.endTime = liveNow
        this.emit({ type: 'off', midi: n.midi, songTime: clamped })
      }
    }
    for (const stop of this.liveStops.values()) stop()
    this.liveStops.clear()

    // Trigger newly-spanning song notes (not already in `active`). Each
    // gets a normal note-on so listeners (particles / glow / flash) react,
    // and audio is started at the new context time so the user hears what
    // would be sounding at this moment in the song.
    if (this.song && this.piano) {
      for (const n of this.song.notes) {
        if (n.time > midiClamped) break
        if (!newActiveIds.has(n.id)) continue
        if (this.active.has(n.id)) continue
        const playedMidi = n.midi + this.transpose
        if (playedMidi < 0 || playedMidi > 127) continue
        const shaped = this.shapeVelocity(n.velocity)
        const stopFn = this.piano.start(playedMidi, shaped, audioBase, `s${n.id}`)
        const endTime = Math.min(n.time + n.duration, seekTrimEnd)
        this.active.set(n.id, { id: n.id, midi: playedMidi, endTime, stop: stopFn })
        this.emit({ type: 'on', midi: playedMidi, velocity: shaped, songTime: clamped, track: n.track })
      }
    }

    this.offsetAtStart = clamped
    this.startedAt = now()
    this.recomputeIndices(clamped)
    this.playing = wasPlaying

    // Restart the accompaniment source at the new position so it
    // tracks the seek instead of continuing from the old playhead.
    this.stopUserAudioSource()
    if (wasPlaying) this.startUserAudioFromCurrent()
  }

  isPlaying(): boolean {
    return this.playing
  }

  /**
   * The engine's INTERNAL playback clock — TL_audio. Advances at
   * `rate × wall-clock` from `startedAt`. This is the time axis the
   * audio context is actually scheduled against; it's NOT the
   * timeline shown in the UI (which is in natural MIDI-time when
   * speed automation is active).
   *
   * Callers that need "where the cursor should sit on the UI
   * timeline" want `currentDisplayTime()` instead.
   */
  currentSongTime(): number {
    if (!this.playing) return this.offsetAtStart
    const wall = now()
    return this.offsetAtStart + (wall - this.startedAt) * this.rate
  }

  /**
   * MIDI-time playhead — the MIDI position the sampler is currently
   * voicing. Routes the TL_audio clock through the inverse speed
   * map. Visual code that compares against `n.time` (e.g. note
   * highlighting at the cursor) reads this. Falling-note placement
   * does NOT — see `midiTimeToTimeline` for the "constant descent
   * rate" model.
   */
  currentMidiTime(): number {
    return timelineToMidi(this.speedMap, this.currentSongTime() - this.midiOffsetSec)
  }

  /**
   * Cursor position on the natural-duration UI timeline = MIDI-time
   * of audio playhead, shifted by the configured MIDI clip offset.
   * Advances at the speed-curve-adjusted rate so the cursor sits at
   * the MIDI position the user is actually hearing.
   *
   * The UI's seek bar / timeline cursor / time readout all use THIS,
   * not `currentSongTime()`, so the timeline doesn't visually
   * stretch with the speed curve.
   */
  currentDisplayTime(): number {
    return this.midiOffsetSec + this.currentMidiTime()
  }

  /**
   * Convert a MIDI-time position to its TL_audio firing moment
   * (offset + map(midiTime)). Used by the visual layer to compute
   * each falling note's "wall-clock seconds until it lands", which
   * is what keeps the descent rate constant regardless of the speed
   * curve. With no automation this collapses to `offset + midiTime`.
   */
  midiTimeToTimeline(midiTime: number): number {
    return this.midiOffsetSec + midiToTimeline(this.speedMap, midiTime)
  }

  /** Returns a shallow snapshot of the current speed map for callers
   *  that need to render the curve (Timeline editor). The internal
   *  map is treated as immutable, so the snapshot doesn't need to be
   *  defensively copied. */
  getSpeedMap(): SpeedMap {
    return this.speedMap
  }

  isPedalDown(): boolean {
    return this.pedalDown && this.pedalEnabled
  }

  /**
   * Trigger a note from the user (touch/click). Returns a release function.
   * Returns null if the piano isn't loaded yet.
   */
  triggerKey(midi: number, velocity = 0.75): { id: number; release: () => void } | null {
    if (!this.piano) return null
    const id = this.liveIdCounter++
    const shaped = this.shapeVelocity(velocity)
    const stopFn = this.piano.start(midi, shaped, undefined, `live${id}`)
    const startTime = now()
    const note: LiveNote = { id, midi, velocity: shaped, startTime, endTime: null }
    this.liveNotes.push(note)
    this.liveStops.set(id, stopFn)
    this.emit({ type: 'on', midi, velocity, songTime: this.currentSongTime() })
    this.emitLive({ type: 'noteOn', midi, velocity, time: startTime })

    return {
      id,
      release: () => {
        if (note.endTime !== null) return
        note.endTime = now()
        const stopTime = (this.piano?.context.currentTime ?? 0) + STOP_BUFFER
        // Live notes are sustained by either pedal source. Tag with whichever
        // is currently down — live takes precedence when both are pressed,
        // since the physical pedal is the more direct controller.
        if (this.livePedalDown) {
          this.pedalHeld.push({ midi, stop: stopFn, source: 'live' })
        } else if (this.pedalEnabled && this.pedalDown) {
          this.pedalHeld.push({ midi, stop: stopFn, source: 'song' })
        } else {
          stopFn(stopTime)
        }
        this.liveStops.delete(id)
        this.emit({ type: 'off', midi, songTime: this.currentSongTime() })
        this.emitLive({ type: 'noteOff', midi, time: note.endTime })
      },
    }
  }

  /** Live notes currently visible / recently played (for visualization). */
  getLiveNotes(): readonly LiveNote[] {
    return this.liveNotes
  }

  // Monotonic counter for the unique smplr stopId of preview triggers.
  // A preview's stopId must not collide with `s${songId}` or `live${liveId}`,
  // otherwise stopping a preview could cancel a real sounding note.
  private previewIdCounter = 0

  /**
   * Brief audible cue for the editor — used when the user clicks a falling
   * note (or drags it to a new pitch) to confirm the action audibly. Does
   * NOT emit key listener events and is NOT added to liveNotes, so:
   *   • the keyboard's press-glow stays dark
   *   • LandingFlashes / HitParticles stay quiet
   *   • a "live" rising falling-note bar is not drawn
   * Returns silently when the sampler hasn't been initialised yet — the
   * caller is responsible for kicking off the load (see audio/preview.ts).
   */
  triggerPreview(midi: number, velocity = 0.7, durationMs = 200): void {
    if (!this.piano) return
    const shaped = this.shapeVelocity(velocity)
    const id = this.previewIdCounter++
    const stopFn = this.piano.start(midi, shaped, undefined, `prev-${id}`)
    // setTimeout is fine here — the stop call doesn't need sample-accurate
    // timing for an audible-cue note, and we already pad smplr's stop with
    // STOP_BUFFER internally for the AudioContext-side schedule.
    setTimeout(() => stopFn(), Math.max(40, durationMs))
  }

  private cleanupLiveNotes(): void {
    const nowSec = now()
    // retain held notes always; drop released notes after 10s (well past any reasonable fall window)
    this.liveNotes = this.liveNotes.filter((n) => n.endTime === null || nowSec - n.endTime < 10)
  }

  addKeyListener(fn: KeyEventListener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  addLiveListener(fn: LiveInputListener): () => void {
    this.liveListeners.add(fn)
    return () => this.liveListeners.delete(fn)
  }

  private emit(ev: Parameters<KeyEventListener>[0]): void {
    this.listeners.forEach((l) => l(ev))
  }

  private emitLive(ev: Parameters<LiveInputListener>[0]): void {
    this.liveListeners.forEach((l) => l(ev))
  }

  private flushPedalHeld(source: 'song' | 'live' | 'all' = 'all'): void {
    const stopTime = (this.piano?.context.currentTime ?? 0) + STOP_BUFFER
    if (source === 'all') {
      for (const h of this.pedalHeld) h.stop(stopTime)
      this.pedalHeld = []
      return
    }
    const remaining: typeof this.pedalHeld = []
    for (const h of this.pedalHeld) {
      if (h.source === source) {
        h.stop(stopTime)
      } else {
        remaining.push(h)
      }
    }
    this.pedalHeld = remaining
  }

  private startBackgroundTicker(): void {
    if (this.tickWorker || typeof Worker === 'undefined') return
    try {
      const code = `setInterval(() => postMessage(0), ${TICK_INTERVAL_MS})`
      const blob = new Blob([code], { type: 'application/javascript' })
      this.tickWorkerUrl = URL.createObjectURL(blob)
      this.tickWorker = new Worker(this.tickWorkerUrl)
      this.tickWorker.onmessage = () => this.tick()
    } catch {
      /* fall back to rAF-only ticking when Worker construction fails */
    }
  }

  private stopBackgroundTicker(): void {
    this.tickWorker?.terminate()
    this.tickWorker = null
    if (this.tickWorkerUrl) {
      URL.revokeObjectURL(this.tickWorkerUrl)
      this.tickWorkerUrl = null
    }
  }

  private releaseAll(): void {
    this.piano?.stopAll()
    const t = this.currentSongTime()
    for (const a of this.active.values()) {
      this.emit({ type: 'off', midi: a.midi, songTime: t })
    }
    this.active.clear()
    for (const h of this.pedalHeld) {
      this.emit({ type: 'off', midi: h.midi, songTime: t })
    }
    this.pedalHeld = []
    // also mark live notes as released (audio already stopped via stopAll)
    const nowSec = now()
    for (const n of this.liveNotes) {
      if (n.endTime === null) {
        n.endTime = nowSec
        this.emit({ type: 'off', midi: n.midi, songTime: t })
      }
    }
    this.liveStops.clear()
  }

  private releaseAllSounding(): void {
    this.piano?.stopAll()
  }

  /** Walks the song's note + pedal arrays to bring the scheduling
   *  cursors (`noteIdx` / `pedalIdx`) up to the current playhead, so
   *  the next `tick()` resumes from the right point.
   *
   *  `songTime` is timeline-time (the same coordinate space as
   *  `currentSongTime()`). Internally we shift it back to MIDI-time
   *  via `midiOffsetSec` so `n.time` and `pedal.time` (still stored in
   *  MIDI-time) compare correctly. Negative MIDI-times collapse to 0
   *  — the cursor then sits at the start of the song. */
  private recomputeIndices(songTime: number): void {
    // Timeline-time → MIDI-time via the speed automation curve. With
    // no curve this collapses to the linear subtract.
    const midiSongTime = timelineToMidi(
      this.speedMap,
      songTime - this.midiOffsetSec,
    )
    if (!this.song) return
    let ni = 0
    while (ni < this.song.notes.length && this.song.notes[ni].time <= midiSongTime) ni++
    this.noteIdx = ni

    let pi = 0
    let pedalDown = false
    while (pi < this.song.pedals.length && this.song.pedals[pi].time <= midiSongTime) {
      pedalDown = this.song.pedals[pi].value >= 0.5
      pi++
    }
    this.pedalIdx = pi
    this.pedalDown = pedalDown
  }

  /** Called every frame from the visual loop, plus from the background-tab worker. */
  tick(): void {
    this.cleanupLiveNotes()
    if (!this.song || !this.playing) return
    // In silent mode (export pass) we operate without a sampler — the
    // tick still walks the song to fire listener events for the
    // visual layer, but no audio is scheduled.
    if (!this.silent && !this.piano) return
    if (!this.silent && this.piano) {
      // Some browsers suspend the AudioContext on background tabs even with
      // sources active; nudge it back to running so scheduled notes still fire.
      // The realtime engine always runs against an AudioContext (Tone's
      // rawContext). Cast for the resume() call which is not on
      // BaseAudioContext.
      const realCtx = this.piano.context as AudioContext
      if (realCtx.state === 'suspended') {
        realCtx.resume().catch(() => {})
      }
    }
    const songTime = this.currentSongTime()
    // Notes + pedals are stored in MIDI-time. With speed automation
    // the timeline ↔ MIDI relationship is non-linear, so we go
    // through the speed map. Without a curve, `timelineToMidi` is
    // the identity, leaving this equivalent to the legacy subtract.
    const midiSongTime = timelineToMidi(
      this.speedMap,
      songTime - this.midiOffsetSec,
    )

    // process pedal events
    while (this.pedalIdx < this.song.pedals.length && this.song.pedals[this.pedalIdx].time <= midiSongTime) {
      const ev = this.song.pedals[this.pedalIdx]
      const wasDown = this.pedalDown
      this.pedalDown = ev.value >= 0.5
      // pedal lifted: release all pedal-held notes
      if (wasDown && !this.pedalDown && this.pedalEnabled) {
        this.flushPedalHeld()
      }
      this.pedalIdx++
    }

    // process note ons. Schedule a small lookahead in the AudioContext clock
    // so the sample starts on a clean buffer boundary instead of mid-quantum
    // — this is what causes the audible "click" at note start.
    const LOOKAHEAD = 0.015
    const audioBase =
      !this.silent && this.piano ? this.piano.context.currentTime + LOOKAHEAD : 0
    const trimStart = this.midiTrimStart
    const trimEnd = this.effectiveMidiTrimEnd()
    while (this.noteIdx < this.song.notes.length && this.song.notes[this.noteIdx].time <= midiSongTime) {
      const n = this.song.notes[this.noteIdx]
      this.noteIdx++
      // Trim filter — notes outside the configured window are silently
      // skipped. Head-trim (`n.time < trimStart`) just drops the note;
      // tail-trim (`n.time >= trimEnd`) does too, but the natural
      // end-of-song detection below still uses the trimmed end so we
      // don't hold playback open waiting for notes that will never
      // fire.
      if (n.time < trimStart) continue
      if (n.time >= trimEnd) continue
      // Apply transpose to the played pitch. Out-of-range notes after
      // shifting are silently dropped (no audio + no glow); the falling
      // note for them is also clipped on the visualization side.
      const playedMidi = n.midi + this.transpose
      if (playedMidi < 0 || playedMidi > 127) continue
      // Notes that are slightly overdue still align to the same lookahead floor,
      // notes scheduled close to "on time" land precisely. The delay
      // must be measured in TIMELINE-time (which `audioBase` lives
      // in) — going through the speed map keeps the offset accurate
      // when the upcoming MIDI-time region is at a non-unity speed.
      const noteTimelineRel = midiToTimeline(this.speedMap, n.time)
      const currentTimelineRel = songTime - this.midiOffsetSec
      const offset = Math.max(0, (noteTimelineRel - currentTimelineRel) / this.rate)
      // Unique stopId per note prevents cross-talk when the same pitch repeats
      // close enough that voices overlap in smplr's voice manager.
      const shaped = this.shapeVelocity(n.velocity)
      const stopFn =
        this.silent || !this.piano
          ? noopStop
          : this.piano.start(playedMidi, shaped, audioBase + offset, `s${n.id}`)
      // Clamp note-off to the trim end so a note that originally
      // extended past the tail trim gets cut at the trim boundary
      // instead of sustaining indefinitely.
      const endTime = Math.min(n.time + n.duration, trimEnd)
      this.active.set(n.id, { id: n.id, midi: playedMidi, endTime, stop: stopFn })
      this.emit({ type: 'on', midi: playedMidi, velocity: shaped, songTime, track: n.track })
    }

    // process note offs (any active note whose end has passed)
    const stopTime =
      !this.silent && this.piano ? this.piano.context.currentTime + STOP_BUFFER : 0
    for (const a of this.active.values()) {
      // a.endTime is stored in MIDI-time (`n.time + n.duration`), so
      // compare against the MIDI-time cursor.
      if (a.endTime <= midiSongTime) {
        if (!this.silent && this.pedalEnabled && this.pedalDown) {
          this.pedalHeld.push({ midi: a.midi, stop: a.stop, source: 'song' })
        } else {
          a.stop(stopTime)
        }
        this.emit({ type: 'off', midi: a.midi, songTime })
        this.active.delete(a.id)
      }
    }

    // end of song. Loop snaps back at the exact end; non-loop adds a tail
    // window so the in-flight visuals + reverb finish naturally. Silent
    // (export) mode skips this — the exporter is the authority on when
    // the timeline ends, and an auto-stop here would terminate a render
    // mid-frame.
    //
    // User audio extends the effective timeline: if the accompaniment
    // ends after the MIDI it must finish playing before we auto-stop,
    // so we take max(song.duration, userAudioEnd) as the end point.
    if (!this.silent) {
      const audioEnd = this.userAudioEndSec()
      // MIDI now starts at `midiOffsetSec` on the timeline, so its end
      // in timeline-time is `songDuration + midiOffsetSec`. Audio end
      // is already in timeline-time (`userAudioOffsetSec + dur`).
      // MIDI clip end in timeline-time = offset + map(trimEnd). With
      // a speed curve below 1 over part of the range this stretches
      // beyond the natural song duration — auto-stop must wait for
      // the stretched end.
      // No song → `effectiveMidiTrimEnd()` is +Infinity (no trim, no
      // duration), which would make the auto-stop never fire. Drop the
      // MIDI term entirely in that case so external media still bounds
      // the timeline.
      const midiEndPart = this.song
        ? this.midiOffsetSec + midiToTimeline(this.speedMap, this.effectiveMidiTrimEnd())
        : 0
      const effectiveEnd = Math.max(
        midiEndPart,
        audioEnd,
        this.externalMediaEndSec,
      )
      const endThreshold = effectiveEnd + (this.loop ? 0 : SONG_TAIL_SECONDS)
      if (songTime >= endThreshold && this.active.size === 0 && this.pedalHeld.length === 0) {
        if (this.loop) {
          this.seek(0)
        } else {
          this.stop()
        }
      }
    }
  }

  /**
   * Set up the engine for a one-pass offline render. Walks the song
   * from t=0 in lockstep with the externally-driven `VirtualClock`
   * (see `audio/clock.ts`): each `tick()` after this point reads
   * `currentSongTime()` = `clock.now()` and fires the listener
   * events the visual layer needs to paint the same scene it would
   * during live playback. No audio is scheduled — `silent` blocks
   * every `piano.start()` and pedal-held queue mutation.
   *
   * The caller is expected to: (a) install a `VirtualClock` via
   * `setActiveClock`, (b) call `engine.loadSong(song)` so the
   * timeline is in place, (c) call `beginExportPlayback`, (d) drive
   * the virtual clock + R3F frame stepping, (e) call
   * `endExportPlayback` to restore the engine to a clean stopped
   * state.
   *
   * Pre-existing playback is torn down (releaseAll + stop the
   * background ticker) so leftover sounding notes don't bleed into
   * the rendered visualization.
   */
  beginExportPlayback(): void {
    if (this.savedExportState) return
    this.savedExportState = { rate: this.rate }
    this.releaseAll()
    this.stopUserAudioSource()
    this.stopBackgroundTicker()
    this.silent = true
    this.playing = true
    this.rate = 1
    this.startedAt = 0
    this.offsetAtStart = 0
    this.noteIdx = 0
    this.pedalIdx = 0
    this.pedalDown = false
  }

  /**
   * Tear down the export pass. Leaves the engine in a clean stopped
   * state with the song still loaded — equivalent to the user having
   * pressed Stop. The user can press Play to resume from the
   * beginning. The previously-saved playback rate is restored so the
   * user's UI slider continues to mean what it said.
   */
  endExportPlayback(): void {
    if (!this.savedExportState) return
    const saved = this.savedExportState
    this.savedExportState = null
    this.releaseAll()
    this.silent = false
    this.playing = false
    this.rate = saved.rate
    this.startedAt = now()
    this.offsetAtStart = 0
    this.noteIdx = 0
    this.pedalIdx = 0
    this.pedalDown = false
  }
}

const noopStop: (time?: number) => void = () => {}

export const audioEngine = new AudioEngine()

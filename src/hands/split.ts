// Automatic hand split: gives every note without a hand one, from the hand planner (no motion data needed).
import type { Hand, NoteEvent, ParsedSong, TrackInfo } from '../midi/types'
import { mapSongNotes, planHandNotes, type HandsTimeMap } from './motion'

/** Notes of the song that have no hand yet. */
export function unassignedCount(song: ParsedSong | null): number {
  if (!song) return 0
  let n = 0
  for (const note of song.notes) if (!note.hand) n++
  return n
}

/** Track layout of a split song: right hand = track 0, left hand = track 1. */
const RIGHT_TRACK = 0
const LEFT_TRACK = 1
const SPLIT_TRACKS = { right: 'Right hand', left: 'Left hand' } as const

/** How far (in neighbours by time) the nearest-note search for a note the planner dropped looks. */
const NEAR_WINDOW = 12
/** Seconds one semitone counts as when picking the nearest assigned note. */
const SEMITONE_S = 0.05

export type SplitOptions = {
  signal: AbortSignal
  /** Throw away the hands the notes carry and plan all of them. */
  replace?: boolean
}

export type SplitResult = {
  /** hand per note id, for every note of the song */
  hands: Map<number, Hand>
  right: number
  left: number
}

/**
 * Hand of every note. Notes with a hand keep it (the planner gets it as a pin, unless `replace`); the rest take the
 * planner's. A note it drops, or one the mapping leaves out (trimmed, out of range), takes the hand of the nearest
 * assigned note in time and pitch.
 */
export async function planSongHands(song: ParsedSong, map: HandsTimeMap, opt: SplitOptions): Promise<SplitResult> {
  const input = opt.replace ? { ...song, notes: song.notes.map(({ hand: _h, ...n }) => n as NoteEvent) } : song
  const mapped = mapSongNotes(input, map)
  const hands = new Map<number, Hand>()
  if (mapped.length > 0) {
    const plan = await planHandNotes(
      mapped.map((e) => e.hn),
      opt.signal,
    )
    mapped.forEach((e, i) => {
      const h = plan.hand[i]
      if (h) hands.set(e.note.id, h)
    })
  }
  // fall back for the rest: the nearest note that has a hand
  const have = input.notes.filter((n) => hands.has(n.id) || n.hand).sort((a, b) => a.time - b.time)
  const handOf = (n: NoteEvent): Hand => hands.get(n.id) ?? n.hand!
  const out = new Map<number, Hand>()
  let right = 0
  let left = 0
  for (const n of input.notes) {
    let h: Hand | undefined = hands.get(n.id) ?? n.hand
    if (!h) {
      if (have.length === 0) h = n.midi < 60 ? 'L' : 'R'
      else {
        let lo = 0
        let hi = have.length
        while (lo < hi) {
          const mid = (lo + hi) >> 1
          if (have[mid].time < n.time) lo = mid + 1
          else hi = mid
        }
        let best = Infinity
        for (let k = Math.max(0, lo - NEAR_WINDOW); k < Math.min(have.length, lo + NEAR_WINDOW); k++) {
          const c = Math.abs(have[k].time - n.time) + Math.abs(have[k].midi - n.midi) * SEMITONE_S
          if (c < best) {
            best = c
            h = handOf(have[k])
          }
        }
      }
    }
    if (h === 'L') left++
    else right++
    out.set(n.id, h!)
  }
  return { hands: out, right, left }
}

/**
 * The song with the hands set (a note keeps the hand it has unless `replace`). Fingers are never written. When all
 * notes sit on one track they also go onto two (0 = right hand, 1 = left hand), so a saved MIDI has two tracks and
 * per-track colours work; with several note tracks the tracks stay as they are.
 */
export function applySongHands(song: ParsedSong, hands: ReadonlyMap<number, Hand>, replace = false): ParsedSong {
  const used = new Set<number>()
  for (const n of song.notes) used.add(n.track)
  const oneTrack = used.size <= 1
  let r = 0
  let l = 0
  const notes = song.notes.map((n) => {
    const h = replace ? hands.get(n.id) ?? n.hand : n.hand ?? hands.get(n.id)
    if (!h) return n
    if (h === 'L') l++
    else r++
    const track = oneTrack ? (h === 'L' ? LEFT_TRACK : RIGHT_TRACK) : n.track
    if (n.hand === h && n.track === track) return n
    return { ...n, hand: h, track }
  })
  const tracks: TrackInfo[] = oneTrack
    ? [
        { name: SPLIT_TRACKS.right, hasNotes: r > 0 },
        { name: SPLIT_TRACKS.left, hasNotes: l > 0 },
      ]
    : song.tracks
  return { ...song, notes, tracks }
}

/** Whether `applySongHands` would put the notes on the two hand tracks (all notes on one track, or none). */
export function splitsTracks(song: ParsedSong): boolean {
  return new Set(song.notes.map((n) => n.track)).size <= 1
}

/** Whether the song's tracks are the two hand tracks `applySongHands` makes. */
export function isHandSplit(song: ParsedSong): boolean {
  return song.tracks.length === 2 && song.tracks[RIGHT_TRACK].name === SPLIT_TRACKS.right && song.tracks[LEFT_TRACK].name === SPLIT_TRACKS.left
}

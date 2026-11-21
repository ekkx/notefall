// Messages between the main thread (`client.ts`) and the detection worker (`worker.ts`).
// Every request carries an `id`; every reply echoes it, so one worker can serve several
// requests (drift tracking over the whole video reuses this protocol with a new request type).

/** The keyboard as found in a video. */
export interface KeyboardFit {
  /** Row-major 3×3: lens-corrected picture coords (0..1, x right, y down) → keyboard plane (white-key widths: x 0..52 from A0's left edge, y 0..WL from the front edge). */
  H: number[]
  /** Radial lens bend, notefall's convention (`video/geometry.ts` distort / undistort). */
  bend: number
  /** False when the keyboard's ends are not in the picture: the octave is a guess. */
  octaveKnown: boolean
  /** Video time (s) at the middle of the frames analysed. */
  t: number
  /** Diagnostics. */
  keys: number
  cost: number
  seam: number | null
  /** Lowest / highest black key found, 0..35 (0 = A#0, 35 = A#7). */
  lo: number
  hi: number
}

export type DetectOutcome =
  | { ok: true; fit: KeyboardFit; ms: number }
  | { ok: false; reason: string; ms: number }

export type WorkerRequest =
  | {
      type: 'detect'
      id: number
      blob: Blob
      /** Video time (s) to look near; default: near the start. */
      at?: number
    }
  | {
      /** Follow the keyboard through the whole video (one sample a second); replies `tracked`, with `progress` on the way. */
      type: 'track'
      id: number
      blob: Blob
      /** Slice `part` of `parts` (contiguous, one extra sample at the seam) when several workers share the video. */
      part?: number
      parts?: number
    }
  | { type: 'cancel'; id: number }

/** One analysis step of the drift tracker: the keyboard fitted to the 9 frames around video time `t`. */
export interface TrackSample {
  t: number
  /** A keyboard was found at all. */
  ok: boolean
  /** The detector's own quality gate (cost, key count, lens) passed. */
  good: boolean
  /** As `KeyboardFit.H` / `bend`: this sample's own fit (its lens bend can differ from the others'). */
  H?: number[]
  bend?: number
  keys?: number
  cost?: number
  seam?: number | null
}

export type TrackOutcome =
  | { ok: true; samples: TrackSample[]; /** Picture width / height of the analysis frames. */ aspect: number; duration: number; ms: number; /** Where the time went (ms), for tuning. */ stats?: Record<string, number> }
  | { ok: false; reason: string; ms: number }

export type WorkerResponse =
  | { type: 'progress'; id: number; fraction: number }
  | { type: 'detected'; id: number; outcome: DetectOutcome }
  | { type: 'tracked'; id: number; outcome: TrackOutcome }
  | { type: 'error'; id: number; message: string }

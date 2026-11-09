// Types of hands.js, the main-thread client of the hand motion runtime (hands-worker.js + hands.wasm + the motion data).
export type Hand = 'L' | 'R'
export type Vec3 = [number, number, number]
/** One hand's pose: world-space joints (fingers[0] = thumb [CMC, MCP, IP, tip], others [MCP, PIP, DIP, tip]), per-finger press 0 / 1, the thumb's twist references */
export type HandPose = { hand: Hand; elbow: Vec3; wrist: Vec3; bases: Vec3[]; fingers: Vec3[][]; press: number[]; thumbRef: Vec3[] }
export type HandPoses = { L: HandPose | null; R: HandPose | null }
/** A note to play, in seconds on the clock poses are asked on. With hand / finger it is played that way; without, they are planned. */
export type HandsNote = { midi: number; on: number; off: number; hand?: Hand | null; finger?: number | null }
export type HandsMotion = {
  fps: number; t0: number; frames: number; S: Record<Hand, number>
  angles: Float32Array
  holds: Record<Hand, [number, number][][]>
  /** per input note: the hand / finger that plays it; hand null = dropped (no finger plays it) */
  plan: { hand: (Hand | null)[]; finger: number[] }
  /** per hand: the frame runs [first, last] with motion */
  runs: Record<Hand, [number, number][]>
  /** per hand: its first note's onset and last note's release (s), null without notes */
  span: Record<Hand, [number, number] | null>
}
export type SynthOptions = {
  S?: Partial<Record<Hand, number>>
  onProgress?: (stage: string, fraction: number) => void
  signal?: AbortSignal
}
/** thrown (name 'AbortError') when a load or synthesis is cancelled */
export declare class HandsCancelled extends Error {}
export declare class HandsRuntime {
  /** compiles hands.wasm once and starts the Worker (module Worker) */
  static create(urls: { worker: string | URL; wasm: string | URL }): Promise<HandsRuntime>
  /** downloads (Cache Storage first) and prepares the motion data inside the Worker; stages 'download' / 'decode' / 'build' */
  load(url: string, onProgress?: (stage: string, fraction: number) => void): Promise<void>
  cancelLoad(): void
  synth(notes: HandsNote[], opt?: SynthOptions): Promise<HandsMotion>
  /** pure in t; a hand comes in from below the keys before its first note and slides away after its last (null only for a hand with no notes) */
  poseAt(motion: HandsMotion, t: number): HandPoses
  dispose(): void
}

import * as THREE from 'three'
import type { Settings } from '../store'
import { handOfNote } from '../midi/noteHands'
import { KEY_COUNT, KEYBOARD_LAYOUT, MIDI_MIN } from '../keyboard/layout'

/**
 * Note colouring. `solid` = the base `noteColor` with per-track overrides (`trackColors`); `gradient` = up to five
 * colour stops spread across the note area at an angle (the falling notes shade it per pixel, everything that only
 * has a key — particles, flashes, key glow, the timeline clip — takes the colour at that key on the hit line);
 * `random` = every note (or pitch / pitch class) picks a palette colour from a seeded hash (per-track colours are
 * `solid`'s `trackColors`); `hand` = the note's hand from the selection card (`noteHandColorL` / `R`), `noteColor` for
 * notes without one.
 *
 * Stop / palette colours are interpolated as sRGB-encoded values; consumers get linear RGB. A gradient either blends
 * between neighbouring stops over a `softness` share of the gap between them, centred on its midpoint: 1 = a linear blend
 * across the whole gap, 0 = a hard switch halfway between the two stops.
 *
 * The hit line has its own colouring (`hitLineColorMode`): `solid` = hitLineColor, `gradient` = its own 2..5 stops
 * along the line, `note` = the notes' colouring (their gradient along the line, else noteColor).
 */
export type NoteColorMode = 'solid' | 'gradient' | 'random' | 'hand'
export type NoteRandomBy = 'note' | 'pitch' | 'pitchClass'

export const COLOR_STOPS_MAX = 5
export const GRADIENT_COLOR_KEYS = [
  'noteGradientColor1',
  'noteGradientColor2',
  'noteGradientColor3',
  'noteGradientColor4',
  'noteGradientColor5',
] as const
export const GRADIENT_POS_KEYS = [
  'noteGradientPos1',
  'noteGradientPos2',
  'noteGradientPos3',
  'noteGradientPos4',
  'noteGradientPos5',
] as const
export const HIT_LINE_GRADIENT_COLOR_KEYS = [
  'hitLineGradientColor1',
  'hitLineGradientColor2',
  'hitLineGradientColor3',
  'hitLineGradientColor4',
  'hitLineGradientColor5',
] as const
export const HIT_LINE_GRADIENT_POS_KEYS = [
  'hitLineGradientPos1',
  'hitLineGradientPos2',
  'hitLineGradientPos3',
  'hitLineGradientPos4',
  'hitLineGradientPos5',
] as const
export const RANDOM_COLOR_KEYS = [
  'noteRandomColor1',
  'noteRandomColor2',
  'noteRandomColor3',
  'noteRandomColor4',
  'noteRandomColor5',
] as const

export type NoteColorSettings = Pick<
  Settings,
  | 'noteColor'
  | 'trackColors'
  | 'noteColorMode'
  | 'noteGradientStops'
  | 'noteGradientAngle'
  | 'noteGradientSoftness'
  | 'noteRandomBy'
  | 'noteRandomSeed'
  | 'noteRandomCount'
  | 'noteHandColorL'
  | 'noteHandColorR'
  | (typeof GRADIENT_COLOR_KEYS)[number]
  | (typeof GRADIENT_POS_KEYS)[number]
  | (typeof RANDOM_COLOR_KEYS)[number]
>

export const NOTE_COLOR_DEFAULTS = {
  noteColorMode: 'solid' as NoteColorMode,
  noteGradientStops: 2,
  noteGradientAngle: 338,
  noteGradientSoftness: 1,
  noteGradientColor1: '#4f00ff',
  noteGradientColor2: '#e67d1a',
  noteGradientColor3: '#ffffff',
  noteGradientColor4: '#00e0ff',
  noteGradientColor5: '#ff3080',
  noteGradientPos1: 0,
  noteGradientPos2: 1,
  noteGradientPos3: 0.5,
  noteGradientPos4: 0.75,
  noteGradientPos5: 0.25,
  noteRandomBy: 'note' as NoteRandomBy,
  noteRandomSeed: 1,
  noteRandomCount: 3,
  noteRandomColor1: '#ff3080',
  noteRandomColor2: '#30e0ff',
  noteRandomColor3: '#ffd040',
  noteRandomColor4: '#80ff60',
  noteRandomColor5: '#b060ff',
  noteHandColorL: '#ff8a5c',
  noteHandColorR: '#5ad7ff',
} satisfies Partial<NoteColorSettings>

export type HitLineColorMode = 'solid' | 'gradient' | 'note'
export const HIT_LINE_COLOR_DEFAULTS = {
  hitLineColorMode: 'note' as HitLineColorMode,
  hitLineGradientStops: 2,
  hitLineGradientSoftness: 1,
  hitLineGradientColor1: '#5ad7ff',
  hitLineGradientColor2: '#ff3080',
  hitLineGradientColor3: '#ffd040',
  hitLineGradientColor4: '#80ff60',
  hitLineGradientColor5: '#b060ff',
  hitLineGradientPos1: 0,
  hitLineGradientPos2: 1,
  hitLineGradientPos3: 0.5,
  hitLineGradientPos4: 0.75,
  hitLineGradientPos5: 0.25,
}
type HitLineGradientSettings = Pick<
  Settings,
  | 'hitLineGradientStops'
  | 'hitLineGradientSoftness'
  | (typeof HIT_LINE_GRADIENT_COLOR_KEYS)[number]
  | (typeof HIT_LINE_GRADIENT_POS_KEYS)[number]
>

type Rgb = [number, number, number]

/**
 * The gradient's area in world units: the keyboard's width × about the visible note field above the hit line at the
 * default camera (fixed, so the gradient doesn't move with the camera or the fall time).
 */
export const GRADIENT_AREA_LEFT = -KEYBOARD_LAYOUT.totalWidth / 2
export const GRADIENT_AREA_WIDTH = KEYBOARD_LAYOUT.totalWidth
export const GRADIENT_AREA_HEIGHT = 4

const clampCount = (n: number) => Math.min(COLOR_STOPS_MAX, Math.max(1, Math.round(n)))
const tmp = new THREE.Color()
/** '#rrggbb' → sRGB-encoded 0..1 (no colour management, so the value is the hex's own). */
function hexSrgb(hex: string): Rgb {
  tmp.setStyle(hex, THREE.NoColorSpace)
  return [tmp.r, tmp.g, tmp.b]
}
const toLinear = (c: number) => (c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4))

type Stop = { pos: number; c: Rgb }
/** A resolved gradient: stops sorted by position (sRGB), direction (see `gradientDir`), blend softness 0..1. */
export type GradientSpec = { stops: Stop[]; dir: [number, number]; softness: number }

function stopsFrom(count: number, colors: readonly string[], positions: readonly number[]): Stop[] {
  const n = Math.max(2, clampCount(count))
  const out: Stop[] = []
  for (let i = 0; i < n; i++) out.push({ pos: Math.min(1, Math.max(0, positions[i])), c: hexSrgb(colors[i]) })
  return out.sort((a, b) => a.pos - b.pos)
}
/** The notes' gradient. */
export function noteGradient(s: NoteColorSettings): GradientSpec {
  return {
    stops: stopsFrom(
      s.noteGradientStops,
      GRADIENT_COLOR_KEYS.map((k) => s[k]),
      GRADIENT_POS_KEYS.map((k) => s[k]),
    ),
    dir: gradientDir(s.noteGradientAngle),
    softness: s.noteGradientSoftness,
  }
}
/** The hit line's own gradient, left (0) → right (1) along the keyboard. */
export function hitLineGradient(s: HitLineGradientSettings): GradientSpec {
  return {
    stops: stopsFrom(
      s.hitLineGradientStops,
      HIT_LINE_GRADIENT_COLOR_KEYS.map((k) => s[k]),
      HIT_LINE_GRADIENT_POS_KEYS.map((k) => s[k]),
    ),
    dir: [1, 0],
    softness: s.hitLineGradientSoftness,
  }
}

/**
 * What the hit line shows (the line itself and its light on the keys): its own gradient, the notes' (their
 * gradient along the line, noteColor for solid notes), or the plain hitLineColor (random / by-hand notes have no
 * single colour). `gradient` null = the solid `hex`.
 */
export function hitLineColoring(s: Settings): { gradient: GradientSpec | null; hex: string } {
  const mode = s.hitLineColorMode
  const gradient =
    mode === 'gradient' ? hitLineGradient(s) : mode === 'note' && s.noteColorMode === 'gradient' ? noteGradient(s) : null
  const hex = mode === 'note' && s.noteColorMode === 'solid' ? s.noteColor : s.hitLineColor
  return { gradient, hex }
}

/**
 * Direction of the gradient for an angle in degrees measured on screen, clockwise from +x (0° = first stop on the
 * left, 90° = first stop at the top), expressed in the area's normalised coords p ∈ [−1, 1]² and scaled so the
 * parameter `dot(p, dir) · 0.5 + 0.5` runs exactly 0 → 1 from one corner (or edge) of the area to the opposite one.
 */
export function gradientDir(angleDeg: number): [number, number] {
  const a = (angleDeg * Math.PI) / 180
  // world direction → p-space: p.x spans half the width, p.y half the height
  const dx = Math.cos(a) * GRADIENT_AREA_WIDTH
  const dy = -Math.sin(a) * GRADIENT_AREA_HEIGHT
  const norm = Math.abs(dx) + Math.abs(dy)
  return [dx / norm, dy / norm]
}

/** Blend weight from stop a (at `a`) to the next stop (at `b`) at t: a ramp `softness · (b − a)` wide on the midpoint. */
export function stopBlend(a: number, b: number, t: number, softness: number): number {
  const w = Math.max(0, Math.min(1, softness)) * (b - a)
  const m = (a + b) / 2
  if (w <= 1e-6) return t >= m ? 1 : 0
  return Math.max(0, Math.min(1, (t - (m - w / 2)) / w))
}

/** sRGB colour of sorted stops at parameter t (clamped at both ends). */
export function evalStops(stops: Stop[], t: number, out: Rgb, softness = 1): Rgb {
  const first = stops[0]
  const last = stops[stops.length - 1]
  if (t <= first.pos) return copy(out, first.c)
  if (t >= last.pos) return copy(out, last.c)
  for (let k = 0; k + 1 < stops.length; k++) {
    const a = stops[k]
    const b = stops[k + 1]
    if (t <= b.pos) {
      const f = stopBlend(a.pos, b.pos, t, softness)
      out[0] = a.c[0] + (b.c[0] - a.c[0]) * f
      out[1] = a.c[1] + (b.c[1] - a.c[1]) * f
      out[2] = a.c[2] + (b.c[2] - a.c[2]) * f
      return out
    }
  }
  return copy(out, last.c)
}
function copy(out: Rgb, c: Rgb): Rgb {
  out[0] = c[0]
  out[1] = c[1]
  out[2] = c[2]
  return out
}

/** Seeded hash → [0, 1). */
function hash01(key: number, seed: number): number {
  let h = Math.imul(key | 0, 0x9e3779b1) ^ Math.imul((seed | 0) + 0x632be5ab, 0x85ebca77)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

/** Palette slot of a note in `random` mode. `id` is undefined for live input. */
export function randomSlot(s: NoteColorSettings, midi: number, id: number | undefined): number {
  let key: number
  switch (s.noteRandomBy) {
    case 'pitch':
      key = midi
      break
    case 'pitchClass':
      key = midi % 12
      break
    default:
      key = id ?? midi + 0x10000
  }
  return Math.floor(hash01(key, s.noteRandomSeed) * clampCount(s.noteRandomCount))
}

/**
 * Per-frame resolver for consumers that colour by note / key (falling-note instance tints, particles, flashes, key
 * glow, the timeline clip). `update` once per frame with the pin-resolved settings, then `rgb` per note.
 */
export class NoteColorResolver {
  private s: NoteColorSettings | null = null
  private base: Rgb = [1, 1, 1]
  private tracks = new Map<number, Rgb>()
  private palette: Rgb[] = []
  private handL: Rgb = [1, 1, 1]
  private handR: Rgb = [1, 1, 1]
  private keyGradient = new Float32Array(0)
  private out: Rgb = [0, 0, 0]

  update(s: NoteColorSettings): void {
    this.s = s
    this.base = hexLinear(s.noteColor)
    this.tracks.clear()
    if (s.noteColorMode === 'hand') {
      this.handL = hexLinear(s.noteHandColorL)
      this.handR = hexLinear(s.noteHandColorR)
    } else if (s.noteColorMode === 'random') {
      this.palette = RANDOM_COLOR_KEYS.slice(0, clampCount(s.noteRandomCount)).map((k) => hexLinear(s[k]))
    } else if (s.noteColorMode === 'gradient') {
      const g = noteGradient(s)
      // the hit-line colour of every key (v = 0)
      const keys = KEYBOARD_LAYOUT.keys
      if (this.keyGradient.length !== keys.length * 3) this.keyGradient = new Float32Array(keys.length * 3)
      for (let i = 0; i < keys.length; i++) {
        const u = (keys[i].x - GRADIENT_AREA_LEFT) / GRADIENT_AREA_WIDTH
        const t = ((2 * u - 1) * g.dir[0] - g.dir[1]) * 0.5 + 0.5
        const c = evalStops(g.stops, t, this.out, g.softness)
        this.keyGradient[i * 3] = toLinear(c[0])
        this.keyGradient[i * 3 + 1] = toLinear(c[1])
        this.keyGradient[i * 3 + 2] = toLinear(c[2])
      }
    }
  }

  /** Linear RGB of a note. The returned tuple is reused by the next call: copy it out. */
  rgb(midi: number, track: number | undefined, id?: number): Readonly<Rgb> {
    const s = this.s
    if (!s) return this.base
    if (s.noteColorMode === 'random') return this.palette[randomSlot(s, midi, id)] ?? this.base
    if (s.noteColorMode === 'hand') {
      const hand = handOfNote(id)
      return hand === 'L' ? this.handL : hand === 'R' ? this.handR : this.base
    }
    if (s.noteColorMode === 'gradient') {
      const k = midi - MIDI_MIN
      if (k < 0 || k >= KEY_COUNT) return this.base
      const i = k * 3
      this.out[0] = this.keyGradient[i]
      this.out[1] = this.keyGradient[i + 1]
      this.out[2] = this.keyGradient[i + 2]
      return this.out
    }
    if (track == null) return this.base
    let c = this.tracks.get(track)
    if (!c) {
      const hex = s.trackColors[String(track)]
      c = hex ? hexLinear(hex) : this.base
      this.tracks.set(track, c)
    }
    return c
  }

  /** `rgb` as a '#rrggbb' sRGB string (the timeline clip's canvas fill). */
  hex(midi: number, track: number | undefined, id?: number): string {
    const [r, g, b] = this.rgb(midi, track, id)
    return '#' + tmp.setRGB(r, g, b, THREE.LinearSRGBColorSpace).getHexString(THREE.SRGBColorSpace)
  }
}

function hexLinear(hex: string): Rgb {
  const c = hexSrgb(hex)
  return [toLinear(c[0]), toLinear(c[1]), toLinear(c[2])]
}

/** The colouring keys other than `noteColor` / `trackColors`, as a flat list (a cheap memo dependency). */
export function noteColoringDeps(s: NoteColorSettings): (string | number)[] {
  return [
    s.noteColorMode,
    s.noteGradientStops,
    s.noteGradientAngle,
    s.noteGradientSoftness,
    s.noteRandomBy,
    s.noteRandomSeed,
    s.noteRandomCount,
    s.noteHandColorL,
    s.noteHandColorR,
    ...GRADIENT_COLOR_KEYS.map((k) => s[k]),
    ...GRADIENT_POS_KEYS.map((k) => s[k]),
    ...RANDOM_COLOR_KEYS.map((k) => s[k]),
  ]
}

/**
 * GLSL for the gradient, shared by the note and hit-line shaders: the uniforms (sorted sRGB stops; the area as left,
 * bottom, width, height in world units) and `gradientAt(world xy)` → linear colour, stops interpolated as
 * sRGB-encoded values like the CPU side.
 */
export const NOTE_GRADIENT_GLSL = /* glsl */ `
  uniform float uGradient;
  uniform int uGradN;
  uniform vec3 uGradC[${COLOR_STOPS_MAX}];
  uniform float uGradP[${COLOR_STOPS_MAX}];
  uniform vec2 uGradDir;
  uniform vec4 uGradArea;
  uniform float uGradSoft;
  vec3 gradientAt(vec2 w) {
    vec2 uv = (w - uGradArea.xy) / uGradArea.zw;
    float t = dot(uv * 2.0 - 1.0, uGradDir) * 0.5 + 0.5;
    vec3 c = uGradC[0];
    for (int i = 1; i < ${COLOR_STOPS_MAX}; i++) {
      if (i >= uGradN) break;
      float a = uGradP[i - 1];
      float b = uGradP[i];
      float w = clamp(uGradSoft, 0.0, 1.0) * (b - a);
      float m = 0.5 * (a + b);
      float f = w > 1e-6 ? clamp((t - (m - 0.5 * w)) / w, 0.0, 1.0) : step(m, t);
      c = mix(c, uGradC[i], f);
    }
    c = max(c, 0.0);
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
  }
`

/** Uniform objects for `NOTE_GRADIENT_GLSL`; `bottom` = the area's world y (the hit line). */
export function createGradientUniforms(bottom: number) {
  return {
    uGradient: { value: 0 },
    uGradN: { value: 2 },
    uGradC: { value: Array.from({ length: COLOR_STOPS_MAX }, () => new THREE.Vector3()) },
    uGradP: { value: new Array<number>(COLOR_STOPS_MAX).fill(0) },
    uGradDir: { value: new THREE.Vector2(1, 0) },
    uGradArea: { value: new THREE.Vector4(GRADIENT_AREA_LEFT, bottom, GRADIENT_AREA_WIDTH, GRADIENT_AREA_HEIGHT) },
    uGradSoft: { value: 1 },
  }
}

/** Push a resolved gradient into uniforms made by `createGradientUniforms`; `null` switches the gradient off. */
export function writeGradientUniforms(u: ReturnType<typeof createGradientUniforms>, g: GradientSpec | null): void {
  u.uGradient.value = g ? 1 : 0
  if (!g) return
  for (let i = 0; i < COLOR_STOPS_MAX; i++) {
    const st = g.stops[Math.min(i, g.stops.length - 1)]
    u.uGradC.value[i].set(st.c[0], st.c[1], st.c[2])
    u.uGradP.value[i] = st.pos
  }
  u.uGradN.value = g.stops.length
  u.uGradDir.value.set(g.dir[0], g.dir[1])
  u.uGradSoft.value = g.softness
}

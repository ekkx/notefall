import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import type { ParsedSong } from './midi/types'
import type { SpeedPoint } from './midi/speedMap'
import { audioEngine } from './audio/engine'
import type { FileRef } from './projects/types'
import {
  DEFAULT_VELOCITY_CURVE,
  type VelocityCurve,
} from './audio/velocityCurve'

// Cap on the in-memory undo stack. 50 individual edits is plenty for a
// session of editing without tipping into multi-MB snapshot retention on
// large MIDIs (each snapshot keeps the full notes/pedals arrays).
const HISTORY_LIMIT = 50

export type FallDirection = 'down' | 'up'

/**
 * Surface treatment applied to falling-note instances. Add new entries here
 * AND add a matching code path inside FallingNotes' fragment shader.
 * - 'solid'  — flat tinted fill (legacy behavior)
 * - 'liquid' — molten-metal flow with bright glassy edge, FBM-driven
 * - 'gem'    — cut-crystal facets with bright cell edges, Voronoi-driven
 * - 'custom' — user-provided image (managed via useCustomTexture store)
 */
export type NoteTexture = 'solid' | 'liquid' | 'gem' | 'custom'

export type Settings = {
  // Theme — a single color the user can apply across notes / hit line /
  // particles / keyboard glow at once via the Inspector's "Apply to All"
  // button. Stored separately so it persists between applies; individual
  // color settings can still be tweaked independently afterward.
  themeColor: string
  // Layout
  keyboardY: number
  // Camera
  cameraFov: number
  cameraPos: [number, number, number]
  cameraLookAt: [number, number, number]
  // Notes
  notesEnabled: boolean
  fallDirection: FallDirection
  fallDurationSec: number // どのぐらいの時間をかけて鍵盤に到達するか
  noteColor: string
  // Per-track colour overrides keyed by track index (as string for JSON
  // round-trip safety). Unset / missing keys fall back to `noteColor`.
  // Index matches `NoteEvent.track` / `ParsedSong.tracks[i]`.
  trackColors: Record<string, string>
  noteEmissive: number
  noteOpacity: number
  noteCornerRadius: number
  noteWidthScale: number
  // Minimum visible length so very short notes do not collapse into a line
  noteMinLength: number
  // Surface treatment preset — see NoteTexture for the registry.
  noteTexture: NoteTexture
  // Spatial frequency of the texture pattern (higher = denser detail /
  // more repetitions; lower = zoomed in).
  noteTextureScale: number
  // Animation speed along X. Used by 'custom' for horizontal scroll. Other
  // presets ignore X (their patterns aren't directional).
  noteAnimSpeedX: number
  // Animation speed along Y. Used by 'custom' for vertical scroll. Liquid
  // and gem use this as their generic time multiplier (flow / twinkle rate).
  noteAnimSpeedY: number
  // Static positional shift of the texture sample point. Positive X = image
  // moves right on the note; positive Y = image moves up. Texture wrap is
  // RepeatWrapping so values outside [-1,1] just tile through.
  noteTextureOffsetX: number
  noteTextureOffsetY: number
  // Gaussian-style blur radius (in UV space) applied to the custom-image
  // sample. 0 = single tap (no blur). Higher = wider 9-tap kernel — useful
  // for softening low-resolution source images. Beyond ~0.05 the discrete
  // taps become visible as ghosting.
  noteTextureBlur: number
  // Per-note random offset on the custom-image sample, in [0, 1]. 0 = every
  // note shows the image identically positioned. 1 = each note starts at a
  // hash-derived random spot, so adjacent notes look different.
  noteTextureVariation: number
  // Push factor on bright spots — higher = more contrast between dark and
  // highlight regions of the pattern.
  noteTextureContrast: number
  // Bright outline around the SDF edge — applies to every texture preset
  // (including 'solid'). Drawn on top of the note's fill, intended for the
  // "glassy edge" highlight regardless of the surface treatment.
  edgeEnabled: boolean
  noteEdgeColor: string
  // Edge thickness in world units. 0 = no edge.
  noteEdgeWidth: number
  // Edge brightness multiplier on the chosen color.
  noteEdgeIntensity: number
  // White flash that appears at the contact line while a note is held
  flashEnabled: boolean
  // When true, flash uses noteColor instead of the explicit flashColor.
  flashFollowNote: boolean
  // Lift the flash colour toward white. 0 = pure flashColor, 1 = pure white.
  // Lets a coloured flash keep a bright white core for that "spark" feel.
  flashBrightness: number
  flashIntensity: number
  flashSize: number
  flashWidth: number
  // Softness of the core falloff — larger = wider halo edge around the bright spot
  flashHaloWidth: number
  flashColor: string
  // Particles drifting up from the keyboard while a note is held. The
  // visual signature is a billboarded radial flame-wisp: the quad geometry
  // stays at fixed size, but the fragment's UV is radially dilated as the
  // particle ages so the bright core appears to shrink while the soft halo
  // expands. Motion is curl-noise driven (Bridson 2007), with per-particle
  // 3D position so the divergence-free vector field can produce internal
  // cluster width without horizontal spreading.
  particlesEnabled: boolean
  particleColor: string
  particleSize: number          // global scale on the radial falloff
  particleOpacity: number       // alpha multiplier on the final color
  particleBrightness: number    // lift toward white in `tex × (color + (1 − color) × brightness) × 1.4`
  particleLifetime: number      // seconds — visible duration of each particle
  particleSpeed: number         // multiplier on the initial upward drift velocity
  particleCount: number         // per-key per-frame emission count (stochastic-rounded)
  // Curl-noise wind field shape. Multi-octave FBM on top of a 3D Perlin
  // gradient sampled at 3 displaced bases (Bridson 2007's vector
  // potential ψ → curl(ψ) = divergence-free flow).
  particleTurbulence: number    // master strength of the curl contribution to velocity
  turbulenceFrequency: number   // spatial frequency of the curl field (smaller = larger features)
  flowSpeed: number        // rate the noise sample point slides along Z (= "wind landscape evolves")
  // Per-axis turbulence scales — applied BOTH as inverse feature-size
  // inside the domain transform (asymmetric noise) AND component-wise on
  // the curl output (per-axis amplitude).
  turbulenceX: number
  turbulenceY: number
  turbulenceZ: number
  // 0 = noise sample point pinned to the emitter (all particles in one
  // press follow the same wind in lockstep). 1 = sample purely at the
  // particle's current position (each drifts independently). Mid values
  // give intra-emission coherence within a single press.
  noiseLocality: number
  // FBM octave count and per-octave multipliers. octaveScale = lacunarity
  // (frequency multiplier per octave); octaveMultiplier = gain (amplitude
  // multiplier per octave).
  turbulenceOctaves: number
  octaveScale: number
  octaveMultiplier: number
  // Multiplicative drag rate on velocity per second. xy_speed and |vz|
  // are damped by `drag × C × min(speed, 1) × dt` per frame; xy_speed is
  // floored at a small minimum so particles don't completely stall in
  // zero-curl regions.
  drag: number
  // Rotational pull on velocity.xy angle AWAY from π/2 (= +Y, "up"). +Y
  // is an unstable equilibrium — particles starting purely upward stay
  // upward, but any horizontal perturbation grows over time, producing
  // a swirling-spread visual when this is dialled up.
  swirl: number
  // Initial outward kick on emission, in a direction deterministically
  // hashed from the spawn XY (so two particles spawned at the same XY
  // get the same launch direction). 0 = pure upward initial velocity.
  kick: number
  // Glowing laser line at the keyboard hit point — straight bar + animated wavy beam
  hitLineEnabled: boolean
  hitLineColor: string
  hitLineIntensity: number   // straight-bar brightness
  hitLineThickness: number   // straight-bar core thickness (fraction of plane height)
  hitLineWaveEnabled: boolean   // gates JUST the wavy laser overlay (the straight bar is gated by hitLineEnabled)
  hitLineWaveIntensity: number  // wavy laser brightness
  hitLineWaveAmplitude: number  // vertical swing of the wave (fraction of plane half-height)
  hitLineWaveScale: number      // wave spatial frequency along the keyboard
  hitLineWaveScrollSpeed: number // horizontal scroll rate; signed (positive = rightward, negative = leftward)
  hitLineWaveMorphSpeed: number  // in-place shape evolution (no horizontal motion)
  hitLineWaveThickness: number  // wavy laser line thickness (fraction of plane)
  hitLineWaveGrain: number      // particulate-ness: high-freq curve tremor + brightness modulation along the line
  hitLineBarY: number           // vertical offset of the straight bar from the hit line (world units)
  hitLineWaveY: number          // vertical offset of the wave's center from the hit line (world units)
  hitLineBarHalo: number        // bar halo extent — divides the gaussian falloff so larger = wider
  hitLineWaveHalo: number       // wave halo extent — same idea, around the wavy laser line
  // Effects (Bloom)
  bloomEnabled: boolean
  bloomIntensity: number
  bloomThreshold: number
  bloomRadius: number
  bloomSmoothing: number
  // Scene
  backgroundColor: string
  // Keyboard
  whiteKeyColor: string
  blackKeyColor: string
  // Wood chassis tint (the strip below each white-key cap, visible
  // through the 4% inter-key gap and any black-key notches).
  woodColor: string
  keyboardBrightness: number
  keyGlowEnabled: boolean
  // When true, keyboard press-glow uses noteColor. When false, the user's
  // explicit keyGlowColor is used instead.
  keyGlowFollowNote: boolean
  keyGlowColor: string
  keyGlowIntensity: number
  keyGlowDecay: number
  // Audio
  // Linear gain on the **master** output — multiplies BOTH the sampler
  // (MIDI playback) and the user-provided accompaniment. 0 = silent,
  // 1 = unity, >1 = boost. Linear (not dB) so the slider's bottom is
  // true mute. The transport bar's Volume slider edits this.
  volume: number
  // Linear gain on the MIDI sampler, multiplied with `volume` to form
  // the effective sampler level. Lets the user duck the synthesised
  // piano against an imported accompaniment without touching master.
  midiVolume: number
  // When false, the MIDI sampler is silenced (effective gain = 0)
  // while the timeline + falling notes + key glow continue to play.
  // Auto-flipped to false on a user-gesture audio import so the
  // visualization can sync against the user's own recording without
  // doubling up on a synthesized piano.
  midiEnabled: boolean
  playbackRate: number
  pedalEnabled: boolean
  // Master on/off for the reverb. When off, the wet path output is silenced
  // (Dry is unaffected). Useful for A/B comparison without losing settings.
  reverbEnabled: boolean
  // Linear gain on the dry (un-reverbed) signal. 1 = unity, 0 = mute.
  reverbDry: number
  // Linear gain on the reverb output (post-convolver). 1 = unity, 0 = mute.
  reverbWet: number
  // IR buffer length (seconds) — the maximum tail before silence.
  reverbSize: number
  // RT60 — time (seconds) for the reverb to drop ~60 dB. Independent of Size.
  reverbDecayTime: number
  // Power-curve exponent on the IR envelope, on top of the RT60 exponential.
  // Higher = quicker initial drop (tighter attack on the wash).
  reverbDecay: number
  // Delay (seconds) before the wet path enters the convolver. Adds visible
  // separation between the dry attack and the reverb wash.
  reverbPreDelay: number
  // Progressive HF absorption inside the IR (0..1). 0 = no damping; higher =
  // HF dies faster than LF as the tail progresses (physical room behavior).
  // Distinct from Hi Cut: this varies over time within the IR.
  reverbDamping: number
  // Static low-pass cutoff (Hz) on the wet path AFTER the convolver. Dulls
  // the whole reverb uniformly.
  reverbHiCut: number
  // High-pass cutoff (Hz) on the wet path — keeps the reverb out of the
  // bass register so chords don't muddy.
  reverbLowCut: number
  // Sampler release time (seconds) — how long a held note takes to fade
  // out after stop is called. Smaller = sharper key-up cutoff.
  releaseTime: number
  // Sampler — applies to every note (song + live) sent to the piano.
  samplerDetune: number      // pitch offset in cents (-100..+100)
  // 6-band master EQ on the sampler output. Gain in dB per band, ordered
  // low → high (80, 250, 800, 2.5k, 6k, 12k Hz).
  eqBands: number[]
  // Velocity shaping — applied at every note trigger (song playback + live
  // MIDI + on-screen keyboard) so the user's dynamics preferences feel
  // consistent across input sources. Two interior control points define
  // a monotone-cubic curve from (0,0) to (1,1). See
  // `audio/velocityCurve.ts` for the evaluator.
  velocityCurve: VelocityCurve
  // Cancels a fraction of smplr's built-in `(v/127)^2` velocity-to-gain
  // curve via per-layer group volume offsets. 0..1; default 0.85.
  // See `audio/salamanderDescriptor.applyVelocityCompensation`.
  velocityCompensation: number
  // Pitch shift in semitones applied at every "input" stage — live MIDI
  // input from a physical device, AND the song timeline. Falling-note
  // positions also shift so the visualization stays aligned with the
  // played pitch. Screen-keyboard / PC-keyboard touches are NOT shifted
  // (the user is clicking on visible keys directly).
  transpose: number
  // === User audio sync ====================================================
  // Position (in song time, seconds) at which the user-provided
  // accompaniment track (WAV / MP3 / etc., managed via `useUserAudio`)
  // should start playing. 0 means "starts at the same moment the MIDI
  // does"; positive values delay the audio by that many seconds.
  // Negative offsets (audio before MIDI t=0) are intentionally not
  // supported yet — they require drawing the timeline below t=0, which
  // adds enough viewport / scroll complexity to defer until requested.
  userAudioOffsetSec: number
  // Linear gain on the user audio output (post-decode). 1 = unity.
  userAudioVolume: number
  // Sync offset for the MIDI track in seconds — the song's t=0 plays
  // at this many seconds into the timeline. Lets the user drag the
  // MIDI clip along the timeline like the audio clip. Negative values
  // are not supported yet for the same viewport reason as the audio
  // offset.
  midiOffsetSec: number
  // Non-destructive head / tail trim for the MIDI clip, in MIDI-time
  // seconds (NOT timeline-time). Notes/pedals whose `n.time` falls
  // outside `[midiTrimStartSec, midiTrimEndSec ?? song.duration)` are
  // skipped at playback / render / visualization time. Notes that span
  // the tail trim have their note-off clamped to the trim point.
  // `null` for the end means "no tail trim" so the values stay
  // meaningful when the song loaded underneath the user changes
  // duration. Trimming only HIDES content; the underlying ParsedSong
  // is never mutated.
  midiTrimStartSec: number
  midiTrimEndSec: number | null
  // Same idea for the user-provided audio clip, but in buffer-time
  // seconds (offset into the decoded AudioBuffer). Used to mute the
  // tail of a long recording or skip a noisy intro without re-encoding.
  userAudioTrimStartSec: number
  userAudioTrimEndSec: number | null
  // Speed automation breakpoints for the MIDI track. Each entry is
  // `(time, value)` where `time` is MIDI-time seconds and `value` is
  // the speed multiplier at that point (linear-interpolated between
  // points). Empty = constant 1.0 (no automation). Only affects MIDI
  // playback / visualisation; user-provided audio plays at constant
  // rate so it isn't degraded by naïve resampling.
  midiSpeedAutomation: SpeedPoint[]
  // Half-range of the speed automation lane in log₂ units (so the
  // visible range is `[2^-range, 2^range]` around 1.0). Tunable
  // because the default of 2 (i.e. 0.25× – 4×) is too sensitive for
  // small rubato-style adjustments — users editing in [0.9×, 1.1×]
  // want a finer Y-axis. Wheel-over-the-lane adjusts this live.
  midiSpeedAutomationYRangeLog2: number
  // Log₂-center of the visible speed range — 0 means the lane is
  // centred on 1.0×. Drifts away from 0 when the user zooms in over
  // a breakpoint whose value isn't 1.0× (cursor-anchored zoom), so
  // they can fine-tune values around any speed without the dot
  // clamping to the top/bottom edge of the lane.
  midiSpeedAutomationYCenterLog2: number
  // Whether the bottom TimelineEditor section is expanded. Persisted
  // so a user who collapses it to reclaim vertical canvas space gets
  // their layout back on reload.
  timelineEditorOpen: boolean
  // Scale factor on the timeline editor's lane heights. 1.0 = the
  // natural minimum (current values for MIDI / audio / speed lanes).
  // Higher values grow the clips proportionally while leaving the
  // ruler / minimap fixed. Driven by the resize handle at the top
  // of the editor section.
  timelineLaneScale: number
  // Per-lane height weights. Each lane's pixel height is
  // `LANE_HEIGHT_BASE × timelineLaneScale × laneRatio`. Dragging the
  // divider between two adjacent lanes shifts ratio between them
  // while keeping their sum constant (so total editor height is
  // preserved). Default 1.0 each → all lanes are the same height.
  timelineMidiLaneRatio: number
  timelineSpeedLaneRatio: number
  timelineAudioLaneRatio: number
  // Cap on the on-screen preview tick rate. The exported video drives
  // its own fps regardless. false (default) → 30 fps preview, lighter
  // on CPU; true → 60 fps preview for the smoothest fast-fall feel.
  previewHighFps: boolean
  // When true and the user has zoomed in, the timeline auto-pans so
  // the playhead stays centred during playback. Auto-disables when
  // the user manually pans / zooms (minimap drag, edge resize, wheel
  // pan or zoom) — those gestures clearly imply "show me something
  // other than the playhead".
  followPlayhead: boolean
  // === Hand video overlay =================================================
  // A user-provided overhead clip of their hands on a real keyboard,
  // composited into the scene (and the exported MP4) so the falling
  // notes line up with the actual finger movement. The video bytes live
  // in the standalone `useHandVideo` store (GPU/`<video>`-bound, not
  // serialisable); these settings are the placement / look knobs.
  handVideoEnabled: boolean
  // Linear opacity [0, 1] of the overlay plane.
  handVideoOpacity: number
  // Brightness multiplier on the sampled video colour. 1 = unchanged,
  // <1 darkens, >1 brightens (capped in-shader to avoid bloom blowout).
  handVideoBrightness: number
  // Centre position of the overlay plane in world units. The scene is
  // ~12.22 wu wide; (0,0) is the viewport centre, the keyboard sits
  // around y = -1.26.
  handVideoPosX: number
  handVideoPosY: number
  // Plane width in world units. Height is derived from the video's
  // native aspect ratio so the clip never distorts.
  handVideoScale: number
  // Timeline offset (song-time seconds) where the clip's t=0 plays —
  // same model as `userAudioOffsetSec`, driven by dragging the hand-
  // video clip on the timeline. Negative not supported yet (viewport).
  handVideoOffsetSec: number
  // Non-destructive head / tail trim in video-time seconds (offset into
  // the source clip). `null` end = no tail trim. Only hides content.
  handVideoTrimStartSec: number
  handVideoTrimEndSec: number | null
}

export const defaultSettings: Settings = {
  themeColor: '#5ad7ff',
  keyboardY: -2.0,
  cameraFov: 32,
  cameraPos: [0, 0, 12],
  cameraLookAt: [0, 0, 0],
  notesEnabled: true,
  fallDirection: 'down',
  fallDurationSec: 2.5,
  noteColor: '#5ad7ff',
  trackColors: {},
  noteEmissive: 1.0,
  noteOpacity: 1.0,
  noteCornerRadius: 0.05,
  noteWidthScale: 1.0,
  noteMinLength: 0.15,
  noteTexture: 'solid',
  noteTextureScale: 3.0,
  noteAnimSpeedX: 0.0,
  noteAnimSpeedY: 0.0,
  noteTextureOffsetX: 0.0,
  noteTextureOffsetY: 0.0,
  noteTextureBlur: 0.0,
  noteTextureVariation: 0.0,
  noteTextureContrast: 2.5,
  edgeEnabled: true,
  noteEdgeColor: '#ffffff',
  noteEdgeWidth: 0,
  noteEdgeIntensity: 1.0,
  flashEnabled: true,
  flashFollowNote: true,
  flashBrightness: 0.5,
  flashIntensity: 1.1,
  flashSize: 2.5,
  flashWidth: 2.5,
  flashHaloWidth: 0.5,
  flashColor: '#ffffff',
  particlesEnabled: true,
  particleColor: '#5ad7ff',
  particleSize: 0.80,
  particleOpacity: 0.15,
  particleBrightness: 0.15,
  particleLifetime: 0.70,
  particleSpeed: 1.00,
  particleCount: 5.00,
  particleTurbulence: 0.50,
  turbulenceFrequency: 1.40,
  flowSpeed: 4.75,
  turbulenceX: 0.5,
  turbulenceY: 0.70,
  turbulenceZ: 0.90,
  noiseLocality: 0.80,
  turbulenceOctaves: 3,
  octaveScale: 1.1,
  octaveMultiplier: 0.0,
  drag: 0.10,
  swirl: 0.10,
  kick: 0,
  hitLineEnabled: true,
  hitLineColor: '#5ad7ff',
  hitLineIntensity: 2.5,
  hitLineThickness: 0.3,
  hitLineWaveEnabled: true,
  hitLineWaveIntensity: 1.0,
  hitLineWaveAmplitude: 0.2,
  hitLineWaveScale: 60.0,
  hitLineWaveScrollSpeed: -0.5,
  hitLineWaveMorphSpeed: 0.7,
  hitLineWaveThickness: 0.04,
  hitLineWaveGrain: 0.8,
  hitLineBarY: 0,
  hitLineWaveY: 0,
  hitLineBarHalo: 2.0,
  hitLineWaveHalo: 0.8,
  bloomEnabled: true,
  bloomIntensity: 0.5,
  bloomThreshold: 0.2,
  bloomRadius: 0.7,
  bloomSmoothing: 0.4,
  backgroundColor: '#05060a',
  whiteKeyColor: '#f5f5f5',
  blackKeyColor: '#161616',
  woodColor: '#a87d38',
  keyboardBrightness: 0.5,
  keyGlowEnabled: true,
  keyGlowFollowNote: true,
  keyGlowColor: '#5ad7ff',
  keyGlowIntensity: 1.5,
  keyGlowDecay: 0.05,
  volume: 0.8,
  midiVolume: 1.0,
  midiEnabled: true,
  playbackRate: 1.0,
  pedalEnabled: true,
  reverbEnabled: true,
  reverbDry: 1.0,
  reverbWet: 1.0,
  reverbSize: 3.0,
  reverbDecayTime: 2.2,
  reverbDecay: 1.0,
  reverbPreDelay: 0.03,
  reverbDamping: 0.4,
  reverbHiCut: 6000,
  reverbLowCut: 100,
  releaseTime: 0.45,
  samplerDetune: 0,
  eqBands: [-6, -2, 0, 0, 0, 0],
  velocityCurve: DEFAULT_VELOCITY_CURVE,
  velocityCompensation: 0.85,
  transpose: 0,
  userAudioOffsetSec: 0,
  userAudioVolume: 1.0,
  midiOffsetSec: 0,
  midiTrimStartSec: 0,
  midiTrimEndSec: null,
  userAudioTrimStartSec: 0,
  userAudioTrimEndSec: null,
  midiSpeedAutomation: [],
  midiSpeedAutomationYRangeLog2: 1,
  midiSpeedAutomationYCenterLog2: 0,
  timelineEditorOpen: true,
  timelineLaneScale: 1,
  timelineMidiLaneRatio: 1,
  timelineSpeedLaneRatio: 1,
  timelineAudioLaneRatio: 1,
  previewHighFps: false,
  followPlayhead: true,
  handVideoEnabled: true,
  handVideoOpacity: 1.0,
  handVideoBrightness: 1.0,
  handVideoPosX: 0,
  handVideoPosY: 1.6,
  handVideoScale: 6.0,
  handVideoOffsetSec: 0,
  handVideoTrimStartSec: 0,
  handVideoTrimEndSec: null,
}

/**
 * One entry on the undo / redo stack. Discriminated by which domain owns
 * the change so undo/redo can dispatch to the right restore path. Both
 * kinds keep the *pre-edit* snapshot — `undoEdit` swaps it in and pushes
 * the *current* state onto the redo stack.
 */
/**
 * Serialisable view of `useCustomTexture` for undo snapshots. The GPU
 * texture itself isn't stored — it can be re-derived from bytes + mime
 * via `setFromBytes`, so only the source triple needs to round-trip
 * through history.
 */
export type CustomTextureSnapshot = {
  bytes: ArrayBuffer | null
  mime: string | null
  fileName: string | null
}

export type EditEntry =
  | { kind: 'song'; before: ParsedSong }
  | { kind: 'settings'; before: Settings }
  | { kind: 'projectName'; before: string }
  | { kind: 'customTexture'; before: CustomTextureSnapshot }

// Bridge between the main store and the standalone `useCustomTexture`
// store. Keeping a registration slot here (rather than importing the
// custom-texture module from store.ts) avoids a cyclic import: customTexture
// already depends on the main store for markDirty. customTexture registers
// itself at module load time; until it does, customTexture-kind entries
// can't be created (and won't appear in history).
let customTextureGetter: (() => CustomTextureSnapshot) | null = null
let customTextureRestorer: ((snap: CustomTextureSnapshot) => void) | null = null
export const registerCustomTextureBridge = (
  getter: () => CustomTextureSnapshot,
  restorer: (snap: CustomTextureSnapshot) => void,
): void => {
  customTextureGetter = getter
  customTextureRestorer = restorer
}

// Module-level baseline + depth counter for in-flight settings gestures.
// `beginSettingsEdit` captures the baseline on the FIRST call (depth
// 0 → 1) and bumps the depth; further calls just bump. `endSettingsEdit`
// only commits when the depth drops back to 0. This refcounting makes
// the begin/end pair freely nestable, so a slider's outer gesture
// wrapper can call begin and the user's per-onChange `update()` can
// begin/end internally without prematurely committing the slider's
// drag to history. Each control still produces one undo entry per
// gesture: drag = one, toggle = one, color popover session = one.
let pendingSettingsBaseline: Settings | null = null
let pendingSettingsDepth = 0

const beginSettingsEdit = (): void => {
  if (pendingSettingsDepth === 0) {
    pendingSettingsBaseline = useStore.getState().settings
  }
  pendingSettingsDepth++
}

const endSettingsEdit = (): void => {
  if (pendingSettingsDepth === 0) return
  pendingSettingsDepth--
  if (pendingSettingsDepth > 0) return
  // Outermost end: commit the baseline.
  const baseline = pendingSettingsBaseline
  pendingSettingsBaseline = null
  if (baseline === null) return
  useStore.setState((state) => {
    // Defensive no-op: a gesture that ended without changing anything
    // (e.g. opening a color popover and closing it) shouldn't add a
    // phantom undo entry.
    if (state.settings === baseline) return state
    const history = state.editHistory.concat({ kind: 'settings', before: baseline })
    if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT)
    // Recompute dirty here (gesture commit). Per-frame updateSettings
    // calls inside the gesture skipped the hash for performance; this
    // settles dirty once on release so the indicator reflects the
    // final state.
    return {
      editHistory: history,
      editFuture: [],
      dirty: dirtyFor({
        song: state.song,
        settings: state.settings,
        savedContentHash: state.savedContentHash,
        externalDirty: state.externalDirty,
      }),
    }
  })
}

/**
 * Discard any pending baseline without committing — used when the entire
 * settings context is being replaced (loadProject / newProject / setSong),
 * since the undo entry would refer to settings that no longer relate to
 * the current session.
 */
const dropSettingsBaseline = (): void => {
  pendingSettingsBaseline = null
  pendingSettingsDepth = 0
}

// ─── Content fingerprint (for the dirty flag) ───────────────────────
// "Dirty" is derived from whether the current song + settings differ
// from the last-saved snapshot. Tracking it by content (not by
// per-mutation flags) means an edit + undo / add + delete cycle that
// nets to the original state correctly reads as clean again — which
// is what users intuitively expect.
//
// Settings whose values describe the playback session rather than the
// document (volume, playbackRate) are excluded — they don't get
// persisted to .nfz anyway, so toggling them shouldn't show "unsaved".
function hashSong(song: ParsedSong | null): string {
  if (!song) return ''
  let acc = ''
  for (const n of song.notes) {
    acc += `${n.id},${n.midi},${n.time.toFixed(6)},${n.duration.toFixed(6)},${n.velocity.toFixed(4)};`
  }
  acc += '|'
  for (const p of song.pedals) {
    acc += `${p.time.toFixed(6)},${p.value.toFixed(4)};`
  }
  return acc
}
function hashSettings(settings: Settings): string {
  // Snapshot all keys — settings that don't belong in the document
  // fingerprint (volume, playbackRate) are still included for now;
  // they happen to be stable across the dirty-relevant flows, and
  // listing exclusions risks drift as new settings are added.
  return JSON.stringify(settings)
}
function computeContentHash(s: {
  song: ParsedSong | null
  settings: Settings
}): string {
  return hashSong(s.song) + '|' + hashSettings(s.settings)
}
function dirtyFor(s: {
  song: ParsedSong | null
  settings: Settings
  savedContentHash: string
  externalDirty: boolean
}): boolean {
  if (s.externalDirty) return true
  return computeContentHash(s) !== s.savedContentHash
}

export type TransportState = 'stopped' | 'playing' | 'paused'

export type LoadStatus =
  | { state: 'idle' }
  | { state: 'loading'; loaded: number; total: number }
  | { state: 'ready' }

type AppState = {
  song: ParsedSong | null
  setSong: (s: ParsedSong | null) => void

  transport: TransportState
  setTransport: (t: TransportState) => void

  currentTime: number
  setCurrentTime: (t: number) => void

  loadStatus: LoadStatus
  setLoadStatus: (s: LoadStatus) => void

  loop: boolean
  setLoop: (b: boolean) => void

  // True while the user is holding the falling-notes area to fast-forward.
  fastForward: boolean
  setFastForward: (b: boolean) => void

  // When true, pressing Record plays a 4-beat metronome count-in before
  // the recorder actually starts capturing input. Lets the user prepare
  // the first downbeat instead of scrambling into the first note.
  countInEnabled: boolean
  setCountInEnabled: (b: boolean) => void
  // Current beat number during a count-in (1..N). 0 when not counting in.
  // Driven by the audio click scheduler; the toolbar reads this to show
  // the countdown badge.
  countInBeat: number
  setCountInBeat: (n: number) => void

  // === MIDI editor ==========================================================
  // Selection of falling-note ids the user is editing. Stored as a Set for
  // O(1) membership tests during click handling and selection-aware shader
  // attribute assembly. A new Set instance is allocated on each mutation
  // (replaceSelection / addToSelection / etc.) so zustand's reference-equality
  // change detection re-renders subscribers.
  selection: Set<number>
  // Replace the selection. Pass an empty array to clear.
  replaceSelection: (ids: Iterable<number>) => void
  // Toggle a single id. Used by Ctrl/Cmd+click for additive selection.
  toggleSelection: (id: number) => void
  // Convenience for clicking on empty space.
  clearSelection: () => void

  // Snapshot stack for undo. Each entry captures the *before* state of one
  // domain (song notes or inspector settings); undo restores it. Capped at
  // HISTORY_LIMIT entries to keep memory bounded for long sessions.
  editHistory: EditEntry[]
  // Forward stack for redo. Cleared whenever a fresh edit is applied
  // (standard branching-history semantics).
  editFuture: EditEntry[]
  /**
   * Apply an edit to the current song. Pushes the previous state onto
   * `editHistory`, sets the new song, clears `editFuture`, and notifies the
   * audio engine so its scheduling cursor tracks the new note array. No-op
   * when nothing is loaded. Pass either a replacement song or a function
   * `(prev) => next` for in-place mutation patterns.
   */
  applySongEdit: (next: ParsedSong | ((prev: ParsedSong) => ParsedSong)) => void
  /**
   * Set the song without touching undo history. Used during a drag where
   * each frame produces a new song state but we only want one undo entry
   * for the whole gesture (pushed via `pushUndoSnapshot` at drag start).
   */
  setSongPreview: (s: ParsedSong) => void
  /**
   * Push a snapshot to the undo stack without applying any change. Pair
   * with `setSongPreview` to bracket a multi-frame edit (e.g. a drag) so
   * one Undo restores the pre-drag state in a single step.
   */
  pushUndoSnapshot: (snapshot: ParsedSong) => void
  undoEdit: () => void
  redoEdit: () => void
  canUndo: () => boolean
  canRedo: () => boolean

  // Active range-select rectangle (in viewport client coords). Non-null
  // while the user is dragging on empty space in edit mode; the Viewport
  // overlay subscribes to this to draw the marquee.
  rangeSelectRect: { x1: number; y1: number; x2: number; y2: number } | null
  setRangeSelectRect: (
    r: { x1: number; y1: number; x2: number; y2: number } | null,
  ) => void

  // Position (in viewport client coords) of the per-note context menu, or
  // null when no menu is open. Set by a right-click on a falling note;
  // cleared by outside-click / Escape / selection-empty. The menu reads
  // velocity (etc.) from the current `selection`, not from a captured
  // note id, so dragging-into-selection-then-right-clicking still works.
  contextMenu: { x: number; y: number } | null
  setContextMenu: (m: { x: number; y: number } | null) => void

  // Defaults inherited by the next new note (left-click on empty edit
  // area). Updated whenever exactly one note is the active edit subject:
  // selecting it (replaceSelection of size 1), creating a new note, or
  // editing it via velocity menu / drag-resize. Survives Escape and
  // note deletion so a user can deselect / delete and the next created
  // note still picks up the last-touched note's feel.
  // `track` carries forward so a new note inherits the track (and thus
  // the per-track colour) of whichever note the user most recently
  // touched. Lets users keep adding notes to the "right hand" track
  // without per-note bookkeeping.
  lastNoteParams: { duration: number; velocity: number; track: number }
  setLastNoteParams: (p: { duration: number; velocity: number; track: number }) => void

  settings: Settings
  updateSettings: (patch: Partial<Settings>) => void
  resetSettings: () => void
  /**
   * Mark the start of a user gesture that mutates settings. Idempotent
   * within a gesture — only the first call records the baseline; nested
   * calls are no-ops. Pair every begin with an end (or use the gesture
   * helpers in controls.tsx that already do).
   */
  beginSettingsEdit: () => void
  /**
   * Commit the captured baseline to the undo stack as a single entry.
   * If the live settings are unchanged from the baseline, no entry is
   * added (so a no-op gesture doesn't pollute history).
   */
  endSettingsEdit: () => void
  /**
   * Append a custom-texture snapshot to the undo stack. Called by
   * `useCustomTexture.setFromFile` after a successful image swap so the
   * change becomes Cmd+Z'able like any other settings edit.
   */
  pushCustomTextureSnapshot: (before: CustomTextureSnapshot) => void

  // === Project file persistence ============================================
  // The .nfz file currently associated with this session, or null when
  // the user is editing a fresh / never-saved project. `handle` (when
  // present) lets `Save` overwrite the file without re-prompting; on
  // browsers without the File System Access API, `handle` is always null
  // and `Save` falls back to a download.
  currentFile: FileRef | null
  setCurrentFile: (f: FileRef | null) => void

  // True when in-memory state has changed since the last Save / Open / New.
  // Drives the beforeunload prompt and a "*" indicator next to the filename.
  dirty: boolean
  // Snapshot of the project content at the last save / load. The dirty
  // flag is computed by comparing the current content hash against
  // this baseline, so edits that net to the original state (add +
  // delete, undo a change, reset a setting) read as clean.
  savedContentHash: string
  // Flips true when external state (custom texture / user audio /
  // anything outside this store) has changed since the last save.
  // The content hash doesn't cover those, so they need a separate
  // signal. Cleared on save / load.
  externalDirty: boolean
  markClean: () => void
  // Manual dirty trigger — for state held outside this store that still
  // belongs to the project (e.g. `useCustomTexture`'s loaded image).
  markDirty: () => void

  // User-editable project display name. Persisted into manifest.name on
  // save and used as the Save As suggested filename. Empty string means
  // "not explicitly set" — display falls back to currentFile.name (minus
  // extension) → song.name → "Untitled" in that order.
  projectName: string
  setProjectName: (name: string) => void

  // Atomic project load. Replaces settings + song + currentFile in one
  // step and marks clean. Bypasses the per-mutation dirty flag since the
  // session now represents exactly what's on disk. Editor state (history,
  // selection, etc.) is reset like any other song change.
  loadProject: (
    nextSettings: Settings,
    nextSong: ParsedSong | null,
    ref: FileRef | null,
    projectName: string,
  ) => void

  // Clear to a blank session — equivalent to a fresh page load. Resets
  // settings to defaults, drops the song, clears `currentFile`, and marks
  // clean. Editor state is reset.
  newProject: () => void
}

export const useStore = create<AppState>((set) => ({
  song: null,
  // Loading a new song wipes the editor state — the undo stack referenced
  // notes from the previous file and the highlighted selection no longer
  // points at anything visible. Editor restarts fresh on every load.
  setSong: (song) => {
    // A fresh song means the previous file's note-undo entries point at
    // ids that no longer exist; settings entries would survive in
    // principle but we wipe them too to keep the "this session" model
    // intuitive. Drop any pending settings baseline for the same reason.
    dropSettingsBaseline()
    set((state) => ({
      song,
      editHistory: [],
      editFuture: [],
      selection: new Set(),
      // The freshly loaded MIDI becomes the new dirty baseline:
      // anything from this point reads as dirty, and an edit-then-
      // revert (add + delete, undo, etc.) returns to clean. Loading
      // a file should not itself read as "unsaved changes" — there
      // are no changes yet. The action layer is responsible for
      // gating MIDI load behind a discard-unsaved confirm so we
      // don't accidentally clobber prior work here.
      savedContentHash: computeContentHash({ song, settings: state.settings }),
      externalDirty: false,
      dirty: false,
    }))
  },

  transport: 'stopped',
  setTransport: (transport) => set({ transport }),

  currentTime: 0,
  setCurrentTime: (currentTime) => set({ currentTime }),

  loadStatus: { state: 'idle' },
  setLoadStatus: (loadStatus) => set({ loadStatus }),

  loop: false,
  setLoop: (loop) => set({ loop }),

  fastForward: false,
  setFastForward: (fastForward) => set({ fastForward }),

  countInEnabled: true,
  setCountInEnabled: (countInEnabled) => set({ countInEnabled }),

  countInBeat: 0,
  setCountInBeat: (countInBeat) => set({ countInBeat }),

  selection: new Set<number>(),
  replaceSelection: (ids) =>
    set((state) => {
      const next = new Set(ids)
      // Snapshot the singly-selected note's params so the next new
      // note can inherit them. Skipped for multi-select (ambiguous)
      // and empty (preserve previous snapshot).
      if (next.size === 1 && state.song) {
        const id = next.values().next().value as number
        const note = state.song.notes.find((n) => n.id === id)
        if (note) {
          return {
            selection: next,
            lastNoteParams: { duration: note.duration, velocity: note.velocity, track: note.track },
          }
        }
      }
      return { selection: next }
    }),
  toggleSelection: (id) =>
    set((state) => {
      const next = new Set(state.selection)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      // Same single-selection snapshot rule as replaceSelection.
      if (next.size === 1 && state.song) {
        const sid = next.values().next().value as number
        const note = state.song.notes.find((n) => n.id === sid)
        if (note) {
          return {
            selection: next,
            lastNoteParams: { duration: note.duration, velocity: note.velocity, track: note.track },
          }
        }
      }
      return { selection: next }
    }),
  clearSelection: () =>
    set((state) => (state.selection.size === 0 ? state : { selection: new Set() })),

  editHistory: [],
  editFuture: [],
  applySongEdit: (next) =>
    set((state) => {
      if (!state.song) return state
      const computed = typeof next === 'function' ? next(state.song) : next
      if (computed === state.song) return state
      const history = state.editHistory.concat({ kind: 'song', before: state.song })
      if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT)
      audioEngine.updateSong(computed)
      // Re-snapshot lastNoteParams so post-edit values (resize, velocity
      // change) carry over to the next new note even if the user later
      // deselects.
      const patch: Partial<AppState> = {
        song: computed,
        editHistory: history,
        editFuture: [],
        dirty: dirtyFor({
          song: computed,
          settings: state.settings,
          savedContentHash: state.savedContentHash,
          externalDirty: state.externalDirty,
        }),
      }
      if (state.selection.size === 1) {
        const id = state.selection.values().next().value as number
        const note = computed.notes.find((n) => n.id === id)
        if (note) patch.lastNoteParams = { duration: note.duration, velocity: note.velocity, track: note.track }
      }
      return patch
    }),
  setSongPreview: (s) =>
    set((state) => {
      if (!state.song) return state
      audioEngine.updateSong(s)
      // Per-frame setter — drags fire this many times. We deliberately
      // SKIP the dirty hash here: `hashSong` walks every note and
      // allocates a fresh string each call, which at 60fps becomes the
      // dominant CPU cost during a note drag. The gesture's commit
      // (applySongEdit) recomputes dirty correctly on release; the
      // indicator may lag by one drag but that's invisible to users
      // since they're already mid-edit.
      const patch: Partial<AppState> = {
        song: s,
      }
      if (state.selection.size === 1) {
        const id = state.selection.values().next().value as number
        const note = s.notes.find((n) => n.id === id)
        if (note) patch.lastNoteParams = { duration: note.duration, velocity: note.velocity, track: note.track }
      }
      return patch
    }),
  pushUndoSnapshot: (snapshot) =>
    set((state) => {
      const history = state.editHistory.concat({ kind: 'song', before: snapshot })
      if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT)
      return { editHistory: history, editFuture: [] }
    }),
  undoEdit: () => {
    // Defensively close any settings gesture that didn't make it to its
    // own end call (e.g. a slider whose pointercancel didn't fire). Most
    // gestures already commit themselves; this is the safety net.
    endSettingsEdit()
    // Custom-texture restore is async (TextureLoader / ImageDecoder), so
    // it's dispatched OUTSIDE set(): we capture the current snapshot
    // synchronously, swap stacks synchronously, then kick off the
    // bridge restore which lands on the customTexture store when its
    // own promise resolves.
    {
      const peek = useStore.getState().editHistory
      if (peek.length > 0) {
        const top = peek[peek.length - 1]
        if (top.kind === 'customTexture') {
          const snapshotNow = customTextureGetter?.() ?? {
            bytes: null,
            mime: null,
            fileName: null,
          }
          set((state) => ({
            editHistory: state.editHistory.slice(0, -1),
            editFuture: state.editFuture.concat({
              kind: 'customTexture',
              before: snapshotNow,
            }),
            dirty: true,
          }))
          customTextureRestorer?.(top.before)
          return
        }
      }
    }
    set((state) => {
      if (state.editHistory.length === 0) return state
      const entry = state.editHistory[state.editHistory.length - 1]
      const history = state.editHistory.slice(0, -1)
      if (entry.kind === 'song') {
        if (!state.song) return state
        const future = state.editFuture.concat({ kind: 'song', before: state.song })
        audioEngine.updateSong(entry.before)
        // The selection may reference notes that no longer exist in the
        // restored snapshot; intersect to drop the strays so highlight stays
        // truthful.
        const validIds = new Set(entry.before.notes.map((n) => n.id))
        const trimmed = new Set<number>()
        for (const id of state.selection) if (validIds.has(id)) trimmed.add(id)
        return {
          song: entry.before,
          editHistory: history,
          editFuture: future,
          selection: trimmed,
          dirty: dirtyFor({
            song: entry.before,
            settings: state.settings,
            savedContentHash: state.savedContentHash,
            externalDirty: state.externalDirty,
          }),
        }
      }
      if (entry.kind === 'projectName') {
        const future = state.editFuture.concat({
          kind: 'projectName',
          before: state.projectName,
        })
        // Match setProjectName's no-dirty semantics — restoring an old
        // name shouldn't flip dirty if the rename never did.
        return {
          projectName: entry.before,
          editHistory: history,
          editFuture: future,
        }
      }
      if (entry.kind === 'settings') {
        const future = state.editFuture.concat({ kind: 'settings', before: state.settings })
        return {
          settings: entry.before,
          editHistory: history,
          editFuture: future,
          dirty: dirtyFor({
            song: state.song,
            settings: entry.before,
            savedContentHash: state.savedContentHash,
            externalDirty: state.externalDirty,
          }),
        }
      }
      // 'customTexture' is handled by the early-return block above; this
      // path is unreachable but kept exhaustive for the discriminated
      // union so future kinds force a compile error here.
      return state
    })
  },
  redoEdit: () => {
    endSettingsEdit()
    {
      const peek = useStore.getState().editFuture
      if (peek.length > 0) {
        const top = peek[peek.length - 1]
        if (top.kind === 'customTexture') {
          const snapshotNow = customTextureGetter?.() ?? {
            bytes: null,
            mime: null,
            fileName: null,
          }
          set((state) => {
            const history = state.editHistory.concat({
              kind: 'customTexture',
              before: snapshotNow,
            })
            if (history.length > HISTORY_LIMIT)
              history.splice(0, history.length - HISTORY_LIMIT)
            return {
              editHistory: history,
              editFuture: state.editFuture.slice(0, -1),
              dirty: true,
            }
          })
          customTextureRestorer?.(top.before)
          return
        }
      }
    }
    set((state) => {
      if (state.editFuture.length === 0) return state
      const entry = state.editFuture[state.editFuture.length - 1]
      const future = state.editFuture.slice(0, -1)
      if (entry.kind === 'song') {
        if (!state.song) return state
        const history = state.editHistory.concat({ kind: 'song', before: state.song })
        if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT)
        audioEngine.updateSong(entry.before)
        const validIds = new Set(entry.before.notes.map((n) => n.id))
        const trimmed = new Set<number>()
        for (const id of state.selection) if (validIds.has(id)) trimmed.add(id)
        return {
          song: entry.before,
          editHistory: history,
          editFuture: future,
          selection: trimmed,
          dirty: dirtyFor({
            song: entry.before,
            settings: state.settings,
            savedContentHash: state.savedContentHash,
            externalDirty: state.externalDirty,
          }),
        }
      }
      if (entry.kind === 'projectName') {
        const history = state.editHistory.concat({
          kind: 'projectName',
          before: state.projectName,
        })
        if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT)
        return {
          projectName: entry.before,
          editHistory: history,
          editFuture: future,
        }
      }
      if (entry.kind === 'settings') {
        const history = state.editHistory.concat({ kind: 'settings', before: state.settings })
        if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT)
        return {
          settings: entry.before,
          editHistory: history,
          editFuture: future,
          dirty: dirtyFor({
            song: state.song,
            settings: entry.before,
            savedContentHash: state.savedContentHash,
            externalDirty: state.externalDirty,
          }),
        }
      }
      // 'customTexture' handled in the early-return block above.
      return state
    })
  },
  canUndo: (): boolean => useStore.getState().editHistory.length > 0,
  canRedo: (): boolean => useStore.getState().editFuture.length > 0,

  rangeSelectRect: null,
  setRangeSelectRect: (rangeSelectRect) => set({ rangeSelectRect }),

  contextMenu: null,
  setContextMenu: (contextMenu) => set({ contextMenu }),

  // Defaults match the original NEW_NOTE_DURATION / NEW_NOTE_VELOCITY in
  // EditTools — mirror them here so the very first new note (before any
  // selection happened) still uses the same baseline feel.
  lastNoteParams: { duration: 0.25, velocity: 0.7, track: 0 },
  setLastNoteParams: (lastNoteParams) => set({ lastNoteParams }),

  settings: defaultSettings,
  // Pure apply — history is bracketed by the caller via begin/endSettingsEdit
  // (Inspector controls do this transparently). Direct callers that want
  // an undoable atomic change should wrap themselves in begin → update →
  // end, or use the helpers in controls.tsx.
  updateSettings: (patch) =>
    set((state) => {
      const settings = { ...state.settings, ...patch }
      // Inside a gesture (slider drag, color popover session, etc.)
      // every onChange would otherwise call `dirtyFor` → `hashSong`
      // (O(notes)) + JSON.stringify(settings). At 60fps on a multi-
      // thousand-note song that burns several ms per frame for a value
      // that only matters at gesture end. `endSettingsEdit` recomputes
      // it once when the outermost begin/end pair closes; outside a
      // gesture (atomic switch/select clicks) we still compute it
      // synchronously so the indicator flips immediately.
      if (pendingSettingsDepth > 0) {
        return { settings }
      }
      return {
        settings,
        dirty: dirtyFor({
          song: state.song,
          settings,
          savedContentHash: state.savedContentHash,
          externalDirty: state.externalDirty,
        }),
      }
    }),
  // Preserve transport-bar controlled settings (volume, playback speed) so
  // the user's listening setup isn't lost when they reset the visual /
  // audio Inspector. The Reset button lives in the Inspector and is
  // expected to only affect what the Inspector shows.
  resetSettings: () => {
    beginSettingsEdit()
    set((state) => {
      const settings = {
        ...defaultSettings,
        volume: state.settings.volume,
        playbackRate: state.settings.playbackRate,
      }
      return {
        settings,
        dirty: dirtyFor({
          song: state.song,
          settings,
          savedContentHash: state.savedContentHash,
          externalDirty: state.externalDirty,
        }),
      }
    })
    endSettingsEdit()
  },
  beginSettingsEdit: () => beginSettingsEdit(),
  endSettingsEdit: () => endSettingsEdit(),
  pushCustomTextureSnapshot: (before) =>
    set((state) => {
      const history = state.editHistory.concat({ kind: 'customTexture', before })
      if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT)
      return { editHistory: history, editFuture: [] }
    }),

  currentFile: null,
  setCurrentFile: (currentFile) => set({ currentFile }),

  dirty: false,
  // Initial saved hash matches the initial empty state so a freshly
  // opened app reads as clean (no song, default settings = empty
  // project that doesn't need saving).
  savedContentHash: computeContentHash({ song: null, settings: defaultSettings }),
  externalDirty: false,
  markClean: () =>
    set((state) => ({
      dirty: false,
      externalDirty: false,
      savedContentHash: computeContentHash(state),
    })),
  // External-state change (audio buffer load, custom texture import,
  // etc.). Sets the external-dirty bit so subsequent content-hash
  // recomputations don't accidentally clear dirty.
  markDirty: () => set({ dirty: true, externalDirty: true }),

  projectName: '',
  // Renaming doesn't flip the dirty flag — the project name is metadata
  // that lives outside the song / settings the user is iterating on, so
  // a rename shouldn't trigger the "Discard unsaved changes?" gate when
  // they open a different file. The next Save still picks up the new
  // name; users who rename and close without saving lose only the
  // rename, not real edits. Renames DO push to history so Cmd+Z reverts
  // them like any other edit; the history entry is independent of the
  // dirty flag.
  setProjectName: (name) =>
    set((state) => {
      if (name === state.projectName) return state
      const history = state.editHistory.concat({
        kind: 'projectName',
        before: state.projectName,
      })
      if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT)
      return { projectName: name, editHistory: history, editFuture: [] }
    }),

  loadProject: (nextSettings, nextSong, ref, projectName) => {
    dropSettingsBaseline()
    set({
      settings: nextSettings,
      song: nextSong,
      currentFile: ref,
      projectName,
      dirty: false,
      externalDirty: false,
      // Re-baseline the dirty fingerprint to the freshly-loaded state
      // so subsequent edits read as dirty from THIS point, and any
      // edit-then-revert cycle returns the project to clean.
      savedContentHash: computeContentHash({
        song: nextSong,
        settings: nextSettings,
      }),
      editHistory: [],
      editFuture: [],
      selection: new Set(),
      contextMenu: null,
      rangeSelectRect: null,
    })
  },

  newProject: () => {
    dropSettingsBaseline()
    set({
      settings: defaultSettings,
      song: null,
      currentFile: null,
      projectName: '',
      dirty: false,
      externalDirty: false,
      savedContentHash: computeContentHash({
        song: null,
        settings: defaultSettings,
      }),
      editHistory: [],
      editFuture: [],
      selection: new Set(),
      contextMenu: null,
      rangeSelectRect: null,
    })
  },
}))

/**
 * Subscribe to a narrow slice of `settings` instead of the whole object.
 * `keys` is an `as const` tuple — the returned object's type narrows to
 * `Pick<Settings, …>` automatically. With `useShallow`, the component
 * re-renders ONLY when one of the listed values actually changes —
 * Inspector slider drags on unrelated keys (e.g. dragging Reverb Wet
 * while reading flash params) won't trigger a re-render.
 *
 * Pass the keys array as a module-level `as const` constant (NOT inline)
 * so its identity stays stable across renders.
 */
export function useSettingsSlice<K extends readonly (keyof Settings)[]>(
  keys: K,
): Pick<Settings, K[number]> {
  return useStore(
    useShallow((s) => {
      const out = {} as Pick<Settings, K[number]>
      for (const k of keys) (out as Record<string, unknown>)[k as string] = s.settings[k]
      return out
    }),
  )
}

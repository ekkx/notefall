import { create } from 'zustand'
import { setHandSongSource } from './midi/noteHands'
import type { NoteLabelContent } from './notes/pitchLabels'
import {
  NOTE_LOOK_PRESETS,
  type NoteBump,
  type NoteMaterial,
  type Note2dOutline,
  type NotePattern,
  type NoteShape,
  type NoteSurface,
} from './notes/looks/noteLook'
import {
  HIT_LINE_COLOR_DEFAULTS,
  NOTE_COLOR_DEFAULTS,
  type HitLineColorMode,
  type NoteColorMode,
  type NoteRandomBy,
} from './notes/noteColor'
import { useShallow } from 'zustand/react/shallow'
import type { ParsedSong } from './midi/types'
import type { Accidental, PitchLabelFormat } from './midi/noteName'
import type { SpeedPoint } from './midi/speedMap'
import {
  type SettingsKeyframe,
  pickAnimatable,
  resolveSettingsAt,
  isAnimatableKey,
} from './midi/settingsKeyframes'
import { audioEngine } from './audio/engine'
import { track } from './usage'
import { pinCountBucket } from './usage/events'
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
 * Image applied to falling-note instances (multiplies the note colour under
 * either note material). Add new entries here AND add a matching code path
 * inside the note fragment shader (notes/noteShader.ts).
 * - 'solid'  — the plain note colour
 * - 'custom' — user-provided image (managed via useCustomTexture store)
 */
export type NoteTexture = 'solid' | 'custom'

export type StageBackgroundFit = 'cover' | 'contain' | 'stretch'

export type Settings = {
  // Layout
  // On-screen keyboard position: 0 = its front edge on the bottom of the
  // view, 1 = its back edge on the top. Applied as a lens shift, so the
  // keyboard keeps its straight-on look (see scene/visibleTop.ts).
  keyboardScreenY: number
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
  // Note colouring (notes/noteColor.ts): solid = noteColor + trackColors,
  // gradient = up to 5 stops across the note area at an angle, random = a
  // seeded palette pick per note / pitch / pitch class / track.
  noteColorMode: NoteColorMode
  noteGradientStops: number
  noteGradientAngle: number
  noteGradientSoftness: number
  noteGradientColor1: string
  noteGradientColor2: string
  noteGradientColor3: string
  noteGradientColor4: string
  noteGradientColor5: string
  noteGradientPos1: number
  noteGradientPos2: number
  noteGradientPos3: number
  noteGradientPos4: number
  noteGradientPos5: number
  noteRandomBy: NoteRandomBy
  noteRandomSeed: number
  noteRandomCount: number
  noteRandomColor1: string
  noteRandomColor2: string
  noteRandomColor3: string
  noteRandomColor4: string
  noteRandomColor5: string
  /** `noteColorMode: 'hand'`: notes assigned to the left / right hand (others keep `noteColor`). */
  noteHandColorL: string
  noteHandColorR: string
  noteEmissive: number
  noteOpacity: number
  noteCornerRadius: number
  noteWidthScale: number
  // Minimum visible length so very short notes do not collapse into a line
  noteMinLength: number
  // Note look (notes/looks/noteLook.ts): 'flat' = plain tinted fill, 'reflective' = lit bevel + bump reflecting an
  // animated light pattern. The look keys below apply to 'reflective'. Lengths are world units.
  noteMaterial: NoteMaterial
  // Outline of the note (applies to every material): see NoteShape. Gem: corner radius = chamfer leg, bevel = crown;
  // angled: bevel = frame width.
  noteShape: NoteShape
  // Bevelled rim measured inward from the edge; depth = slope at the very edge.
  noteBevelWidth: number
  noteBevelDepth: number
  // 0 = rounded-over (slope fades across the band), 1 = chamfer (flat slope that rolls into the top over Softness).
  noteBevelProfile: number
  noteBevelSoftness: number
  // How much the bevel bends the reflected pattern (1 = fully; the lights always see it fully).
  noteBevelReflect: number
  // Darkens (> 0) / brightens (< 0) the bevel band along its profile.
  noteRimShade: number
  // 0..1: fade the bevel's pattern bend where it would alias on steep rims.
  noteRimFade: number
  // Key light: intensity, direction it comes FROM in the screen plane (deg, 0 = top, 90 = right), height above
  // the note plane (deg). The fill light sits opposite at the same height.
  noteLightIntensity: number
  noteLightAzimuth: number
  noteLightElevation: number
  noteFillIntensity: number
  noteAmbient: number
  // Weight of the reflected pattern; sheen = how far its hot spots push toward white.
  noteReflectivity: number
  noteSheen: number
  // 0 = opaque; 1 = the body is see-through where the pattern is dark.
  noteTransparency: number
  noteSaturation: number
  // Realistic material: map set, albedo gain, key/fill highlight weight, emissive seams, albedo variation
  // (1 = as baked, 0 = its mean, > 1 = exaggerated). Cells (0 = the set's default) / irregularity are bake-time.
  noteSurface: NoteSurface
  noteAlbedoGain: number
  noteSpecular: number
  noteEmission: number
  noteSurfaceContrast: number
  noteSurfaceCells: number
  noteSurfaceIrregularity: number
  // Light pattern source (see NotePattern) and its sideways scroll (world units / s).
  notePattern: NotePattern
  notePatternDrift: number
  // Animated silk texture multiplied into the pattern (0 = off), its tile size and animation rate.
  noteSilk: number
  noteSilkScale: number
  noteSilkSpeed: number
  // Light pattern: tile size, cells per tile, focus of its bright lines, contrast / brightness of the reflection,
  // animation rate, 0 = fixed on screen … 1 = carried with the note, how far the surface bends the lookup,
  // and 1 = full modulation … 0 = flat at its mean.
  notePatternScale: number
  notePatternDensity: number
  notePatternSharpness: number
  notePatternContrast: number
  notePatternBrightness: number
  notePatternSpeed: number
  notePatternLock: number
  notePatternDistortion: number
  notePatternAmount: number
  // Soft knee: reflected-light level above which the pattern rolls off smoothly (0 = off) + how gradually.
  notePatternKnee: number
  notePatternKneeSoftness: number
  // 0..1: bright pattern plateaus turn grey-translucent with brighter edges.
  notePatternRibbon: number
  // Baked normal map carried by the note (see NoteBump); tile size + slope gain.
  noteBump: NoteBump
  noteBumpScale: number
  noteBumpDepth: number
  // 0 = crisp creases … 1 = strongly rounded (reads a blurrier mip).
  noteBumpSoftness: number
  // 0..1: melt the creases where the cloud is strong (everywhere without a cloud).
  noteBumpMelt: number
  // Song-space per-key frame for the note-carried maps (bump, cloud, frost grain): continuous along a key,
  // different on every key, so chords never repeat the same interior.
  noteBumpScatter: boolean
  // Faint glass lines along the bump's facet boundaries (kept when melted / frosted).
  noteFacetEdges: number
  // Soft cloudy volume: light added by large soft blobs, their size, edge softness, and how see-through the body
  // gets between them.
  noteCloud: number
  noteCloudScale: number
  noteCloudSoftness: number
  noteCloudClear: number
  // White-hot cores: luminance above Threshold rolls into white over Softness (> 1 overdrives for Bloom).
  noteHighlight: number
  noteHighlightThreshold: number
  noteHighlightSoftness: number
  // Frosted glass: diffusion of the seen pattern, satin grain + its size, milky veil (lifts darks).
  noteFrost: number
  noteFrostGrain: number
  noteFrostScale: number
  noteFrostVeil: number
  // Ring OUTSIDE the body (width 0 = off): brightness, colour, 0 = Color … 1 = note colour, pattern reflection.
  noteOutlineWidth: number
  noteOutlineBrightness: number
  noteOutlineColor: string
  noteOutlineBlend: number
  noteOutlineReflect: number
  // Thick-glass rim INSIDE the edge (width 0 = off): bright band, then a darker gap.
  noteRimBand: number
  noteRimBandBrightness: number
  noteRimBandColor: string
  // 0 = Color, 1 = the note colour lifted toward white (so the band follows every track's colour).
  noteRimBandBlend: number
  noteRimGap: number
  noteRimGapDark: number
  // Liquid merge (round shape): fillet size (0 = off; gaps below ≈ 1.4× this bridge), colour blend width across the
  // fillet, whether consecutive notes on ONE key fuse too, opt-in closing of same-key legato joints into one column
  // (0..1), and the depth of a groove at those closed joints (× bevel depth).
  noteMergeRadius: number
  noteMergeColorSpread: number
  noteMergeSameKey: boolean
  noteMergeLegatoClose: number
  noteMergeCrease: number
  // 2D (sprite) material — see looks/noteLook.ts. Shares noteLightIntensity / Azimuth / Elevation (key light),
  // noteFillIntensity, noteAmbient and noteCornerRadius. Lengths world units, angles degrees.
  // Rounded-over rim band width + how far the normal tips over at the edge (0 = flat), ring width (0 = solid).
  note2dRimWidth: number
  note2dRimTilt: number
  note2dHollow: number
  // Fill light direction (its intensity is noteFillIntensity).
  note2dFillAzimuth: number
  note2dFillElevation: number
  // Specular lobe weight / sharpness; shade → tint gain (the tint is reached at shade = 1 / exposure); whitening
  // above WhitenStart; black-key notes darker / white-key notes lighter by KeySplit.
  note2dGloss: number
  note2dGlossPower: number
  note2dExposure: number
  note2dWhiten: number
  note2dWhitenStart: number
  note2dKeySplit: number
  // Moving light pattern (0 = off): brightness gain while on, cell size, rate, 0 = fixed on screen … 1 = carried.
  note2dShimmer: number
  note2dShimmerGain: number
  note2dShimmerScale: number
  note2dShimmerSpeed: number
  note2dShimmerLock: number
  // Embossed silk filaments: spacing, elongation along travel, contrast, albedo gain, relief, rate, lock.
  note2dTexture: boolean
  note2dTextureScale: number
  note2dTextureStretch: number
  note2dTextureContrast: number
  note2dTextureGain: number
  note2dTextureRelief: number
  note2dTextureSpeed: number
  note2dTextureLock: number
  // Outline band (see Note2dOutline): width, 0 = grey … 1 = darkened tint, tint multiplier, grey level,
  // brightness, 0 = flat band … 1 = lit tube.
  note2dOutline: Note2dOutline
  note2dOutlineWidth: number
  note2dOutlineTint: number
  note2dOutlineShade: number
  note2dOutlineGrey: number
  note2dOutlineBrightness: number
  note2dOutlineRelief: number
  // Glow halo (0 = off): core radius, weight of the long tail, whitening, body brightness while on.
  note2dGlow: number
  note2dGlowRadius: number
  note2dGlowTail: number
  note2dGlowWhiten: number
  note2dGlowBoost: number
  // Image applied to the note — see NoteTexture.
  noteTexture: NoteTexture
  // Spatial frequency of the texture pattern (higher = denser detail /
  // more repetitions; lower = zoomed in).
  noteTextureScale: number
  // Animation speed along X. Used by 'custom' for horizontal scroll.
  noteAnimSpeedX: number
  // Animation speed along Y. Used by 'custom' for vertical scroll.
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
  // When true, particles take the colour of their note; else particleColor.
  particleColorFollowNote: boolean
  particleColor: string
  // Lift the flash colour toward white. 0 = pure flashColor, 1 = pure white.
  // Lets a coloured flash keep a bright white core for that "spark" feel.
  flashBrightness: number
  flashIntensity: number
  flashSize: number
  flashWidth: number
  // Softness of the core falloff — larger = wider halo edge around the bright spot
  flashHaloWidth: number
  flashColor: string
  // Particles rising from held keys: soft dots (a share of them drawn
  // as thin tilted rays) carried by a curl-noise flow, plus faint fog
  // puffs behind them. See notes/particleSim.ts for the motion model.
  particlesEnabled: boolean
  particleBlending: 'alpha' | 'additive'
  particleDotCount: number       // emission rate multiplier (rays are a share of the dots)
  particleDotSize: number
  particleDotOpacity: number
  particleDotBrightness: number  // lift of the dot colour toward white
  particleLife: number           // lifetime multiplier
  particleRise: number           // upward drift speed
  particleSpread: number         // launch-direction fan across the emitter (needs launch speed)
  particleEmitterWidth: number   // spawn band width, in key widths
  // Turbulence: a multi-octave curl-noise flow the velocity lags toward.
  particleFlowStrength: number
  particleFlowX: number          // per-axis weight of the flow
  particleFlowY: number
  particleFlowZ: number
  particleFlowOctaves: number    // 1..4
  particleFlowOctaveScale: number // frequency multiplier per octave
  particleFlowOctaveGain: number  // amplitude multiplier per octave
  particleFlowFrequency: number  // spatial frequency of the flow (larger = smaller swirls)
  particleFlowEvolution: number  // how fast the flow pattern changes over time
  particleFlowFollow: number     // 0 = static field the particles rise through, 1 = field rises with them
  // Motion extras (all off at 0).
  particleLaunchSpeed: number
  particleRandomDirection: number
  particleRandomSpeed: number
  particleAirFriction: number
  particleGravityCurl: number    // bends headings away from vertical
  particleTwirl: number          // orbit around the key's vertical axis
  particleTwirlVariance: number
  particleMotionTrail: boolean   // stretch dots along their travel
  particleRaysEnabled: boolean
  particleRayLength: number
  particleRayOpacity: number
  particleRayAngle: number       // degrees at the keyboard centre
  particleRaySpread: number      // extra degrees fanned across the keyboard width
  particleFogEnabled: boolean
  particleFogCount: number       // fog puff emission rate multiplier
  particleFogOpacity: number
  // Glowing laser line at the keyboard hit point — straight bar + animated wavy beam
  hitLineEnabled: boolean
  hitLineColor: string
  // Line colouring (notes/noteColor.ts): solid = hitLineColor, gradient =
  // its own 2..5 stops along the line, note = the notes' colouring.
  hitLineColorMode: HitLineColorMode
  hitLineGradientStops: number
  hitLineGradientSoftness: number
  hitLineGradientColor1: string
  hitLineGradientColor2: string
  hitLineGradientColor3: string
  hitLineGradientColor4: string
  hitLineGradientColor5: string
  hitLineGradientPos1: number
  hitLineGradientPos2: number
  hitLineGradientPos3: number
  hitLineGradientPos4: number
  hitLineGradientPos5: number
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
  octaveLinesEnabled: boolean   // vertical B→C guide lines above the keyboard
  // Pitch names on the falling notes (at the keyboard end) and on the keys.
  noteLabelsEnabled: boolean
  noteLabelContent: NoteLabelContent   // pitch name, finger number, or both
  noteLabelFormat: PitchLabelFormat
  noteLabelAccidental: Accidental
  noteLabelSize: number
  noteLabelColor: string
  noteLabelOpacity: number
  noteLabelOutlineWidth: number   // 0 = no outline, 1 = widest
  noteLabelOutlineColor: string
  noteLabelPosition: 'keyboard' | 'center' | 'far'   // which part of the note
  noteLabelOffset: number   // world units from that end, toward the middle
  // Virtual piano hands (beta, src/hands/). Not pin-animatable.
  handsEnabled: boolean
  // 0..2: how strongly the landing flashes light the hands (1 = as strong as on the keys, 0 = off).
  handsFlashLight: number
  // Temporal-supersampling motion blur on the hands only (src/hands/motionBlur.ts). Samples = cap; the actual count adapts to speed.
  handsMotionBlur: boolean
  handsBlurSamples: number
  keyLabelsEnabled: boolean
  keyLabelsMode: 'c' | 'white' | 'all'   // which keys carry a label
  keyLabelFormat: PitchLabelFormat
  keyLabelAccidental: Accidental
  keyLabelSize: number
  keyLabelOpacity: number
  keyLabelOffset: number   // world units from the key's front edge (black: its flat top)
  keyLabelWhiteColor: string
  keyLabelBlackColor: string
  // Project-level image displayed behind the 3D scene. The source bytes
  // live in the standalone stage-background asset store; these settings
  // only describe how that asset is presented. They are deliberately not
  // keyframe-animatable.
  backgroundImageFit: StageBackgroundFit
  backgroundImageOpacity: number
  // Framing of the background image on top of the fit mode: zoom factor
  // (1 = fit exactly) and pan, both in normalised image units. Mirrors
  // the `noteTextureScale` / `noteTextureOffset*` trio the custom note
  // texture already offers.
  backgroundImageScale: number
  backgroundImageOffsetX: number
  backgroundImageOffsetY: number
  /** Degrees, clockwise, about the centre of the viewport. */
  backgroundImageRotation: number
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
  // Timeline "pins": snapshot keyframes for animatable visual settings.
  // Each pin captures the visual-continuous subset of settings at a
  // timeline-time; the scene morphs between consecutive pins. Lives
  // inside Settings (like `midiSpeedAutomation`) so it rides the
  // normal persistence / dirty / undo / .nfz paths. See
  // `midi/settingsKeyframes.ts`. Empty = no automation (resolver is a
  // bit-for-bit identity early-return).
  settingsKeyframes: SettingsKeyframe[]
}

export const defaultSettings: Settings = {
  keyboardScreenY: 0.27,
  cameraFov: 32,
  cameraPos: [0, 0, 12],
  cameraLookAt: [0, 0, 0],
  notesEnabled: true,
  fallDirection: 'down',
  fallDurationSec: 2.5,
  noteColor: '#5ad7ff',
  trackColors: {},
  ...NOTE_COLOR_DEFAULTS,
  noteEmissive: 1.0,
  noteOpacity: 1.0,
  noteWidthScale: 1.2,
  noteMinLength: 0.15,
  // corner radius + every look key: the 'plain' look preset
  ...NOTE_LOOK_PRESETS.plain,
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
  particleColorFollowNote: true,
  particleColor: '#5ad7ff',
  flashBrightness: 0.5,
  flashIntensity: 1.1,
  flashSize: 2.5,
  flashWidth: 2.5,
  flashHaloWidth: 0.5,
  flashColor: '#ffffff',
  particlesEnabled: true,
  particleBlending: 'alpha',
  particleDotCount: 3.0,
  particleDotSize: 0.8,
  particleDotOpacity: 0.7,
  particleDotBrightness: 1.2,
  particleLife: 0.8,
  particleRise: 1.0,
  particleSpread: 0,
  particleEmitterWidth: 0.9,
  particleFlowStrength: 1.0,
  particleFlowX: 0.5,
  particleFlowY: 0.5,
  particleFlowZ: 0.5,
  particleFlowOctaves: 3,
  particleFlowOctaveScale: 1.1,
  particleFlowOctaveGain: 0.5,
  particleFlowFrequency: 1.1,
  particleFlowEvolution: 1.3,
  particleFlowFollow: 0.7,
  particleLaunchSpeed: 0,
  particleRandomDirection: 0,
  particleRandomSpeed: 0,
  particleAirFriction: 0,
  particleGravityCurl: 0,
  particleTwirl: 0,
  particleTwirlVariance: 0,
  particleMotionTrail: false,
  particleRaysEnabled: true,
  particleRayLength: 1.2,
  particleRayOpacity: 0.08,
  particleRayAngle: -40,
  particleRaySpread: 80,
  particleFogEnabled: true,
  particleFogCount: 1.6,
  particleFogOpacity: 0.08,
  hitLineEnabled: true,
  hitLineColor: '#5ad7ff',
  ...HIT_LINE_COLOR_DEFAULTS,
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
  octaveLinesEnabled: true,
  noteLabelsEnabled: false,
  noteLabelContent: 'pitch',
  noteLabelFormat: 'letter',
  noteLabelAccidental: 'sharp',
  noteLabelSize: 1,
  noteLabelColor: '#ffffff',
  noteLabelOpacity: 0.9,
  noteLabelOutlineWidth: 0.6,
  noteLabelOutlineColor: '#000000',
  noteLabelPosition: 'keyboard',
  noteLabelOffset: 0,
  handsEnabled: false,
  handsFlashLight: 1,
  handsMotionBlur: true,
  handsBlurSamples: 8,
  keyLabelsEnabled: false,
  keyLabelsMode: 'c',
  keyLabelFormat: 'letterOctave',
  keyLabelAccidental: 'sharp',
  keyLabelSize: 1,
  keyLabelOpacity: 0.85,
  keyLabelOffset: 0.06,
  keyLabelWhiteColor: '#2b2b2b',
  keyLabelBlackColor: '#d1d1d1',
  backgroundImageFit: 'cover',
  backgroundImageOpacity: 1,
  backgroundImageScale: 1,
  backgroundImageOffsetX: 0,
  backgroundImageOffsetY: 0,
  backgroundImageRotation: 0,
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
  // Closed by default: the floating panel sits over the keyboard. A view preference, so opening a
  // project keeps the current state (see loadProject).
  timelineEditorOpen: false,
  timelineLaneScale: 1,
  timelineMidiLaneRatio: 1,
  timelineSpeedLaneRatio: 1,
  timelineAudioLaneRatio: 1,
  previewHighFps: false,
  followPlayhead: true,
  settingsKeyframes: [],
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

/** Serialisable view of the standalone stage-background image store. */
export type StageBackgroundSnapshot = CustomTextureSnapshot

export type EditEntry =
  | { kind: 'song'; before: ParsedSong }
  | { kind: 'settings'; before: Settings }
  | { kind: 'projectName'; before: string }
  | { kind: 'customTexture'; before: CustomTextureSnapshot }
  | { kind: 'stageBackground'; before: StageBackgroundSnapshot }

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

let stageBackgroundGetter: (() => StageBackgroundSnapshot) | null = null
let stageBackgroundRestorer: ((snap: StageBackgroundSnapshot) => void) | null = null
export const registerStageBackgroundBridge = (
  getter: () => StageBackgroundSnapshot,
  restorer: (snap: StageBackgroundSnapshot) => void,
): void => {
  stageBackgroundGetter = getter
  stageBackgroundRestorer = restorer
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
    acc += `${n.id},${n.midi},${n.time.toFixed(6)},${n.duration.toFixed(6)},${n.velocity.toFixed(4)},${n.hand ?? ''},${n.finger ?? ''};`
  }
  acc += '|'
  for (const p of song.pedals) {
    acc += `${p.time.toFixed(6)},${p.value.toFixed(4)};`
  }
  for (const c of song.controls ?? []) {
    acc += `${c.number},${c.time.toFixed(6)},${c.value.toFixed(4)};`
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

/**
 * Keys the Inspector's Reset button must NOT touch — it should stay
 * confined to what the Inspector itself shows (look + audio voicing).
 * These all live OUTSIDE the Inspector: the transport bar, and the
 * timeline editor (clip sync / trim = "clip length", speed
 * automation = "speed pins", lane layout, follow/preview session
 * prefs) — plus the pins themselves. A naive `{ ...defaultSettings }`
 * wiped all of these; Reset now carries them over from current state.
 * If you add a NEW timeline-editor / clip / session setting, add its
 * key here so Reset keeps leaving it alone.
 */
const RESET_PRESERVED_KEYS = [
  // Transport bar
  'volume',
  'playbackRate',
  // Clip sync + trim ("clip length")
  'midiOffsetSec',
  'midiTrimStartSec',
  'midiTrimEndSec',
  'userAudioOffsetSec',
  'userAudioTrimStartSec',
  'userAudioTrimEndSec',
  // Per-clip audio, controlled from the timeline lanes
  'userAudioVolume',
  'midiVolume',
  'midiEnabled',
  // Speed automation ("speed pins")
  'midiSpeedAutomation',
  'midiSpeedAutomationYRangeLog2',
  'midiSpeedAutomationYCenterLog2',
  // Timeline editor layout / session prefs
  'timelineEditorOpen',
  'timelineLaneScale',
  'timelineMidiLaneRatio',
  'timelineSpeedLaneRatio',
  'timelineAudioLaneRatio',
  'previewHighFps',
  'followPlayhead',
  // Settings pins — never wiped by Reset
  'settingsKeyframes',
] as const satisfies readonly (keyof Settings)[]

/**
 * Timeline-editor content TIED TO THE SONG — reset to defaults when a
 * *different* MIDI / song is opened (even within the same project),
 * since pins / clip length / speed curve are all keyed to the old
 * song's timeline and are meaningless against a new one. The Inspector
 * look + editor layout + session prefs are intentionally NOT here, so
 * opening a new MIDI keeps the user's visual setup. Reset to
 * `defaultSettings[k]`.
 */
const SONG_TIED_KEYS = [
  // Pins
  'settingsKeyframes',
  // MIDI clip position + length (trim)
  'midiOffsetSec',
  'midiTrimStartSec',
  'midiTrimEndSec',
  // User-audio clip sync + length — its relationship to the song is
  // per-song, so a new MIDI invalidates it
  'userAudioOffsetSec',
  'userAudioTrimStartSec',
  'userAudioTrimEndSec',
  // Speed automation
  'midiSpeedAutomation',
  'midiSpeedAutomationYRangeLog2',
  'midiSpeedAutomationYCenterLog2',
] as const satisfies readonly (keyof Settings)[]

export type TransportState = 'stopped' | 'playing' | 'paused'

export type LoadStatus =
  | { state: 'idle' }
  | { state: 'loading'; loaded: number; total: number }
  | { state: 'ready' }

type AppState = {
  song: ParsedSong | null
  // `opts.resetTimeline` clears the song-tied timeline-editor content
  // (pins / clip length / speed — see `SONG_TIED_KEYS`) back to
  // defaults. Pass it when OPENING A DIFFERENT MIDI so stale pins /
  // trim / speed from the previous song don't carry over; leave it off
  // for recorder restore / empty-song bootstrap (same song context).
  setSong: (s: ParsedSong | null, opts?: { resetTimeline?: boolean }) => void

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
  // The selection the selection card was opened for (double-click on a note), or null. The card shows only while
  // `selection` is still this very Set, so any selection change closes it.
  selectionCardFor: Set<number> | null
  openSelectionCard: () => void
  closeSelectionCard: () => void

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

  // Defaults inherited by the next new note (left-click on empty edit
  // area). Updated whenever exactly one note is the active edit subject:
  // selecting it (replaceSelection of size 1), creating a new note, or
  // editing it via the selection card / drag-resize. Survives Escape and
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
  /** Append a stage-background image snapshot to the undo stack. */
  pushStageBackgroundSnapshot: (before: StageBackgroundSnapshot) => void

  // === Timeline pins (settings keyframes) =================================
  // Timeline-time (seconds) of the pin the Inspector is currently
  // editing, or null when editing the global base settings. When a pin
  // is selected, `updateSettings` transparently stamps animatable
  // patches into that pin's snapshot too — so every Inspector control
  // keeps working unchanged while it edits "the pin".
  editingKeyframeTime: number | null
  // Select a pin for editing: loads its snapshot into the live base
  // settings (so the Inspector reflects it) and marks it the edit
  // target. Pass null to go back to editing base settings. Does NOT
  // seek the transport — the timeline UI owns playhead movement.
  selectKeyframe: (time: number | null) => void
  // Drop a pin at `time`, capturing the *resolved* (interpolated)
  // animatable settings there so inserting between pins doesn't jump.
  // Selects the new pin. One undo entry.
  addKeyframe: (time: number) => void
  // Remove the pin at (closest to, within epsilon) `time`. Clears the
  // edit target if it pointed at the removed pin.
  removeKeyframe: (time: number) => void
  // Move a pin from one timeline-time to another (drag). One undo
  // entry per gesture — bracket the drag with begin/endSettingsEdit.
  moveKeyframe: (from: number, to: number) => void
  // Set the easing curvature of the segment STARTING at the pin at
  // `time` (matches SpeedPoint.curvature semantics).
  setKeyframeCurvature: (time: number, curvature: number) => void
  // Translate EVERY pin's time by `delta` seconds (clamped ≥ 0). Driven
  // by the MIDI-clip drag so pins stay glued to the music: `midiOffset`
  // is a pure additive shift of every note's TL_audio time, so shifting
  // each pin's TL_audio time by the same delta keeps pins locked to the
  // notes regardless of the speed map. Per-drag-frame setter — the
  // caller brackets the drag with begin/endSettingsEdit (one undo
  // entry per gesture), same contract as `moveKeyframe`.
  shiftKeyframes: (delta: number) => void

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
  setSong: (song, opts) => {
    // A fresh song means the previous file's note-undo entries point at
    // ids that no longer exist; settings entries would survive in
    // principle but we wipe them too to keep the "this session" model
    // intuitive. Drop any pending settings baseline for the same reason.
    dropSettingsBaseline()
    set((state) => {
      // Opening a DIFFERENT MIDI: clear the song-tied timeline-editor
      // content (pins / clip length / speed) so it doesn't carry over
      // from the previous song. The Inspector look is left untouched.
      let settings = state.settings
      if (opts?.resetTimeline) {
        const next = { ...settings } as Record<string, unknown>
        for (const k of SONG_TIED_KEYS) next[k as string] = defaultSettings[k]
        settings = next as Settings
      }
      return {
        song,
        settings,
        editHistory: [],
        editFuture: [],
        selection: new Set(),
        editingKeyframeTime: null,
        // The freshly loaded MIDI becomes the new dirty baseline:
        // anything from this point reads as dirty, and an edit-then-
        // revert (add + delete, undo, etc.) returns to clean. Loading
        // a file should not itself read as "unsaved changes" — there
        // are no changes yet. The action layer is responsible for
        // gating MIDI load behind a discard-unsaved confirm so we
        // don't accidentally clobber prior work here.
        savedContentHash: computeContentHash({ song, settings }),
        externalDirty: false,
        dirty: false,
      }
    })
  },

  transport: 'stopped',
  setTransport: (transport) =>
    set((state) => {
      if (state.transport === transport) return state
      if (transport === 'playing') track('playback_started')
      else if (transport === 'paused') track('playback_paused')
      else track('playback_stopped')
      return { transport }
    }),

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
  selectionCardFor: null,
  openSelectionCard: () => set((state) => ({ selectionCardFor: state.selection })),
  closeSelectionCard: () => set((state) => (state.selectionCardFor === null ? state : { selectionCardFor: null })),

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
      // One per committed gesture (applySongEdit is the single undo-
      // pushing chokepoint; in-flight drag frames go through
      // setSongPreview and are deliberately not counted). Count only —
      // no op label, no note data.
      track('note_edited')
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
    if (useStore.getState().editHistory.length > 0) track('undo')
    // External-image restores are async (TextureLoader / ImageDecoder),
    // so they are dispatched OUTSIDE set(): capture the current snapshot
    // synchronously, swap stacks synchronously, then kick off the bridge
    // restore which lands on the owning asset store when its promise
    // resolves.
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
        if (top.kind === 'stageBackground') {
          const snapshotNow = stageBackgroundGetter?.() ?? {
            bytes: null,
            mime: null,
            fileName: null,
          }
          set((state) => ({
            editHistory: state.editHistory.slice(0, -1),
            editFuture: state.editFuture.concat({
              kind: 'stageBackground',
              before: snapshotNow,
            }),
            dirty: true,
          }))
          stageBackgroundRestorer?.(top.before)
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
      // External image kinds are handled by the early-return block above.
      return state
    })
  },
  redoEdit: () => {
    endSettingsEdit()
    if (useStore.getState().editFuture.length > 0) track('redo')
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
        if (top.kind === 'stageBackground') {
          const snapshotNow = stageBackgroundGetter?.() ?? {
            bytes: null,
            mime: null,
            fileName: null,
          }
          set((state) => {
            const history = state.editHistory.concat({
              kind: 'stageBackground',
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
          stageBackgroundRestorer?.(top.before)
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
      // External image kinds are handled by the early-return block above.
      return state
    })
  },
  canUndo: (): boolean => useStore.getState().editHistory.length > 0,
  canRedo: (): boolean => useStore.getState().editFuture.length > 0,

  rangeSelectRect: null,
  setRangeSelectRect: (rangeSelectRect) => set({ rangeSelectRect }),


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
      // Pin-edit routing keyed to the SELECTED pin (`editingKeyframeTime`,
      // set by clicking a pin / adding one — playhead-independent so the
      // Inspector is deterministic and shows that pin):
      //  - a pin is selected → animatable keys edit THAT pin's snapshot
      //    ONLY; base (the separate, persistent "default look" the
      //    pre-first-pin region uses) is left untouched. Non-animatable
      //    keys (audio etc.) still go to base — pins never hold them.
      //  - no pin selected → edit base = the default look.
      // The Inspector mirrors this on the read side (see
      // `useEffectiveSetting`) so the controls show what they edit.
      const kfs = state.settings.settingsKeyframes
      const editT = state.editingKeyframeTime
      const targetIdx =
        editT !== null
          ? kfs.findIndex((p) => Math.abs(p.time - editT) < 1e-6)
          : -1
      let settings: Settings
      if (targetIdx >= 0) {
        const basePatch: Record<string, unknown> = {}
        const pinPatch: Record<string, unknown> = {}
        for (const k of Object.keys(patch)) {
          if (isAnimatableKey(k as keyof Settings)) {
            pinPatch[k] = (patch as Record<string, unknown>)[k]
          } else {
            basePatch[k] = (patch as Record<string, unknown>)[k]
          }
        }
        settings = { ...state.settings, ...basePatch }
        if (Object.keys(pinPatch).length > 0) {
          const next = kfs.slice()
          next[targetIdx] = {
            ...next[targetIdx],
            settings: { ...next[targetIdx].settings, ...pinPatch },
          }
          settings = { ...settings, settingsKeyframes: next }
        }
      } else {
        settings = { ...state.settings, ...patch }
      }
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
  // Reset stays confined to what the Inspector shows (visual look +
  // audio voicing): every Inspector-controlled key goes back to its
  // default, while everything OUTSIDE the Inspector is carried over
  // untouched — transport, and the timeline editor's clip length
  // (sync/trim), speed pins, lane layout and session prefs (see
  // `RESET_PRESERVED_KEYS`). The pins themselves are never wiped;
  // additionally, when a pin is SELECTED (`editingKeyframeTime`), only
  // that pin's *content* is reset to the default look (other pins'
  // snapshots and the base default untouched) so "Reset" means "reset
  // this pin" while a pin is selected; with no pin selected it resets
  // the base default look.
  resetSettings: () => {
    beginSettingsEdit()
    set((state) => {
      const curKfs = state.settings.settingsKeyframes
      const editT = state.editingKeyframeTime
      const selIdx =
        editT !== null
          ? curKfs.findIndex((p) => Math.abs(p.time - editT) < 1e-6)
          : -1
      track('settings_reset', { scope: selIdx >= 0 ? 'pin' : 'base' })
      let settings: Settings
      if (selIdx >= 0) {
        // A pin is selected → reset ONLY that pin's snapshot to the
        // default look. The base default and everything else are left
        // exactly as-is (the separate default look is not clobbered).
        const next = curKfs.slice()
        next[selIdx] = {
          ...next[selIdx],
          settings: pickAnimatable(defaultSettings),
        }
        settings = { ...state.settings, settingsKeyframes: next }
      } else {
        // No pin selected → reset the base default look, confined to
        // what the Inspector shows (RESET_PRESERVED_KEYS carried over,
        // pins never wiped).
        settings = { ...defaultSettings }
        for (const k of RESET_PRESERVED_KEYS) {
          ;(settings as Record<string, unknown>)[k as string] = state.settings[k]
        }
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
  pushStageBackgroundSnapshot: (before) =>
    set((state) => {
      const history = state.editHistory.concat({ kind: 'stageBackground', before })
      if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT)
      return { editHistory: history, editFuture: [] }
    }),

  editingKeyframeTime: null,
  selectKeyframe: (time) => {
    // Sets the SELECTED pin — the explicit target the Inspector reads
    // and writes (`useEffectiveSetting` / `updateSettings`), the banner
    // names, and the lane glows. `null` deselects → the Inspector edits
    // the separate base "default look" instead. It must NEVER merge the
    // pin snapshot into base `settings`: base is held separately (it's
    // what the pre-first-pin region ramps from) and selecting a pin
    // must not overwrite it. The caller also seeks for visual context.
    set((state) =>
      state.editingKeyframeTime === time
        ? state
        : { editingKeyframeTime: time },
    )
  },
  addKeyframe: (time) => {
    beginSettingsEdit()
    set((state) => {
      const t = Math.max(0, time)
      const kfs = state.settings.settingsKeyframes
      // Capture the *resolved* look at `t` so inserting between two
      // pins doesn't snap the scene.
      const snapshot = pickAnimatable(resolveSettingsAt(state.settings, kfs, t))
      const without = kfs.filter((p) => Math.abs(p.time - t) >= 1e-6)
      const next = without
        .concat({ time: t, settings: snapshot })
        .sort((a, b) => a.time - b.time)
      track('settings_pin_added', { pin_count: pinCountBucket(next.length) })
      return {
        editingKeyframeTime: t,
        settings: { ...state.settings, settingsKeyframes: next },
      }
    })
    endSettingsEdit()
  },
  removeKeyframe: (time) => {
    beginSettingsEdit()
    set((state) => {
      const next = state.settings.settingsKeyframes.filter(
        (p) => Math.abs(p.time - time) >= 1e-6,
      )
      if (next.length === state.settings.settingsKeyframes.length) return state
      return {
        settings: { ...state.settings, settingsKeyframes: next },
        editingKeyframeTime:
          state.editingKeyframeTime !== null &&
          Math.abs(state.editingKeyframeTime - time) < 1e-6
            ? null
            : state.editingKeyframeTime,
      }
    })
    endSettingsEdit()
  },
  // Per-drag-frame setter — the caller brackets the whole drag with
  // begin/endSettingsEdit (same one-undo-entry-per-gesture model as
  // Inspector sliders), so this just replaces state.
  moveKeyframe: (from, to) =>
    set((state) => {
      const t = Math.max(0, to)
      const kfs = state.settings.settingsKeyframes
      const idx = kfs.findIndex((p) => Math.abs(p.time - from) < 1e-6)
      if (idx < 0) return state
      const moved = { ...kfs[idx], time: t }
      const next = kfs
        .filter((_, i) => i !== idx)
        .filter((p) => Math.abs(p.time - t) >= 1e-6)
        .concat(moved)
        .sort((a, b) => a.time - b.time)
      const editingKeyframeTime =
        state.editingKeyframeTime !== null &&
        Math.abs(state.editingKeyframeTime - from) < 1e-6
          ? t
          : state.editingKeyframeTime
      return {
        settings: { ...state.settings, settingsKeyframes: next },
        editingKeyframeTime,
      }
    }),
  setKeyframeCurvature: (time, curvature) =>
    set((state) => {
      const kfs = state.settings.settingsKeyframes
      const idx = kfs.findIndex((p) => Math.abs(p.time - time) < 1e-6)
      if (idx < 0) return state
      const next = kfs.slice()
      next[idx] = { ...next[idx], curvature }
      return { settings: { ...state.settings, settingsKeyframes: next } }
    }),
  shiftKeyframes: (delta) =>
    set((state) => {
      const kfs = state.settings.settingsKeyframes
      if (kfs.length === 0 || delta === 0) return state
      // Shift then re-sort: clamping at 0 can reorder pins that were
      // already before the clip's content (an edge case — pins
      // normally sit over notes, well past t=0).
      const next = kfs
        .map((p) => ({ ...p, time: Math.max(0, p.time + delta) }))
        .sort((a, b) => a.time - b.time)
      // Keep the edit target glued to its pin for this frame;
      // PinTargetSync re-derives it from the playhead next rAF anyway.
      const editingKeyframeTime =
        state.editingKeyframeTime !== null
          ? Math.max(0, state.editingKeyframeTime + delta)
          : null
      return {
        settings: { ...state.settings, settingsKeyframes: next },
        editingKeyframeTime,
      }
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

  loadProject: (loadedSettings, nextSong, ref, projectName) => {
    dropSettingsBaseline()
    // Whether the timeline panel is open is how this window is laid out, not part of the song.
    const nextSettings = { ...loadedSettings, timelineEditorOpen: useStore.getState().settings.timelineEditorOpen }
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
      editingKeyframeTime: null,
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
      editingKeyframeTime: null,
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

// Lets the note colouring look up a note's hand without importing the store.
setHandSongSource(() => useStore.getState().song)

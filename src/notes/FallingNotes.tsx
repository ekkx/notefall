import { useMemo, useRef, useEffect } from 'react'
import * as THREE from 'three'
import { isLinearTarget } from '../scene/linearTarget'
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { useStore, useSettingsSlice } from '../store'
import { getLensWindow } from '../scene/framing'
import { computeLiveVisibleTop } from '../scene/visibleTop'
import { getResolvedSettings } from '../scene/automatedSettings'
import { audioEngine } from '../audio/engine'
import { now } from '../audio/clock'
import { KEYBOARD_LAYOUT, MIDI_MIN, KEY_COUNT, NOTE_HIT_Y, WHITE_KEY_WIDTH, isBlackKey } from '../keyboard/layout'
import { useCustomTexture } from './customTexture'
import { computeDuration, deleteNotes, moveNotes, splitNote } from '../midi/edit'
import { ensureSamplerLoaded, previewNote } from '../audio/preview'
import {
  clickXToMidi,
  clickYToTime,
  fallDistance,
  FALL_REFERENCE_DISTANCE,
  SPAWN_BUFFER,
  noteVisualBounds,
  parallaxX,
  NOTE_PLANE_Z,
  NOTE_PARALLAX_SCALE,
  type TimeContext,
} from './positions'
import { buildSpeedMap, midiToTimeline } from '../midi/speedMap'
import { noteDeathFx, FADE_DURATION as DEATH_FADE_DURATION } from './noteDeathFx'
import {
  NOTE_VERTEX_SHADER,
  NOTE_FRAGMENT_SHADER,
  TEXTURE_SOLID,
  TEXTURE_CUSTOM,
  MATERIAL_FLAT,
  MATERIAL_REFLECTIVE,
  MATERIAL_REALISTIC,
  MATERIAL_SPRITE,
  SHAPE_ROUND,
  SHAPE_GEM,
  SHAPE_ANGLED,
  linearToSrgbChannel,
} from './noteShader'
import { NoteLookResources } from './looks/noteLookResources'
import { GRADIENT_AREA_HEIGHT, NoteColorResolver, createGradientUniforms, noteGradient, writeGradientUniforms } from './noteColor'
import { MergeData, type MergeNote } from './looks/merge'
import {
  createLabelMesh,
  labelAtlas,
  noteLabelHeight,
  noteLabelMinLength,
  noteLabelMinLengths,
  fingerGlyph,
  LABEL_CELL_ASPECT,
  type LabelMesh,
} from './pitchLabels'

const MAX_INSTANCES = 4096
// Texture-phase wrap period (see the wrap in the useFrame). A power of
// two so the modulo is float32-exact; large enough that the one-frame
// noise discontinuity at the wrap is tens of minutes apart even at the
// max animation speed, yet small enough that fbm/hash inputs stay in
// float32-precise range so the flow never freezes. Mirrors HitLine's
// TIME_WRAP_SECONDS guard for the same precision-collapse failure.
const PHASE_WRAP = 1024
// Shared in/out object for `computeRisingRect`. Reused across notes so
// the per-frame layout pass doesn't allocate thousands of objects.
const _risingRect: { topY: number; bottomY: number } = { topY: 0, bottomY: 0 }

/**
 * Geometry of a rising trail (head leads upward, tail follows). Used
 * identically by recorded-MIDI 'up' notes and live MIDI input notes —
 * the two paths feed in different time origins (`t - n.time` vs
 * `liveNow - startTime`) and different durations (`n.duration` vs
 * `endTime - startTime`), but everything downstream (visualLength,
 * head/tail Y, cull math) must stay byte-for-byte identical, so the
 * geometry lives in one place.
 *
 * Returns null when the head hasn't crossed the hit line yet
 * (`headT < 0`). Otherwise mutates and returns the shared object.
 */
function computeRisingRect(
  headT: number,
  duration: number,
  hitY: number,
  fall: number,
  fallDistance: number,
  minLength: number,
): { topY: number; bottomY: number } | null {
  if (headT < 0) return null
  const tailT = headT - duration
  const headY = hitY + (headT / fall) * fallDistance
  const tailY = hitY + (tailT / fall) * fallDistance
  const visualLength = Math.max(minLength, headY - tailY)
  _risingRect.topY = headY
  _risingRect.bottomY = headY - visualLength
  return _risingRect
}

// Same-key gaps below this are closed into one column when the merge's
// legato closing is on (world units; a quarter white key).
const MERGE_LEGATO_GAP = 0.25 * WHITE_KEY_WIDTH

// The merge's same-key rule assumes the editor's "no same-pitch overlap"
// (resolveOverlaps); an imported or live overlap would hard-union into a V
// crease inside the column, so the lower note is clipped to end where the
// upper one starts. Rects are centre / full size; solo entries are skipped.
function clipSameKeyOverlaps(notes: MergeNote[]): void {
  const byKey = new Map<number, MergeNote[]>()
  for (const n of notes) {
    if (n.solo) continue
    const a = byKey.get(n.key)
    if (a) a.push(n)
    else byKey.set(n.key, [n])
  }
  for (const a of byKey.values()) {
    if (a.length < 2) continue
    a.sort((p, q) => p.y - p.h / 2 - (q.y - q.h / 2))
    for (let i = 0; i + 1 < a.length; i++) {
      const lo = a[i]
      const bottom = lo.y - lo.h / 2
      const top = Math.max(Math.min(lo.y + lo.h / 2, a[i + 1].y - a[i + 1].h / 2), bottom + 1e-3)
      lo.y = (bottom + top) / 2
      lo.h = top - bottom
    }
  }
}

// Direction TOWARDS a light at `azimuthDeg` in the screen plane (0 = from
// the top, 90 = from the right) and `elevationDeg` above the note plane.
function setLightDir(out: THREE.Vector3, azimuthDeg: number, elevationDeg: number): void {
  const a = THREE.MathUtils.degToRad(azimuthDeg)
  const e = THREE.MathUtils.degToRad(elevationDeg)
  out.set(Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), Math.sin(e))
}

// Unknown values (the removed 'liquid' / 'gem' of older projects) fall back to solid.
const TEXTURE_MODE: Record<string, number> = {
  solid: TEXTURE_SOLID,
  custom: TEXTURE_CUSTOM,
}

// 1x1 transparent placeholder so the sampler2D uniform always has a valid
// texture bound (an unbound sampler reads black on some drivers + warns).
// The shader uses uHasCustomTexture to ignore samples from this placeholder.
const PLACEHOLDER_TEXTURE = new THREE.DataTexture(
  new Uint8Array([255, 255, 255, 255]),
  1,
  1,
  THREE.RGBAFormat,
)
PLACEHOLDER_TEXTURE.needsUpdate = true

// Keys FallingNotes actually reads from settings. Selecting these with
// `useShallow` means an Inspector slider drag on an unrelated key (e.g.
// any Audio / Reverb / Particles slider) does NOT re-render this
// component — and therefore doesn't trigger Three.js / R3F
// reconciliation on the instanced mesh.
const FALLING_NOTES_KEYS = [
  'cameraFov',
  'cameraLookAt',
  'cameraPos',
  'edgeEnabled',
  'fallDirection',
  'fallDurationSec',
  'midiOffsetSec',
  'midiSpeedAutomation',
  'midiTrimEndSec',
  'midiTrimStartSec',
  'noteAnimSpeedX',
  'noteAnimSpeedY',
  'noteColor',
  'noteCornerRadius',
  'noteEdgeColor',
  'noteEdgeIntensity',
  'noteEdgeWidth',
  'noteEmissive',
  'noteMaterial',
  'noteBump',
  'noteBumpScatter',
  'noteShape',
  'notePattern',
  'noteSurface',
  'noteSurfaceCells',
  'noteSurfaceIrregularity',
  'noteSilk',
  'noteMergeSameKey',
  'noteMergeLegatoClose',
  'noteMergeCrease',
  'note2dTexture',
  'note2dOutline',
  'noteMinLength',
  'noteOpacity',
  'noteTexture',
  'noteTextureBlur',
  'noteTextureContrast',
  'noteTextureOffsetX',
  'noteTextureOffsetY',
  'noteTextureScale',
  'noteTextureVariation',
  'noteWidthScale',
  'noteLabelsEnabled',
  'noteLabelContent',
  'noteLabelFormat',
  'noteLabelAccidental',
  'noteLabelPosition',
  'trackColors',
  'transpose',
] as const

export function FallingNotes() {
  const settings = useSettingsSlice(FALLING_NOTES_KEYS)
  const song = useStore((s) => s.song)
  const customTexture = useCustomTexture((s) => s.texture)
  const transport = useStore((s) => s.transport)
  // Speed automation map — memoised against the breakpoint array so
  // useFrame re-uses the same instance until the user actually
  // edits the curve. With no automation this is `EMPTY_SPEED_MAP`,
  // which makes `midiToTimeline` an identity (zero cost).
  const speedMap = useMemo(
    () => buildSpeedMap(settings.midiSpeedAutomation),
    [settings.midiSpeedAutomation],
  )
  // Shared geometry context handed to the per-note helpers. Built
  // here so the per-frame closure / per-event handlers don't need
  // to thread the speed map + offset through every call site.
  const timeCtx: TimeContext = useMemo(
    () => ({ speedMap, midiOffset: settings.midiOffsetSec }),
    [speedMap, settings.midiOffsetSec],
  )

  const meshRef = useRef<THREE.InstancedMesh>(null)
  // Integrated texture phase (∫ animSpeed dt) + the previous `now()` it
  // was advanced at. Persist across frames AND across the live→export
  // handoff (same component instance) so the flow never jumps.
  const phaseRef = useRef(new THREE.Vector2(0, 0))
  const lastPhaseNow = useRef<number | null>(null)
  const dummy = useMemo(() => new THREE.Object3D(), [])
  // Scratch Color used to parse hex strings into linear RGB once per
  // track per frame. Reused across all calls in the resolveTint cache
  // so we don't allocate per note.
  const colorResolver = useMemo(() => new NoteColorResolver(), [])
  const { camera, gl } = useThree()

  // per-instance world size attribute (width, length)
  const sizes = useMemo(() => new Float32Array(MAX_INSTANCES * 2), [])
  // per-instance noise seed (vec2). Derived from the note's stable id each
  // frame so a given note keeps the same texture pattern even if its slot
  // in the instance buffer shifts as earlier notes scroll past.
  const seeds = useMemo(() => new Float32Array(MAX_INSTANCES * 2), [])
  // per-instance selection flag (0 / 1). Drives the bright white outline in
  // the fragment shader. Filled in the same useFrame pass that builds size
  // and seed, since the per-frame instance ↔ note mapping is built there.
  const selectedAttrData = useMemo(() => new Float32Array(MAX_INSTANCES), [])
  // per-instance opacity multiplier. 1.0 for normal notes; ramps 1 → 0
  // over DEATH_FADE_DURATION for dying-note ghosts that the renderer
  // appends after the live-note pass.
  const alphaAttrData = useMemo(() => {
    const a = new Float32Array(MAX_INSTANCES)
    a.fill(1)
    return a
  }, [])
  // Per-instance RGB tint. Resolved each frame from the note's track →
  // settings.trackColors[trackIdx], with fallback to settings.noteColor.
  // Live notes / dying ghosts (which have no track index) use the
  // global noteColor as well.
  const tints = useMemo(() => new Float32Array(MAX_INSTANCES * 3), [])
  // Per-instance black-key flag (the 2D look's key split).
  const blacks = useMemo(() => new Float32Array(MAX_INSTANCES), [])
  // GPU-side copies of the arrays above, packed into three vec4s (see
  // NOTE_VERTEX_SHADER: fits WebGL's 8-attribute minimum). Filled from the
  // per-field arrays at the end of each frame.
  const packed = useMemo(() => {
    const make = () => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(MAX_INSTANCES * 4), 4)
      a.setUsage(THREE.DynamicDrawUsage)
      return a
    }
    return { rect: make(), seedSel: make(), tintAlpha: make() }
  }, [])
  // Per-instance key index (0..87, transpose applied), for the pitch labels.
  const labelKeys = useMemo(() => new Int16Array(MAX_INSTANCES), [])
  // Finger number (1–5) per instance for finger labels; 0 = none (live notes, ghosts, unassigned).
  const labelFingers = useMemo(() => new Int8Array(MAX_INSTANCES), [])
  const labelMinLen = useMemo(() => new Float32Array(KEY_COUNT), [])
  // Maps the per-frame instance slot back to the song's note id. Click
  // handling reads from this; useFrame writes it.
  const instanceToNoteId = useRef<number[]>([])

  // Liquid merge (looks/merge.ts): neighbour attributes + data texture.
  // Its uniforms are shared into the material below.
  const mergeData = useMemo(() => new MergeData(), [])
  useEffect(() => () => mergeData.dispose(), [mergeData])
  // Per-slot key index (merge's same-key rule) — -1 = solo (dying ghosts).
  const mergeKeys = useMemo(() => new Int16Array(MAX_INSTANCES), [])
  const mergeNotes = useRef<MergeNote[]>([])

  const material = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        ...mergeData.uniforms,
        uEmissive: { value: settings.noteEmissive },
        uOpacity: { value: settings.noteOpacity },
        uRadius: { value: settings.noteCornerRadius },
        uHitY: { value: 0 },
        uNoteZ: { value: NOTE_PLANE_Z },
        uTextureMode: { value: TEXTURE_MODE[settings.noteTexture] ?? TEXTURE_SOLID },
        ...createGradientUniforms(NOTE_HIT_Y),
        uTextureScale: { value: settings.noteTextureScale },
        uPhase: { value: new THREE.Vector2(0, 0) },
        uTextureOffset: { value: new THREE.Vector2(settings.noteTextureOffsetX, settings.noteTextureOffsetY) },
        uTextureBlur: { value: settings.noteTextureBlur },
        uTextureVariation: { value: settings.noteTextureVariation },
        uTextureContrast: { value: settings.noteTextureContrast },
        uEdgeColor: { value: new THREE.Color(settings.noteEdgeColor) },
        uEdgeWidth: { value: settings.noteEdgeWidth },
        uEdgeIntensity: { value: settings.noteEdgeIntensity },
        uCustomTexture: { value: PLACEHOLDER_TEXTURE },
        uHasCustomTexture: { value: 0 },
        uLinearTarget: { value: 0 },
        // note look — pushed per frame from the pin-resolved settings
        uMaterial: { value: MATERIAL_FLAT },
        uShape: { value: SHAPE_ROUND },
        uDriftX: { value: 0 },
        uNoteTex: { value: null },
        uNoteTexAmount: { value: 0 },
        uNoteTexTile: { value: 1 },
        uAlbedoMap: { value: null },
        uGlossMap: { value: null },
        uEmissiveMap: { value: null },
        uAlbedoGain: { value: 1.6 },
        uSpecular: { value: 0.5 },
        uEmission: { value: 0 },
        uSurfaceContrast: { value: 1 },
        uBumpZEnc: { value: 0 },
        uUnit: { value: WHITE_KEY_WIDTH },
        uBevelW: { value: 0 },
        uBevelD: { value: 0 },
        uBevelProfile: { value: 0 },
        uBevelSoft: { value: 0.5 },
        uBevelReflect: { value: 1 },
        uRimShade: { value: 0 },
        uRimFade: { value: 1 },
        uKey: { value: new THREE.Vector3(0, 0, 1) },
        uFill: { value: new THREE.Vector3(0, 0, 1) },
        uKeyI: { value: 0 },
        uFillI: { value: 0 },
        uAmbient: { value: 0 },
        uReflect: { value: 1 },
        uTransparency: { value: 0 },
        uSaturation: { value: 1 },
        uSheen: { value: 0 },
        uPattern: { value: null },
        uPatternTile: { value: 1 },
        uContrast: { value: 1 },
        uBrightness: { value: 0 },
        uLock: { value: 0 },
        uDistort: { value: 0 },
        uPatternAmount: { value: 1 },
        uKnee: { value: 0 },
        uKneeSoft: { value: 0.3 },
        uRibbon: { value: 0 },
        uBump: { value: null },
        uBumpTile: { value: 1 },
        uBumpDepth: { value: 0 },
        uDetail: { value: 0 },
        uBumpSoft: { value: 0 },
        uMelt: { value: 0 },
        uScatter: { value: 0 },
        uFacetEdges: { value: 0 },
        uFacetMap: { value: 0 },
        uScroll: { value: 0 },
        uTexUnit: { value: 1 },
        uTime: { value: 0 },
        uCloud: { value: 0 },
        uCloudTile: { value: 1 },
        uCloudSoft: { value: 0.6 },
        uCloudClear: { value: 0 },
        uHighlight: { value: 0 },
        uHighlightThr: { value: 0.7 },
        uHighlightSoft: { value: 0.45 },
        uFrost: { value: 0 },
        uFrostGrain: { value: 0 },
        uFrostTile: { value: 1 },
        uFrostVeil: { value: 0 },
        uMargin: { value: 0.01 },
        uOutlineW: { value: 0 },
        uOutlineBright: { value: 1 },
        uOutlineBlend: { value: 0.8 },
        uOutlineReflect: { value: 1 },
        uOutlineColor: { value: new THREE.Color(1, 1, 1) },
        uBandW: { value: 0 },
        uBandBright: { value: 1 },
        uBandBlend: { value: 0 },
        uGapW: { value: 0 },
        uGapDark: { value: 0 },
        uBandColor: { value: new THREE.Color(1, 1, 1) },
        u2dRimW: { value: 0 },
        u2dRimTilt: { value: 0 },
        u2dHollow: { value: 0 },
        u2dFill: { value: new THREE.Vector3(0, 0, 1) },
        u2dGloss: { value: 0 },
        u2dGlossPow: { value: 16 },
        u2dExposure: { value: 1 },
        u2dWhiten: { value: 0 },
        u2dWhitenStart: { value: 1 },
        u2dKeySplit: { value: 0 },
        u2dShimmer: { value: 0 },
        u2dShimmerGain: { value: 1 },
        u2dShimmerCell: { value: 1 },
        u2dShimmerSpeed: { value: 0 },
        u2dShimmerLock: { value: 0 },
        u2dTex: { value: 0 },
        u2dTexCell: { value: 1 },
        u2dTexStretch: { value: 1 },
        u2dTexContrast: { value: 0 },
        u2dTexGain: { value: 1 },
        u2dTexRelief: { value: 0 },
        u2dTexSpeed: { value: 0 },
        u2dTexLock: { value: 0 },
        u2dOutline: { value: 0 },
        u2dOutW: { value: 0 },
        u2dOutTint: { value: 0 },
        u2dOutShade: { value: 0 },
        u2dOutGrey: { value: 0 },
        u2dOutBright: { value: 1 },
        u2dOutRelief: { value: 0 },
        u2dGlow: { value: 0 },
        u2dGlowR: { value: 1 },
        u2dGlowTail: { value: 0 },
        u2dGlowWhiten: { value: 0 },
        u2dGlowBoost: { value: 1 },
      },
      vertexShader: NOTE_VERTEX_SHADER,
      fragmentShader: NOTE_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    })
    // we intentionally don't include settings in deps — uniforms are mutated via the effect below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Only the non-animatable texture-mode selector is synced here.
  // Every animatable note uniform (emissive / opacity / radius /
  // texture scale-offset-blur-variation-contrast / edge colour-width-
  // intensity) is pushed per-frame from the pin-resolved settings
  // inside useFrame, so they follow timeline pins and animate under
  // the export advance() loop. With zero pins the resolved values
  // equal the live settings, so the written uniforms are identical to
  // what this effect used to write.
  useEffect(() => {
    material.uniforms.uTextureMode.value = TEXTURE_MODE[settings.noteTexture] ?? TEXTURE_SOLID
  }, [material, settings.noteTexture])

  useEffect(() => {
    const mesh = meshRef.current
    if (!mesh) return
    mesh.geometry.setAttribute('iRect', packed.rect)
    mesh.geometry.setAttribute('iSeedSel', packed.seedSel)
    mesh.geometry.setAttribute('iTintAlpha', packed.tintAlpha)
    mesh.geometry.setAttribute('iMergeNbrA', mergeData.nbrA)
    mesh.geometry.setAttribute('iMergeNbrB', mergeData.nbrB)
    // Pin a large bounding sphere so raycasting never short-circuits.
    // Three.js's InstancedMesh.raycast() does an early-reject against the
    // mesh's bounding sphere, but auto-computes it ONCE (lazily, on first
    // raycast) from whatever instances happened to be visible then. Notes
    // that arrive later — at the screen edges, far above / below — would
    // then sit outside that stale sphere and silently become unclickable
    // (selecting "some notes, not others"). A fixed sphere larger than any
    // realistic camera frame keeps every instance in scope; the per-
    // instance triangle test is what actually decides hits.
    mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1000)
    // Bloom on = the composer's linear target, off = the canvas (sRGB).
    mesh.onBeforeRender = (renderer, _scene, cam) => {
      const target = renderer.getRenderTarget()
      material.uniforms.uLinearTarget.value = isLinearTarget(target) ? 1 : 0
      // merge: gl_FragCoord → world on the note plane, for exactly the
      // camera + target of this draw
      if (material.defines.MERGE !== undefined) mergeData.updateCamera(cam, target, renderer, NOTE_PLANE_Z)
    }
    return () => {
      mesh.geometry.deleteAttribute('iRect')
      mesh.geometry.deleteAttribute('iSeedSel')
      mesh.geometry.deleteAttribute('iTintAlpha')
      mesh.geometry.deleteAttribute('iMergeNbrA')
      mesh.geometry.deleteAttribute('iMergeNbrB')
    }
  }, [packed, material, mergeData])

  // The 2D look's glow halo: a second instanced mesh over the SAME geometry,
  // instance matrices and uniforms (shader variant GLOW_PASS), drawn just
  // under the notes. A child of the note mesh, so it inherits the parallax
  // transform; it is never raycast (picking stays on the notes).
  const glowMeshRef = useRef<THREE.InstancedMesh | null>(null)
  useEffect(() => {
    const mesh = meshRef.current
    if (!mesh) return
    const glowMaterial = new THREE.ShaderMaterial({
      uniforms: material.uniforms,
      vertexShader: NOTE_VERTEX_SHADER,
      fragmentShader: NOTE_FRAGMENT_SHADER,
      defines: { GLOW_PASS: '' },
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    })
    const glow = new THREE.InstancedMesh(mesh.geometry, glowMaterial, MAX_INSTANCES)
    glow.instanceMatrix = mesh.instanceMatrix
    glow.frustumCulled = false
    glow.renderOrder = mesh.renderOrder - 0.01
    glow.raycast = () => {}
    glow.visible = false
    glow.count = 0
    glow.onBeforeRender = (renderer) => {
      material.uniforms.uLinearTarget.value = isLinearTarget(renderer.getRenderTarget()) ? 1 : 0
    }
    mesh.add(glow)
    glowMeshRef.current = glow
    return () => {
      mesh.remove(glow)
      glowMaterial.dispose()
      glowMeshRef.current = null
    }
  }, [material])

  // Labels fixed to the note (they sink into the hit line with it): its
  // pitch, its finger number, or both stacked (finger at the keyboard side),
  // as a block at the note's keyboard end, middle or far end, fitted to the
  // note width, hidden when the note is shorter than the block.
  const labelColor = useMemo(() => new THREE.Color(), [])
  const writeNoteLabels = (
    labels: LabelMesh,
    count: number,
    rs: ReturnType<typeof getResolvedSettings>,
    noteZ: number,
    hitY: number,
  ) => {
    const atlas = labelAtlas(settings.noteLabelFormat, settings.noteLabelAccidental)
    const u = labels.material.uniforms
    u.uAtlas.value = atlas.texture
    const outline = Math.min(Math.max(rs.noteLabelOutlineWidth, 0), 1)
    u.uOutline.value = outline
    labelColor.set(rs.noteLabelOutlineColor).convertLinearToSRGB()
    u.uOutlineColor.value.set(labelColor.r, labelColor.g, labelColor.b)
    u.uClipY.value = hitY
    labelColor.set(rs.noteLabelColor).convertLinearToSRGB()
    const position = settings.noteLabelPosition
    const content = settings.noteLabelContent
    const offset = Math.max(rs.noteLabelOffset, 0)
    const opacity = Math.min(Math.max(rs.noteLabelOpacity, 0), 1)
    const m = meshRef.current!.instanceMatrix.array
    const out = labels.mesh.instanceMatrix.array as Float32Array
    let n = 0
    const put = (glyph: number, x: number, y: number, h: number, alpha: number) => {
      const w = h * LABEL_CELL_ASPECT
      const o = n * 16
      out[o] = w; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0
      out[o + 4] = 0; out[o + 5] = h; out[o + 6] = 0; out[o + 7] = 0
      out[o + 8] = 0; out[o + 9] = 0; out[o + 10] = 1; out[o + 11] = 0
      out[o + 12] = x; out[o + 13] = y; out[o + 14] = noteZ + 0.002; out[o + 15] = 1
      labels.glyphs[n] = glyph
      labels.alphas[n] = alpha
      labels.colors[n * 3] = labelColor.r
      labels.colors[n * 3 + 1] = labelColor.g
      labels.colors[n * 3 + 2] = labelColor.b
      n++
    }
    for (let i = 0; i < count; i++) {
      const k = labelKeys[i]
      if (k < 0 || k >= KEY_COUNT) continue
      const finger = labelFingers[i]
      const showPitch = content !== 'finger'
      const showFinger = content !== 'pitch' && finger > 0
      if (!showPitch && !showFinger) continue
      const lines = showPitch && showFinger ? 2 : 1
      const x = m[i * 16 + 12]
      const centerY = m[i * 16 + 13]
      const width = sizes[i * 2]
      const length = sizes[i * 2 + 1]
      const h = noteLabelHeight(atlas, k, width, rs.noteLabelSize, outline)
      // notes are drawn at least noteLabelMinLength long; only a same-key
      // clip (liquid merge) or a dying ghost can still be shorter
      if (length < noteLabelMinLength(h, lines) * 0.99) continue
      // keyboard end = bottom when falling, also bottom when rising (the
      // trail grows up from the keys)
      const block = h * lines
      const room = (length - block) / 2
      const blockY =
        position === 'center'
          ? centerY
          : centerY + (position === 'far' ? 1 : -1) * (room - Math.min(offset, room))
      const alpha = opacity * alphaAttrData[i]
      const firstY = blockY - block / 2 + h / 2
      if (showFinger) put(fingerGlyph(finger), x, firstY, h, alpha)
      if (showPitch) put(k, x, showFinger ? firstY + h : firstY, h, alpha)
    }
    labels.commit(n)
  }

  // Pitch labels: a child of the note mesh too (same parallax transform),
  // drawn over the notes and under the hit line.
  const labelMeshRef = useRef<LabelMesh | null>(null)
  useEffect(() => {
    const mesh = meshRef.current
    if (!mesh) return
    // two labels per note at most (pitch + finger)
    const labels = createLabelMesh(MAX_INSTANCES * 2)
    labels.mesh.renderOrder = 2.05
    labels.mesh.visible = false
    mesh.add(labels.mesh)
    labelMeshRef.current = labels
    return () => {
      mesh.remove(labels.mesh)
      labels.dispose()
      labelMeshRef.current = null
    }
  }, [])

  useEffect(() => () => material.dispose(), [material])

  // Pattern generators, baked bump maps / realistic map sets and the silk
  // texture of the lit looks. Created lazily on first use (a flat look
  // never allocates them).
  const lookResources = useMemo(() => new NoteLookResources(gl), [gl])
  useEffect(() => () => lookResources.dispose(), [lookResources])
  const lastPatternNow = useRef<number | null>(null)
  // Sideways pattern scroll (∫ drift dt, world units), wrapped by whole tiles.
  const driftRef = useRef(0)

  // Material / shape / pattern source / bump / map set are discrete
  // (non-animatable) — bind on change.
  useEffect(() => {
    const u = material.uniforms
    const m = settings.noteMaterial
    // the 2D look draws everything analytically — no pattern / maps
    const lit = m === 'reflective' || m === 'realistic'
    u.uMaterial.value =
      m === 'sprite'
        ? MATERIAL_SPRITE
        : m === 'realistic'
          ? MATERIAL_REALISTIC
          : m === 'reflective'
            ? MATERIAL_REFLECTIVE
            : MATERIAL_FLAT
    u.uShape.value = settings.noteShape === 'gem' ? SHAPE_GEM : settings.noteShape === 'angled' ? SHAPE_ANGLED : SHAPE_ROUND
    u.uPattern.value = lit ? lookResources.pattern(settings.notePattern) : lookResources.greyPattern
    u.uNoteTex.value = lit && settings.noteSilk > 0 ? lookResources.silkTexture() : lookResources.white
    if (m === 'realistic') {
      // the set's normal map replaces the bump map (tile / depth still apply)
      const set = lookResources.surface(settings.noteSurface, settings.noteSurfaceCells, settings.noteSurfaceIrregularity)
      u.uBump.value = set.normal
      u.uBumpZEnc.value = 1
      u.uFacetMap.value = 0
      u.uAlbedoMap.value = set.albedo
      u.uGlossMap.value = set.gloss
      u.uEmissiveMap.value = set.emissive ?? lookResources.black
      u.uDetail.value = 0
    } else {
      u.uBump.value = lit ? lookResources.bump(settings.noteBump) : lookResources.flatNormal
      u.uBumpZEnc.value = 0
      // the crystal bake carries its facet edges in alpha (looks/crystalNormal.ts)
      u.uFacetMap.value = lit && settings.noteBump === 'crystal' ? 1 : 0
      u.uAlbedoMap.value = lookResources.white
      u.uGlossMap.value = lookResources.white
      u.uEmissiveMap.value = lookResources.black
      u.uDetail.value = settings.noteBump === 'cast' ? 0.45 : 0
    }
  }, [
    material,
    lookResources,
    settings.noteMaterial,
    settings.noteShape,
    settings.notePattern,
    settings.noteBump,
    settings.noteSurface,
    settings.noteSurfaceCells,
    settings.noteSurfaceIrregularity,
    settings.noteSilk,
  ])

  // Bind the user-uploaded texture (or the placeholder) to the shader's
  // sampler whenever it changes. uHasCustomTexture lets the shader ignore
  // samples from the placeholder so a not-yet-uploaded 'custom' preset
  // gracefully falls back to the tint colour.
  useEffect(() => {
    material.uniforms.uCustomTexture.value = customTexture ?? PLACEHOLDER_TEXTURE
    material.uniforms.uHasCustomTexture.value = customTexture ? 1 : 0
  }, [material, customTexture])

  useFrame(() => {
    audioEngine.tick()

    const mesh = meshRef.current
    if (!mesh) return

    // Falling-note placement is in TL_audio (wall-clock × rate) and
    // each note's "fire moment" is `midiOffset + map(n.time)`. This
    // keeps the descent rate constant in wall-clock seconds — speed
    // automation only changes WHEN audio fires, not how fast the
    // visual moves. Without automation the map collapses to identity
    // and this reduces to the legacy `n.time` vs `currentSongTime`.
    const tl = audioEngine.currentSongTime()
    // Pin-resolved settings for every animatable note parameter.
    // Non-animatable keys (midiOffsetSec / fallDirection / transpose /
    // noteTexture / edgeEnabled / trim + speed automation) keep reading
    // the React `settings` slice. Zero pins ⇒ `rs` is the live settings
    // object by reference, so all reads are bit-identical to pre-pin.
    const rs = getResolvedSettings()
    const midiOffset = settings.midiOffsetSec
    const hitY = NOTE_HIT_Y
    const isDown = settings.fallDirection === 'down'
    const fall = rs.fallDurationSec
    const widthScale = rs.noteWidthScale
    const minLength = Math.max(0.01, rs.noteMinLength)
    // With labels on, a note is drawn at least as long as its label.
    noteLabelMinLengths(
      {
        noteLabelsEnabled: settings.noteLabelsEnabled,
        noteLabelContent: settings.noteLabelContent,
        noteLabelFormat: settings.noteLabelFormat,
        noteLabelAccidental: settings.noteLabelAccidental,
        noteLabelSize: rs.noteLabelSize,
        noteLabelOutlineWidth: rs.noteLabelOutlineWidth,
      },
      widthScale,
      labelMinLen,
    )
    // Sit in front of the 3D black keys (top face at z=BLACK_KEY_THICKNESS
    // = 0.09) so notes don't appear stuck inside them at the moment they
    // cross the hit line. Hit-line clipping happens per-pixel in the
    // fragment shader, so geometry below hitY is invisible.
    const noteZ = NOTE_PLANE_Z
    // Perspective parallax between this z plane and the keyboard surface
    // (z=0) is NOT sub-pixel — at the keyboard edges it visibly pushes
    // notes outward. Counter it with a mesh-level x-affine so every
    // instance's z=NOTE_PLANE_Z projection lands on its key's z=0
    // projection. Width scales with it too, which is also correct (the
    // note should project the same width as the key it lands on).
    mesh.scale.x = NOTE_PARALLAX_SCALE
    mesh.position.x = parallaxX(0)
    material.uniforms.uHitY.value = hitY
    // Texture phase = ∫ animSpeed dt. `noteAnimSpeed{X,Y}` is a global
    // (non-animatable) value, so this is normally a steady ramp; we
    // still integrate rather than use the old `now() * animSpeed` form
    // because that made the velocity `animSpeed + now()*dAnimSpeed/dt`
    // — fragile the instant the rate ever changes (an Inspector tweak
    // mid-flow would jump the pattern, since `now()` is a huge absolute
    // timestamp). Integrating keeps the visible speed exactly animSpeed
    // and the phase continuous through any rate change. Driven off
    // `now()` (so it stays pause-proof and the virtual export clock
    // keeps parity); the per-frame delta is clamped so a backgrounded
    // tab / seek / the live→export clock handoff can't teleport it.
    {
      const nowT = now()
      const prev = lastPhaseNow.current
      const dt = prev === null ? 0 : Math.min(Math.max(nowT - prev, 0), 0.1)
      lastPhaseNow.current = nowT
      const ph = phaseRef.current
      ph.x += dt * rs.noteAnimSpeedX
      ph.y += dt * rs.noteAnimSpeedY
      // Wrap the phase the same way HitLine wraps its uTime, and for the
      // same reason: the accumulator grows unboundedly, and once it
      // feeds fbm/hash at hundreds-of-thousands magnitude GLSL's float32
      // precision collapses — the per-frame delta drops below the ULP
      // and the flow visibly FREEZES even at speed 1 (a long-standing
      // bug the old `now() * animSpeed` form had too, since `now()`
      // itself was unbounded and unwrapped here). The `%` discontinuity
      // is one frame, ~tens of minutes apart, and lands inside the
      // noise's churn so it isn't perceptible. JS `%` keeps the sign so
      // negative speeds wrap symmetrically. Deterministic in the phase,
      // so live and the offline export wrap at the same point.
      ph.x %= PHASE_WRAP
      ph.y %= PHASE_WRAP
      material.uniforms.uPhase.value.copy(ph)
    }
    // Pin-resolved animatable note uniforms (formerly a settings-deps
    // useEffect). Edge gating still keys off the non-animatable
    // `edgeEnabled` toggle but the width/intensity it gates are
    // animatable. Only the flat material draws it — the other materials
    // have their own outline / rim band. Idempotent with zero pins.
    const edgeOn = settings.edgeEnabled && settings.noteMaterial === 'flat'
    material.uniforms.uEmissive.value = rs.noteEmissive
    material.uniforms.uOpacity.value = rs.noteOpacity
    material.uniforms.uRadius.value = rs.noteCornerRadius
    material.uniforms.uTextureScale.value = rs.noteTextureScale
    material.uniforms.uTextureOffset.value.set(rs.noteTextureOffsetX, rs.noteTextureOffsetY)
    material.uniforms.uTextureBlur.value = rs.noteTextureBlur
    material.uniforms.uTextureVariation.value = rs.noteTextureVariation
    material.uniforms.uTextureContrast.value = rs.noteTextureContrast
    // gradient colouring, shaded per pixel
    writeGradientUniforms(
      material.uniforms as unknown as ReturnType<typeof createGradientUniforms>,
      rs.noteColorMode === 'gradient' ? noteGradient(rs) : null,
    )
    material.uniforms.uEdgeColor.value.set(rs.noteEdgeColor)
    material.uniforms.uEdgeWidth.value = edgeOn ? rs.noteEdgeWidth : 0
    material.uniforms.uEdgeIntensity.value = edgeOn ? rs.noteEdgeIntensity : 0
    if (settings.noteMaterial !== 'flat') {
      const u = material.uniforms
      u.uAlbedoGain.value = rs.noteAlbedoGain
      u.uSpecular.value = rs.noteSpecular
      u.uEmission.value = rs.noteEmission
      u.uSurfaceContrast.value = rs.noteSurfaceContrast
      u.uNoteTexAmount.value = settings.noteSilk > 0 ? Math.min(rs.noteSilk, 1) : 0
      u.uNoteTexTile.value = Math.max(rs.noteSilkScale, 0.01)
      u.uBevelW.value = rs.noteBevelWidth
      u.uBevelD.value = rs.noteBevelDepth
      u.uBevelProfile.value = rs.noteBevelProfile
      u.uBevelSoft.value = rs.noteBevelSoftness
      u.uBevelReflect.value = rs.noteBevelReflect
      u.uRimShade.value = rs.noteRimShade
      u.uRimFade.value = rs.noteRimFade
      setLightDir(u.uKey.value, rs.noteLightAzimuth, rs.noteLightElevation)
      setLightDir(u.uFill.value, rs.noteLightAzimuth + 180, rs.noteLightElevation)
      u.uKeyI.value = rs.noteLightIntensity
      u.uFillI.value = rs.noteFillIntensity
      u.uAmbient.value = rs.noteAmbient
      u.uReflect.value = rs.noteReflectivity
      u.uTransparency.value = rs.noteTransparency
      u.uSaturation.value = rs.noteSaturation
      u.uSheen.value = rs.noteSheen
      u.uPatternTile.value = Math.max(rs.notePatternScale, 0.01)
      u.uContrast.value = rs.notePatternContrast
      u.uBrightness.value = rs.notePatternBrightness
      u.uLock.value = rs.notePatternLock
      u.uDistort.value = rs.notePatternDistortion
      u.uPatternAmount.value = rs.notePatternAmount
      u.uBumpTile.value = Math.max(rs.noteBumpScale, 0.01)
      u.uBumpDepth.value = settings.noteMaterial !== 'realistic' && settings.noteBump === 'none' ? 0 : rs.noteBumpDepth
      u.uBumpSoft.value = rs.noteBumpSoftness * 5
      u.uMelt.value = rs.noteBumpMelt
      u.uScatter.value = settings.noteBumpScatter ? 1 : 0
      u.uFacetEdges.value = rs.noteFacetEdges
      u.uKnee.value = rs.notePatternKnee
      u.uKneeSoft.value = rs.notePatternKneeSoftness
      u.uRibbon.value = rs.notePatternRibbon
      u.uCloud.value = rs.noteCloud
      u.uCloudTile.value = Math.max(rs.noteCloudScale, 0.01)
      u.uCloudSoft.value = rs.noteCloudSoftness
      u.uCloudClear.value = rs.noteCloudClear
      u.uHighlight.value = rs.noteHighlight
      u.uHighlightThr.value = rs.noteHighlightThreshold
      u.uHighlightSoft.value = Math.max(rs.noteHighlightSoftness, 0.02)
      u.uFrost.value = rs.noteFrost
      u.uFrostGrain.value = rs.noteFrostGrain
      u.uFrostTile.value = Math.max(rs.noteFrostScale, 0.001)
      u.uFrostVeil.value = rs.noteFrostVeil
      u.uOutlineW.value = rs.noteOutlineWidth
      u.uOutlineBright.value = rs.noteOutlineBrightness
      u.uOutlineBlend.value = rs.noteOutlineBlend
      u.uOutlineReflect.value = rs.noteOutlineReflect
      // the look's colours are sRGB-encoded in the shader (see noteShader.ts)
      u.uOutlineColor.value.set(rs.noteOutlineColor).convertLinearToSRGB()
      u.uBandW.value = rs.noteRimBand
      u.uBandBright.value = rs.noteRimBandBrightness
      u.uBandBlend.value = rs.noteRimBandBlend
      u.uBandColor.value.set(rs.noteRimBandColor).convertLinearToSRGB()
      u.uGapW.value = rs.noteRimGap
      u.uGapDark.value = rs.noteRimGapDark
      u.uMargin.value = 0.01 + Math.max(rs.noteOutlineWidth, 0)
      if (settings.noteMaterial === 'sprite') {
        u.u2dRimW.value = rs.note2dRimWidth
        u.u2dRimTilt.value = THREE.MathUtils.degToRad(rs.note2dRimTilt)
        u.u2dHollow.value = rs.note2dHollow
        setLightDir(u.u2dFill.value, rs.note2dFillAzimuth, rs.note2dFillElevation)
        u.u2dGloss.value = rs.note2dGloss
        u.u2dGlossPow.value = rs.note2dGlossPower
        u.u2dExposure.value = rs.note2dExposure
        u.u2dWhiten.value = rs.note2dWhiten
        u.u2dWhitenStart.value = rs.note2dWhitenStart
        u.u2dKeySplit.value = rs.note2dKeySplit
        u.u2dShimmer.value = rs.note2dShimmer
        u.u2dShimmerGain.value = rs.note2dShimmer > 0 ? rs.note2dShimmerGain : 1
        u.u2dShimmerCell.value = Math.max(rs.note2dShimmerScale, 0.01)
        u.u2dShimmerSpeed.value = rs.note2dShimmerSpeed
        u.u2dShimmerLock.value = rs.note2dShimmerLock
        u.u2dTex.value = settings.note2dTexture ? 1 : 0
        u.u2dTexCell.value = Math.max(rs.note2dTextureScale, 0.01)
        u.u2dTexStretch.value = Math.max(rs.note2dTextureStretch, 0.01)
        u.u2dTexContrast.value = rs.note2dTextureContrast
        u.u2dTexGain.value = rs.note2dTextureGain
        u.u2dTexRelief.value = rs.note2dTextureRelief
        u.u2dTexSpeed.value = rs.note2dTextureSpeed
        u.u2dTexLock.value = rs.note2dTextureLock
        u.u2dOutline.value = settings.note2dOutline === 'whole' ? 1 : settings.note2dOutline === 'half' ? 2 : 0
        u.u2dOutW.value = rs.note2dOutlineWidth
        u.u2dOutTint.value = rs.note2dOutlineTint
        u.u2dOutShade.value = rs.note2dOutlineShade
        u.u2dOutGrey.value = rs.note2dOutlineGrey
        u.u2dOutBright.value = rs.note2dOutlineBrightness
        u.u2dOutRelief.value = rs.note2dOutlineRelief
        u.u2dGlow.value = rs.note2dGlow
        u.u2dGlowR.value = Math.max(rs.note2dGlowRadius, 1e-4)
        u.u2dGlowTail.value = rs.note2dGlowTail
        u.u2dGlowWhiten.value = rs.note2dGlowWhiten
        u.u2dGlowBoost.value = rs.note2dGlowBoost
        // quad padding: room for the halo tail and an outside outline band
        // (+ ~0.06 white-key widths of slack; the halo fades out over the last 40 % of the pad)
        const glowPad = rs.note2dGlow > 0 ? rs.note2dGlowRadius * (rs.note2dGlowTail > 0 ? 4.5 : 2.2) : 0
        const outPad = settings.note2dOutline === 'off' ? 0 : rs.note2dOutlineWidth
        u.uMargin.value = Math.max(glowPad, outPad) + 0.06 * WHITE_KEY_WIDTH
      }
      // Animated light pattern: stepped by the clamped now() delta like the
      // texture phase above, so it is pause-proof and the export's virtual
      // clock drives it identically.
      const nowT = now()
      const prev = lastPatternNow.current
      const dt = prev === null ? 0 : Math.min(Math.max(nowT - prev, 0), 0.1)
      lastPatternNow.current = nowT
      lookResources.tickPattern(settings.notePattern, dt, rs.notePatternSpeed, rs.notePatternDensity, rs.notePatternSharpness)
      if (settings.noteSilk > 0) lookResources.tickSilk(dt * rs.noteSilkSpeed)
      const tile = Math.max(rs.notePatternScale, 0.01)
      driftRef.current = (driftRef.current + dt * rs.notePatternDrift) % (tile * 64)
      u.uDriftX.value = driftRef.current
      // cloud evolution clock, wrapped like uPhase (float precision)
      u.uTime.value = (u.uTime.value + dt) % 4096
    } else {
      lastPatternNow.current = null
      material.uniforms.uMargin.value = 0.01
    }

    const FALL_DISTANCE = fallDistance()
    // What is drawn on the notes lives in a frame whose y is in units of fall
    // (shader `texFrame`), so a zoom that lengthens the notes neither slides
    // it along them nor changes its speed.
    const textureFall = FALL_REFERENCE_DISTANCE * getLensWindow().texture
    material.uniforms.uScroll.value = ((isDown ? 1 : -1) * tl * textureFall) / fall
    material.uniforms.uTexUnit.value = textureFall / FALL_DISTANCE
    material.uniforms.uGradArea.value.w = GRADIENT_AREA_HEIGHT * getLensWindow().fall
    // Visible-range bound for spawn / cull — derived from the live
    // camera so song notes (down spawn), 'up' history trails, and live
    // notes all rise / appear up to the user's actual viewport. Capped
    // (see scene/visibleTop.ts) so steep look-up angles don't blow it
    // up unboundedly. Floored to the reference trajectory cap so
    // zoom-in / look-down can't shrink it and cull notes mid-travel.
    const liveVisibleTop = computeLiveVisibleTop(
      rs.cameraPos,
      rs.cameraLookAt,
      rs.cameraFov,
      noteZ,
      hitY,
      getLensWindow(),
    )
    const visibleTop = Math.max(liveVisibleTop, hitY + FALL_DISTANCE)
    // Spawn cutoff (in seconds-into-future) for 'down' notes. Default
    // is `fall`, but when the visible top sits above hitY+FALL_DISTANCE
    // we need to spawn earlier so notes appear right at the top edge
    // of the user's view rather than popping in mid-frame. The +1 wu
    // buffer mirrors SPAWN_BUFFER so the note slides in instead of
    // appearing exactly on the visible edge.
    const downSpawnCutoff = Math.max(
      fall,
      ((visibleTop - hitY + SPAWN_BUFFER) * fall) / FALL_DISTANCE,
    )

    // Pitch shift in semitones — keeps the falling-note position aligned
    // with the audio engine's transposed playback so the user sees the
    // notes land on the keys that will actually sound.
    const transpose = settings.transpose

    // Selection set is read once per frame so the per-instance flag fill
    // doesn't pay a Map lookup cost per song note (could be thousands).
    const selection = useStore.getState().selection
    const noteIds = instanceToNoteId.current

    // Per-note tint (linear): solid = track colour / noteColor, random =
    // palette pick, gradient = the hit-line colour at the note's key (the
    // shader shades the gradient itself per pixel; the instance tint still
    // feeds the merge data and the 2D glow).
    colorResolver.update(rs)
    const resolveTint = (midi: number, trackIdx: number | undefined, id?: number) =>
      colorResolver.rgb(midi, trackIdx, id)

    let count = 0
    const notes = song?.notes ?? []
    // Non-destructive trim window — notes outside `[trimStart, trimEnd)`
    // are skipped on the canvas, mirroring the engine's playback
    // filter so what the user sees matches what they hear.
    const trimStart = settings.midiTrimStartSec
    const trimEnd =
      settings.midiTrimEndSec ?? song?.duration ?? Number.POSITIVE_INFINITY
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i]
      if (n.time < trimStart) continue
      if (n.time >= trimEnd) continue
      // Clamp duration to the trim window so a note whose natural
      // release sits past trimEnd visually shortens to land its tail
      // at the trim point (mirroring the audio engine's clamped
      // note-off).
      const effEndMidi = Math.min(n.time + n.duration, trimEnd)
      // Each note's head/tail FIRE MOMENT in TL_audio (= when audio
      // will play that point). With the speed map, this stretches /
      // compresses the visual note length to match audio duration in
      // wall-clock seconds; outside automation, the map is identity
      // and this collapses to `midiOffset + n.time`.
      const headFire = midiOffset + midiToTimeline(speedMap, n.time)
      const tailFire = midiOffset + midiToTimeline(speedMap, effEndMidi)
      const idx = (n.midi + transpose) - MIDI_MIN
      if (idx < 0 || idx >= KEY_COUNT) continue
      const noteMinLength = Math.max(minLength, labelMinLen[idx])
      let topY: number
      let bottomY: number

      if (isDown) {
        // Future notes fall from above onto the keyboard. `headT` is
        // TL_audio seconds until the note's audio fires; under the
        // engine's wall × rate clock it shrinks at constant rate so
        // the visual descent stays at `FALL_DISTANCE / fall` per
        // wall-second regardless of the speed curve.
        const headT = headFire - tl
        const tailT = tailFire - tl
        if (headT > downSpawnCutoff) break // sorted by time → no later notes are visible yet
        const headY = hitY + (headT / fall) * FALL_DISTANCE
        const tailY = hitY + (tailT / fall) * FALL_DISTANCE
        const visualLength = Math.max(noteMinLength, tailY - headY)
        bottomY = headY
        topY = bottomY + visualLength
        // Skip once the entire visual rect is at or below the hit line.
        if (topY <= hitY) continue
      } else {
        // Past notes rise from the keyboard upward (history trail).
        // Same geometry as the live-note path below — see computeRisingRect.
        const audioDuration = tailFire - headFire
        const rect = computeRisingRect(
          tl - headFire,
          audioDuration,
          hitY,
          fall,
          FALL_DISTANCE,
          noteMinLength,
        )
        if (rect === null) break // not yet emerged (sorted → no later notes either)
        if (rect.bottomY >= visibleTop) continue
        if (rect.topY <= hitY) continue
        topY = rect.topY
        bottomY = rect.bottomY
      }

      const length = topY - bottomY
      const centerY = (topY + bottomY) / 2

      const key = KEYBOARD_LAYOUT.keys[idx]
      const width = key.width * widthScale

      dummy.position.set(key.x, centerY, noteZ)
      dummy.rotation.set(0, 0, 0)
      dummy.scale.set(width, length, 1)
      dummy.updateMatrix()
      mesh.setMatrixAt(count, dummy.matrix)

      // store world size so the fragment shader can compute the SDF correctly
      sizes[count * 2] = width
      sizes[count * 2 + 1] = length

      // Per-note stable noise seed (vec2 in 0..1) so each note's texture
      // samples a different region. Golden-ratio + sqrt(3/2) decimals are
      // low-discrepancy so adjacent ids produce well-separated seeds.
      const sid = n.id + 1
      seeds[count * 2] = (sid * 0.6180339887498949) % 1
      seeds[count * 2 + 1] = (sid * 0.7548776662466927) % 1

      selectedAttrData[count] = selection.has(n.id) ? 1 : 0
      alphaAttrData[count] = 1
      noteIds[count] = n.id
      mergeKeys[count] = idx
      blacks[count] = key.isBlack ? 1 : 0
      labelKeys[count] = idx
      labelFingers[count] = n.finger ?? 0

      const tint = resolveTint(n.midi + transpose, n.track, n.id)
      tints[count * 3] = tint[0]
      tints[count * 3 + 1] = tint[1]
      tints[count * 3 + 2] = tint[2]

      count++
      if (count >= MAX_INSTANCES) break
    }

    // Live notes (touch/click) — always render as rising trails, sharing
    // the exact same `computeRisingRect` geometry as the song 'up' branch
    // above. The only thing that differs is the timeline source: songs
    // use `t = currentSongTime()`, live uses `liveNow = now()`, with the
    // live note's `endTime` (or `liveNow` while held) playing the role of
    // `n.duration`.
    const liveNotes = audioEngine.getLiveNotes()
    if (liveNotes.length > 0) {
      const liveNow = now()
      for (let i = 0; i < liveNotes.length; i++) {
        const ln = liveNotes[i]
        const noteDuration = (ln.endTime ?? liveNow) - ln.startTime
        const idx = ln.midi - MIDI_MIN
        if (idx < 0 || idx >= KEY_COUNT) continue
        const rect = computeRisingRect(
          liveNow - ln.startTime,
          noteDuration,
          hitY,
          fall,
          FALL_DISTANCE,
          Math.max(minLength, labelMinLen[idx]),
        )
        if (rect === null) continue
        if (rect.bottomY >= visibleTop) continue
        if (rect.topY <= hitY) continue
        const topY = rect.topY
        const bottomY = rect.bottomY

        const length = topY - bottomY
        const centerY = (topY + bottomY) / 2

        const key = KEYBOARD_LAYOUT.keys[idx]
        const width = key.width * widthScale

        dummy.position.set(key.x, centerY, noteZ)
        dummy.rotation.set(0, 0, 0)
        dummy.scale.set(width, length, 1)
        dummy.updateMatrix()
        mesh.setMatrixAt(count, dummy.matrix)
        sizes[count * 2] = width
        sizes[count * 2 + 1] = length
        // Live ids use a separate counter; offset to avoid colliding with
        // song ids in seed space (so a song note + a live note triggered
        // simultaneously won't accidentally share a pattern).
        const lsid = ln.id + 1_000_003
        seeds[count * 2] = (lsid * 0.6180339887498949) % 1
        seeds[count * 2 + 1] = (lsid * 0.7548776662466927) % 1
        // Live notes are user-played performance, never editable, so they're
        // never selected and the noteId map gets a sentinel.
        selectedAttrData[count] = 0
        alphaAttrData[count] = 1
        noteIds[count] = -1
        mergeKeys[count] = idx
        blacks[count] = key.isBlack ? 1 : 0
        labelKeys[count] = idx
        labelFingers[count] = 0
        // Live notes have no track / id.
        const liveTint = resolveTint(ln.midi, undefined)
        tints[count * 3] = liveTint[0]
        tints[count * 3 + 1] = liveTint[1]
        tints[count * 3 + 2] = liveTint[2]

        count++
        if (count >= MAX_INSTANCES) break
      }
    }

    // Dying-note ghosts (right-click delete + eraser drag). Renders the
    // same shader as a regular note with a per-instance alpha multiplier
    // ramped 1 → 0 over DEATH_FADE_DURATION on a plain linear curve.
    const nowSec = now()
    noteDeathFx.prune(nowSec)
    const dying = noteDeathFx.list()
    for (let i = 0; i < dying.length; i++) {
      if (count >= MAX_INSTANCES) break
      const d = dying[i]
      const ageNorm = (nowSec - d.startTime) / DEATH_FADE_DURATION
      if (ageNorm >= 1) continue
      const fadeAlpha = 1 - Math.max(0, Math.min(1, ageNorm))

      dummy.position.set(d.x, d.centerY, noteZ)
      dummy.rotation.set(0, 0, 0)
      dummy.scale.set(d.width, d.length, 1)
      dummy.updateMatrix()
      mesh.setMatrixAt(count, dummy.matrix)
      sizes[count * 2] = d.width
      sizes[count * 2 + 1] = d.length
      // Reuse a high low-discrepancy seed so the ghost's texture sample
      // is stable for its lifetime instead of crawling each frame.
      const seedBase = (i + 7919) // arbitrary prime offset
      seeds[count * 2] = (seedBase * 0.6180339887498949) % 1
      seeds[count * 2 + 1] = (seedBase * 0.7548776662466927) % 1
      selectedAttrData[count] = 0
      alphaAttrData[count] = fadeAlpha
      noteIds[count] = -1 // not editable / not selectable
      mergeKeys[count] = -1 // fades on its own, never fuses
      blacks[count] = isBlackKey(d.midi) ? 1 : 0
      labelKeys[count] = d.midi - MIDI_MIN
      labelFingers[count] = 0
      // Preserve the deleted note's track tint so the fade-out reads
      // as "this exact note is dissolving" instead of flashing back
      // to the global noteColor for its final 0.12s.
      const ghostTint = resolveTint(d.midi, d.track, d.id)
      tints[count * 3] = ghostTint[0]
      tints[count * 3 + 1] = ghostTint[1]
      tints[count * 3 + 2] = ghostTint[2]
      count++
    }

    // Liquid merge: world-space rects in instance order (round shape only).
    const merging = rs.noteMergeRadius > 0 && settings.noteShape === 'round' && settings.noteMaterial !== 'sprite'
    if (merging !== (material.defines.MERGE !== undefined)) {
      if (merging) material.defines.MERGE = ''
      else delete material.defines.MERGE
      material.needsUpdate = true
    }
    if (merging) {
      const mi = mesh.instanceMatrix.array
      const sx = mesh.scale.x
      const x0 = mesh.position.x
      const MN = mergeNotes.current
      for (let i = 0; i < count; i++) {
        const o = MN[i] ?? (MN[i] = { x: 0, y: 0, w: 0, h: 0, color: [0, 0, 0], key: 0, seed: [0, 0] })
        o.x = x0 + mi[i * 16 + 12] * sx
        o.y = mi[i * 16 + 13]
        o.w = sizes[i * 2] * sx
        o.h = sizes[i * 2 + 1]
        // sRGB-encoded: the fillet blends colours in display space (noteShader.ts decodes)
        o.color[0] = linearToSrgbChannel(tints[i * 3])
        o.color[1] = linearToSrgbChannel(tints[i * 3 + 1])
        o.color[2] = linearToSrgbChannel(tints[i * 3 + 2])
        o.key = mergeKeys[i]
        o.seed![0] = seeds[i * 2]
        o.seed![1] = seeds[i * 2 + 1]
        o.solo = mergeKeys[i] < 0
      }
      MN.length = count
      clipSameKeyOverlaps(MN)
      const lit = settings.noteMaterial === 'reflective' || settings.noteMaterial === 'realistic'
      mergeData.build(MN, {
        mergeRadius: rs.noteMergeRadius,
        colorSpread: rs.noteMergeColorSpread,
        sameKey: settings.noteMergeSameKey,
        cornerRadius: rs.noteCornerRadius,
        bevelWidth: rs.noteBevelWidth,
        outlineWidth: lit ? Math.max(rs.noteOutlineWidth, 0) : 0,
        creaseDepth: settings.noteMergeCrease,
        legatoClose: settings.noteMergeLegatoClose,
        legatoGap: MERGE_LEGATO_GAP,
      })
    }

    mesh.count = count
    mesh.instanceMatrix.needsUpdate = true
    {
      const mi = mesh.instanceMatrix.array
      const r = packed.rect.array as Float32Array
      const ss = packed.seedSel.array as Float32Array
      const ta = packed.tintAlpha.array as Float32Array
      for (let i = 0; i < count; i++) {
        const j = i * 4
        r[j] = mi[i * 16 + 12]
        r[j + 1] = mi[i * 16 + 13]
        r[j + 2] = sizes[i * 2]
        r[j + 3] = sizes[i * 2 + 1]
        ss[j] = seeds[i * 2]
        ss[j + 1] = seeds[i * 2 + 1]
        ss[j + 2] = selectedAttrData[i]
        ss[j + 3] = blacks[i]
        ta[j] = tints[i * 3]
        ta[j + 1] = tints[i * 3 + 1]
        ta[j + 2] = tints[i * 3 + 2]
        ta[j + 3] = alphaAttrData[i]
      }
      for (const a of [packed.rect, packed.seedSel, packed.tintAlpha]) {
        a.clearUpdateRanges()
        a.addUpdateRange(0, count * 4)
        a.needsUpdate = true
      }
    }
    const labels = labelMeshRef.current
    if (labels) {
      labels.mesh.visible = settings.noteLabelsEnabled
      if (settings.noteLabelsEnabled) writeNoteLabels(labels, count, rs, noteZ, hitY)
    }
    const glow = glowMeshRef.current
    if (glow) {
      glow.visible = settings.noteMaterial === 'sprite' && rs.note2dGlow > 0
      glow.count = count
    }
  })

  // Project a screen-space pointer to the falling-note z plane.
  // Used during drag tracking via window-level pointermove (which is in
  // client coords, not three event coords). Returns null if the canvas has
  // disappeared mid-drag (e.g. the user navigated away). The result is in
  // the parallax-compensated x space (same space the notes are drawn in),
  // so it matches `parallaxX(key.x)` / `noteVisualBounds` directly.
  const noteZ = NOTE_PLANE_Z
  const screenToWorld = (clientX: number, clientY: number): THREE.Vector3 | null => {
    const canvas = gl.domElement
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -(((clientY - rect.top) / rect.height) * 2 - 1),
    )
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(ndc, camera)
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -noteZ)
    const out = new THREE.Vector3()
    if (!raycaster.ray.intersectPlane(plane, out)) return null
    return out
  }

  // Brief audible cue when the user selects a note. Goes through the
  // editor-only `previewNote` helper so it does NOT light up the keyboard
  // press-glow / landing flash / hit particles — those are reserved for
  // real performance input.
  const previewSelectedNote = (noteId: number) => {
    const state = useStore.getState()
    if (!state.song) return
    const n = state.song.notes.find((x) => x.id === noteId)
    if (!n) return
    void previewNote(n.midi + state.settings.transpose, n.velocity, 200)
  }

  // Cached "we are hovering this note's top/bottom edge". Updated every
  // pointermove over the InstancedMesh and consumed at pointerdown to
  // decide whether the click should resize the note's duration instead
  // of selecting / starting a move-drag. Also drives the `ns-resize`
  // canvas cursor so the user gets a hint before clicking.
  const hoveredEdgeRef = useRef<{
    noteId: number
    edge: 'head' | 'tail'
  } | null>(null)
  // World-space proximity threshold for "is the cursor near this edge".
  // Scaled so 1080p height ≈ 12 px at default camera; small enough that
  // it doesn't accidentally trigger on the body of short notes, large
  // enough to grab without pixel-perfect aim.
  const EDGE_PROXIMITY = 0.08

  // Drag state. Lives on a ref so the closure handlers can mutate without
  // causing React re-renders, which would interrupt the pointer capture.
  const dragRef = useRef<{
    snapshot: import('../midi/types').ParsedSong
    ids: Set<number>
    anchorMidi: number
    anchorOriginalDisplayedX: number
    startWorld: THREE.Vector3
    startClient: { x: number; y: number }
    moved: boolean
    pushedHistory: boolean
    lastDeltaSemis: number
  } | null>(null)

  const beginDrag = (
    startWorld: THREE.Vector3,
    startClient: { x: number; y: number },
    anchorNoteId: number,
  ) => {
    const state = useStore.getState()
    if (!state.song) return
    const anchor = state.song.notes.find((n) => n.id === anchorNoteId)
    if (!anchor) return
    // Drag every currently-selected note. The anchor is just the click
    // target — its delta drives everyone else's delta uniformly so the
    // selection's relative shape is preserved.
    const ids = new Set<number>(state.selection)
    if (!ids.has(anchorNoteId)) ids.add(anchorNoteId)
    const anchorIdx = anchor.midi + state.settings.transpose - MIDI_MIN
    if (anchorIdx < 0 || anchorIdx >= KEY_COUNT) return
    dragRef.current = {
      snapshot: state.song,
      ids,
      anchorMidi: anchor.midi + state.settings.transpose,
      anchorOriginalDisplayedX: parallaxX(KEYBOARD_LAYOUT.keys[anchorIdx].x),
      startWorld,
      startClient,
      moved: false,
      pushedHistory: false,
      lastDeltaSemis: 0,
    }

    const onMove = (ev: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return
      // Threshold so a tiny accidental jitter on click doesn't push history
      // and doesn't reposition the note. ~5 px before drag starts.
      if (!drag.moved) {
        const cdx = ev.clientX - drag.startClient.x
        const cdy = ev.clientY - drag.startClient.y
        if (cdx * cdx + cdy * cdy < 25) return
        drag.moved = true
        // Stay on the four-way 'move' cursor through the drag — it
        // already represents both the hover affordance and the active
        // gesture (no need for a separate "grabbing" variant).
        gl.domElement.style.cursor = 'move'
      }
      const world = screenToWorld(ev.clientX, ev.clientY)
      if (!world) return
      const dx = world.x - drag.startWorld.x
      const dy = world.y - drag.startWorld.y

      const settings = useStore.getState().settings
      const fd = fallDistance()
      // Y → time. In 'down', notes higher up are later → +ΔY = +ΔTime.
      // In 'up', notes higher up are older → +ΔY = −ΔTime.
      const dirSign = settings.fallDirection === 'down' ? 1 : -1
      const deltaTime = dirSign * (dy / fd) * settings.fallDurationSec

      // X → semitones. Compute via the anchor's snapped position so the
      // black/white key X spacing is honoured naturally — clickXToMidi
      // already finds the nearest key by absolute X distance.
      const newAnchorDisplayedMidi = clickXToMidi(drag.anchorOriginalDisplayedX + dx, 0)
      const deltaSemis = newAnchorDisplayedMidi - drag.anchorMidi

      if (!drag.pushedHistory) {
        useStore.getState().pushUndoSnapshot(drag.snapshot)
        drag.pushedHistory = true
      }

      // Audible confirmation when the snapped pitch crosses to a new key.
      if (deltaSemis !== drag.lastDeltaSemis) {
        drag.lastDeltaSemis = deltaSemis
        // Preview the anchor at its new pitch — uses `previewNote` so the
        // keyboard glow / flash stay quiet while dragging through pitches.
        const anchorVel =
          drag.snapshot.notes.find((n) => n.id === anchorNoteId)?.velocity ?? 0.7
        void previewNote(drag.anchorMidi + deltaSemis, anchorVel, 150)
      }

      const next = moveNotes(drag.snapshot, drag.ids, deltaTime, deltaSemis)
      useStore.getState().setSongPreview(next)
    }

    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      dragRef.current = null
      // Drop the grabbing cursor — the next pointermove will decide
      // whether the cursor sits over a note again and re-establish
      // the right hover cursor.
      gl.domElement.style.cursor = ''
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  // Edge-resize gesture. Drags one end of a note's time interval while
  // keeping the other end fixed. Direction-aware: "head" edge moves
  // note.time (and inversely adjusts duration so the tail stays put);
  // "tail" edge changes note.duration only.
  //
  // Collision behavior — same "solid blocks" model as moveNotes: extending
  // into a same-pitch neighbour is BLOCKED, not allowed-with-clipping.
  // The neighbour's edge becomes a hard stop so resize feels symmetric
  // with move (you can't carve out room from another note by accident).
  const beginResizeDrag = (
    noteId: number,
    edge: 'head' | 'tail',
    startWorld: THREE.Vector3,
    startClient: { x: number; y: number },
  ) => {
    const cur = useStore.getState()
    if (!cur.song) return
    const snapshot = cur.song
    if (!snapshot.notes.some((n) => n.id === noteId)) return
    // Grabbing the edge of a note that's part of a multi-selection resizes
    // the same edge of every selected note by the same time delta (mirrors
    // the body drag, which moves the whole selection).
    const ids = cur.selection.has(noteId) && cur.selection.size > 1 ? cur.selection : new Set([noteId])
    const MIN_DUR = 0.02

    // The delta is clamped uniformly: the most constrained note sets the
    // limit for all, so every selected note changes by exactly the same
    // amount (same "solid blocks" rule as moveNotes). Obstacles are the
    // nearest same-pitch neighbours of each note; they don't change during
    // the drag (only the dragged edge moves, the other edge of every note
    // — selected or not — stays put), so they're computed once here.
    let minDelta = Number.NEGATIVE_INFINITY
    let maxDelta = Number.POSITIVE_INFINITY
    for (const note of snapshot.notes) {
      if (!ids.has(note.id)) continue
      const start = note.time
      const end = note.time + note.duration
      let prevObstacleEnd = 0
      let nextObstacleStart = Number.POSITIVE_INFINITY
      for (const o of snapshot.notes) {
        if (o.id === note.id || o.midi !== note.midi) continue
        const oEnd = o.time + o.duration
        if (oEnd <= start && oEnd > prevObstacleEnd) prevObstacleEnd = oEnd
        if (o.time >= end && o.time < nextObstacleStart) nextObstacleStart = o.time
      }
      if (edge === 'head') {
        // Head moves; tail stays. Not before the previous obstacle (or 0),
        // and the duration stays at least MIN_DUR.
        minDelta = Math.max(minDelta, Math.max(0, prevObstacleEnd) - start)
        maxDelta = Math.min(maxDelta, end - MIN_DUR - start)
      } else {
        // Tail moves; head stays. Not into the next obstacle, and the
        // duration stays at least MIN_DUR.
        minDelta = Math.max(minDelta, MIN_DUR - note.duration)
        maxDelta = Math.min(maxDelta, nextObstacleStart - end)
      }
    }
    // A note already below MIN_DUR could make the window empty; never
    // push anything the "wrong" way in that case.
    minDelta = Math.min(minDelta, 0)
    maxDelta = Math.max(maxDelta, 0)

    let pushedHistory = false
    let started = false

    const onMove = (ev: PointerEvent) => {
      if (!started) {
        const cdx = ev.clientX - startClient.x
        const cdy = ev.clientY - startClient.y
        if (cdx * cdx + cdy * cdy < 25) return
        started = true
      }
      const w = screenToWorld(ev.clientX, ev.clientY)
      if (!w) return
      const dy = w.y - startWorld.y
      const settings = useStore.getState().settings
      const fd = fallDistance()
      // For 'down', +Y on screen is later in time; for 'up', +Y is older.
      const dirSign = settings.fallDirection === 'down' ? 1 : -1
      const deltaTimeOnAxis = dirSign * (dy / fd) * settings.fallDurationSec

      const delta = Math.max(minDelta, Math.min(maxDelta, deltaTimeOnAxis))
      if (delta === 0 && !pushedHistory) return

      if (!pushedHistory) {
        useStore.getState().pushUndoSnapshot(snapshot)
        pushedHistory = true
      }

      const updated = snapshot.notes.map((n) => {
        if (!ids.has(n.id)) return n
        return edge === 'head'
          ? { ...n, time: n.time + delta, duration: n.duration - delta }
          : { ...n, duration: n.duration + delta }
      })
      // No resolveOverlaps — the clamp above keeps every resized note
      // inside its allowed window, so neighbour notes are never touched.
      // The song duration must follow a tail dragged past the old end:
      // the canvas and engine clamp notes to `midiTrimEndSec ?? duration`,
      // so a stale duration hid the extension until the next edit.
      useStore.getState().setSongPreview({
        ...snapshot,
        notes: updated,
        duration: computeDuration(snapshot.duration, updated),
      })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      // Clear the resize cursor — the next pointermove over a note will
      // decide whether to put it back.
      gl.domElement.style.cursor = ''
      hoveredEdgeRef.current = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  // Hover detection. Three cursor states based on where on the note the
  // pointer is sitting:
  //   - within EDGE_PROXIMITY of top/bottom → 'ns-resize' (drag the
  //     time-extent of the note)
  //   - anywhere else inside the note rectangle → 'move' (the body
  //     drag is 2D — vertical for time, horizontal for pitch — so the
  //     four-way 'move' cursor is more honest than 'grab')
  //   - off the note → cleared by onPointerOutNote
  const onPointerMoveNote = (e: ThreeEvent<PointerEvent>) => {
    if (transport === 'playing') {
      hoveredEdgeRef.current = null
      gl.domElement.style.cursor = ''
      return
    }
    // Note planes extend below the hit line geometrically (the SDF-clip in
    // the fragment shader hides those fragments visually, but raycasts
    // still hit the geometry). Reject hits whose world-y is below the hit
    // line so clicks on the keyboard area don't grab visually-hidden
    // notes; let the event fall through for other handlers to pick up.
    if (e.point.y < NOTE_HIT_Y) return
    const instId = e.instanceId
    if (instId === undefined) return
    const noteId = instanceToNoteId.current[instId]
    if (noteId === undefined || noteId < 0) return
    // Own this pointermove so EditTools' empty-area cursor handler
    // doesn't run after us and overwrite our grab/ns-resize cursor
    // with crosshair.
    e.stopPropagation()
    const state = useStore.getState()
    if (!state.song) return
    const note = state.song.notes.find((n) => n.id === noteId)
    if (!note) return
    const tl = audioEngine.currentSongTime()
    const b = noteVisualBounds(note, tl, state.settings, timeCtx)
    if (!b) {
      hoveredEdgeRef.current = null
      gl.domElement.style.cursor = ''
      return
    }

    // Map screen-edge → semantic head/tail edge based on fall direction.
    // 'down': bottom = head, top = tail. 'up': top = head, bottom = tail.
    const isDownFall = state.settings.fallDirection === 'down'
    const distTop = Math.abs(e.point.y - b.yMax)
    const distBottom = Math.abs(e.point.y - b.yMin)
    // Scale the edge-grab zone for short notes so the centre stays
    // reachable for body-drag / pitch-change. Each edge gets at most
    // 30 % of the note's visual height — guarantees the middle 40 %
    // always falls through as a body hit even for sub-EDGE_PROXIMITY
    // (≈ 16-pixel-tall) notes.
    const noteHeight = Math.max(0.001, b.yMax - b.yMin)
    const edgeReach = Math.min(EDGE_PROXIMITY, noteHeight * 0.3)
    const nearTop = distTop < edgeReach && distTop <= distBottom
    const nearBottom = distBottom < edgeReach && distBottom < distTop

    if (nearTop) {
      hoveredEdgeRef.current = { noteId, edge: isDownFall ? 'tail' : 'head' }
      gl.domElement.style.cursor = 'ns-resize'
    } else if (nearBottom) {
      hoveredEdgeRef.current = { noteId, edge: isDownFall ? 'head' : 'tail' }
      gl.domElement.style.cursor = 'ns-resize'
    } else {
      hoveredEdgeRef.current = null
      gl.domElement.style.cursor = 'move'
    }
  }

  const onPointerOutNote = () => {
    // Cursor leaves the note's hit area — clear any resize/grab state.
    // (Without this the cursor can stick on ns-resize / grab when the
    // user moves off a note quickly.)
    hoveredEdgeRef.current = null
    gl.domElement.style.cursor = ''
  }

  const onPointerDownNote = (e: ThreeEvent<PointerEvent>) => {
    // While playing, click-on-note shouldn't preempt the play/pause toggle.
    // We let the event continue past us so PlayToggleArea handles it.
    if (transport === 'playing') return
    // Skip hits whose world-y is below the hit line. The note plane
    // extends below it geometrically (clipped per-fragment in the shader),
    // so without this guard a click on the keyboard area would land on a
    // visually-hidden note. Don't stopPropagation — let the event reach
    // EditTools / Keyboard as if we missed.
    if (e.point.y < NOTE_HIT_Y) return
    // In edit mode we own every click on the note plane geometry. Stop
    // propagation up-front so EditTools' empty-area clear-selection
    // handler can't fire on the same gesture even if the instance lookup
    // below bails out (e.g. instanceId race during a buffer-rebuild).
    e.stopPropagation()
    // Edit gestures require the sampler to be ready — see EditTools'
    // matching guard for the rationale (silent drag + queued-preview
    // burst on ready). Swallow this click and kick off the load so a
    // subsequent click works normally.
    if (!audioEngine.isReady()) {
      void ensureSamplerLoaded()
      return
    }
    const instId = e.instanceId
    if (instId === undefined) return
    const noteId = instanceToNoteId.current[instId]
    // Live notes (id === -1) and stale slots can't be edited.
    if (noteId === undefined || noteId < 0) return
    const state = useStore.getState()
    if (!state.song) return

    const native = e.nativeEvent

    // Middle button is reserved for camera orbit/pan
    // (see scene/CameraControls.tsx) — let it pass through.
    if (native.button === 1) return

    // Right-click → delete just this single note, even when it's part
    // of a multi-selection. Bulk deletion of the whole selection is
    // intentionally reserved for the Delete / Backspace key, so a stray
    // right-click can't wipe out a multi-note selection in one action.
    // Browser default contextmenu is suppressed by the canvas-level
    // handler in Viewport.
    if (native.button === 2) {
      const targetNote = state.song.notes.find((n) => n.id === noteId)
      const next = deleteNotes(state.song, [noteId])
      if (next !== state.song) {
        // Capture the note's visible rectangle BEFORE applying the edit
        // so the death FX can puff out from the spot the note actually
        // occupied (querying after the delete would find nothing).
        if (targetNote) {
          const tl = audioEngine.currentSongTime()
          const b = noteVisualBounds(targetNote, tl, state.settings, timeCtx)
          if (b) {
            noteDeathFx.emit({
              midi: targetNote.midi + state.settings.transpose,
              velocity: targetNote.velocity,
              x: (b.xMin + b.xMax) / 2,
              centerY: (b.yMin + b.yMax) / 2,
              width: b.xMax - b.xMin,
              length: b.yMax - b.yMin,
              track: targetNote.track,
            })
          }
        }
        state.applySongEdit(next)
        if (state.selection.has(noteId)) {
          const trimmed = new Set(state.selection)
          trimmed.delete(noteId)
          state.replaceSelection(trimmed)
        }
      }
      return
    }

    // Alt+click splits the note at the click position. The split time uses
    // the click's world Y so the cut lands exactly where the user pointed.
    if (native.altKey) {
      const splitTime = clickYToTime(
        e.point.y,
        audioEngine.currentSongTime(),
        state.settings,
        timeCtx,
      )
      const result = splitNote(state.song, noteId, splitTime)
      if (result) {
        state.applySongEdit(result.song)
        state.replaceSelection([noteId, result.tailId])
      }
      return
    }

    // Ctrl/Cmd+click toggles this note's selection without disturbing the
    // others. No drag is started — additive selection is a discrete action.
    if (native.ctrlKey || native.metaKey) {
      state.toggleSelection(noteId)
      previewSelectedNote(noteId)
      return
    }

    // Edge hover takes precedence over move-drag for plain clicks. The
    // hover state was set in onPointerMoveNote; we read it here so the
    // pointerdown that converts the hover into a gesture starts a
    // resize instead of a move. If the note is part of a multi-selection,
    // the selection is kept and every selected note is resized together.
    const hovered = hoveredEdgeRef.current
    if (hovered && hovered.noteId === noteId) {
      if (!state.selection.has(noteId)) {
        state.replaceSelection([noteId])
      }
      beginResizeDrag(
        noteId,
        hovered.edge,
        e.point.clone(),
        { x: native.clientX, y: native.clientY },
      )
      return
    }

    // Plain click: collapse selection to this note (unless it's already
    // part of a multi-selection — preserve the group so the drag carries
    // everyone). Then arm a drag.
    if (!state.selection.has(noteId)) {
      state.replaceSelection([noteId])
    }
    previewSelectedNote(noteId)
    beginDrag(e.point.clone(), { x: native.clientX, y: native.clientY }, noteId)
  }

  // Double-click → open the selection card for the selection. The two
  // pointerdowns that precede the dblclick already select the note (via
  // the regular click handler; a note inside a multi-selection keeps the
  // whole selection). We still defensively replace selection here in case
  // some intermediate event (e.g. ctrl-click toggle) cleared it between
  // the first and second click.
  const onDoubleClickNote = (e: ThreeEvent<MouseEvent>) => {
    if (transport === 'playing') return
    if (e.point.y < NOTE_HIT_Y) return
    e.stopPropagation()
    if (!audioEngine.isReady()) {
      void ensureSamplerLoaded()
      return
    }
    const instId = e.instanceId
    if (instId === undefined) return
    const noteId = instanceToNoteId.current[instId]
    if (noteId === undefined || noteId < 0) return
    const state = useStore.getState()
    if (!state.song) return
    if (!state.selection.has(noteId)) {
      state.replaceSelection([noteId])
    }
    useStore.getState().openSelectionCard()
  }

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, MAX_INSTANCES]}
      frustumCulled={false}
      material={material}
      count={0}
      // Paint order of the transparent layers: notes 2, then the hit
      // line (2.2) over them, particles (2.5), landing flashes (3).
      renderOrder={2}
      onPointerDown={onPointerDownNote}
      onPointerMove={onPointerMoveNote}
      onPointerOut={onPointerOutNote}
      onDoubleClick={onDoubleClickNote}
    >
      <planeGeometry args={[1, 1]} />
    </instancedMesh>
  )
}

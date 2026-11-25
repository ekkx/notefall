import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { isLinearTarget } from '../scene/linearTarget'
import { useFrame } from '@react-three/fiber'
import { useSettingsSlice } from '../store'

const HIT_PARTICLES_KEYS = [
  'particleColorFollowNote',
  'fallDurationSec',
  'noteColor',
  'noteMinLength',
  'noteLabelsEnabled',
  'noteLabelContent',
  'noteLabelFormat',
  'noteLabelAccidental',
  'particleAirFriction',
  'particleBlending',
  'particleDotBrightness',
  'particleDotCount',
  'particleDotOpacity',
  'particleDotSize',
  'particleEmitterWidth',
  'particleFlowEvolution',
  'particleFlowFollow',
  'particleFlowFrequency',
  'particleFlowOctaveGain',
  'particleFlowOctaveScale',
  'particleFlowOctaves',
  'particleFlowStrength',
  'particleFlowX',
  'particleFlowY',
  'particleFlowZ',
  'particleFogCount',
  'particleFogEnabled',
  'particleFogOpacity',
  'particleGravityCurl',
  'particleLaunchSpeed',
  'particleLife',
  'particleMotionTrail',
  'particleRandomDirection',
  'particleRandomSpeed',
  'particleRayAngle',
  'particleRayLength',
  'particleRayOpacity',
  'particleRaySpread',
  'particleRaysEnabled',
  'particleRise',
  'particleSpread',
  'particleTwirl',
  'particleTwirlVariance',
  'particlesEnabled',
  'trackColors',
] as const
import { audioEngine } from '../audio/engine'
import { clockEpoch, now } from '../audio/clock'
import { fallDistance } from './positions'
import { getResolvedSettings } from '../scene/automatedSettings'
import { KEYBOARD_LAYOUT, KEY_COUNT, MIDI_MIN, NOTE_HIT_Y } from '../keyboard/layout'
import { NoteColorResolver } from './noteColor'
import { noteDeathFx } from './noteDeathFx'
import { noteLabelMinLengthAt } from './pitchLabels'
import {
  DOT_SIZE_SCALE,
  RAY_SIZE_SCALE,
  RISE_SCALE,
  KEY_EMITTER_HALF_WIDTH,
  KEY_SPAWN_Y,
  ParticleSim,
  SIM_TO_WORLD,
  type EmitSource,
  type ParticleParams,
} from './particleSim'

// How long a single death event keeps emitting particles. Spreading
// emission over a window — instead of dumping everything in one frame —
// reproduces the "particles streaming out of a held key" look exactly,
// because we're literally running the same per-frame emit logic the
// held-key path uses, just at the death position.
const DEATH_EMIT_DURATION = 0.35

// Keyboard particles: soft dots rising from held keys, a share of them
// drawn as thin tilted rays, plus a few large faint fog puffs behind.
// Motion lives in `particleSim.ts` (CPU, sim units); this component
// wires key / death events and settings into it and uploads the live
// particles as two instanced quad batches each frame (fog first, so
// the dots and rays sit on top).
//
// Colour is computed in sRGB and alpha-blended. Bloom off, that blends
// straight onto the sRGB canvas. Bloom on, the scene renders into a
// linear target that is encoded to sRGB at the end, which makes the many
// overlapping faint halos read several times brighter; the fragment then
// converts its colour to linear and raises alpha to 1.5. That exponent
// was matched by measuring a held key's plume against the bloom-off
// render (2.2 would be exact for a single layer over black, but
// under-shoots once dozens of halos overlap).

const VERTEX_SHADER = /* glsl */ `
  attribute vec3 iPos;     // world position
  attribute vec4 iShape;   // size (sim units), rotation (deg), age (0..1), lifetime (s)
  attribute vec3 iColor;   // sRGB
  attribute vec3 iExtra;   // ray flag, phase, speed (sim units/s)

  uniform float uSimToWorld;

  varying vec2  vUv;
  varying float vWorldY;
  varying vec3  vColor;
  varying vec4  vShape;
  varying vec3  vExtra;

  void main() {
    float t = iShape.z;
  #ifdef FOG
    float grow = mix(0.59, 1.0, smoothstep(0.0, 0.1, t)) * (1.0 - 0.25 * smoothstep(0.41, 1.0, t));
  #else
    float grow = mix(0.483, 1.0, smoothstep(0.0, 0.1, t));
  #endif
    float a = -radians(iShape.y);
    vec2 c = position.xy * iShape.x * grow * uSimToWorld;
    vec2 r = vec2(c.x * cos(a) - c.y * sin(a), c.x * sin(a) + c.y * cos(a));
    // Camera-aligned billboard, rotated in the view plane.
    mat3 invViewRot = transpose(mat3(viewMatrix));
    vec3 wp = iPos + invViewRot[0] * r.x + invViewRot[1] * r.y;
    vUv = position.xy + 0.5;
    vWorldY = wp.y;
    vColor = iColor;
    vShape = iShape;
    vExtra = iExtra;
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  }
`

const OUTPUT_GLSL = /* glsl */ `
  uniform float uLinearTarget;
  vec4 particleOutput(vec3 rgb, float a) {
    // Low brightness pushes channels below 0; pow() of a negative is NaN,
    // which the bloom blur would then smear across the whole frame.
    rgb = max(rgb, vec3(0.0));
    if (uLinearTarget > 0.5) return vec4(pow(rgb, vec3(2.2)), pow(a, 1.5));
    return vec4(rgb, a);
  }
`

const DOT_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  varying vec2  vUv;
  varying float vWorldY;
  varying vec3  vColor;
  varying vec4  vShape;
  varying vec3  vExtra;

  uniform float uHitY;
  uniform float uDotSize;
  uniform float uRaySize;
  uniform float uRayWidth;
  uniform float uBrightness;
  uniform float uOpacity;
  uniform float uRayOpacity;
  uniform float uAdditive;
  uniform float uMotionTrail;
  uniform float uRise;
  ${OUTPUT_GLSL}

  // Soft glow with a slightly dimmer rim tint; fades to 0 at the quad edge.
  vec4 dotSprite(vec2 uv) {
    float r = length(uv - 0.5) * 2.0;
    float a = 0.9 * exp(-r * r * 4.5) * (1.0 - smoothstep(0.8, 1.0, r));
    return vec4(vec3(mix(0.66, 1.0, exp(-r * r * 4.0))), a);
  }

  // Thin filament: exponential cross-section, starting at the particle
  // and thinning toward its far end.
  float raySprite(vec2 uv) {
    float w = exp(-abs(uv.x - 0.5) / 0.03);
    float rise = smoothstep(0.44, 0.5, uv.y);
    float fall = mix(1.0, 0.3, smoothstep(0.55, 0.95, uv.y)) * (1.0 - smoothstep(0.93, 1.0, uv.y));
    return 0.624 * w * rise * fall;
  }

  void main() {
    if (vWorldY < uHitY) discard;
    float age = vShape.z;
    float size = vShape.x;
    float rayFlag = vExtra.x;
    float phase = vExtra.y;

    // The dot shrinks inside its quad after a quarter of its life and
    // fades out over the last 40 %.
    vec2 p = vUv - 0.5;
    vec2 q = p * (size / uDotSize);
    float env = 1.0;
    if (age > 0.25) q /= 1.0 - (age - 0.25) * 1.1111111;
    if (age > 0.6) env = 2.5 - 2.5 * age;
    vec2 tuv = q + 0.5;
    if (uMotionTrail > 0.5) {
      // Stretch the dot along its (pre-rotated) travel direction with speed.
      float travel = vExtra.z + uRise;
      if (travel > 0.5) {
        float s = min(2.0 * travel, 3.5);
        tuv = vec2(q.x * ((s - 1.0) * 0.12 + 1.0), q.y / s) + 0.5;
      }
    }
    vec4 dot = (tuv.x < 0.0 || tuv.y < 0.0 || tuv.x > 1.0 || tuv.y > 1.0) ? vec4(0.0) : dotSprite(tuv);
    float pa = env * dot.a * uOpacity;

    float ra = 0.0;
    if (rayFlag > 0.0 && uRaySize > 0.0) {
      // Ray length pulses with a per-particle phase.
      float f = fract(abs((age * 0.7 + phase) * 0.5));
      float tri = f > 0.5 ? 2.0 - f * 2.0 : f * 2.0;
      float len = tri * 0.66 + 0.33;
      vec2 ruv = vec2(clamp(p.x * (size / uRayWidth) + 0.5, 0.0, 1.0),
                      clamp(p.y * (size / (len * uRaySize)) + 0.5, 0.0, 1.0));
      ra = raySprite(ruv) * 2.0 * uRayOpacity * len * env;
      if (p.y < 0.0) ra *= max((vUv.y - 0.45) * 20.0, 0.0);
    }

    float a = pa + ra;
    if (a <= 0.0) discard;
    vec3 dotRgb = dot.rgb * (vColor + (1.0 - vColor) * uBrightness);
    if (uAdditive > 0.5) dotRgb *= 1.4;
    vec3 rgb = dotRgb * (pa / a) + vColor * (ra / a);
    gl_FragColor = particleOutput(rgb, max(pa, ra));
  }
`

const FOG_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  varying vec2  vUv;
  varying float vWorldY;
  varying vec3  vColor;
  varying vec4  vShape;
  varying vec3  vExtra;

  uniform float uHitY;
  uniform float uOpacity;
  ${OUTPUT_GLSL}

  float hash3(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float noise3(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
  float fbm3(vec3 p) { return 0.55 * noise3(p) + 0.28 * noise3(p * 2.03) + 0.17 * noise3(p * 4.01); }

  void main() {
    if (vWorldY < uHitY) discard;
    float age = vShape.z;
    float elapsed = age * vShape.w;
    float seed = vExtra.y;
    // Round blob broken up by slowly churning fbm; fades over the last 10 %.
    float blob = 1.0 - smoothstep(0.05, 0.5, length(vUv - 0.5));
    float n = fbm3(vec3(vUv * 3.0, elapsed * 0.35 + seed * 7.0));
    float density = 1.15 * blob * smoothstep(0.35, 0.9, n * 0.75 + blob * 0.35);
    float fade = age > 0.9 ? 1.0 - (age - 0.9) * 10.0 : 1.0;
    float a = density * uOpacity * fade * 0.63;
    if (a <= 0.0) discard;
    gl_FragColor = particleOutput(vColor * 0.95, a);
  }
`

/** Instanced quad batch mirroring one sim pool on the GPU. */
function createBatch(capacity: number, fragmentShader: string, uniforms: Record<string, THREE.IUniform>, fog: boolean) {
  const base = new THREE.PlaneGeometry(1, 1)
  const geometry = new THREE.InstancedBufferGeometry()
  geometry.index = base.index
  geometry.setAttribute('position', base.getAttribute('position'))
  base.dispose()
  const attr = (itemSize: number) =>
    new THREE.InstancedBufferAttribute(new Float32Array(capacity * itemSize), itemSize).setUsage(THREE.DynamicDrawUsage)
  const pos = attr(3)
  const shape = attr(4)
  const color = attr(3)
  const extra = attr(3)
  geometry.setAttribute('iPos', pos)
  geometry.setAttribute('iShape', shape)
  geometry.setAttribute('iColor', color)
  geometry.setAttribute('iExtra', extra)
  geometry.instanceCount = 0
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uSimToWorld: { value: SIM_TO_WORLD },
      uHitY: { value: NOTE_HIT_Y },
      uLinearTarget: { value: 0 },
      ...uniforms,
    },
    defines: fog ? { FOG: '' } : {},
    vertexShader: VERTEX_SHADER,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.SrcAlphaFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    // Destination alpha must stay opaque: with SrcAlpha here the bloom
    // composer's target ends up translucent under every particle and the
    // canvas composites them darker against the page.
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    toneMapped: false,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.frustumCulled = false
  // Bloom renders the scene into a linear target, bloom off straight onto
  // the sRGB canvas — pick the matching output transform per draw.
  mesh.onBeforeRender = (renderer) => {
    material.uniforms.uLinearTarget.value = isLinearTarget(renderer.getRenderTarget()) ? 1 : 0
  }
  const attrs = [pos, shape, color, extra]
  /** Flag the first `n` instances for upload (the rest of the buffer is stale and not drawn). */
  const commit = (n: number) => {
    geometry.instanceCount = n
    for (const a of attrs) {
      a.clearUpdateRanges()
      if (n > 0) {
        a.addUpdateRange(0, n * a.itemSize)
        a.needsUpdate = true
      }
    }
  }
  return {
    mesh,
    material,
    pos: pos.array as Float32Array,
    shape: shape.array as Float32Array,
    color: color.array as Float32Array,
    extra: extra.array as Float32Array,
    commit,
    dispose: () => {
      geometry.dispose()
      material.dispose()
    },
  }
}

type Batch = ReturnType<typeof createBatch>

/** Copy a sim pool into its batch's instance buffers (sim units → world). */
function upload(pool: ParticleSim['dots'], batch: Batch, hitY: number) {
  const n = pool.count
  const { pos, shape, color, extra } = batch
  for (let i = 0; i < n; i++) {
    const i3 = i * 3, i4 = i * 4
    pos[i3] = pool.x[i] * SIM_TO_WORLD
    pos[i3 + 1] = hitY + pool.y[i] * SIM_TO_WORLD
    pos[i3 + 2] = pool.z[i] * SIM_TO_WORLD
    shape[i4] = pool.size[i]
    shape[i4 + 1] = pool.rot[i]
    shape[i4 + 2] = pool.age[i] / pool.life[i]
    shape[i4 + 3] = pool.life[i]
    color[i3] = pool.r[i]
    color[i3 + 1] = pool.g[i]
    color[i3 + 2] = pool.b[i]
    extra[i3] = pool.ray[i]
    extra[i3 + 1] = pool.phase[i]
    extra[i3 + 2] = Math.hypot(pool.vx[i], pool.vy[i], pool.vz[i])
  }
  batch.commit(n)
}

export function HitParticles() {
  const settings = useSettingsSlice(HIT_PARTICLES_KEYS)

  const sim = useMemo(() => new ParticleSim(), [])
  const fogBatch = useMemo(
    () => createBatch(sim.fog.capacity, FOG_FRAGMENT_SHADER, { uOpacity: { value: 0 } }, true),
    [sim],
  )
  const dotBatch = useMemo(
    () =>
      createBatch(
        sim.dots.capacity,
        DOT_FRAGMENT_SHADER,
        {
          uDotSize: { value: 0 },
          uRaySize: { value: 0 },
          uRayWidth: { value: 0 },
          uBrightness: { value: 0 },
          uOpacity: { value: 0 },
          uRayOpacity: { value: 0 },
          uAdditive: { value: 0 },
          uMotionTrail: { value: 0 },
          uRise: { value: 0 },
        },
        false,
      ),
    [sim],
  )
  useEffect(() => () => fogBatch.dispose(), [fogBatch])
  useEffect(() => () => dotBatch.dispose(), [dotBatch])

  const group = useMemo(() => {
    const g = new THREE.Group()
    // Drawn after the falling notes (renderOrder 2) so the plume stays
    // visible over them, but before the landing flashes (3).
    fogBatch.mesh.renderOrder = 2.5
    dotBatch.mesh.renderOrder = 2.5
    // Same renderOrder, same object position → three falls back to
    // creation order, so adding fog first keeps it underneath.
    g.add(fogBatch.mesh, dotBatch.mesh)
    return g
  }, [fogBatch, dotBatch])

  const heldCount = useMemo(() => new Uint8Array(KEY_COUNT), [])
  // Track index of the most recent note-on per key (-1 = no track /
  // live input). Read at emission time to look up the per-track tint
  // — gives the particle plume the same colour as the falling note
  // that triggered it.
  const lastTrack = useMemo(() => {
    const a = new Int32Array(KEY_COUNT)
    a.fill(-1)
    return a
  }, [])
  // Song note id of that note-on (-1 = live input), for per-note random colours.
  const lastNoteId = useMemo(() => {
    const a = new Int32Array(KEY_COUNT)
    a.fill(-1)
    return a
  }, [])
  const colorResolver = useMemo(() => new NoteColorResolver(), [])
  // Set on note-on; the next emission for that key is the press burst.
  const pendingBurst = useMemo(() => new Uint8Array(KEY_COUNT), [])
  // Per-key timestamp of the most recent note-on, used to enforce a
  // minimum sustained emission window matching the falling-note
  // `noteMinLength` — staccato notes still spawn particles for as long
  // as the visual bar is on screen, so the key glow, the bar, and the
  // particles all have synchronised durations. -Infinity = no past note.
  const noteOnTime = useMemo(() => {
    const a = new Float32Array(KEY_COUNT)
    a.fill(-Infinity)
    return a
  }, [])
  const lastFrame = useRef(now())
  const lastEpoch = useRef(clockEpoch())
  const colorVec = useMemo(() => new THREE.Color(), [])
  const source = useMemo<EmitSource>(() => ({ x: 0, halfWidth: 0, y: 0, halfHeight: 0, r: 0, g: 0, b: 0 }), [])

  useEffect(() => {
    const off = audioEngine.addKeyListener((ev) => {
      const idx = ev.midi - MIDI_MIN
      if (idx < 0 || idx >= KEY_COUNT) return
      if (ev.type === 'on') {
        heldCount[idx]++
        lastTrack[idx] = ev.track ?? -1
        lastNoteId[idx] = ev.id ?? -1
        pendingBurst[idx] = 1
        noteOnTime[idx] = now()
      } else {
        heldCount[idx] = Math.max(0, heldCount[idx] - 1)
      }
    })
    return off
  }, [heldCount, lastTrack, lastNoteId, pendingBurst, noteOnTime])

  // Active "death emitters" — each death event spawns one of these and it
  // emits particles for DEATH_EMIT_DURATION using the same per-frame rate
  // a held key would, scattered over the deleted note's rectangle.
  type DeathEmitter = {
    x: number
    centerY: number
    width: number
    length: number
    startTime: number
    burstFired: boolean
    /** Source track of the deleted note; -1 if the dying note had no
     *  track tag (e.g. recorder-built song). */
    track: number
  }
  const deathEmittersRef = useRef<DeathEmitter[]>([])
  useEffect(() => {
    const off = noteDeathFx.subscribe((d) => {
      deathEmittersRef.current.push({
        x: d.x,
        centerY: d.centerY,
        width: d.width,
        length: d.length,
        startTime: now(),
        burstFired: false,
        track: d.track ?? -1,
      })
    })
    return off
  }, [])

  useFrame(() => {
    const nowSec = now()

    // The offline exporter swaps `now()` for a virtual clock that
    // restarts at 0 (see `clockEpoch`). Every timestamp below is from
    // the previous epoch, so drop the pool and re-anchor instead of
    // integrating across the discontinuity, and so keys played live
    // right before Export don't read as "just struck" in the render.
    const epoch = clockEpoch()
    if (epoch !== lastEpoch.current) {
      lastEpoch.current = epoch
      lastFrame.current = nowSec
      sim.clear()
      noteOnTime.fill(-Infinity)
      pendingBurst.fill(0)
      deathEmittersRef.current.length = 0
    }

    // Clamped at both ends: the upper bound absorbs backgrounded-tab
    // gaps, the lower one is a guard against any other source of
    // backwards time (the epoch reset above already handles the
    // exporter's handoff).
    const dt = Math.min(0.05, Math.max(0, nowSec - lastFrame.current))
    lastFrame.current = nowSec

    if (!settings.particlesEnabled) {
      if (sim.alive > 0) sim.clear()
      deathEmittersRef.current.length = 0
      fogBatch.commit(0)
      dotBatch.commit(0)
      return
    }

    // Pin-resolved settings for every animatable particle parameter;
    // the on/off switches are non-animatable and read the React slice.
    // Zero pins ⇒ `rs` is the live settings object by reference.
    const rs = getResolvedSettings()
    const params: ParticleParams = {
      dotCount: rs.particleDotCount,
      dotSize: rs.particleDotSize,
      life: Math.max(0.01, rs.particleLife),
      rise: rs.particleRise,
      spread: rs.particleSpread,
      emitterWidth: rs.particleEmitterWidth,
      flowStrength: rs.particleFlowStrength,
      flowX: rs.particleFlowX,
      flowY: rs.particleFlowY,
      flowZ: rs.particleFlowZ,
      flowOctaves: settings.particleFlowOctaves,
      flowOctaveScale: rs.particleFlowOctaveScale,
      flowOctaveGain: rs.particleFlowOctaveGain,
      flowFrequency: rs.particleFlowFrequency,
      flowEvolution: rs.particleFlowEvolution,
      flowFollow: rs.particleFlowFollow,
      launchSpeed: rs.particleLaunchSpeed,
      randomDirection: rs.particleRandomDirection,
      randomSpeed: rs.particleRandomSpeed,
      airFriction: rs.particleAirFriction,
      gravityCurl: rs.particleGravityCurl,
      twirl: rs.particleTwirl,
      twirlVariance: rs.particleTwirlVariance,
      motionTrail: settings.particleMotionTrail,
      raysEnabled: settings.particleRaysEnabled,
      rayLength: rs.particleRayLength,
      rayAngle: rs.particleRayAngle,
      raySpread: rs.particleRaySpread,
      fogEnabled: settings.particleFogEnabled && rs.particleFogOpacity > 0,
      fogCount: rs.particleFogCount,
    }

    const additive = settings.particleBlending === 'additive'
    const dotSize = params.dotSize * DOT_SIZE_SCALE
    const rayLength = Math.max(params.rayLength, 1)
    const dotMaterial = dotBatch.material
    const du = dotMaterial.uniforms
    du.uDotSize.value = Math.max(dotSize, 1e-6)
    du.uRaySize.value = params.raysEnabled && params.rayLength > 0 ? params.rayLength * RAY_SIZE_SCALE : 0
    du.uRayWidth.value = Math.max(2 * dotSize, 0.8) * ((rayLength - 1) * 0.2 + 1)
    // Additive blending already brightens overlaps, so the alpha mode
    // gets a fixed lift toward white instead.
    du.uBrightness.value = rs.particleDotBrightness - (additive ? 1 : 0.7)
    du.uOpacity.value = rs.particleDotOpacity
    du.uRayOpacity.value = params.raysEnabled ? rs.particleRayOpacity : 0
    du.uAdditive.value = additive ? 1 : 0
    du.uMotionTrail.value = params.motionTrail ? 1 : 0
    du.uRise.value = params.rise * RISE_SCALE
    const blendDst = additive ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor
    if (dotMaterial.blendDst !== blendDst) {
      dotMaterial.blendDst = blendDst
      dotMaterial.needsUpdate = true
    }
    du.uHitY.value = NOTE_HIT_Y
    fogBatch.material.uniforms.uOpacity.value = settings.particleFogEnabled ? rs.particleFogOpacity : 0
    fogBatch.material.uniforms.uHitY.value = NOTE_HIT_Y

    const hitY = NOTE_HIT_Y
    // Minimum emission duration in seconds, derived from the falling-note
    // `noteMinLength` (world units) using the same fall-distance ↔ time
    // conversion FallingNotes uses. Recomputed per frame so changes to
    // camera / keyboard / fall duration take effect immediately, including
    // for notes already in their min-emit window.
    const minEmitPerLength = rs.fallDurationSec / fallDistance()
    const minLength = Math.max(0, rs.noteMinLength)
    // labelled notes are drawn at least as long as their label
    const labelSettings = {
      noteLabelsEnabled: settings.noteLabelsEnabled,
      noteLabelContent: settings.noteLabelContent,
      noteLabelFormat: settings.noteLabelFormat,
      noteLabelAccidental: settings.noteLabelAccidental,
      noteLabelSize: rs.noteLabelSize,
      noteLabelOutlineWidth: rs.noteLabelOutlineWidth,
    }

    // Particles take their note's colour, resolved exactly like
    // FallingNotes (notes/noteColor.ts; live input has no track / id).
    // sRGB — see the blending note at the top.
    // Or the explicit particleColor when not following.
    const follow = settings.particleColorFollowNote
    if (follow) colorResolver.update(rs)
    else colorVec.set(rs.particleColor)
    const fixed = [colorVec.r, colorVec.g, colorVec.b] as const
    const setSourceColor = (i: number) => {
      const t = lastTrack[i]
      const id = lastNoteId[i]
      const rgb = follow ? colorResolver.rgb(i + MIDI_MIN, t < 0 ? undefined : t, id < 0 ? undefined : id) : fixed
      colorVec.setRGB(rgb[0], rgb[1], rgb[2]).convertLinearToSRGB()
      source.r = colorVec.r
      source.g = colorVec.g
      source.b = colorVec.b
    }

    for (let i = 0; i < KEY_COUNT; i++) {
      // Effective "still emitting" = key physically held OR within the
      // min-emission window since the last note-on. Lets staccato notes
      // produce a particle plume that lasts as long as the falling-note
      // visual bar (which is also extended to noteMinLength).
      const minEmitDurationSec =
        Math.max(minLength, noteLabelMinLengthAt(labelSettings, rs.noteWidthScale, i)) * minEmitPerLength
      const effectiveHeld = heldCount[i] > 0 || nowSec < noteOnTime[i] + minEmitDurationSec
      if (!effectiveHeld) {
        pendingBurst[i] = 0
        continue
      }
      source.x = KEYBOARD_LAYOUT.keys[i].x / SIM_TO_WORLD
      source.halfWidth = KEY_EMITTER_HALF_WIDTH
      source.y = KEY_SPAWN_Y
      source.halfHeight = KEY_SPAWN_Y
      setSourceColor(i)
      sim.emit(source, dt, pendingBurst[i] === 1, params)
      pendingBurst[i] = 0
    }

    // Death emitters: a "phantom hit" running the held-key emission for
    // DEATH_EMIT_DURATION over the deleted note's rectangle, so every
    // setting that shapes the hit column shapes the puff identically.
    const deathEmitters = deathEmittersRef.current
    for (let e = deathEmitters.length - 1; e >= 0; e--) {
      const em = deathEmitters[e]
      if (nowSec - em.startTime >= DEATH_EMIT_DURATION) {
        deathEmitters.splice(e, 1)
        continue
      }
      source.x = em.x / SIM_TO_WORLD
      source.halfWidth = em.width / 2 / SIM_TO_WORLD
      source.y = (em.centerY - hitY) / SIM_TO_WORLD
      source.halfHeight = em.length / 2 / SIM_TO_WORLD
      setSourceColor(em.track)
      sim.emit(source, dt, !em.burstFired, params)
      em.burstFired = true
    }

    sim.step(dt, params)
    upload(sim.fog, fogBatch, hitY)
    upload(sim.dots, dotBatch, hitY)
  })

  return <primitive object={group} />
}

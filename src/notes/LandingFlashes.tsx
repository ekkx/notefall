import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { useSettingsSlice } from '../store'
import { audioEngine } from '../audio/engine'
import { clockEpoch, now } from '../audio/clock'
import { getResolvedSettings } from '../scene/automatedSettings'
import { isLinearTarget } from '../scene/linearTarget'
import { retriggerDip } from '../keyboard/retriggerDip'
import { KEYBOARD_LAYOUT, KEYBOARD_Y, KEY_COUNT, MIDI_MIN, WHITE_KEY_LENGTH, WHITE_KEY_WIDTH } from '../keyboard/layout'
import { NoteColorResolver } from './noteColor'

const LANDING_FLASHES_KEYS = ['flashFollowNote', 'noteColor', 'trackColors'] as const

/**
 * The landing flash: one quad per key at the hit line, drawn additively over the notes (renderOrder 3), made of
 *  - a soft core (an ellipse, slightly wider than tall, half brightness at `flashCoreSize`),
 *  - a starburst of soft spokes (count, length, angular width and edge softness are settings; each note-on gives the
 *    key a fixed angle offset, a hash of key + note-on count, so neighbouring flashes do not line up),
 *  - a low haze along the hit line (exponential falloff, no contour).
 * One `flashWhiten` lifts the colour of all three toward white. Everything is a pure function of the clock and the
 * note-ons (hashes, no `Math.random`; the counters restart with the clock epoch), so the export matches the live view. The flash never
 * touches the notes.
 *
 * Attribute budget: position + uv + instanceMatrix (4) + intensity + tint = 8, so the per-hit angle offset rides in the
 * instance matrix's unused z scale (scale.z = 1 + offset).
 */
const VERTEX_SHADER = /* glsl */ `
  attribute float instanceIntensity;
  attribute vec3 instanceTint;
  varying vec2 vUv;
  varying float vIntensity;
  varying vec3 vTint;
  varying float vSeed;
  varying float vHit;
  void main() {
    vUv = uv;
    vIntensity = instanceIntensity;
    vTint = instanceTint;
    vSeed = fract(instanceMatrix[3].x * 37.31 + 0.5);
    vHit = length(instanceMatrix[2].xyz) - 1.0;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`

const MAX_RAYS = 16

const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  varying float vIntensity;
  varying vec3 vTint;
  varying float vSeed;
  varying float vHit;
  uniform vec3 uPlane;   // plane width, height, depth under the hit line (white-key widths)
  uniform vec3 uCore;    // core size, aspect, softness
  uniform vec4 uRays;    // strength, length, angular width, softness
  uniform vec3 uHaze;    // strength, width, height
  uniform vec2 uMisc;    // whiten, ray count
  // 1 = the composer's linear buffer (Bloom on), 0 = the canvas, which wants sRGB-encoded values (set per draw).
  uniform float uLinearTarget;
  const float TAU = 6.2831853;
  vec3 toSrgb(vec3 c) {
    c = max(c, 0.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  }
  float hash(float n) { return fract(sin(n * 127.1 + vSeed * 311.7) * 43758.5453); }
  void main() {
    if (vIntensity < 0.005) discard;
    float x = (vUv.x - 0.5) * uPlane.x;
    float y = vUv.y * uPlane.y - uPlane.z;
    float I = vIntensity;
    // Composed in display (sRGB) space like the notes' / particles' colour: the whitened tint is encoded first and
    // the envelope multiplies it; a linear target (Bloom on) gets the result linearised, so both look alike.
    vec3 base = toSrgb(mix(vTint, vec3(1.0), uMisc.x));
    vec3 col = vec3(0.0);

    // Core: elliptical, shorter below the line; gaussian at softness 0, long soft tail at 1.
    float hy = uCore.x * (y < 0.0 ? 0.35 : 1.0);
    float hx = uCore.x * uCore.y;
    float q2 = x * x / (hx * hx) + y * y / (hy * hy);
    float prof = mix(exp(-0.6931 * q2), 1.0 / (1.0 + q2), uCore.z);
    col += base * pow(1.5 * I * I * prof, 0.4545);

    // Starburst: soft wedges from the flash point, fading toward their tips; the keyboard below stays clean.
    if (uRays.x > 0.001 && y > -0.3) {
      float cnt = uMisc.y;
      float r = length(vec2(x, y));
      float ang = atan(y, x);
      float beams = 0.0;
      for (int i = 0; i < ${MAX_RAYS}; i++) {
        float fi = float(i);
        if (fi >= cnt) break;
        float a0 = TAU * ((fi + 0.5 * (hash(fi + 1.0) - 0.5)) / cnt + vHit);
        float d = abs(mod(ang - a0 + 3.14159265, TAU) - 3.14159265);
        float u = d / (uRays.z * (0.75 + 0.5 * hash(fi + 7.0)));
        float wedge = mix(1.0 - smoothstep(0.7, 1.0, u), exp(-1.2 * u * u), uRays.w);
        float len = uRays.y * (0.6 + 0.4 * hash(fi + 13.0));
        float t = clamp(r / len, 0.0, 1.0);
        float fall = pow(1.0 - t, 1.8) * smoothstep(0.0, 0.1, r);
        beams += wedge * fall * (0.6 + 0.4 * hash(fi + 29.0));
      }
      beams *= smoothstep(-0.3, 0.05, y);
      col += base * beams * uRays.x * I * 0.55;
    }

    // Haze: low and wide along the hit line, exponential in both directions (a cusp-free |x| keeps the middle
    // smooth), faint over the key backs below.
    if (uHaze.x > 0.001) {
      float ax = sqrt(x * x + 0.02) / uHaze.y;
      float ay = y >= 0.0 ? y / uHaze.z : -y / (uHaze.z * 0.35);
      float s1 = ax + ay;
      float g = mix(exp(-s1 * 2.2), pow(1.0 + s1 * 1.2, -2.5), 0.5);
      if (y < 0.0) g *= 0.35;
      col += base * g * uHaze.x * I;
    }

    // Zero at the quad's edge, whatever the tails' height there (no contour for Bloom's threshold to pick out).
    float fx = 1.0 - smoothstep(0.4, 1.0, abs(vUv.x * 2.0 - 1.0));
    float fy = (1.0 - smoothstep(0.5, 1.0, vUv.y)) * smoothstep(0.0, 1.0, (y + uPlane.z) / uPlane.z);
    col *= fx * fy;
    if (max(col.r, max(col.g, col.b)) < 0.002) discard;
    gl_FragColor = vec4(uLinearTarget > 0.5 ? pow(col, vec3(2.2)) : col, 1.0);
  }
`

// Minimum visible hold time after a note-on, even if note-off arrives almost
// immediately. Without this, sub-frame staccato notes never get a chance to
// reach the GPU and look unlit.
const MIN_HOLD_SECONDS = 0.08
const hash01 = (n: number) => Math.abs(Math.sin(n * 12.9898 + 78.233) * 43758.5453) % 1

export function LandingFlashes() {
  const settings = useSettingsSlice(LANDING_FLASHES_KEYS)
  const meshRef = useRef<THREE.InstancedMesh>(null)
  const dummy = useMemo(() => new THREE.Object3D(), [])

  const intensities = useMemo(() => new Float32Array(KEY_COUNT), [])
  const intensityAttr = useMemo(() => {
    const a = new THREE.InstancedBufferAttribute(intensities, 1)
    a.setUsage(THREE.DynamicDrawUsage)
    return a
  }, [intensities])
  // Per-key RGB tint, re-uploaded each frame (cheap — 88 × 3 floats).
  const tints = useMemo(() => new Float32Array(KEY_COUNT * 3), [])
  const tintAttr = useMemo(() => {
    const a = new THREE.InstancedBufferAttribute(tints, 3)
    a.setUsage(THREE.DynamicDrawUsage)
    return a
  }, [tints])
  // Track index of the most recent note-on per key (-1 = no track /
  // live input). Read in the per-frame tint update loop.
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
  // Flash level before the retrigger dip; `intensities` (the uploaded attribute) is this × retriggerDip, rebuilt
  // each frame.
  const levels = useMemo(() => new Float32Array(KEY_COUNT), [])
  const heldCount = useMemo(() => new Uint8Array(KEY_COUNT), [])
  const sustainLevels = useMemo(() => new Float32Array(KEY_COUNT), [])
  // Earliest wall-clock time at which a key can fade to off. Bumped on every
  // note-on so very short notes still show for at least MIN_HOLD_SECONDS.
  const heldUntil = useMemo(() => new Float32Array(KEY_COUNT), [])
  const lastEpoch = useRef(clockEpoch())

  // Per-hit state: the spokes' angle offset (hash of key + that key's note-on count).
  const hitSeed = useMemo(() => new Float32Array(KEY_COUNT), [])
  const hitCount = useMemo(() => new Uint32Array(KEY_COUNT), [])
  const resetHitState = useMemo(
    () => () => {
      hitCount.fill(0)
      hitSeed.fill(0)
    },
    [hitCount, hitSeed],
  )

  const material = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        uPlane: { value: new THREE.Vector3(6, 4, 0.8) },
        uCore: { value: new THREE.Vector3(0.37, 1.35, 0) },
        uRays: { value: new THREE.Vector4(1, 2, 0.1, 0.6) },
        uHaze: { value: new THREE.Vector3(0, 6, 1) },
        uMisc: { value: new THREE.Vector2(0.5, 12) },
        uLinearTarget: { value: 0 },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      // Disable depthTest so the flash renders on top regardless of z. The quads sit at the SAME z as the falling
      // notes (0.05) for perspective parity, so the black keys (z ≈ 0.09) would otherwise occlude the part that
      // extends across neighbours. Render order + additive blending keep the painter order correct.
      depthTest: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      toneMapped: false,
    })
  }, [])
  useEffect(() => () => material.dispose(), [material])

  // Plane size (white-key widths) the instances are currently built for, and the key's quad writer.
  const dims = useRef({ w: 6, h: 4, under: 0.8 })
  const setInstance = useMemo(
    () => (i: number) => {
      const m = meshRef.current
      if (!m) return
      const { w, h, under } = dims.current
      const k = KEYBOARD_LAYOUT.keys[i]
      dummy.position.set(k.x, WHITE_KEY_LENGTH + (WHITE_KEY_WIDTH * (h - under)) / 2, 0.05)
      dummy.scale.set(WHITE_KEY_WIDTH * w, WHITE_KEY_WIDTH * (h + under), 1 + hitSeed[i])
      dummy.updateMatrix()
      m.setMatrixAt(i, dummy.matrix)
      m.instanceMatrix.needsUpdate = true
    },
    [dummy, hitSeed],
  )
  const lastShape = useRef<[number, number, number]>([NaN, NaN, NaN])

  // Press / release tracking. The flash snaps to its sustain level on
  // note-on (no fade-in) and snaps back to 0 once the key is released
  // AND the minimum-hold window has elapsed (no fade-out).
  useEffect(() => {
    const off = audioEngine.addKeyListener((ev) => {
      const idx = ev.midi - MIDI_MIN
      if (idx < 0 || idx >= KEY_COUNT) return
      if (ev.type === 'on') {
        heldCount[idx]++
        const rs = getResolvedSettings()
        // Pin-resolved flashIntensity at the instant of note-on so the
        // sustain level tracks any active automation.
        const sustain = rs.flashIntensity * (0.7 + ev.velocity * 0.3)
        if (sustainLevels[idx] < sustain) sustainLevels[idx] = sustain
        // Per-hit variation: the spokes' angle offset.
        hitCount[idx]++
        hitSeed[idx] = hash01((idx + 1) * 7.31 + hitCount[idx] * 19.17)
        setInstance(idx)
        // Instant on — no rise time. Also extend the minimum-visible window.
        levels[idx] = sustainLevels[idx]
        intensities[idx] = levels[idx] * retriggerDip[idx]
        heldUntil[idx] = now() + MIN_HOLD_SECONDS
        lastTrack[idx] = ev.track ?? -1
        lastNoteId[idx] = ev.id ?? -1
        intensityAttr.needsUpdate = true
      } else {
        heldCount[idx] = Math.max(0, heldCount[idx] - 1)
        // useFrame handles the off transition once heldUntil has elapsed.
      }
    })
    return off
  }, [heldCount, sustainLevels, heldUntil, lastTrack, lastNoteId, levels, intensities, intensityAttr, hitCount, hitSeed, setInstance])

  // Attribute wiring only; the quads are placed in useFrame (pins animate the sizes).
  useEffect(() => {
    const mesh = meshRef.current
    if (!mesh) return
    mesh.geometry.setAttribute('instanceIntensity', intensityAttr)
    mesh.geometry.setAttribute('instanceTint', tintAttr)
    mesh.count = KEY_COUNT
    return () => {
      mesh.geometry.deleteAttribute('instanceIntensity')
      mesh.geometry.deleteAttribute('instanceTint')
    }
  }, [intensityAttr, tintAttr])

  // Scratch THREE.Color reused inside the per-frame tint resolver to
  // parse hex strings without allocating.
  const tmpColor = useMemo(() => new THREE.Color(), [])

  useFrame(() => {
    const nowSec = now()

    // `heldUntil` stores an ABSOLUTE time, so it does not survive the
    // exporter swapping `now()` for a virtual clock that restarts at 0
    // (see `clockEpoch`). A deadline captured during the live session
    // sits in the future of the entire render, so every key that was
    // played before the export stayed lit for the whole video. Drop the
    // deadlines and let the frame below rebuild them from the render's
    // own note-ons; the hit counters restart too, so the render's flashes
    // do not depend on what was played before it.
    const epoch = clockEpoch()
    if (epoch !== lastEpoch.current) {
      lastEpoch.current = epoch
      heldUntil.fill(-Infinity)
      resetHitState()
    }

    const rs = getResolvedSettings()
    const mesh = meshRef.current

    // Pin-resolved uniforms; the quad is sized to hold the longest of core / rays / haze.
    const soft = Math.min(1, Math.max(0, rs.flashCoreSoftness))
    const hx = rs.flashCoreSize * rs.flashCoreAspect
    const hy = rs.flashCoreSize
    const reach = 6 + 10 * soft
    const rayLen = rs.flashRays > 0.001 ? rs.flashRaysLength : 0
    const hazeOn = rs.flashHaze > 0.001
    const wKeys = Math.max(2 * hx * reach, 2 * rayLen + 0.5, hazeOn ? rs.flashHazeWidth * 7 : 0, 1)
    const hKeys = Math.max(hy * reach, rayLen + 0.5, hazeOn ? rs.flashHazeHeight * 7 : 0, 1)
    const under = Math.max(0.6, hy * 0.35 * reach)
    const u = material.uniforms
    ;(u.uPlane.value as THREE.Vector3).set(wKeys, hKeys + under, under)
    ;(u.uCore.value as THREE.Vector3).set(rs.flashCoreSize, rs.flashCoreAspect, soft)
    ;(u.uRays.value as THREE.Vector4).set(rs.flashRays, rs.flashRaysLength, rs.flashRaysWidth, rs.flashRaysSoftness)
    ;(u.uHaze.value as THREE.Vector3).set(rs.flashHaze, rs.flashHazeWidth, rs.flashHazeHeight)
    ;(u.uMisc.value as THREE.Vector2).set(rs.flashWhiten, Math.min(MAX_RAYS, Math.max(1, Math.round(rs.flashRaysCount))))
    // Rebuild the quads only when their size changed (a steady state builds them once).
    const ls = lastShape.current
    if (mesh && (ls[0] !== wKeys || ls[1] !== hKeys || ls[2] !== under)) {
      ls[0] = wKeys
      ls[1] = hKeys
      ls[2] = under
      dims.current.w = wKeys
      dims.current.h = hKeys
      dims.current.under = under
      for (let i = 0; i < KEY_COUNT; i++) setInstance(i)
    }

    let dirty = false
    for (let i = 0; i < KEY_COUNT; i++) {
      if (levels[i] === 0) continue
      // Snap off only when the key has been released AND the minimum hold
      // window has elapsed. Otherwise hold the current level steady.
      if (heldCount[i] === 0 && nowSec >= heldUntil[i]) {
        levels[i] = 0
        sustainLevels[i] = 0
      }
      const v = levels[i] * retriggerDip[i]
      if (intensities[i] !== v) {
        intensities[i] = v
        dirty = true
      }
    }
    if (dirty) intensityAttr.needsUpdate = true

    // Per-key tint: the note's colour (notes/noteColor.ts) when the flash
    // follows the note, else the explicit flashColor. Colours are
    // pin-resolved; flashFollowNote is non-animatable.
    const followNote = settings.flashFollowNote
    if (followNote) colorResolver.update(rs)
    tmpColor.set(rs.flashColor)
    const flashRgb = [tmpColor.r, tmpColor.g, tmpColor.b] as const
    const resolveTint = (i: number): readonly [number, number, number] => {
      if (!followNote) return flashRgb
      const t = lastTrack[i]
      const id = lastNoteId[i]
      const c = colorResolver.rgb(i + MIDI_MIN, t < 0 ? undefined : t, id < 0 ? undefined : id)
      return [c[0], c[1], c[2]]
    }
    let tintDirty = false
    for (let i = 0; i < KEY_COUNT; i++) {
      if (intensities[i] === 0) continue
      const [r, g, b] = resolveTint(i)
      const o = i * 3
      if (tints[o] !== r || tints[o + 1] !== g || tints[o + 2] !== b) {
        tints[o] = r
        tints[o + 1] = g
        tints[o + 2] = b
        tintDirty = true
      }
    }
    if (tintDirty) tintAttr.needsUpdate = true
  })

  return (
    <group position={[0, KEYBOARD_Y, 0]}>
      <instancedMesh
        ref={meshRef}
        args={[undefined, undefined, KEY_COUNT]}
        frustumCulled={false}
        material={material}
        count={KEY_COUNT}
        raycast={() => null}
        onBeforeRender={(renderer) => {
          material.uniforms.uLinearTarget.value = isLinearTarget(renderer.getRenderTarget()) ? 1 : 0
        }}
        // These effects are all transparent + depthWrite:false, so paint order is renderOrder then camera
        // distance. The flash mesh's origin is z≈0 (z is baked per instance at 0.05), so the distance sort would put
        // it BEHIND the falling-notes mesh (renderOrder 2). Pin it above the notes so the flash blooms on top.
        renderOrder={3}
      >
        <planeGeometry args={[1, 1]} />
      </instancedMesh>
    </group>
  )
}

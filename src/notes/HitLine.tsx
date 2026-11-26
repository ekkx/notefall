import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { useSettingsSlice } from '../store'
import { getResolvedSettings } from '../scene/automatedSettings'
import { KEYBOARD_LAYOUT, NOTE_HIT_Y } from '../keyboard/layout'

const HIT_LINE_KEYS = [
  'hitLineBarHalo',
  'hitLineBarY',
  'hitLineColor',
  'hitLineEnabled',
  'hitLineColorMode',
  'hitLineIntensity',
  'hitLineThickness',
  'hitLineWaveAmplitude',
  'hitLineWaveEnabled',
  'hitLineWaveGrain',
  'hitLineWaveHalo',
  'hitLineWaveIntensity',
  'hitLineWaveMorphSpeed',
  'hitLineWaveScale',
  'hitLineWaveScrollSpeed',
  'hitLineWaveThickness',
  'hitLineWaveY',
] as const
import { now } from '../audio/clock'
import {
  NOTE_GRADIENT_GLSL,
  createGradientUniforms,
  hitLineColoring,
  writeGradientUniforms,
} from './noteColor'

type GradientUniforms = ReturnType<typeof createGradientUniforms>

// The line's colour: uColor, or the note gradient along the line (uPlaneWidth
// = the plane's world width, centred on x = 0) when following the notes.
const LINE_COLOR_GLSL = /* glsl */ `
  uniform float uPlaneWidth;
  ${NOTE_GRADIENT_GLSL}
  vec3 lineColor() {
    if (uGradient < 0.5) return uColor;
    return gradientAt(vec2((vUv.x - 0.5) * uPlaneWidth, uGradArea.y));
  }
`

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

// Straight glowing bar at the hit line. Two layers in one pass: a tight
// bright core for the laser itself, plus a soft halo that extends past
// the core so the bar reads as a glow band, not a hard line.
const BAR_FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform float uThickness;
  uniform float uHalo;
  ${LINE_COLOR_GLSL}
  void main() {
    // Distance from horizontal centerline of the plane (0 at center, 1 at edge).
    float d = abs(vUv.y - 0.5) * 2.0;
    float t = max(uThickness, 0.001);
    float core = 1.0 - smoothstep(0.0, t, d);
    // Gaussian halo around the bar. Coefficient is divided by uHalo² so a
    // larger halo value = wider falloff. Clamped to avoid divide-by-zero.
    float h = max(uHalo, 0.001);
    float halo = exp(-d * d * (12.0 / (h * h)));
    float a = core + halo * 0.35;
    if (a < 0.005) discard;
    gl_FragColor = vec4(lineColor() * uIntensity * a, a);
  }
`

// Wavy laser — animated noise-driven curve in the plane. Same idea as the
// straight bar but the centerline is displaced per-x by an FBM noise that
// evolves over time, so it reads as a glowing organic ribbon.
const WAVE_FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform float uAmplitude;
  uniform float uThickness;
  uniform float uWaveScale;
  uniform float uScrollSpeed;
  uniform float uMorphSpeed;
  uniform float uHalo;
  uniform float uGrain;
  ${LINE_COLOR_GLSL}

  float hash21(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  // 3-octave FBM gives the wave both broad sway and small ripples — the
  // small ripples are what reads as a "laser flicker" when the wave moves.
  float fbm(vec2 p) {
    return vnoise(p) * 0.55
         + vnoise(p * 2.13 + 4.7) * 0.30
         + vnoise(p * 4.5 + 8.3) * 0.15;
  }

  void main() {
    // Borrowed from HitParticles' wind logic. Two independent time inputs:
    //   - scroll: translates the noise sample along X so features visibly
    //     drift across the screen. Sign convention is "what the user sees":
    //     positive uScrollSpeed = visual moves rightward, negative = left.
    //     We achieve this by SUBTRACTING the offset (a feature at fixed
    //     noise coord c sits at xs = c + uScrollSpeed*time*scale).
    //   - morph: secondary-axis evolution so the shape isn't a perfectly
    //     periodic loop even at zero scroll.
    //
    // Two stacked octaves at different spatial scales / scroll multipliers
    // give a parallax effect — broad slow wave with small fast ripples
    // riding on it, which reads as the wind+particle quality from the
    // reference image.
    float xs = vUv.x * uWaveScale;
    float scroll = uTime * uScrollSpeed;
    float morph = uTime * uMorphSpeed;
    // Layer 1 — broad slow wave (the dominant shape)
    float n1 = fbm(vec2(xs - scroll * 4.0, morph)) - 0.5;
    // Layer 2 — parallax detail riding on top of layer 1
    float n2 = (vnoise(vec2(xs * 2.4 - scroll * 7.0, morph * 1.7)) - 0.5) * 0.35;
    // Layer 3 — high-frequency tremor for grain. Scales with uGrain so at
    // 0 the curve stays smooth; at 1+ it picks up jagged sub-features that
    // read as the line being made of vibrating particles rather than a
    // clean glow stroke.
    float n3 = (vnoise(vec2(xs * 8.0 - scroll * 12.0, morph * 2.5)) - 0.5) * 0.15 * uGrain;
    float n = (n1 + n2 + n3) * 2.0;
    float curveY = 0.5 + n * uAmplitude * 0.5;

    float dist = abs(vUv.y - curveY);
    float t = max(uThickness, 0.001);
    // Sharp laser core
    float core = 1.0 - smoothstep(0.0, t, dist);
    // Soft halo — gives the laser its glow. Coefficient divided by uHalo²
    // so larger value = wider, softer halo around the wavy line.
    float h = max(uHalo, 0.001);
    float halo = exp(-dist * dist * (25.0 / (h * h)));

    // Sparkle — per-x brightness modulation. High-frequency noise sharpened
    // by a power so most sections are dim and a few are bright; the line
    // visually breaks into a stream of "particles" instead of a continuous
    // laser. Scrolls faster than the main waves to feel like grains being
    // carried by the wind. Mixed in by uGrain so at 0 the line is uniformly
    // bright (smooth-laser look).
    float sparkleX = xs * 4.0 - scroll * 10.0;
    float sparkle = pow(vnoise(vec2(sparkleX, morph * 3.0)), 2.5);
    // mix() the modulation amount in by clamped uGrain so values > 1 only
    // affect the curve tremor (n3), not the brightness range.
    float brightness = mix(1.0, 0.3 + sparkle * 1.7, clamp(uGrain, 0.0, 1.0));

    float a = (core + halo * 0.4) * brightness;
    if (a < 0.005) discard;
    gl_FragColor = vec4(lineColor() * uIntensity * a, a);
  }
`

// World-space heights of the two planes. Tuned so the bar is a thin glow
// band and the wave plane is tall enough to contain a wave with full-amplitude
// swing without clipping at its top/bottom edges.
const BAR_PLANE_HEIGHT = 0.12
const WAVE_PLANE_HEIGHT = 0.7
// Extra width past the keyboard so the additive glow fades at the edges
// instead of cutting off in a hard rectangle.
const PLANE_WIDTH_PAD = 0.5
const PLANE_WIDTH = KEYBOARD_LAYOUT.totalWidth + PLANE_WIDTH_PAD

/**
 * Glowing horizontal laser at the keyboard hit line. Composed of a steady
 * straight bar plus an animated wavy beam. Both run as fragment shaders on
 * a single quad each — no per-frame CPU work beyond pushing uTime.
 */
export function HitLine() {
  const settings = useSettingsSlice(HIT_LINE_KEYS)
  const barMeshRef = useRef<THREE.Mesh>(null)
  const waveMeshRef = useRef<THREE.Mesh>(null)

  const barMaterial = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(settings.hitLineColor) },
        uIntensity: { value: settings.hitLineIntensity },
        uThickness: { value: settings.hitLineThickness },
        uHalo: { value: settings.hitLineBarHalo },
        uPlaneWidth: { value: PLANE_WIDTH },
        ...createGradientUniforms(NOTE_HIT_Y),
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: BAR_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    })
    // settings deliberately excluded — uniforms mutated below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => () => barMaterial.dispose(), [barMaterial])

  const waveMaterial = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(settings.hitLineColor) },
        uIntensity: { value: settings.hitLineWaveIntensity },
        uAmplitude: { value: settings.hitLineWaveAmplitude },
        uThickness: { value: settings.hitLineWaveThickness },
        uWaveScale: { value: settings.hitLineWaveScale },
        uScrollSpeed: { value: settings.hitLineWaveScrollSpeed },
        uMorphSpeed: { value: settings.hitLineWaveMorphSpeed },
        uHalo: { value: settings.hitLineWaveHalo },
        uGrain: { value: settings.hitLineWaveGrain },
        uPlaneWidth: { value: PLANE_WIDTH },
        ...createGradientUniforms(NOTE_HIT_Y),
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: WAVE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => () => waveMaterial.dispose(), [waveMaterial])

  // Animatable uniforms are pushed per-frame from the pin-resolved
  // settings (see useFrame below) instead of via per-field useEffects.
  // This makes them follow timeline pins AND animate correctly under
  // the export's `r3f.advance()` loop. With zero pins the resolved
  // values equal the live settings, so every write is the same value
  // the old effects wrote — behaviour is unchanged.

  // Wrap uTime so the shader's noise inputs stay in float32-precise
  // territory. `performance.now()` grows unboundedly per page session,
  // and once `uTime * scrollSpeed` (and the downstream `* 4.0`, `* 12.0`
  // multipliers feeding fbm/hash21) reaches the hundreds-of-thousands
  // range, GLSL's `sin()` argument reduction loses precision — the
  // hash output collapses toward a near-constant value, which manifests
  // as the wave drifting downward (mean of `n1` no longer ≈ 0.5),
  // halo/grain dynamic range dropping, and the line becoming flat.
  // Wrapping at a long-enough period keeps the inputs bounded; the
  // discontinuity at the wrap is one-frame and falls inside the wave's
  // continuous morph so users don't perceive it as a glitch.
  const TIME_WRAP_SECONDS = 600
  useFrame(() => {
    const r = getResolvedSettings()
    waveMaterial.uniforms.uTime.value = now() % TIME_WRAP_SECONDS
    const { gradient, hex: lineHex } = hitLineColoring(r)
    writeGradientUniforms(barMaterial.uniforms as unknown as GradientUniforms, gradient)
    writeGradientUniforms(waveMaterial.uniforms as unknown as GradientUniforms, gradient)
    barMaterial.uniforms.uColor.value.set(lineHex)
    barMaterial.uniforms.uIntensity.value = r.hitLineIntensity
    barMaterial.uniforms.uThickness.value = r.hitLineThickness
    barMaterial.uniforms.uHalo.value = r.hitLineBarHalo
    waveMaterial.uniforms.uColor.value.set(lineHex)
    waveMaterial.uniforms.uIntensity.value = r.hitLineWaveIntensity
    waveMaterial.uniforms.uAmplitude.value = r.hitLineWaveAmplitude
    waveMaterial.uniforms.uThickness.value = r.hitLineWaveThickness
    waveMaterial.uniforms.uWaveScale.value = r.hitLineWaveScale
    waveMaterial.uniforms.uScrollSpeed.value = r.hitLineWaveScrollSpeed
    waveMaterial.uniforms.uMorphSpeed.value = r.hitLineWaveMorphSpeed
    waveMaterial.uniforms.uHalo.value = r.hitLineWaveHalo
    waveMaterial.uniforms.uGrain.value = r.hitLineWaveGrain
    // Pin-resolved vertical offsets from the fixed hit line.
    const hitYR = NOTE_HIT_Y
    if (barMeshRef.current) barMeshRef.current.position.y = hitYR + r.hitLineBarY
    if (waveMeshRef.current) waveMeshRef.current.position.y = hitYR + r.hitLineWaveY
  })

  if (!settings.hitLineEnabled) return null

  const hitY = NOTE_HIT_Y
  const planeWidth = PLANE_WIDTH

  // z = 0.14 / 0.141: in front of the 3D black keys (top z ≈ 0.09),
  // falling notes (0.1) and landing flashes (0.105) so the laser
  // visibly sits over them. Layers use additive blending so render
  // order has no visual effect, but separating their z avoids
  // depth-sort flicker if it's ever enabled.
  return (
    <>
      {/* Sit in front of the now-3D black keys (top face at
          z=BLACK_KEY_THICKNESS = 0.125). Earlier these planes were at
          0.061/0.062 — fine when every key was a flat plane at z≈0, but
          the 3D black keys would have hidden the bar/wave behind their
          tops near the back edge. */}
      {/* Explicit renderOrder puts the line OVER the falling notes in
          the transparent-object paint sequence (notes 2, line 2.2,
          particles 2.5, landing flashes 3): a note reaching the keys
          slides under the glowing line instead of covering it. The z
          coordinate stays where it is (in front of the 3D black keys
          at z=0.125) so the line is still visible against the keys. */}
      <mesh
        ref={barMeshRef}
        position={[0, hitY + settings.hitLineBarY, 0.14]}
        renderOrder={2.2}
      >
        <planeGeometry args={[planeWidth, BAR_PLANE_HEIGHT]} />
        <primitive object={barMaterial} attach="material" />
      </mesh>
      {settings.hitLineWaveEnabled && (
        <mesh
          ref={waveMeshRef}
          position={[0, hitY + settings.hitLineWaveY, 0.141]}
          renderOrder={2.2}
        >
          <planeGeometry args={[planeWidth, WAVE_PLANE_HEIGHT]} />
          <primitive object={waveMaterial} attach="material" />
        </mesh>
      )}
    </>
  )
}

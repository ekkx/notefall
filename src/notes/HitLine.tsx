import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { useSettingsSlice } from '../store'
import { getResolvedSettings } from '../scene/automatedSettings'
import { KEYBOARD_LAYOUT, NOTE_HIT_Y } from '../keyboard/layout'
import { clockEpoch, now } from '../audio/clock'
import { isLinearTarget } from '../scene/linearTarget'
import {
  NOTE_GRADIENT_GLSL,
  createGradientUniforms,
  hitLineColoring,
  hitLineKeysOf,
  writeGradientUniforms,
} from './noteColor'

type GradientUniforms = ReturnType<typeof createGradientUniforms>

// The line's colour: uColor, or the note gradient along the line (x in world
// units from the plane's centre) when following the notes.
const LINE_COLOR_GLSL = /* glsl */ `
  ${NOTE_GRADIENT_GLSL}
  vec3 lineColor(float x) {
    if (uGradient < 0.5) return uColor;
    return gradientAt(vec2(x, uGradArea.y));
  }
`

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

// One additive quad (all world units, x along the line from its centre, y across it):
//  - two lines: thin filaments, each displaced by its own fractal noise (sway + tangle), with their own settings;
//  - glow: one straight soft glow, a tight part plus a long tail;
//  - haze: one patchy mist above and below, fading out at the quad's top and bottom.
// The lines' and the haze's motion phases (sideways offset, the noise's third axis) are integrated on the CPU.
const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform float uWhiten;
  uniform vec2 uPlane;      // world size of the quad
  uniform float uFadeFrom;  // |x| where the end fade starts
  uniform vec4 uLineA[2];   // per line: width, strength, wobble, wobble scale
  uniform vec4 uLineB[2];   // per line: blur, tangle, drift phase, wobble phase
  uniform vec2 uGlow;       // strength, width
  uniform vec4 uHaze;       // strength, height, contrast, scale
  uniform vec2 uHazePhase;  // drift, churn
  uniform float uLinearTarget;
  ${LINE_COLOR_GLSL}

  // Lattice hash and value noise (own construction), tiled every 256 cells to keep the arguments small.
  float cellHash(vec3 c) {
    c = mod(c, 256.0);
    vec3 q = fract(c * vec3(0.7548777, 0.5698403, 0.6180340) + vec3(0.137, 0.291, 0.419));
    q += dot(q, q.yzx + vec3(3.71, 2.93, 4.37));
    float h = fract((q.x + q.y) * q.z + q.x * 0.5731 + q.y * 0.2967);
    return fract(h * 53.11 + q.z * 7.13);
  }
  float noise3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float x00 = mix(cellHash(i), cellHash(i + vec3(1.0, 0.0, 0.0)), u.x);
    float x10 = mix(cellHash(i + vec3(0.0, 1.0, 0.0)), cellHash(i + vec3(1.0, 1.0, 0.0)), u.x);
    float x01 = mix(cellHash(i + vec3(0.0, 0.0, 1.0)), cellHash(i + vec3(1.0, 0.0, 1.0)), u.x);
    float x11 = mix(cellHash(i + vec3(0.0, 1.0, 1.0)), cellHash(i + vec3(1.0, 1.0, 1.0)), u.x);
    return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
  }
  // 0..1 around 0.5. Each octave is also offset so the layers don't line up on the origin.
  float fbm(vec3 p, int octaves) {
    float sum = 0.0;
    float amp = 0.5;
    float norm = 0.0;
    for (int k = 0; k < 5; k++) {
      if (k >= octaves) break;
      sum += amp * noise3(p);
      norm += amp;
      p = p * 2.03 + vec3(17.3, 9.1, 4.7);
      amp *= 0.58;
    }
    return sum / norm;
  }

  // The line's implicit field: zero on the line, ≈ signed vertical distance away from it. Two parts:
  //  - the sway: fractal noise along x only (wobble = amount, wobble scale = feature size), one clean curve y = d(x);
  //  - the tangle: isotropic fractal noise over (x, y) whose cells are sized by the wobble, with an amplitude of
  //    tangle × wobble. Amplitude over cell size is then fixed by tangle alone, so how much the line folds, splits
  //    into strands and rejoins doesn't change with the wobble or its scale.
  // The tangle's octaves are rotated against each other (no lattice axis lines up), and an octave whose cells get
  // shorter than a few pixels fades out (px = world units per pixel): pixel-sized flecks read as dithering.
  const mat2 LINE_ROT = mat2(0.8, -0.6, 0.6, 0.8);
  const float TANGLE_CELL = 1.5;  // tangle cell size, in wobbles
  const float TANGLE_AMP = 0.6;   // tangle amplitude per unit of tangle, in wobbles
  // A, B = the line's uLineA / uLineB; seed keeps the two lines' noise apart.
  float lineField(float x, float y, float px, vec4 A, vec4 B, float seed) {
    float wob = max(A.z, 0.0005);
    float xs = x - B.z + seed;
    float z = B.w + seed;
    // Sway
    float fx = 1.0 / max(A.w, 0.01);
    float sway = 0.0;
    float amp = 0.5;
    float norm = 0.0;
    for (int k = 0; k < 5; k++) {
      float fade = 1.0 - smoothstep(0.12, 0.25, fx * px);
      sway += amp * fade * (noise3(vec3(xs * fx + float(k) * 17.3, 3.7 + float(k) * 9.1, z * pow(2.03, float(k)) + float(k) * 4.7)) - 0.5);
      norm += amp;
      fx *= 2.03;
      amp *= 0.58;
    }
    float d = sway / norm * 3.0 * wob;
    // Tangle
    if (B.y > 0.001) {
      float f = 1.0 / (TANGLE_CELL * wob);
      vec2 q = vec2(xs, y) * f + vec2(31.9, 11.3);
      float zt = z * 1.3 + 57.1;
      float t = 0.0;
      amp = 0.5;
      norm = 0.0;
      for (int k = 0; k < 4; k++) {
        float fade = 1.0 - smoothstep(0.12, 0.25, f * px);
        t += amp * fade * (noise3(vec3(q, zt)) - 0.5);
        norm += amp;
        q = LINE_ROT * q * 2.03 + vec2(17.3, 9.1);
        zt = zt * 2.03 + 4.7;
        f *= 2.03;
        amp *= 0.58;
      }
      d += t / norm * 2.0 * TANGLE_AMP * B.y * wob;
    }
    return y - d;
  }

  void main() {
    float x = (vUv.x - 0.5) * uPlane.x;
    float y = (vUv.y - 0.5) * uPlane.y;
    float ay = abs(y);
    // World units per pixel, taken before any branch (derivatives need uniform control flow).
    float px = max(fwidth(x), fwidth(y));

    float a = 0.0;

    // Lines. Blur widens the profile and lowers its peak by the same factor (a blurred gaussian keeps its area).
    // The two lines combine by max, not sum: where they overlap they read as one line (no doubled brightness), apart
    // each keeps its own.
    float lines = 0.0;
    for (int i = 0; i < 2; i++) {
      vec4 A = uLineA[i];
      vec4 B = uLineB[i];
      float w0 = max(A.x, 0.0005);
      float w = sqrt(w0 * w0 + B.x * B.x);
      // The sway stays within ±1.5 × wobble and the tangle adds ≤ ~0.6 × tangle × wobble, so nothing is cut off.
      float reach = (1.6 + 0.7 * B.y) * A.z + 5.0 * w;
      if (A.y > 0.0005 && ay < reach) {
        // The line is where g(x, y) = y - d(x, y) = 0, an implicit curve that can fold back, pinch, split into strands
        // and rejoin. g / |∇g| is the distance to it, so the strands keep the set width on steep slopes and at folds
        // (g alone would smear them into blobs there); the gradient's floor keeps a saddle from lighting a wide patch.
        float seed = float(i) * 113.7;
        float g = lineField(x, y, px, A, B, seed);
        const float e = 0.003;
        vec2 grad = vec2(lineField(x + e, y, px, A, B, seed) - g, lineField(x, y + e, px, A, B, seed) - g) / e;
        float r = g / (max(length(grad), 0.35) * w);
        lines = max(lines, A.y * (w0 / w) * exp(-3.0 * r * r));
      }
    }
    a += lines;

    // Glow: tight part + long tail
    if (uGlow.x > 0.0005) {
      float gw = max(uGlow.y, 0.002);
      float tight = exp(-1.5 * (ay / (0.4 * gw)) * (ay / (0.4 * gw)));
      float tail = pow(1.0 + (ay / gw) * (ay / gw), -1.5);
      a += uGlow.x * (0.6 * tight + 0.4 * tail);
    }

    // Haze
    if (uHaze.x > 0.0005) {
      float hh = max(uHaze.y, 0.01);
      float t = ay / hh;
      float env = exp(-3.2 * t * t) * (1.0 - smoothstep(0.7, 1.0, t));
      float s = 1.0 / max(uHaze.w, 0.02);
      vec3 q = vec3((x - uHazePhase.x) * s, y * s, uHazePhase.y * 0.6 + 41.0);
      float v = fbm(q, 3);
      // Unevenness takes mist away between the clouds (0 = an even band as bright as the clouds), so it never
      // changes how bright the clouds themselves are.
      float cloud = smoothstep(0.3, 0.7, v);
      float m = clamp(1.0 - uHaze.z * (1.0 - cloud), 0.0, 1.0);
      a += uHaze.x * env * m;
    }

    // Zero at the quad's edges (no contour for Bloom's threshold to pick out).
    float fx = 1.0 - smoothstep(uFadeFrom, uPlane.x * 0.5, abs(x));
    float fy = 1.0 - smoothstep(0.75, 1.0, ay / (uPlane.y * 0.5));
    a *= fx * fy * uIntensity;
    if (a < 0.002) discard;

    vec3 col = mix(lineColor(x), vec3(1.0), uWhiten) * a;
    gl_FragColor = vec4(uLinearTarget > 0.5 ? pow(col, vec3(2.2)) : col, 1.0);
  }
`

// Extra width past the keyboard so the additive glow fades out at the ends instead of cutting off.
const PLANE_WIDTH_PAD = 1.0
const PLANE_WIDTH = KEYBOARD_LAYOUT.totalWidth + PLANE_WIDTH_PAD
// The haze drifts a little faster than the line (parallax).
const HAZE_DRIFT_RATIO = 1.6
// Phases wrap to keep float32 precision in the shader (the noise tiles every 256 cells, so this is only a bound).
const PHASE_WRAP = 1024

/**
 * The hit line: one additive quad drawn by a fragment shader (two lines + one glow + one haze, see the shader). Only
 * the lines have per-line settings (`hitLineKeysOf(1 | 2)`); colour, intensity, whiten, offset, glow and haze
 * are shared (`hitLine*`). No render target; the CPU only integrates the motion phases and pushes uniforms.
 */
const LINE_IDS = [1, 2] as const
export function HitLine() {
  const settings = useSettingsSlice(['hitLineEnabled'] as const)
  const meshRef = useRef<THREE.Mesh>(null)

  const material = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color('#87a5ff') },
        uIntensity: { value: 1 },
        uWhiten: { value: 0 },
        uPlane: { value: new THREE.Vector2(PLANE_WIDTH, 1) },
        uFadeFrom: { value: KEYBOARD_LAYOUT.totalWidth * 0.5 },
        uLineA: { value: [new THREE.Vector4(), new THREE.Vector4()] },
        uLineB: { value: [new THREE.Vector4(), new THREE.Vector4()] },
        uGlow: { value: new THREE.Vector2() },
        uHaze: { value: new THREE.Vector4() },
        uHazePhase: { value: new THREE.Vector2() },
        uLinearTarget: { value: 0 },
        ...createGradientUniforms(NOTE_HIT_Y),
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneFactor,
      toneMapped: false,
    })
  }, [])
  useEffect(() => () => material.dispose(), [material])

  // Integrated motion phases: the shared sideways drift (wu), per line wobble, the haze (drift wu, churn); + the
  // previous now() and clock epoch.
  const phase = useRef({
    drift: 0,
    wobble: [0, 0],
    hazeDrift: 0,
    hazeChurn: 0,
    last: now(),
    epoch: clockEpoch(),
  })

  useFrame(() => {
    const r = getResolvedSettings()
    const ph = phase.current
    const t = now()
    const epoch = clockEpoch()
    if (epoch !== ph.epoch) {
      ph.epoch = epoch
      ph.drift = ph.wobble[0] = ph.wobble[1] = 0
      ph.hazeDrift = ph.hazeChurn = 0
      ph.last = t
    }
    const dt = Math.min(Math.max(t - ph.last, 0), 0.1)
    ph.last = t

    ph.drift = (ph.drift + dt * r.hitLineDrift) % PHASE_WRAP
    const u = material.uniforms
    let lineHalf = 0
    for (let i = 0; i < 2; i++) {
      const K = hitLineKeysOf(LINE_IDS[i])
      ph.wobble[i] = (ph.wobble[i] + dt * r[K.wobbleSpeed]) % PHASE_WRAP
      const strength = r[K.enabled] ? r[K.line] : 0
      u.uLineA.value[i].set(r[K.lineWidth], strength, r[K.wobble], r[K.wobbleScale])
      u.uLineB.value[i].set(r[K.lineBlur], r[K.lineTangle], ph.drift, ph.wobble[i])
      if (strength > 0) {
        lineHalf = Math.max(
          lineHalf,
          r[K.wobble] * (1.6 + 0.7 * r[K.lineTangle]) + Math.hypot(r[K.lineWidth], r[K.lineBlur]) * 6,
        )
      }
    }
    // The haze drifts with the lines, a little faster (parallax).
    ph.hazeDrift = (ph.hazeDrift + dt * r.hitLineDrift * HAZE_DRIFT_RATIO) % PHASE_WRAP
    ph.hazeChurn = (ph.hazeChurn + dt * r.hitLineChurn) % PHASE_WRAP
    u.uHazePhase.value.set(ph.hazeDrift, ph.hazeChurn)

    const { gradient, hex } = hitLineColoring(r)
    writeGradientUniforms(u as unknown as GradientUniforms, gradient)
    u.uColor.value.set(hex)
    u.uIntensity.value = r.hitLineBrightness
    u.uWhiten.value = r.hitLineWhiten
    u.uGlow.value.set(r.hitLineGlow, r.hitLineGlowWidth)
    u.uHaze.value.set(r.hitLineHaze, r.hitLineHazeHeight, r.hitLineHazeContrast, r.hitLineHazeScale)

    // Half height: the tallest layer's reach, so nothing clips at the quad's top / bottom.
    const half =
      Math.max(
        r.hitLineHaze > 0 ? r.hitLineHazeHeight : 0,
        r.hitLineGlow > 0 ? r.hitLineGlowWidth * 6 : 0,
        lineHalf,
        0.03,
      ) * 1.1
    u.uPlane.value.set(PLANE_WIDTH, half * 2)
    const mesh = meshRef.current
    if (mesh) {
      mesh.position.y = NOTE_HIT_Y + r.hitLineY
      mesh.scale.y = half * 2
    }
  })

  if (!settings.hitLineEnabled) return null

  // z = 0.14: in front of the 3D black keys (top z ≈ 0.125), the falling notes (0.05) and the landing flashes. The
  // explicit renderOrder puts the line over the notes (2), under particles (2.5) and flashes (3), so a note
  // reaching the keys slides under it.
  return (
    <mesh
      ref={meshRef}
      position={[0, NOTE_HIT_Y, 0.14]}
      renderOrder={2.2}
      frustumCulled={false}
      raycast={() => null}
      onBeforeRender={(renderer) => {
        material.uniforms.uLinearTarget.value = isLinearTarget(renderer.getRenderTarget()) ? 1 : 0
      }}
    >
      <planeGeometry args={[PLANE_WIDTH, 1]} />
      <primitive object={material} attach="material" />
    </mesh>
  )
}

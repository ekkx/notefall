import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { getResolvedSettings } from '../scene/automatedSettings'
import { isLinearTarget } from '../scene/linearTarget'
import { KEYBOARD_LAYOUT, NOTE_HIT_Y } from '../keyboard/layout'
import { clockEpoch, now } from '../audio/clock'
import { NOTE_PLANE_Z } from './positions'
import { NOTE_GRADIENT_GLSL, createGradientUniforms, hitLineColoring, writeGradientUniforms } from './noteColor'

type GradientUniforms = ReturnType<typeof createGradientUniforms>
// Following the hit line: the specks are its colour lifted this far toward white (they read as white-hot points),
// the bokeh nearly its own colour.
const SPECK_FOLLOW_WHITEN = 0.7
const BOKEH_FOLLOW_WHITEN = 0

/**
 * Floating lights: tiny fireflies that rise from the top edge of the keyboard (and some that appear mid-air), plus
 * soft out-of-focus "bokeh" discs. Two instanced-quad meshes, both stateless on the GPU: the vertex shader derives
 * everything from the instance index, per-cycle hashes and ONE integrated time phase (a rate, so it is integrated
 * on the CPU, wrapped, and reset when `clockEpoch()` changes, like HitLine's). No per-particle CPU work, so the
 * offline export, which steps the same useFrame on the virtual clock, draws exactly the live view.
 *
 * Each particle lives in cycles of a fixed per-particle length; every cycle re-rolls its place, rise distance,
 * speed, depth, … by hashing (index, cycle). Distances are in units of the visible note area's height, so the look
 * follows the framing (lens window, shape, follow). Sizes are shares of the picture's height, so they stay the same
 * at any export resolution. Drawn behind the notes (renderOrder 1.8), additive, never below the hit line.
 */

const MAX_SPECKS = 1600
const BASE_SPECKS = 780
// Bokeh balls at amount 1, and the most the buffer holds.
const BOKEH_COUNT = 40
const MAX_BOKEH = 120
// Share of the fireflies that appear mid-air instead of at the keyboard, and the depth-of-field strength of the
// bokeh (larger / dimmer / softer away from the focus depth): fixed looks, not settings.
const MID_SPAWN = 0.3
const BOKEH_BLUR = 1
// Float32 keeps ~ms precision at this phase; a wrap re-rolls the cycles once, hours apart.
const PHASE_WRAP = 32768
/** The specks' z: just behind the note plane. */
const LIGHT_Z = NOTE_PLANE_Z - 0.02
const WIDTH_MARGIN = 0.6

const VERTEX_SHADER = /* glsl */ `
  attribute float aId;
  uniform float uKind;       // 0 = specks, 1 = bokeh
  uniform float uTime;
  uniform float uHitY;
  uniform float uVisH;       // world height of the note area (hit line to the picture's top)
  uniform float uFullH;      // world height of the whole picture at the light plane
  uniform float uWidth;
  uniform float uBright;
  uniform float uSize;
  uniform float uTwinkle;
  uniform float uMid;
  uniform float uHeight;
  uniform float uBlur;
  // Colour: the hit line's (solid or its gradient at this x) when following, else uColor; lifted by uWhiten.
  uniform float uFollow;
  uniform vec3 uLineColor;
  uniform vec3 uColor;
  uniform float uWhiten;
  ${NOTE_GRADIENT_GLSL}
  varying vec3 vColor;
  varying vec2 vQ;
  varying float vAlpha;
  varying float vSoft;
  varying float vWorldY;
  varying float vTint;
  varying float vKind;

  float h11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
  }

  void main() {
    // Per-particle constants.
    float s0 = fract(aId * 0.7548777) * 100.0 + aId * 0.013;
    float period = uKind < 0.5 ? mix(6.0, 14.0, h11(s0 + 3.1)) : mix(5.0, 9.0, h11(s0 + 3.1));
    float t = uTime + h11(s0 + 9.7) * period * 7.0;
    float cyc = floor(t / period);
    float s = t - cyc * period;            // seconds into this cycle
    float c0 = s0 + mod(cyc, 2048.0) * 3.7;

    float rx = h11(c0 + 1.3);
    float rd = h11(c0 + 5.9);
    float rv = h11(c0 + 11.3);
    float rm = h11(c0 + 17.1);
    float rh = h11(c0 + 23.9);
    float rb = h11(c0 + 29.3);
    float rp = h11(c0 + 37.7);
    float rw = h11(c0 + 41.9);

    float x = (rx - 0.5) * uWidth;
    float yn;     // height above the hit line, in note-area heights
    float env;
    float diam;   // world
    float soft = 0.0;
    float alpha;
    float tint = rb;

    if (uKind < 0.5) {
      // Fireflies.
      bool mid = rm < uMid;
      float expo = -log(1.0 - rd * 0.999);
      float dist = mid ? 0.03 + expo * 0.1 * uHeight : 0.04 + expo * 0.21 * uHeight;
      float v = 0.063 * exp2(2.0 * (rv - 0.5));
      float life = min(dist / v, period * 0.98);
      float h0 = mid ? rh * 0.9 * min(uHeight, 1.5) : 0.0;
      yn = h0 + v * s;
      float fi = mid ? 0.9 : 0.15;
      float fo = min(1.2, life * 0.45);
      env = smoothstep(0.0, fi, s) * (1.0 - smoothstep(life - fo, life, s)) * step(s, life);
      env *= 1.0 - smoothstep(0.88, 1.0, yn);
      // Gentle pulse, its own rate and phase per cycle.
      float pulse = 0.5 + 0.5 * sin(uTime * mix(1.2, 3.4, rp) + rp * 40.0);
      env *= 1.0 - uTwinkle * 0.85 * pulse;
      alpha = uBright * env * mix(0.55, 1.0, rb);
      diam = 3.0 / 1080.0 * uFullH * uSize * mix(0.75, 1.3, rw);
      // Smooth sideways wander (about 8 px/s at 1080p).
      x += (sin(s * 0.7 + rw * 20.0) + 0.5 * sin(s * 1.7 + rp * 30.0)) * 0.012 * uFullH;
    } else {
      // Bokeh: a depth, defocus grows with the distance from the focus depth.
      float depth = rd;
      float defocus = clamp(abs(depth - 0.3) * 1.7 * uBlur, 0.0, 1.0);
      float v = 0.034 * exp2(1.4 * (rv - 0.5)) * (1.0 - 0.6 * depth);
      yn = rh * 0.95 + v * s;
      env = smoothstep(0.0, 0.3 * period, s) * (1.0 - smoothstep(0.7 * period, period, s));
      env *= 1.0 - smoothstep(0.88, 1.0, yn);
      diam = (9.0 + 26.0 * defocus) / 1080.0 * uFullH * uSize;
      soft = 0.1 + 0.55 * defocus;
      alpha = uBright * env * mix(1.0, 0.4, defocus) * mix(0.8, 1.0, rb);
      tint = rp;
    }

    float y = uHitY + yn * uVisH;
    float hs = diam * (uKind < 0.5 ? 2.0 : 0.5);
    vec2 q = position.xy * 2.0;   // -1..1
    vec3 world = vec3(x, y, ${LIGHT_Z.toFixed(3)}) + vec3(position.xy * 2.0 * hs, 0.0);
    // Composed in display (sRGB) values: uColor / uLineColor are uploaded sRGB-encoded, gradientAt gives linear.
    vec3 own = uFollow > 0.5 ? (uGradient > 0.5 ? pow(gradientAt(vec2(x, uGradArea.y)), vec3(1.0 / 2.2)) : uLineColor) : uColor;
    vColor = mix(own, vec3(1.0), uWhiten);
    vQ = q;
    vAlpha = alpha;
    vSoft = soft;
    vWorldY = world.y;
    vTint = tint;
    vKind = uKind;
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`

const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  uniform float uHitY;
  uniform float uLinearTarget;
  varying vec3 vColor;
  varying vec2 vQ;
  varying float vAlpha;
  varying float vSoft;
  varying float vWorldY;
  varying float vTint;
  varying float vKind;

  void main() {
    if (vAlpha < 0.003 || vWorldY < uHitY) discard;
    float r = length(vQ);
    if (r > 1.0) discard;
    float a;
    vec3 base = vColor;
    if (vKind < 0.5) {
      // Sharp core plus a faint halo; the quad is 4 core diameters wide.
      float d = r * 2.0;
      a = exp(-d * d * 4.0) + 0.12 * exp(-d * 1.6);
      a *= 1.0 - smoothstep(0.7, 1.0, r);
      base = mix(vColor, vColor * vec3(0.78, 1.0, 1.0), vTint);
    } else {
      // A flat disc with a soft edge and a slightly brighter rim, like an out-of-focus highlight.
      float edge = 1.0 - smoothstep(1.0 - max(vSoft, 0.04), 1.0, r);
      float rim = 1.0 + 0.3 * smoothstep(0.55, 1.0 - vSoft * 0.5, r) * (1.0 - vSoft);
      a = edge * rim;
      base = mix(vColor * vec3(0.92, 1.0, 1.0), vColor * vec3(1.05, 1.0, 0.95), vTint);
    }
    vec3 col = base * (a * vAlpha);
    gl_FragColor = vec4(uLinearTarget > 0.5 ? pow(col, vec3(2.2)) : col, 1.0);
  }
`

function makeGeometry(count: number): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry()
  const plane = new THREE.PlaneGeometry(1, 1)
  g.index = plane.index
  g.setAttribute('position', plane.getAttribute('position'))
  const ids = new Float32Array(count)
  for (let i = 0; i < count; i++) ids[i] = i
  g.setAttribute('aId', new THREE.InstancedBufferAttribute(ids, 1))
  g.instanceCount = 0
  return g
}

function makeMaterial(kind: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uKind: { value: kind },
      uTime: { value: 0 },
      uHitY: { value: NOTE_HIT_Y },
      uVisH: { value: 5 },
      uFullH: { value: 7 },
      uWidth: { value: KEYBOARD_LAYOUT.totalWidth + WIDTH_MARGIN },
      uBright: { value: 1 },
      uSize: { value: 1 },
      uTwinkle: { value: 0.5 },
      uMid: { value: 0.3 },
      uHeight: { value: 1 },
      uBlur: { value: 1 },
      uColor: { value: new THREE.Color('#ffffff') },
      uLineColor: { value: new THREE.Color('#ffffff') },
      uFollow: { value: 1 },
      uWhiten: { value: 0 },
      ...createGradientUniforms(NOTE_HIT_Y),
      uLinearTarget: { value: 0 },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneFactor,
    toneMapped: false,
  })
}

const tmpV = new THREE.Vector3()
const tmpDir = new THREE.Vector3()

/** World y of the picture's NDC height `ndcY` on the light plane (x = 0). */
function planeY(camera: THREE.Camera, ndcY: number): number {
  tmpV.set(0, ndcY, 0.5).unproject(camera)
  tmpDir.copy(tmpV).sub(camera.position)
  const k = Math.abs(tmpDir.z) < 1e-6 ? 1 : (LIGHT_Z - camera.position.z) / tmpDir.z
  return camera.position.y + tmpDir.y * k
}

export function FloatingLights() {
  const parts = useMemo(() => {
    const specksGeo = makeGeometry(MAX_SPECKS)
    const bokehGeo = makeGeometry(MAX_BOKEH)
    const specksMat = makeMaterial(0)
    const bokehMat = makeMaterial(1)
    const make = (geo: THREE.BufferGeometry, mat: THREE.ShaderMaterial, order: number) => {
      const m = new THREE.Mesh(geo, mat)
      m.renderOrder = order
      m.frustumCulled = false
      m.raycast = () => {}
      m.onBeforeRender = (renderer) => {
        mat.uniforms.uLinearTarget.value = isLinearTarget(renderer.getRenderTarget()) ? 1 : 0
      }
      return m
    }
    return {
      specksGeo, bokehGeo, specksMat, bokehMat,
      specks: make(specksGeo, specksMat, 1.8),
      bokeh: make(bokehGeo, bokehMat, 1.79),
    }
  }, [])
  useEffect(
    () => () => {
      parts.specksGeo.dispose()
      parts.bokehGeo.dispose()
      parts.specksMat.dispose()
      parts.bokehMat.dispose()
    },
    [parts],
  )

  const phase = useRef({ t: 0, last: now(), epoch: clockEpoch() })

  useFrame(({ camera }) => {
    const r = getResolvedSettings()
    const ph = phase.current
    const t = now()
    const epoch = clockEpoch()
    if (epoch !== ph.epoch) {
      ph.epoch = epoch
      ph.t = 0
      ph.last = t
    }
    const dt = Math.min(Math.max(t - ph.last, 0), 0.1)
    ph.last = t
    ph.t = (ph.t + dt * r.floatLightsSpeed) % PHASE_WRAP

    camera.updateMatrixWorld()
    const top = planeY(camera, 1)
    const bottom = planeY(camera, -1)
    const visH = Math.max(0.5, top - NOTE_HIT_Y)
    const fullH = Math.max(0.5, top - bottom)

    const { specksMat: sm, bokehMat: bm, specksGeo, bokehGeo, specks, bokeh } = parts
    for (const m of [sm, bm]) {
      const u = m.uniforms
      u.uTime.value = ph.t
      u.uVisH.value = visH
      u.uFullH.value = fullH
    }
    const follow = r.floatLightsFollowLine
    const { gradient, hex } = hitLineColoring(r)
    for (const m of [sm, bm]) {
      const u = m.uniforms
      u.uFollow.value = follow ? 1 : 0
      if (follow) {
        writeGradientUniforms(u as unknown as GradientUniforms, gradient)
        u.uLineColor.value.set(hex).convertLinearToSRGB()
      }
    }
    const su = sm.uniforms
    su.uWhiten.value = follow ? SPECK_FOLLOW_WHITEN : 0
    su.uBright.value = r.floatLightsBrightness
    su.uSize.value = r.floatLightsSize
    su.uTwinkle.value = Math.min(1, Math.max(0, r.floatLightsTwinkle))
    su.uMid.value = MID_SPAWN
    su.uHeight.value = Math.max(0.05, r.floatLightsHeight)
    su.uColor.value.set(r.floatLightsColor).convertLinearToSRGB()
    const bu = bm.uniforms
    bu.uWhiten.value = follow ? BOKEH_FOLLOW_WHITEN : 0
    bu.uBright.value = r.floatLightsBokehBrightness * 0.45
    bu.uSize.value = r.floatLightsBokehSize
    bu.uBlur.value = BOKEH_BLUR
    bu.uColor.value.set(r.floatLightsBokehColor).convertLinearToSRGB()

    specksGeo.instanceCount = Math.min(MAX_SPECKS, Math.round(BASE_SPECKS * Math.max(0, r.floatLightsAmount)))
    bokehGeo.instanceCount = Math.min(MAX_BOKEH, Math.round(BOKEH_COUNT * Math.max(0, r.floatLightsBokehAmount)))
    specks.visible = specksGeo.instanceCount > 0 && r.floatLightsBrightness > 0
    bokeh.visible = bokehGeo.instanceCount > 0 && r.floatLightsBokehBrightness > 0
  })

  return (
    <>
      <primitive object={parts.bokeh} />
      <primitive object={parts.specks} />
    </>
  )
}

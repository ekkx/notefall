import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { getResolvedSettings } from '../scene/automatedSettings'
import { isLinearTarget } from '../scene/linearTarget'
import { NOTE_HIT_Y } from '../keyboard/layout'
import { NOTE_PLANE_Z } from './positions'

/**
 * Light rays from the falling notes (screen-space radial light scattering).
 *
 * Each frame, before the main render: the notes alone (the note mesh sits on `NOTE_RAYS_LAYER` as well as 0, the
 * camera is narrowed to that layer for one draw) go into a small target; three radial-blur passes, each pulling a
 * few taps toward a centre point, ping-pong between two targets and smear every note's light away from the
 * centre (long beams for few taps); a screen-aligned quad drawn in the scene at renderOrder 1.9 (over the hand
 * video 1.5 / keyboard, under the notes 2) adds the result. It lives in the scene, so it is the same with Bloom on
 * and off and in the offline export (`advance()` runs the same useFrame, the targets follow the drawing buffer).
 * Mounted only while `noteRaysEnabled`; nothing is allocated per frame.
 */
export const NOTE_RAYS_LAYER = 3

/** The pass targets are this share of the drawing buffer. */
const SCALE = 0.25
const TAPS = 12
/** Each pass reaches this many times further than the previous one (TAPS taps cover a little more than that). */
const PASS_RATIO = 8
/** Beam fade rate (per screen height of distance from the note) is FADE / (FADE_BASE + reach slider). */
const FADE = 3.3
const FADE_BASE = 0.2
/** Distance toward the centre (screen heights) at which the compensation in the composite is 1. */
const REF_SPAN = 0.12
const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

const BLUR_FRAG = /* glsl */ `
uniform sampler2D uTex;
uniform vec2 uCenter;
uniform float uStep;
uniform float uRate;
uniform float uAspect;
uniform float uSeed;
varying vec2 vUv;
// Interleaved gradient noise: a fixed per-pixel pattern (no time input, so live and export match).
float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}
void main() {
  vec2 d = (uCenter - vUv) * uStep;
  // Weights fall with the real distance from the note (screen heights), not with the tap index: a pixel near
  // the centre, whose taps all lie in a short span, would otherwise keep nearly full brightness.
  float k = uRate * length((uCenter - vUv) * vec2(uAspect, 1.0)) * uStep;
  // Jitter the start of the taps so the repeated copies of a long note become fine noise, not steps.
  vec2 start = vUv + d * (ign(gl_FragCoord.xy + uSeed) - 0.5);
  vec3 sum = vec3(0.0);
  float w = 1.0;
  for (int i = 0; i < ${TAPS}; i++) {
    sum += min(texture2D(uTex, start + d * float(i)).rgb, vec3(1.0)) * w;
    w = exp(-k * float(i + 1));
  }
  gl_FragColor = vec4(sum / float(${TAPS}), 1.0);
}
`

// Colour: the targets hold linear colour (the notes draw into them as into the composer's buffer); the canvas wants
// sRGB-encoded values, the composer's buffer linear ones (uLinearTarget, set per draw like the notes' / particles').
const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D uTex;
uniform float uGain;
uniform vec2 uCenter;
uniform float uAspect;
uniform float uSpan;
uniform float uHitUv;
uniform float uLinearTarget;
varying vec2 vUv;
vec3 toSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
void main() {
  // The blur averages over a span proportional to the distance from the centre, so its result falls as 1/distance;
  // scaling by that span makes a beam's brightness depend on the light it crosses, not on where the centre is.
  float comp = min(length((uCenter - vUv) * vec2(uAspect, 1.0)) * uSpan / ${REF_SPAN.toFixed(3)}, 6.0);
  vec3 c = texture2D(uTex, vUv).rgb * uGain * comp * smoothstep(uHitUv, uHitUv + 0.004, vUv.y);
  gl_FragColor = vec4(uLinearTarget > 0.5 ? c : toSrgb(c), 1.0);
}
`

/** Brightness of the composite for intensity 1 (the blur averages, so a thin note's beam is faint). */
const GAIN = 1.0

const tmpV = new THREE.Vector3()
const tmpColor = new THREE.Color()
const tmpSize = new THREE.Vector2()

export function NoteRays() {
  const parts = useMemo(() => {
    const makeRt = () =>
      new THREE.WebGLRenderTarget(8, 8, {
        type: THREE.HalfFloatType,
        depthBuffer: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      })
    const rtA = makeRt()
    const rtB = makeRt()
    const blur = new THREE.ShaderMaterial({
      uniforms: {
        uTex: { value: null },
        uCenter: { value: new THREE.Vector2(0.5, 0.5) },
        uStep: { value: 0 },
        uRate: { value: 0 },
        uAspect: { value: 1 },
        uSeed: { value: 0 },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: BLUR_FRAG,
      depthTest: false,
      depthWrite: false,
    })
    const quadGeo = new THREE.PlaneGeometry(2, 2)
    const quad = new THREE.Mesh(quadGeo, blur)
    quad.frustumCulled = false
    const quadScene = new THREE.Scene()
    quadScene.add(quad)
    const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    const composite = new THREE.ShaderMaterial({
      uniforms: {
        uTex: { value: rtB.texture },
        uGain: { value: 0 },
        uCenter: { value: new THREE.Vector2(0.5, 0.5) },
        uAspect: { value: 1 },
        uSpan: { value: 0.4 },
        uHitUv: { value: 0 },
        uLinearTarget: { value: 0 },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: COMPOSITE_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    })
    return { rtA, rtB, blur, quadGeo, quad, quadScene, quadCam, composite }
  }, [])
  useEffect(
    () => () => {
      parts.rtA.dispose()
      parts.rtB.dispose()
      parts.blur.dispose()
      parts.quadGeo.dispose()
      parts.composite.dispose()
    },
    [parts],
  )

  const mesh = useMemo(() => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), parts.composite)
    m.renderOrder = 1.9
    m.frustumCulled = false
    m.raycast = () => {}
    m.visible = false
    m.onBeforeRender = (renderer) => {
      parts.composite.uniforms.uLinearTarget.value = isLinearTarget(renderer.getRenderTarget()) ? 1 : 0
    }
    return m
  }, [parts])
  useEffect(() => () => mesh.geometry.dispose(), [mesh])

  useFrame(({ gl, scene, camera }) => {
    const s = getResolvedSettings()
    const gain = s.noteRaysIntensity * GAIN
    if (gain <= 0.001) {
      mesh.visible = false
      return
    }
    const { rtA, rtB, blur, quadScene, quadCam, composite } = parts

    // Size from the actual destination (the export resizes the drawing buffer).
    gl.getDrawingBufferSize(tmpSize)
    const w = Math.max(8, Math.round(tmpSize.x * SCALE))
    const h = Math.max(8, Math.round(tmpSize.y * SCALE))
    if (rtA.width !== w || rtA.height !== h) {
      rtA.setSize(w, h)
      rtB.setSize(w, h)
    }

    // Where the visible note area is: the hit line's screen height under the current lens window, up to the top.
    camera.updateMatrixWorld()
    tmpV.set(0, NOTE_HIT_Y, NOTE_PLANE_Z).project(camera)
    const hitNdc = Math.min(1, Math.max(-1, tmpV.y))
    const hitUv = hitNdc * 0.5 + 0.5
    const cx = Math.min(1, Math.max(0, s.noteRaysCenterX))
    const cy = hitUv + (1 - hitUv) * Math.min(1, Math.max(0, s.noteRaysCenterY))

    // 1. the notes alone, on black.
    const prevTarget = gl.getRenderTarget()
    const prevAutoClear = gl.autoClear
    const prevBackground = scene.background
    const prevMask = camera.layers.mask
    gl.getClearColor(tmpColor)
    const prevAlpha = gl.getClearAlpha()
    scene.background = null
    gl.setClearColor(0x000000, 0)
    gl.autoClear = true
    camera.layers.set(NOTE_RAYS_LAYER)
    gl.setRenderTarget(rtA)
    gl.render(scene, camera)
    camera.layers.mask = prevMask
    scene.background = prevBackground

    // 2. three radial passes, A → B → A → B.
    const len = Math.min(1, Math.max(0, s.noteRaysLength))
    const reach = 0.25 + 0.75 * len
    const aspect = w / h
    const lastStep = reach / (TAPS - 1)
    ;(blur.uniforms.uCenter.value as THREE.Vector2).set(cx, cy)
    blur.uniforms.uAspect.value = aspect
    blur.uniforms.uRate.value = FADE / (FADE_BASE + len)
    const src = [rtA, rtB, rtA]
    const dst = [rtB, rtA, rtB]
    for (let i = 0; i < 3; i++) {
      blur.uniforms.uTex.value = src[i].texture
      blur.uniforms.uSeed.value = i * 37.0
      blur.uniforms.uStep.value = lastStep / Math.pow(PASS_RATIO, 2 - i)
      gl.setRenderTarget(dst[i])
      gl.render(quadScene, quadCam)
    }
    gl.setRenderTarget(prevTarget)
    gl.autoClear = prevAutoClear
    gl.setClearColor(tmpColor, prevAlpha)

    // 3. the layer the main render draws under the notes.
    ;(composite.uniforms.uCenter.value as THREE.Vector2).set(cx, cy)
    composite.uniforms.uAspect.value = aspect
    composite.uniforms.uSpan.value = reach
    composite.uniforms.uGain.value = gain
    composite.uniforms.uHitUv.value = hitUv
    mesh.visible = true
  })

  return <primitive object={mesh} />
}

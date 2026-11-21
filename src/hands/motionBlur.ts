// Temporal supersampling for the hands. The static scene (everything but the hands: keys, notes, labels, shadow map) is
// rendered ONCE per frame at time t together with its depth; the hands are then rendered N times (hand poses evaluated
// at sub-times spread over a trailing shutter window) against a copy of that depth, and accumulated as premultiplied
// colour + coverage. Result = sum(hand)/N + (1 - sum(coverage)/N) * base. Pure in t (no dependence on the real frame
// delta), so a frame-stepped exporter gets identical pixels. Everything is linear half-float and goes to the screen
// through the renderer's output colour-space conversion (alpha-blended layers such as the note labels blend in linear
// space here vs encoded space on screen: a slight look difference). With no motion in the window the caller renders
// straight to the screen (bit-identical to blur off).
import * as THREE from 'three'
import { Pass } from 'postprocessing'
import type { HandPoses, Vec3 } from './types'

// Port of `_local/hand-lab/src/motionBlur.ts`. App integration: `Hands.tsx` decides per frame (`plan`) whether this frame
// is blurred; the composer path runs `HandsBlurPass` (replacing the composer's RenderPass for that frame, output goes into
// its input buffer so Bloom sees the blurred hands exactly like the unblurred ones), the Bloom-off path renders to the
// canvas from `PlainBlurRender`. Frames with no motion take the untouched default render.

/** Share of one nominal frame the virtual shutter stays open (trailing: sample 0 is the frame time itself). */
export const BLUR_SHUTTER = 0.5
/** Preview nominal frame (display refresh is not measured: the picture must be a pure function of song time). */
export const PREVIEW_FRAME_SECONDS = 1 / 60
/** Screen px of joint travel per sample, and the travel below which the frame is rendered plain. */
export const BLUR_PX_STEP = 3
export const BLUR_MIN_PX = 0.4

/** What `Hands.tsx` decided for the frame about to be rendered; consumed by the pass / plain renderer. */
export type BlurPlan = {
  count: number
  /** hand pixel rectangles for a destination of this size (the composer's buffers keep the PREVIEW size during an export) */
  rectsFor: (width: number, height: number) => PxRect[]
  handsRoot: THREE.Object3D
  /** poses the hands for sub-render i (called once per sample, in order) */
  drawAt: (i: number) => void
}
export const blurBridge: {
  plan: BlurPlan | null
  /** The composer's own scene pass; disabled on frames the blur pass renders the scene itself. */
  renderPass: { enabled: boolean } | null
  /** The blur pass itself (enabled exactly on blurred frames). */
  pass: { enabled: boolean } | null
  /** Number of mounted consumers (pass / plain renderer) that will honour `plan`; a count because they swap in separate commits. */
  consumers: number
} = { plan: null, renderPass: null, pass: null, consumers: 0 }

/** Song-time offsets (<= 0) of the sub-renders; sample 0 is the frame time itself. */
export function blurOffsets(samples: number, shutter: number, frameDt: number): number[] {
  const n = Math.max(1, Math.round(samples))
  return Array.from({ length: n }, (_, i) => -(shutter * frameDt * i) / n)
}

/** Largest joint displacement (world units) between two poses of the same frame set. */
export function maxJointShift(a: HandPoses, b: HandPoses): number {
  let m = 0
  const d = (p: Vec3, q: Vec3) => { m = Math.max(m, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])) }
  for (const h of ['L', 'R'] as const) {
    const p = a[h], q = b[h]
    if (!p || !q) { if (p !== q) m = Infinity; continue }
    d(p.elbow, q.elbow); d(p.wrist, q.wrist)
    p.bases.forEach((v, i) => d(v, q.bases[i]))
    p.fingers.forEach((f, i) => f.forEach((v, j) => d(v, q.fingers[i][j])))
  }
  return m
}

export type PxRect = { x: number; y: number; w: number; h: number }

/**
 * Drawing-buffer pixel rectangles (origin bottom-left) covering every joint of the given poses, one per hand (merged
 * into one when they overlap, so no pixel is accumulated twice), padded by `padWu`.
 */
export function handBounds(poses: HandPoses[], camera: THREE.PerspectiveCamera, width: number, height: number, padWu: number): PxRect[] {
  const v = new THREE.Vector3()
  const pad = Math.ceil(padWu * height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * camera.position.length()) + 4)
  const rects: PxRect[] = []
  for (const h of ['L', 'R'] as const) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    const add = (p: Vec3) => {
      v.set(p[0], p[1], p[2]).project(camera)
      const x = (v.x * 0.5 + 0.5) * width, y = (v.y * 0.5 + 0.5) * height
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y)
    }
    for (const ps of poses) {
      const p = ps[h]
      if (!p) continue
      add(p.elbow); add(p.wrist)
      p.bases.forEach(add)
      p.fingers.forEach((f) => f.forEach(add))
    }
    if (x0 > x1) continue
    x0 = Math.max(0, Math.floor(x0 - pad)); y0 = Math.max(0, Math.floor(y0 - pad))
    x1 = Math.min(width, Math.ceil(x1 + pad)); y1 = Math.min(height, Math.ceil(y1 + pad))
    rects.push({ x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) })
  }
  if (rects.length === 2) {
    const [a, b] = rects
    if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y)
      return [{ x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }]
    }
  }
  return rects.length ? rects : [{ x: 0, y: 0, w: 1, h: 1 }]
}

const MSAA = 4

export function createMotionBlur(renderer: THREE.WebGLRenderer) {
  const size = new THREE.Vector2()
  const mk = (depth: boolean, samples = 0) => {
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples, depthBuffer: true })
    // Colour space and the XR-target flag (whether three tone-maps into it) are set per render for the destination (see `render`).
    // The composite converts to the destination's colour space.
    rt.texture.colorSpace = THREE.LinearSRGBColorSpace
    if (depth) {
      rt.depthTexture = new THREE.DepthTexture(1, 1)
      rt.depthTexture.minFilter = rt.depthTexture.magFilter = THREE.NearestFilter
    }
    return rt
  }
  const base = mk(true, MSAA) // static scene + its depth
  const hand = mk(true, MSAA) // one hands sub-render (own depth, seeded from base's)
  const accum = mk(false)
  const vs = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }'
  const addMat = new THREE.ShaderMaterial({
    uniforms: { tex: { value: hand.texture }, w: { value: 1 } },
    vertexShader: vs,
    fragmentShader: 'uniform sampler2D tex; uniform float w; varying vec2 vUv; void main(){ gl_FragColor = texture2D(tex, vUv) * w; }',
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
    depthTest: false, depthWrite: false,
  })
  // Copies the base depth into the hand target's depth attachment (colour untouched).
  const depthMat = new THREE.ShaderMaterial({
    uniforms: { tex: { value: base.depthTexture } },
    vertexShader: vs,
    fragmentShader: 'uniform sampler2D tex; varying vec2 vUv; void main(){ gl_FragColor = vec4(0.); gl_FragDepth = texture2D(tex, vUv).r; }',
    colorWrite: false, depthTest: true, depthFunc: THREE.AlwaysDepth, depthWrite: true,
  })
  const outMat = new THREE.ShaderMaterial({
    uniforms: { baseTex: { value: base.texture }, handTex: { value: accum.texture }, rects: { value: [new THREE.Vector4(), new THREE.Vector4()] }, uEnc: { value: 0 } },
    vertexShader: vs,
    fragmentShader: 'uniform sampler2D baseTex; uniform sampler2D handTex; varying vec2 vUv; uniform vec4 rects[2]; uniform float uEnc; void main(){ vec4 h = texture2D(handTex, vUv); vec2 c = gl_FragCoord.xy; bool in0 = c.x >= rects[0].x && c.y >= rects[0].y && c.x < rects[0].x + rects[0].z && c.y < rects[0].y + rects[0].w; bool in1 = c.x >= rects[1].x && c.y >= rects[1].y && c.x < rects[1].x + rects[1].z && c.y < rects[1].y + rects[1].w; if (!in0 && !in1) h = vec4(0.); vec3 o = h.rgb + (1. - clamp(h.a, 0., 1.)) * texture2D(baseTex, vUv).rgb; if (uEnc > 0.5) o = mix(o / 12.92, pow((o + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), o)); gl_FragColor = vec4(o, 1.);\n#include <colorspace_fragment>\n}',
    depthTest: false, depthWrite: false,
  })
  const quad = new THREE.Mesh<THREE.PlaneGeometry, THREE.Material>(new THREE.PlaneGeometry(2, 2), addMat)
  quad.frustumCulled = false
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  const qs = new THREE.Scene()
  qs.add(quad)
  const clr = new THREE.Color()

  function fit(w: number, h: number) {
    size.set(w, h)
    if (base.width !== size.x || base.height !== size.y) { base.setSize(size.x, size.y); hand.setSize(size.x, size.y); accum.setSize(size.x, size.y) }
  }
  const drawQuad = (m: THREE.Material) => { quad.material = m; renderer.render(qs, quadCam) }
  return {
    /** `drawAt(i)` poses the hands for sub-render i (called once per sample, in order). `handsRoot` is everything that blurs. */
    render(scene: THREE.Scene, camera: THREE.Camera, handsRoot: THREE.Object3D, rectsFor: (w: number, h: number) => PxRect[], count: number, drawAt: (i: number) => void, dest: THREE.WebGLRenderTarget | null) {
      // Work at the destination's own resolution (canvas drawing buffer, or the composer's input buffer).
      if (dest) fit(dest.width, dest.height)
      else { renderer.getDrawingBufferSize(size); fit(size.x, size.y) }
      const rects = rectsFor(size.x, size.y)
      // Canvas destination (Bloom off): the targets hold sRGB-ENCODED colour, exactly what the canvas holds, so alpha-blended
      // layers (glows, particles, labels; they check `isLinearTarget`) blend as in the plain render and the path switch is
      // invisible. Composer destination (Bloom on): linear, as the composer's own buffer.
      const encoded = dest === null
      // Tone mapping as in the plain render of that destination: the canvas tone-maps `toneMapped` materials (so the targets pose as
      // XR targets, which three tone-maps), the composer's own scene render into its buffer does not (a plain target). Flagging them
      // for the composer too tone-mapped the blurred hands twice, so they went darker whenever the blur kicked in with Bloom on.
      for (const rt of [base, hand]) {
        ;(rt as unknown as { nfEncoded: boolean; isXRRenderTarget: boolean }).nfEncoded = encoded
        ;(rt as unknown as { isXRRenderTarget: boolean }).isXRRenderTarget = encoded
        rt.texture.colorSpace = encoded ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace
      }
      outMat.uniforms.uEnc.value = encoded ? 1 : 0
      const old = renderer.getRenderTarget()
      const oldAuto = renderer.autoClear
      const oldBg = scene.background
      const oldAlpha = renderer.getClearAlpha()
      renderer.getClearColor(clr)
      const oldClr = clr.getHex()

      // 1. Static scene + depth (hands hidden; the app has no hand shadows, so no shadow-map bookkeeping).
      handsRoot.visible = false
      renderer.autoClear = true
      renderer.setRenderTarget(base)
      renderer.render(scene, camera)
      handsRoot.visible = true
      // 2. Hands only, N times, against the base depth.
      const hidden: THREE.Object3D[] = []
      for (const c of scene.children) if (c !== handsRoot && !(c as THREE.Light).isLight && c.visible) { c.visible = false; hidden.push(c) }
      scene.background = null
      const ru = outMat.uniforms.rects.value as THREE.Vector4[]
      ru[0].set(0, 0, 0, 0); ru[1].set(0, 0, 0, 0)
      rects.forEach((r, k) => ru[k].set(r.x, r.y, r.w, r.h))
      // Quads (clear / depth seed / accumulate) are scissored to the hand rectangles; the hands themselves only
      // produce fragments inside them anyway.
      const scissored = (rt: THREE.WebGLRenderTarget, fn: () => void) => {
        rt.scissorTest = true
        for (const r of rects) { rt.scissor.set(r.x, r.y, r.w, r.h); renderer.setRenderTarget(rt); fn() } // three reads the scissor in setRenderTarget
        rt.scissorTest = false
      }
      renderer.setRenderTarget(accum)
      renderer.setClearColor(0x000000, 0)
      scissored(accum, () => renderer.clear())
      addMat.uniforms.w.value = 1 / count
      renderer.autoClear = false
      for (let i = 0; i < count; i++) {
        drawAt(i)
        renderer.setRenderTarget(hand)
        scissored(hand, () => { renderer.clear(true, false, false); drawQuad(depthMat) })
        renderer.setRenderTarget(hand) // rebind so the scissor test is off for the hands
        renderer.render(scene, camera)
        renderer.setRenderTarget(accum)
        scissored(accum, () => drawQuad(addMat))
      }
      for (const c of hidden) c.visible = true
      scene.background = oldBg
      renderer.setClearColor(oldClr, oldAlpha)
      renderer.autoClear = oldAuto
      // 3. Composite into `dest` (a composer buffer: linear; null = canvas: colorspace_fragment encodes).
      renderer.setRenderTarget(dest)
      drawQuad(outMat)
      renderer.setRenderTarget(old)
    },
  }
}

let shared: ReturnType<typeof createMotionBlur> | null = null
let sharedFor: THREE.WebGLRenderer | null = null
export function getMotionBlur(renderer: THREE.WebGLRenderer) {
  if (!shared || sharedFor !== renderer) { shared = createMotionBlur(renderer); sharedFor = renderer }
  return shared
}

/** Composer pass: renders the scene (hands motion-blurred) into the composer's input buffer. Enabled per frame by `Hands.tsx`. */
export class HandsBlurPass extends Pass {
  private blurScene: THREE.Scene
  private blurCamera: THREE.Camera
  constructor(scene: THREE.Scene, camera: THREE.Camera) {
    super('HandsBlurPass')
    this.blurScene = scene
    this.blurCamera = camera
    this.needsSwap = false
    this.enabled = false
  }
  render(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget) {
    const plan = blurBridge.plan
    if (!plan) return
    getMotionBlur(renderer).render(this.blurScene, this.blurCamera, plan.handsRoot, plan.rectsFor, plan.count, plan.drawAt, inputBuffer)
  }
}

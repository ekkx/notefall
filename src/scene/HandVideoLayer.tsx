import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useStore } from '../store'
import { KEYBOARD_Y, NOTE_HIT_Y, WHITE_KEY_WIDTH } from '../keyboard/layout'
import { audioEngine } from '../audio/engine'
import { useHandVideo } from '../video/handVideo'
import { FRAME_GLSL, HAND_VIDEO_PLANE_Z, worldToPictureAt } from '../video/geometry'
import { handVideoTimeAt } from '../video/time'
import { syncHandVideo } from '../video/sync'
import { setupOpacity } from '../video/setup'
import { bloomSource } from './bloomSource'
import { handVideoExportActive, handVideoExportRotation, handVideoExportTexture } from '../video/exportFrames'

// Bound while the live element holds no frame (a video being swapped: the old element is emptied before the new
// layer mounts, and three's VideoTexture re-uploads on every decoded frame regardless): uploading an empty
// <video> makes WebGL warn "texImage2D: no video".
const NO_FRAME_TEXTURE = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1)
NO_FRAME_TEXTURE.needsUpdate = true

const vertexShader = /* glsl */ `
varying vec2 vPlane;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vPlane = world.xy;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`

// world → corrected picture (the placement's homography, `uH`) → picture (FRAME_GLSL: lens bend;
// the file's quarter turns for export frames) → colour. Everything above the hit line is
// dropped so the notes keep their lane (not while fixing the placement by hand); below the
// keys the video can fade out toward the player's arms.
const WK = WHITE_KEY_WIDTH.toFixed(6)
const KY = KEYBOARD_Y.toFixed(6)
const fragmentShader = /* glsl */ `
uniform sampler2D uTex;
uniform mat3 uH;
uniform float uClipY;
uniform float uOpacity;
// 1 while the bloom source is drawn (scene/bloomSource.tsx): the footage is plain black there, so it never blooms.
uniform float uBloomMask;
uniform float uBrightness;
uniform float uContrast;
uniform float uSaturation;
uniform float uFadeTop;
uniform float uFadeLength;
// 1: the texture samples sRGB-encoded values (three uploads a VideoTexture
// without hardware sRGB decode and leaves decoding to its own materials);
// 0: it samples linear values (the export's VideoFrame texture).
uniform int uSrgbSample;
// Display range on the keyboard plane (white-key widths: x from A0's left edge, y down from the keys' front
// edge): uRange = (left, right, front); uRangeOn 0 = the whole video; uRangeDim 1 = the range editor
// (outside the range stays visible, dimmed, and the fade does not hide it).
uniform vec3 uRange;
uniform float uRangeOn;
uniform float uRangeSoft;
uniform float uRangeDim;
varying vec2 vPlane;
${FRAME_GLSL}

vec3 toSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
vec3 toLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

void main() {
  if (vPlane.y > uClipY) discard;
  vec3 q = uH * vec3(vPlane, 1.0);
  if (q.z <= 1e-6) discard;
  vec2 f = q.xy / q.z;
  vec2 uv;
  if (!correctedToDisplay(f, uv)) discard;
  // Frames are uploaded with flipY, so v runs bottom → top.
  vec3 c = texture2D(uTex, vec2(uv.x, 1.0 - uv.y)).rgb;
  // Adjust in the file's own sRGB values so the sliders feel even, then
  // decode exactly: live and export land on the same linear colour.
  if (uSrgbSample == 0) c = toSrgb(c);
  c += uBrightness;
  c = (c - 0.5) * uContrast + 0.5;
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(luma), c, uSaturation);
  c = toLinear(clamp(c, 0.0, 1.0));
  float fadeF = 1.0;
  if (uFadeLength > 0.0) fadeF = 1.0 - smoothstep(0.0, 1.0, (uFadeTop - vPlane.y) / uFadeLength);
  float inside = 1.0;
  if (uRangeOn > 0.5) {
    vec2 pp = vec2(vPlane.x / ${WK} + 26.0, (vPlane.y - ${KY}) / ${WK});
    vec3 d = vec3(pp.x - uRange.x, uRange.y - pp.x, pp.y + uRange.z);
    inside = uRangeSoft > 1e-4
      ? smoothstep(0.0, uRangeSoft, d.x) * smoothstep(0.0, uRangeSoft, d.y) * smoothstep(0.0, uRangeSoft, d.z)
      : step(0.0, min(d.x, min(d.y, d.z)));
  }
  float a = uOpacity * fadeF * inside;
  if (uRangeDim > 0.5) a = uOpacity * mix(0.3, fadeF, inside);
  gl_FragColor = vec4(uBloomMask > 0.5 ? vec3(0.0) : c, a);
  #include <colorspace_fragment>
}
`

// Plane big enough to hold the whole placed frame from any sensible camera (also above the hit line while placing).
const PLANE_W = 60
const PLANE_BOTTOM = KEYBOARD_Y - 24
const PLANE_TOP = NOTE_HIT_Y + 24

/**
 * The hand video, laid on the keyboard plane. Drawn after the opaque
 * keyboard and before the notes / hit line / particles / flashes
 * (renderOrder 1.5, no depth), so the effects stay on top of the footage
 * and, with the virtual keyboard shown, the video lies over it. The
 * placement is in plane coordinates, so it moves with the keyboard
 * whatever the camera does.
 */
export function HandVideoLayer() {
  const element = useHandVideo((s) => s.element)
  const duration = useHandVideo((s) => s.duration)

  const liveTexture = useMemo(() => {
    if (!element) return null
    const tex = new THREE.VideoTexture(element)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.minFilter = THREE.LinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.generateMipmaps = false
    return tex
  }, [element])
  useEffect(() => () => liveTexture?.dispose(), [liveTexture])
  // three refreshes a VideoTexture only when a new frame is decoded while
  // playing (requestVideoFrameCallback); a paused element that was already
  // showing a frame, or one moved by a seek, needs an explicit upload.
  const shownTime = useRef(-1)

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uTex: { value: null },
          uH: { value: new THREE.Matrix3() },
          uBend: { value: 0 },
          uAspect: { value: 1 },
          uTurns: { value: 0 },
          uClipY: { value: NOTE_HIT_Y },
          uOpacity: { value: 1 },
          uBloomMask: { value: 0 },
          uBrightness: { value: 0 },
          uContrast: { value: 1 },
          uSaturation: { value: 1 },
          uFadeTop: { value: KEYBOARD_Y },
          uFadeLength: { value: 0 },
          uSrgbSample: { value: 1 },
          uRange: { value: new THREE.Vector3(0, 52, 0) },
          uRangeOn: { value: 0 },
          uRangeSoft: { value: 0 },
          uRangeDim: { value: 0 },
        },
        vertexShader,
        fragmentShader,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    [],
  )
  useEffect(() => {
    bloomSource.material = material
    return () => {
      if (bloomSource.material === material) bloomSource.material = null
      bloomSource.active = false
      material.dispose()
    }
  }, [material])

  // Stop the element when the layer goes away (switched off / removed).
  useEffect(() => () => element?.pause(), [element])

  useFrame(() => {
    const u = material.uniforms
    const s = useStore.getState().settings
    const editing = useHandVideo.getState().editing
    const exportTex = handVideoExportTexture()
    let noExportFrame = false
    if (exportTex) {
      u.uTex.value = exportTex
      u.uTurns.value = handVideoExportRotation()
      u.uSrgbSample.value = 0
    } else if (handVideoExportActive()) {
      // Never the live element in an export (it would show a stale picture). No export frame yet (the decoder is
      // still starting; the live loop runs meanwhile): draw nothing. renderVideo fails the render with an error if
      // a frame it is about to render has none (`assertHandVideoFrame`).
      u.uTex.value = NO_FRAME_TEXTURE
      u.uTurns.value = 0
      u.uSrgbSample.value = 0
      noExportFrame = true
    } else {
      u.uTex.value = element && element.readyState >= 2 ? liveTexture : NO_FRAME_TEXTURE
      u.uTurns.value = 0
      u.uSrgbSample.value = 1
      if (element) {
        syncHandVideo(element, duration, editing !== null)
        if (liveTexture && element.paused && !element.seeking && element.readyState >= 2 && element.currentTime !== shownTime.current) {
          shownTime.current = element.currentTime
          liveTexture.needsUpdate = true
        }
      }
    }
    if (!element) return

    const aspect = (element.videoWidth || 16) / (element.videoHeight || 9)
    // The placement in effect at the frame on screen.
    const videoTime =
      editing !== null && !exportTex
        ? element.currentTime
        : handVideoTimeAt(audioEngine.currentSongTime(), s, duration).time
    ;(u.uH.value as THREE.Matrix3).set(...worldToPictureAt(s.handVideoKeys, videoTime, aspect))
    u.uBend.value = s.handVideoBend
    u.uAspect.value = aspect

    const placing = editing === 'fix'
    u.uClipY.value = placing ? 1e6 : NOTE_HIT_Y
    // While the keys are still being found there is no placement worth showing yet (the picture would sit
    // keyboard-wide and unturned for a moment), so the video waits until the detection settles.
    const finding = !exportTex && useHandVideo.getState().detect.state === 'finding'
    u.uOpacity.value = finding || noExportFrame ? 0 : editing !== null && editing !== 'range' ? setupOpacity() : s.handVideoOpacity
    bloomSource.active = u.uOpacity.value > 0.001
    u.uBrightness.value = s.handVideoBrightness
    u.uContrast.value = s.handVideoContrast
    u.uSaturation.value = s.handVideoSaturation
    u.uFadeTop.value = KEYBOARD_Y - s.handVideoFadeStart
    const range = s.handVideoRange
    u.uRangeOn.value = range ? 1 : 0
    if (range) (u.uRange.value as THREE.Vector3).set(range.left, range.right, range.front)
    u.uRangeSoft.value = Math.max(0, s.handVideoRangeSoftness)
    u.uRangeDim.value = editing === 'range' && !exportTex ? 1 : 0
    u.uFadeLength.value = s.handVideoFade && !placing ? Math.max(0.01, s.handVideoFadeLength) : 0
  })

  if (!element) return null
  return (
    <mesh
      position={[0, (PLANE_BOTTOM + PLANE_TOP) / 2, HAND_VIDEO_PLANE_Z]}
      renderOrder={1.5}
      frustumCulled={false}
      raycast={() => null}
    >
      <planeGeometry args={[PLANE_W, PLANE_TOP - PLANE_BOTTOM]} />
      <primitive object={material} attach="material" />
    </mesh>
  )
}

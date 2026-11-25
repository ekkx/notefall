import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { useStore } from '../store'
import { getLensWindow } from './framing'
import { CAMERA_LIMITS, clamp } from './cameraLimits'

// True while the user is actively orbiting / panning / wheel-dollying.
// `CameraSync` reads this: during a gesture it must show the value the
// gesture is WRITING (the edit target — selected pin snapshot or base,
// same as the Inspector's `useEffectiveSetting`) instead of the
// playhead-time-resolved value, otherwise the per-frame resolver pulls
// the camera back to the interpolated state and the gesture can't move
// it. Never true during the headless export (no input), so export
// parity is untouched. Wheel has no "end" event → cleared on idle.
let cameraGestureActive = false
let wheelIdleTimer: number | null = null
export function isCameraGestureActive(): boolean {
  return cameraGestureActive
}

// Blender-style viewport navigation:
//   middle-drag           → orbit around cameraLookAt
//   Shift + middle-drag   → pan (translate pos + lookAt together)
//   Ctrl/Cmd + wheel      → dolly along the view axis
//
// State sink is `settings.cameraPos` / `settings.cameraLookAt`, the same
// keys the Inspector sliders write to — so manual numeric input and
// gestural manipulation stay in sync via `CameraSync`. Both paths clamp
// against the shared `CAMERA_LIMITS` so neither can drift the camera
// into a state the other can't represent.

const ORBIT_SENSITIVITY = 0.005 // rad per CSS pixel
const ZOOM_FACTOR = 0.0015 // multiplicative dolly per deltaY pixel
const LINE_PX = 16
const PAGE_PX = 800
// Keep φ off the poles — at exactly 0 / π the spherical → cartesian
// roundtrip loses θ and the camera snaps when the user nudges back.
const PHI_EPSILON = 0.01

const DEG = Math.PI / 180
// Spherical phi limits (φ from +Y axis) derived from the Vertical-deg
// limits in CAMERA_LIMITS. Vertical = 90 − phi·180/π, so the slider's
// max maps to the smallest phi and vice-versa.
const PHI_MIN = Math.max(PHI_EPSILON, (90 - CAMERA_LIMITS.verticalDeg.max) * DEG)
const PHI_MAX = Math.min(
  Math.PI - PHI_EPSILON,
  (90 - CAMERA_LIMITS.verticalDeg.min) * DEG,
)
const THETA_MIN = CAMERA_LIMITS.horizontalDeg.min * DEG
const THETA_MAX = CAMERA_LIMITS.horizontalDeg.max * DEG

export function CameraControls() {
  const gl = useThree((s) => s.gl)
  const size = useThree((s) => s.size)

  useEffect(() => {
    const el = gl.domElement
    let mode: 'orbit' | 'pan' | null = null
    let lastX = 0
    let lastY = 0
    let activePointerId: number | null = null

    // Apply a camera change. `cameraPos/LookAt/Fov` are ANIMATABLE, so
    // when a settings pin is the edit target `updateSettings` routes the
    // write into THAT pin's snapshot (not base) — exactly what the
    // Inspector edits. Visibility is handled by `CameraSync` (it shows
    // the edit target while `isCameraGestureActive()`), so this just
    // writes; it must NOT seek the playhead (that yanked the view to the
    // pin and fought the resolver).
    const commitCamera = (patch: {
      cameraPos: [number, number, number]
      cameraLookAt?: [number, number, number]
    }) => {
      useStore.getState().updateSettings(patch)
    }

    // Current camera state to base a gesture delta on. MUST read from
    // the same place `commitCamera` writes to: when a pin is the edit
    // target the writes land in that pin's snapshot, so reading `base`
    // (settings.cameraPos) would feed every move/notch the same stale
    // value — the gesture never accumulates and the camera barely
    // budges ("locked"). Mirrors the Inspector's `useEffectiveSetting`
    // / `updateSettings` routing: targeted pin snapshot, else base.
    const readEffectiveCamera = () => {
      const st = useStore.getState()
      const base = st.settings
      const kt = st.editingKeyframeTime
      let cp = base.cameraPos
      let cl = base.cameraLookAt
      let cf = base.cameraFov
      if (kt !== null) {
        const kf = base.settingsKeyframes.find(
          (p) => Math.abs(p.time - kt) < 1e-6,
        )
        if (kf) {
          cp = kf.settings.cameraPos ?? cp
          cl = kf.settings.cameraLookAt ?? cl
          cf = kf.settings.cameraFov ?? cf
        }
      }
      return {
        pos: new THREE.Vector3(...cp),
        target: new THREE.Vector3(...cl),
        fov: cf,
      }
    }

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 1) return
      // preventDefault on the pointerdown also suppresses Chrome/Firefox
      // middle-button autoscroll (the little compass cursor).
      e.preventDefault()
      mode = e.shiftKey ? 'pan' : 'orbit'
      cameraGestureActive = true
      lastX = e.clientX
      lastY = e.clientY
      activePointerId = e.pointerId
      try {
        el.setPointerCapture(e.pointerId)
      } catch {
        /* capture can fail if the pointer is already captured elsewhere */
      }
    }

    const onPointerMove = (e: PointerEvent) => {
      if (mode === null) return
      const dx = e.clientX - lastX
      const dy = e.clientY - lastY
      lastX = e.clientX
      lastY = e.clientY
      if (dx === 0 && dy === 0) return

      const { pos, target, fov } = readEffectiveCamera()

      if (mode === 'orbit') {
        const offset = pos.clone().sub(target)
        const sph = new THREE.Spherical().setFromVector3(offset)
        sph.theta = clamp(sph.theta - dx * ORBIT_SENSITIVITY, THETA_MIN, THETA_MAX)
        sph.phi = clamp(sph.phi - dy * ORBIT_SENSITIVITY, PHI_MIN, PHI_MAX)
        const newOffset = new THREE.Vector3().setFromSpherical(sph)
        const newPos = newOffset.add(target)
        commitCamera({
          cameraPos: [newPos.x, newPos.y, newPos.z],
        })
      } else {
        // Pan: shift both pos and target by the same world-space delta so
        // the framing stays put while the pivot moves with the view.
        const view = target.clone().sub(pos).normalize()
        const worldUp = new THREE.Vector3(0, 1, 0)
        const right = new THREE.Vector3().crossVectors(view, worldUp)
        if (right.lengthSq() < 1e-8) right.set(1, 0, 0)
        right.normalize()
        const camUp = new THREE.Vector3().crossVectors(right, view).normalize()
        // World units per CSS pixel at the target plane (perspective scale).
        const distance = pos.distanceTo(target)
        const fovRad = (fov * Math.PI) / 180
        const worldPerPx = (2 * Math.tan(fovRad / 2) * distance * getLensWindow().scale) / size.height
        const deltaWorld = right
          .multiplyScalar(-dx * worldPerPx)
          .add(camUp.multiplyScalar(dy * worldPerPx))
        // Clamp the *target* (= pivot) to the pivot ranges, then derive
        // the actual delta from the clamped result so the camera tracks
        // the pivot exactly even when one axis hits its bound.
        const rawTarget = target.clone().add(deltaWorld)
        const clampedTarget = new THREE.Vector3(
          clamp(rawTarget.x, CAMERA_LIMITS.pivotX.min, CAMERA_LIMITS.pivotX.max),
          clamp(rawTarget.y, CAMERA_LIMITS.pivotY.min, CAMERA_LIMITS.pivotY.max),
          clamp(rawTarget.z, CAMERA_LIMITS.pivotZ.min, CAMERA_LIMITS.pivotZ.max),
        )
        const realDelta = clampedTarget.clone().sub(target)
        const newPos = pos.clone().add(realDelta)
        commitCamera({
          cameraPos: [newPos.x, newPos.y, newPos.z],
          cameraLookAt: [clampedTarget.x, clampedTarget.y, clampedTarget.z],
        })
      }
    }

    const endGesture = (pointerId?: number) => {
      mode = null
      cameraGestureActive = false
      const id = pointerId ?? activePointerId
      activePointerId = null
      if (id !== null) {
        try {
          el.releasePointerCapture(id)
        } catch {
          /* already released */
        }
      }
    }
    const onPointerUp = (e: PointerEvent) => {
      if (mode === null) return
      if (e.button === 1 || e.pointerId === activePointerId) endGesture(e.pointerId)
    }
    const onPointerCancel = (e: PointerEvent) => endGesture(e.pointerId)
    const onBlur = () => endGesture()

    const onWheel = (e: WheelEvent) => {
      // Plain wheel is reserved for seek (see Viewport.tsx). Only the
      // Ctrl/Cmd-modified wheel maps to dolly.
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const unit = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? PAGE_PX : 1
      const dy = e.deltaY * unit
      if (dy === 0) return
      // Wheel emits no gesture-end event; hold the "active" flag and let
      // it lapse a short while after the last notch so `CameraSync`
      // shows the edit target throughout a continuous scroll, then hands
      // back to the time-resolved path.
      cameraGestureActive = true
      if (wheelIdleTimer !== null) clearTimeout(wheelIdleTimer)
      wheelIdleTimer = window.setTimeout(() => {
        cameraGestureActive = false
        wheelIdleTimer = null
      }, 200)
      const { pos, target } = readEffectiveCamera()
      const offset = pos.clone().sub(target)
      const distance = offset.length()
      // Multiplicative dolly: same number of pixels scrolled produces the
      // same ratio change in distance, no matter how far we currently are.
      // Bail when distance has collapsed to zero — the offset has no
      // direction to scale and the user must escape via the Inspector.
      if (distance < 1e-6) return
      const scale = Math.exp(dy * ZOOM_FACTOR)
      const next = clamp(
        distance * scale,
        CAMERA_LIMITS.distance.min,
        CAMERA_LIMITS.distance.max,
      )
      offset.setLength(next)
      const newPos = target.clone().add(offset)
      commitCamera({
        cameraPos: [newPos.x, newPos.y, newPos.z],
      })
    }

    // Some browsers fire `auxclick` on middle-button release and would
    // otherwise trigger "open in new tab" on anchors / paste on Linux.
    const onAuxClick = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault()
    }

    el.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerCancel)
    window.addEventListener('blur', onBlur)
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('auxclick', onAuxClick)
    return () => {
      el.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerCancel)
      window.removeEventListener('blur', onBlur)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('auxclick', onAuxClick)
      if (wheelIdleTimer !== null) {
        clearTimeout(wheelIdleTimer)
        wheelIdleTimer = null
      }
      cameraGestureActive = false
    }
  }, [gl, size])

  return null
}

import { useFrame, useThree } from '@react-three/fiber'
import { EffectComposerContext } from '@react-three/postprocessing'
import { useContext, useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { audioEngine } from '../audio/engine'
import { getResolvedSettings } from '../scene/automatedSettings'
import { buildSpeedMap } from '../midi/speedMap'
import { useSettingsSlice, useStore } from '../store'
import { createMeshHands } from './meshHand'
import { retainHandsRuntime, songHandNotes, synthHandMotion, trackHandsWork, type ReadyMotion } from './motion'
import { getExportFps } from '../scene/exportBridge'
import {
  BLUR_MIN_PX, BLUR_PX_STEP, BLUR_SHUTTER, HandsBlurPass, PREVIEW_FRAME_SECONDS, blurBridge, blurOffsets, getMotionBlur, handBounds,
  maxJointShift,
} from './motionBlur'
import type { HandPoses } from './types'

// Virtual piano hands (beta). The motion comes from the hand runtime (motion.ts) and is remade (debounced, in its Worker)
// when the song or the timeline mapping changes; until the new one is ready the previous one keeps playing (edits), or
// no hands show (another song). Poses come from `poseAt(motion, audioEngine.currentSongTime())` — the same clock
// FallingNotes uses, routed through `audio/clock.ts` — so the offline exporter's frame-stepped render draws the same
// hands as the live preview (it waits for `handsSettled()` first).

const HAND_KEYS = [
  'handsBrightness',
  'handsFlashLight',
  'handsMotionBlur',
  'handsBlurSamples',
  'bloomEnabled',
  'midiOffsetSec',
  'midiSpeedAutomation',
  'midiTrimStartSec',
  'midiTrimEndSec',
  'transpose',
] as const

/** Edits / clip drags change the inputs many times per second; rebuild once they settle. */
const REBUILD_DEBOUNCE_MS = 150

const SIZE = new THREE.Vector2()

function resetBlurFrame() {
  blurBridge.plan = null
  if (blurBridge.renderPass) blurBridge.renderPass.enabled = true
  if (blurBridge.pass) blurBridge.pass.enabled = false
}

export function Hands() {
  const s = useSettingsSlice(HAND_KEYS)
  const song = useStore((st) => st.song)
  const invalidate = useThree((st) => st.invalidate)
  const gl = useThree((st) => st.gl)
  const camera = useThree((st) => st.camera)
  const group = useMemo(() => {
    const g = new THREE.Group()
    g.name = 'hands'
    return g
  }, [])
  const meshRef = useRef<ReturnType<typeof createMeshHands> | null>(null)
  const motionRef = useRef<(ReadyMotion & { song: string }) | null>(null)

  useEffect(() => retainHandsRuntime(), [])

  useEffect(() => {
    const mesh = createMeshHands(group)
    meshRef.current = mesh
    trackHandsWork(mesh.loaded)
    // Hands must never take part in picking (editor clicks / key presses go through them).
    mesh.loaded.then(() => group.traverse((o) => { o.raycast = () => {} })).catch(() => {})
    return () => {
      meshRef.current = null
      mesh.dispose()
    }
  }, [group])

  const speedMap = useMemo(() => buildSpeedMap(s.midiSpeedAutomation), [s.midiSpeedAutomation])
  useEffect(() => {
    if (!song) {
      motionRef.current = null
      return
    }
    // Edits keep the song's name: the previous motion plays on until the new one is ready. Another song: no hands meanwhile.
    if (motionRef.current && motionRef.current.song !== song.name) motionRef.current = null
    const ctl = new AbortController()
    const run = () => {
      const notes = songHandNotes(song, {
        speedMap,
        midiOffsetSec: s.midiOffsetSec,
        trimStartSec: s.midiTrimStartSec,
        trimEndSec: s.midiTrimEndSec ?? song.duration,
        transpose: s.transpose,
      })
      if (!notes.length) {
        motionRef.current = null
        invalidate()
        return
      }
      synthHandMotion(notes, ctl.signal)
        .then((m) => {
          motionRef.current = { ...m, song: song.name }
          invalidate()
        })
        .catch(() => {}) // cancelled by a newer request, or failed (the status says so)
    }
    const id = window.setTimeout(run, motionRef.current ? REBUILD_DEBOUNCE_MS : 0)
    return () => {
      window.clearTimeout(id)
      ctl.abort()
    }
  }, [song, speedMap, s.midiOffsetSec, s.midiTrimStartSec, s.midiTrimEndSec, s.transpose, invalidate])

  useFrame(() => {
    resetBlurFrame()
    const mesh = meshRef.current
    if (!mesh) return
    const ready = motionRef.current
    mesh.setLighting(getResolvedSettings().keyboardBrightness, s.handsBrightness, s.handsFlashLight)
    mesh.setVisible(!!ready)
    if (!ready || !mesh.ready) return
    const { motion, poseAt } = ready
    const t = audioEngine.currentSongTime()
    const poses = poseAt(motion, t)
    mesh.update(poses, false)

    // Motion blur: sub-poses at trailing times of ONE nominal frame of song time (export: 1/fps, preview: 1/60 s, times the
    // playback rate; never the real frame delta), so the picture is a pure function of t. Sample 0 = t.
    if (!s.handsMotionBlur || blurBridge.consumers < 1 || s.handsBlurSamples < 2) return
    const dt = (getExportFps() ? 1 / getExportFps()! : PREVIEW_FRAME_SECONDS) * (useStore.getState().settings.playbackRate || 1)
    const far = poseAt(motion, Math.max(0, t - BLUR_SHUTTER * dt))
    const mid = poseAt(motion, Math.max(0, t - 0.5 * BLUR_SHUTTER * dt))
    const shift = Math.max(maxJointShift(poses, far), maxJointShift(poses, mid))
    const persp = camera as THREE.PerspectiveCamera
    const wr = poses.L?.wrist ?? poses.R?.wrist
    const dist = wr ? camera.position.distanceTo(new THREE.Vector3(wr[0], wr[1], wr[2])) : camera.position.length()
    gl.getDrawingBufferSize(SIZE)
    const px = shift * (SIZE.y / (2 * dist * Math.tan(THREE.MathUtils.degToRad(persp.fov) / 2)))
    if (px < BLUR_MIN_PX) return
    const n = Math.min(Math.round(s.handsBlurSamples), Math.max(2, Math.ceil(px / BLUR_PX_STEP)))
    const sub: HandPoses[] = blurOffsets(n, BLUR_SHUTTER, dt).map((o) => (o === 0 ? poses : poseAt(motion, Math.max(0, t + o))))
    camera.updateMatrixWorld()
    blurBridge.plan = {
      count: n,
      rectsFor: (w, h) => handBounds(sub, persp, w, h, 0.5),
      handsRoot: group,
      drawAt: (i) => mesh.update(sub[i], false),
    }
    if (blurBridge.renderPass) blurBridge.renderPass.enabled = false
    if (blurBridge.pass) blurBridge.pass.enabled = true
  })

  // Hands leaving the tree (or blur turned off) must hand rendering back to the default pipeline.
  useEffect(() => resetBlurFrame, [])

  return (
    <>
      <primitive object={group} />
      {!s.bloomEnabled && s.handsMotionBlur && <HandsBlurPlainRender />}
    </>
  )
}

/** Child of `<EffectComposer>` (before Bloom): the composer-path consumer of `blurBridge.plan`. */
export function HandsBlurComposerPass() {
  const ctx = useContext(EffectComposerContext)
  const pass = useMemo(() => (ctx ? new HandsBlurPass(ctx.scene, ctx.camera) : null), [ctx])
  useEffect(() => {
    if (!ctx || !pass) return
    // The composer's own scene pass is the first one; this pass replaces it on blurred frames.
    blurBridge.renderPass = ctx.composer.passes[0] ?? null
    blurBridge.pass = pass
    blurBridge.consumers++
    return () => {
      if (blurBridge.renderPass === ctx.composer.passes[0]) { blurBridge.renderPass.enabled = true; blurBridge.renderPass = null }
      if (blurBridge.pass === pass) blurBridge.pass = null
      blurBridge.consumers--
      blurBridge.plan = null
    }
  }, [ctx, pass])
  return pass ? <primitive object={pass} /> : null
}

/** Bloom-off consumer: takes over the canvas render (R3F skips its own once a priority > 0 subscriber exists). */
export function HandsBlurPlainRender() {
  const gl = useThree((st) => st.gl)
  useEffect(() => {
    blurBridge.consumers++
    return () => { blurBridge.consumers--; blurBridge.plan = null }
  }, [])
  useFrame(({ scene, camera }) => {
    const plan = blurBridge.plan
    if (plan) getMotionBlur(gl).render(scene, camera, plan.handsRoot, plan.rectsFor, plan.count, plan.drawAt, null)
    else gl.render(scene, camera)
  }, 1)
  return null
}

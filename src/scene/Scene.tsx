import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { EffectComposer, Bloom } from '@react-three/postprocessing'
import * as THREE from 'three'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore, useSettingsSlice } from '../store'

const SCENE_ROOT_KEYS = [
  'backgroundColor',
  'bloomEnabled',
  'bloomIntensity',
  'bloomRadius',
  'bloomSmoothing',
  'bloomThreshold',
  'cameraFov',
  'cameraLookAt',
  'cameraPos',
] as const
const SCENE_CONTENTS_KEYS = [
  'cameraFov',
  'cameraLookAt',
  'cameraPos',
  'flashEnabled',
  'notesEnabled',
] as const
const PLAY_TOGGLE_KEYS = [
  'cameraFov',
  'cameraLookAt',
  'cameraPos',
  'keyboardY',
] as const
import { recorder } from '../audio/recorder'
import { registerR3FStateGetter } from './exportBridge'
import { Keyboard } from '../keyboard/Keyboard'
import { FallingNotes } from '../notes/FallingNotes'
import { LandingFlashes } from '../notes/LandingFlashes'
import { HitParticles } from '../notes/HitParticles'
import { HitLine } from '../notes/HitLine'
import { HandVideoOverlay } from './HandVideoOverlay'
import { WHITE_KEY_LENGTH } from '../keyboard/layout'
import { audioEngine } from '../audio/engine'
import { pauseSong, playSong, togglePlayback } from '../audio/playback'
import { EditTools } from './EditTools'
import { CameraControls } from './CameraControls'

// On-screen preview tick rate when the user opts into the lighter
// 30 fps mode. The rendered MP4 export drives its own fps regardless
// (via `frameloop="never"` + explicit `advance()`), so this only
// affects the live preview — exports stay smooth either way.
const PREVIEW_FRAME_INTERVAL_MS = 1000 / 30

export function Scene() {
  const s = useSettingsSlice(SCENE_ROOT_KEYS)
  const highFps = useStore((st) => st.settings.previewHighFps)
  // Recorder state kept here just for prop drilling into SceneContents
  // (edit-mode gating).
  const [recState, setRecState] = useState(recorder.getState())
  useEffect(() => recorder.addListener(() => setRecState(recorder.getState())), [])
  return (
    <Canvas
      dpr={[1, 2]}
      gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping }}
      camera={{ position: s.cameraPos, fov: s.cameraFov, near: 0.1, far: 100 }}
      frameloop={highFps ? 'always' : 'demand'}
      onCreated={({ camera, gl }) => {
        camera.lookAt(...s.cameraLookAt)
        // Black keys are clipped at the keyboard's back edge (see
        // Keyboard.tsx) so their tilted/extended rear can't poke a
        // coloured sliver above the keyboard into the falling-note lane.
        gl.localClippingEnabled = true
      }}
    >
      <color attach="background" args={[s.backgroundColor]} />
      <SceneContents recState={recState} />
      {!highFps && <ThrottledTicker intervalMs={PREVIEW_FRAME_INTERVAL_MS} />}
      {s.bloomEnabled && (
        <EffectComposer>
          <Bloom
            intensity={s.bloomIntensity}
            luminanceThreshold={s.bloomThreshold}
            luminanceSmoothing={s.bloomSmoothing}
            radius={s.bloomRadius}
            mipmapBlur
          />
        </EffectComposer>
      )}
    </Canvas>
  )
}

/**
 * Beats `invalidate()` at a fixed cadence so `frameloop="demand"` still
 * advances per-frame animations (glow decay, custom-texture pan, FX
 * fade-outs) while the user is editing. Pointer events invalidate
 * automatically on top of this, so hover / drag stays responsive.
 */
function ThrottledTicker({ intervalMs }: { intervalMs: number }) {
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    const id = window.setInterval(() => invalidate(), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs, invalidate])
  return null
}

function SceneContents({ recState }: { recState: 'idle' | 'recording' }) {
  const s = useSettingsSlice(SCENE_CONTENTS_KEYS)
  const transport = useStore((st) => st.transport)
  // Edit mode = not currently playing or recording. Mounting EditTools
  // (instead of PlayToggleArea) flips the meaning of every empty-area
  // click — "toggle play" becomes "select / range / add note". Live
  // performance / fast-forward UX stays untouched while playing. With
  // no song loaded the first added note bootstraps an empty song.
  const editMode = transport !== 'playing' && recState !== 'recording'
  return (
    <>
      <ambientLight intensity={0.35} />
      <directionalLight position={[2, 6, 4]} intensity={0.8} />
      <CameraSync pos={s.cameraPos} lookAt={s.cameraLookAt} fov={s.cameraFov} />
      <CameraControls />
      <R3FStateBridge />
      {editMode ? <EditTools /> : <PlayToggleArea />}
      <Keyboard />
      {s.notesEnabled && <FallingNotes />}
      {s.flashEnabled && <LandingFlashes />}
      <HitParticles />
      <HitLine />
      <HandVideoOverlay />
    </>
  )
}

/**
 * Invisible click regions above and below the keyboard. Short click toggles
 * play/pause; pressing-and-holding (>200ms) temporarily doubles the playback
 * rate and releasing restores the slider value. Sits behind the notes
 * (z < note z); notes have no event handlers so the raycast falls through.
 */
const HOLD_THRESHOLD_MS = 200

function PlayToggleArea() {
  const s = useSettingsSlice(PLAY_TOGGLE_KEYS)
  const camDistance = Math.abs(s.cameraPos[2])
  const halfVisHeight = camDistance * Math.tan((s.cameraFov * Math.PI) / 360)
  const visibleTopY = s.cameraLookAt[1] + halfVisHeight
  const visibleBottomY = s.cameraLookAt[1] - halfVisHeight
  const topOfKeyboard = s.keyboardY + WHITE_KEY_LENGTH
  const bottomOfKeyboard = s.keyboardY
  // Above-keyboard region (where falling notes appear)
  const upperHeight = visibleTopY - topOfKeyboard
  const upperCenterY = (visibleTopY + topOfKeyboard) / 2
  // Below-keyboard region
  const lowerHeight = bottomOfKeyboard - visibleBottomY
  const lowerCenterY = (bottomOfKeyboard + visibleBottomY) / 2
  // Wide enough to cover any reasonable aspect ratio at this camera distance.
  const width = halfVisHeight * 4

  const holdTimer = useRef<number | null>(null)
  const fastForwardActive = useRef(false)
  // Whether the song was already playing when the hold began. If false the
  // hold actively starts playback for the duration of the hold and the song
  // is paused again on release (preview / scrubbing behaviour).
  const wasPlayingBeforeHold = useRef(false)
  // Token to invalidate the async playSong() if the user releases mid-await.
  const holdToken = useRef(0)

  const stopFastForward = useCallback(() => {
    holdToken.current++
    if (holdTimer.current !== null) {
      clearTimeout(holdTimer.current)
      holdTimer.current = null
    }
    if (fastForwardActive.current) {
      fastForwardActive.current = false
      // Restore to whatever the slider currently says — user may have
      // changed it mid-hold.
      audioEngine.setRate(useStore.getState().settings.playbackRate)
      useStore.getState().setFastForward(false)
      // If we started playback because the hold began from a paused state,
      // pause it again now that the hold is over.
      if (!wasPlayingBeforeHold.current) {
        pauseSong()
      }
    }
  }, [])

  // Window-level cleanup so the rate always restores even if the pointer
  // leaves the mesh, the tab loses focus, or pointercancel fires.
  useEffect(() => {
    const onUp = () => stopFastForward()
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    window.addEventListener('blur', onUp)
    return () => {
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      window.removeEventListener('blur', onUp)
      stopFastForward()
    }
  }, [stopFastForward])

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    // Middle button is reserved for camera orbit and right button for the
    // browser context menu — only left clicks should toggle playback or
    // arm the press-and-hold fast-forward.
    if (e.nativeEvent.button !== 0) return
    e.stopPropagation()
    if (holdTimer.current !== null || fastForwardActive.current) return
    holdTimer.current = window.setTimeout(async () => {
      holdTimer.current = null
      const token = ++holdToken.current
      const { transport, settings } = useStore.getState()
      wasPlayingBeforeHold.current = transport === 'playing'
      audioEngine.setRate(settings.playbackRate * 2)
      fastForwardActive.current = true
      useStore.getState().setFastForward(true)
      if (!wasPlayingBeforeHold.current) {
        await playSong()
        // If the user released while playSong was awaiting (sample load /
        // AudioContext resume), the cleanup pauseSong already ran but
        // playSong then re-set transport to 'playing' — undo that.
        if (holdToken.current !== token) {
          pauseSong()
        }
      }
    }, HOLD_THRESHOLD_MS)
  }

  const onPointerUp = (e: ThreeEvent<PointerEvent>) => {
    if (e.nativeEvent.button !== 0) return
    e.stopPropagation()
    const wasArmed = holdTimer.current !== null
    const wasFastForward = fastForwardActive.current
    stopFastForward()
    // Short click (released before the hold timer fired) → treat as toggle.
    if (wasArmed && !wasFastForward) {
      void togglePlayback()
    }
  }

  return (
    <>
      {upperHeight > 0 && (
        <mesh
          position={[0, upperCenterY, 0.01]}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
        >
          <planeGeometry args={[width, upperHeight]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
      {lowerHeight > 0 && (
        <mesh
          position={[0, lowerCenterY, 0.01]}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
        >
          <planeGeometry args={[width, lowerHeight]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
    </>
  )
}

/**
 * Registers the R3F state with the export bridge for the lifetime of
 * the Canvas. The video exporter (src/export/renderVideo.ts) reads
 * gl/scene/camera/advance/set imperatively through the bridge, so this
 * has to live INSIDE the Canvas — `useThree` only resolves under a
 * Canvas's R3F context.
 */
function R3FStateBridge() {
  const get = useThree((s) => s.get)
  useEffect(() => registerR3FStateGetter(get), [get])
  return null
}

function CameraSync({
  pos,
  lookAt,
  fov,
}: {
  pos: [number, number, number]
  lookAt: [number, number, number]
  fov: number
}) {
  const { camera } = useThree()
  useEffect(() => {
    camera.position.set(...pos)
    if ('fov' in camera) {
      ;(camera as THREE.PerspectiveCamera).fov = fov
      ;(camera as THREE.PerspectiveCamera).updateProjectionMatrix()
    }
    camera.lookAt(...lookAt)
  }, [camera, pos, lookAt, fov])
  // also follow each frame in case other code moves camera
  useFrame(() => {
    camera.lookAt(...lookAt)
  })
  return null
}

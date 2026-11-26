import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { EffectComposer } from '@react-three/postprocessing'
import { BloomSourceComposerPass, MaskedBloom } from './bloomSource'
import { RoundedBox } from '@react-three/drei'
import type { BloomEffect } from 'postprocessing'
import * as THREE from 'three'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore, useSettingsSlice } from '../store'
import { getResolvedSettings, updateResolvedSettings } from './automatedSettings'

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
  'handsEnabled',
  'handVideoEnabled',
  'keyboardScreenY',
  'noteRaysEnabled',
  'notesEnabled',
] as const
import { recorder } from '../audio/recorder'
import { registerR3FStateGetter } from './exportBridge'
import { Keyboard } from '../keyboard/Keyboard'
import { FallingNotes } from '../notes/FallingNotes'
import { NoteRays } from '../notes/NoteRays'
import { LandingFlashes } from '../notes/LandingFlashes'
import { HitParticles } from '../notes/HitParticles'
import { HitLine } from '../notes/HitLine'
import { Hands, HandsBlurComposerPass } from '../hands/Hands'
import { KEYBOARD_Y, KEYBOARD_LAYOUT, NOTE_HIT_Y } from '../keyboard/layout'
import { audioEngine } from '../audio/engine'
import { pauseSong, playSong, togglePlayback } from '../audio/playback'
import { EditTools } from './EditTools'
import { CameraControls, isCameraGestureActive } from './CameraControls'
import { StageBackground } from './StageBackgroundLayer'
import { HandVideoLayer } from './HandVideoLayer'
import { useHandVideo } from '../video/handVideo'
import { applyFraming } from './framing'
import { PICK_PLANES } from './pickPlanes'

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
  // Ref to the underlying postprocessing BloomEffect — `BloomSync`
  // pushes pin-resolved intensity / threshold / smoothing / radius
  // into it every frame so the effect animates under the export's
  // `r3f.advance()` loop (which never re-renders React props).
  const bloomRef = useRef<BloomEffect>(null)
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
      {/* Pin driver mounts FIRST so its useFrame subscribes before any
          consumer's — same-priority R3F callbacks run in subscription
          (mount) order, so every consumer this frame reads a snapshot
          resolved against the current playhead. */}
      <AutomatedSettingsDriver />
      <BackgroundSync />
      <StageBackground />
      <SceneContents recState={recState} />
      {!highFps && <ThrottledTicker intervalMs={PREVIEW_FRAME_INTERVAL_MS} />}
      {s.bloomEnabled && (
        <EffectComposer>
          <HandsBlurComposerPass />
          <BloomSourceComposerPass />
          <MaskedBloom
            // @react-three/postprocessing types the ref as
            // `typeof BloomEffect` (the class) instead of an instance —
            // a known typings quirk. The runtime ref IS a BloomEffect
            // instance, which is what BloomSync needs, so cast here.
            ref={bloomRef as unknown as React.Ref<typeof BloomEffect>}
            intensity={s.bloomIntensity}
            luminanceThreshold={s.bloomThreshold}
            luminanceSmoothing={s.bloomSmoothing}
            radius={s.bloomRadius}
            mipmapBlur
          />
          <BloomSync bloomRef={bloomRef} />
        </EffectComposer>
      )}
    </Canvas>
  )
}

/**
 * Single per-frame driver: recomputes the pin-resolved settings
 * snapshot from the live base + `audioEngine.currentSongTime()` once
 * per frame. Mounted before every visual consumer so the snapshot is
 * fresh when they read it (R3F runs same-priority useFrames in mount
 * order). With zero pins the resolver returns `base` by reference, so
 * this is effectively free and changes nothing.
 */
function AutomatedSettingsDriver() {
  useFrame(() => {
    updateResolvedSettings()
  })
  return null
}

/**
 * Imperatively syncs `scene.background` to the pin-resolved background
 * colour each frame. The declarative `<color attach="background">`
 * still seeds the initial value (and the zero-pin steady state — the
 * resolved colour is then identical to it), but the offline exporter
 * only steps `r3f.advance()` and never re-renders React props, so the
 * per-frame imperative write is what makes the background animate in
 * the rendered MP4.
 */
function BackgroundSync() {
  const scene = useThree((s) => s.scene)
  const bg = useMemo(() => new THREE.Color(), [])
  useFrame(() => {
    bg.set(getResolvedSettings().backgroundColor)
    if (scene.background instanceof THREE.Color) {
      scene.background.copy(bg)
    } else {
      scene.background = bg.clone()
    }
  })
  return null
}

/**
 * Imperatively pushes pin-resolved Bloom params into the underlying
 * postprocessing `BloomEffect` each frame. React props on `<Bloom>`
 * cover the initial / zero-pin state; this write makes the values
 * animate through pins AND survive the export pass (which never
 * re-renders React, so prop-only Bloom params would freeze).
 *
 * `intensity` → effect.intensity; `radius` →
 * `mipmapBlurPass.radius`; threshold / smoothing →
 * `luminanceMaterial.threshold` / `.smoothing` (the same internal
 * properties react-three-postprocessing maps the props to).
 */
function BloomSync({ bloomRef }: { bloomRef: React.RefObject<BloomEffect | null> }) {
  useFrame(() => {
    const eff = bloomRef.current
    if (!eff) return
    const r = getResolvedSettings()
    eff.intensity = r.bloomIntensity
    eff.mipmapBlurPass.radius = r.bloomRadius
    eff.luminanceMaterial.threshold = r.bloomThreshold
    eff.luminanceMaterial.smoothing = r.bloomSmoothing
  })
  return null
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
  // Hand video: real hands replace the virtual ones; the virtual keyboard
  // is hidden (still there for clicks and glow state) when the user asks.
  const handVideo = useHandVideo((st) => st.element !== null) && s.handVideoEnabled
  return (
    <>
      <ambientLight intensity={0.35} />
      <directionalLight position={[2, 6, 4]} intensity={0.8} />
      <CameraSync pos={s.cameraPos} lookAt={s.cameraLookAt} fov={s.cameraFov} screenY={s.keyboardScreenY} />
      <CameraControls />
      <R3FStateBridge />
      {editMode ? <EditTools /> : <PlayToggleArea />}
      <Keyboard />
      <KeyboardFrontRail />
      <KeyboardCheekBlocks />
      {handVideo && <HandVideoLayer />}
      {s.notesEnabled && <FallingNotes />}
      {s.notesEnabled && s.noteRaysEnabled && <NoteRays />}
      {s.flashEnabled && <LandingFlashes />}
      <HitParticles />
      <HitLine />
      {s.handsEnabled && !handVideo && <Hands />}
    </>
  )
}

/**
 * Glossy black piano frame — the "key slip" plus the bed the
 * keyboard sits on. Two boxes recessed behind the white-key plane:
 *   - Front rail (visible strip BELOW the keyboard). A gap of
 *     `CHEEK_FRONT_OVERHANG` between the rail's top edge and the
 *     keyboard's player edge reads as a shadowed channel, framed
 *     laterally by the cheekblocks (which overhang by the same
 *     amount).
 *   - Back panel (hidden behind the keys). Plugs the seams between
 *     rounded white keys / chamfered black keys so a light
 *     `backgroundColor` can't bleed through as pale slivers.
 *
 * Both share `FRONT_RAIL_DEPTH` / `FRONT_RAIL_FRONT_Z` so they read
 * as one piece of carcass viewed from the back/top.
 *
 * Material mimics piano polyester lacquer: very dark grey (a hair
 * above true black so scene lighting still picks out highlights),
 * low roughness, modest metalness. `raycast={() => null}` so it
 * never intercepts editor / play-toggle clicks.
 */
const FRONT_RAIL_HEIGHT = 0.13
const FRONT_RAIL_DEPTH = 0.4
const FRONT_RAIL_FRONT_Z = -0.2
// Back panel only needs enough z-thickness to act as an opaque
// surface plugging the inter-key seams. Anchored by its REAR face
// (`BACK_PANEL_BACK_Z`) so pushing the panel further back in z (by
// shrinking `BACK_PANEL_DEPTH`) only moves its FRONT face deeper —
// the rear of the carcass keeps the same silhouette as before.
const BACK_PANEL_BACK_Z = FRONT_RAIL_FRONT_Z - 0.15
const BACK_PANEL_DEPTH = 0.01
const FRONT_RAIL_COLOR = '#0c0c0c'
function KeyboardFrontRail() {
  // Extend laterally under the cheekblocks so the rail and back
  // panel span the same overall x range as the rest of the case
  // (edges align with the outer faces of the cheeks).
  const width = KEYBOARD_LAYOUT.totalWidth + 2 * CHEEK_WIDTH
  const centerZ = FRONT_RAIL_FRONT_Z - FRONT_RAIL_DEPTH / 2

  // Back panel: only as wide as the keyboard. The cheeks already
  // occupy and visually seal the lateral regions, and extending the
  // back panel under them would let it poke out behind the cheeks'
  // rounded corners (where the cheek silhouette inset reveals what
  // sits in z behind it).
  const backWidth = KEYBOARD_LAYOUT.totalWidth

  // Visible front rail strip — sits BELOW the keyboard with a gap of
  // `CHEEK_FRONT_OVERHANG` between its top edge and the white-key
  // player edge. That gap reads as a shadowed channel on real grands,
  // framed laterally by the cheekblocks (which themselves overhang
  // forward by the same amount).
  const railTopY = KEYBOARD_Y - CHEEK_FRONT_OVERHANG
  const railBottomY = railTopY - FRONT_RAIL_HEIGHT
  const railHeight = railTopY - railBottomY
  const railCenterY = (railTopY + railBottomY) / 2

  // Back panel — hidden behind the keys, top at the hit line, bottom
  // extended FORWARD to meet the front rail's top edge so the gap
  // between rail and keyboard (the `CHEEK_FRONT_OVERHANG` channel)
  // is closed off from behind by the back panel. Also plugs the
  // seams between rounded white keys / chamfered black keys so a
  // light `backgroundColor` can't bleed through as pale slivers.
  const backTopY = NOTE_HIT_Y
  const backBottomY = railTopY
  const backHeight = backTopY - backBottomY
  const backCenterY = (backTopY + backBottomY) / 2

  const noRaycast = useMemo(() => () => null, [])
  return (
    <>
      <mesh position={[0, railCenterY, centerZ]} raycast={noRaycast}>
        <boxGeometry args={[width, railHeight, FRONT_RAIL_DEPTH]} />
        <meshStandardMaterial color={FRONT_RAIL_COLOR} roughness={1} metalness={0} />
      </mesh>
      <mesh
        position={[0, backCenterY, BACK_PANEL_BACK_Z + BACK_PANEL_DEPTH / 2]}
        raycast={noRaycast}
      >
        <boxGeometry args={[backWidth, backHeight, BACK_PANEL_DEPTH]} />
        <meshStandardMaterial color={FRONT_RAIL_COLOR} roughness={1} metalness={0} />
      </mesh>
    </>
  )
}

/**
 * Cheekblocks — the two glossy black wooden blocks bookending the
 * keyboard on its left (bass) and right (treble) sides. Real grand
 * pianos rise these slightly ABOVE the white-key surface so the
 * highest sharps stop short of the case rather than meeting it flush.
 *
 * Per block:
 *   width (x)   `CHEEK_WIDTH`                                   — a touch wider than one white key
 *   length (y)  `[KEYBOARD_Y, NOTE_HIT_Y]`                      — full keyboard depth
 *   height (z)  `[FRAME_BACK_Z, CHEEK_TOP_Z]`                   — from the frame's back face up
 *                                                                 just above the black-key top
 *
 * x centres:
 *   left   = −totalWidth/2 − CHEEK_WIDTH/2
 *   right  = +totalWidth/2 + CHEEK_WIDTH/2
 *
 * Same lacquer material as `KeyboardFrontRail` so the surrounding
 * frame reads as one continuous piece. `raycast={() => null}` keeps
 * editor / play-toggle clicks unaffected.
 */
const CHEEK_WIDTH = 0.8
// Top sits just above the black-key crowns (z ≈ 0.09) so the cheek
// reads as taller than the white keys without dominating the blacks.
const CHEEK_TOP_Z = 0.08
// Overhang in front of the white-key player edge. Real grands have the
// cheekblocks protruding a touch toward the player, ahead of the keys.
const CHEEK_FRONT_OVERHANG = 0.02
function KeyboardCheekBlocks() {
  // Match the frame's z extent so the blocks visually continue the
  // front rail / back panel as one carcass piece.
  const frameBackZ = FRONT_RAIL_FRONT_Z - FRONT_RAIL_DEPTH
  const depth = CHEEK_TOP_Z - frameBackZ
  const centerZ = (CHEEK_TOP_Z + frameBackZ) / 2
  // Front edge sits CHEEK_FRONT_OVERHANG ahead of `KEYBOARD_Y` (the
  // white-key player edge); back edge stays at the hit line.
  const frontY = KEYBOARD_Y - CHEEK_FRONT_OVERHANG
  const backY = NOTE_HIT_Y
  const length = backY - frontY
  const centerY = (frontY + backY) / 2
  const halfKb = KEYBOARD_LAYOUT.totalWidth / 2
  const leftX = -halfKb - CHEEK_WIDTH / 2
  const rightX = +halfKb + CHEEK_WIDTH / 2
  const noRaycast = useMemo(() => () => null, [])
  // `RoundedBox` rounds all 12 edges uniformly. The radius is small
  // enough that the bottom / back / outer edges (mostly hidden against
  // the rail or facing offscreen) still read as square, while the two
  // edges the user asked for — front-top (player-side top) and
  // inner-side-top (along the white keys) — get a visible quarter
  // roundover. `creaseAngle` smooths the round-to-flat seam.
  const cornerRadius = 0.04
  return (
    <>
      <RoundedBox
        position={[leftX, centerY, centerZ]}
        args={[CHEEK_WIDTH, length, depth]}
        radius={cornerRadius}
        smoothness={4}
        creaseAngle={0.4}
        raycast={noRaycast}
      >
        <meshStandardMaterial
          color={FRONT_RAIL_COLOR}
          roughness={0.25}
          metalness={0.15}
        />
      </RoundedBox>
      <RoundedBox
        position={[rightX, centerY, centerZ]}
        args={[CHEEK_WIDTH, length, depth]}
        radius={cornerRadius}
        smoothness={4}
        creaseAngle={0.4}
        raycast={noRaycast}
      >
        <meshStandardMaterial
          color={FRONT_RAIL_COLOR}
          roughness={0.25}
          metalness={0.15}
        />
      </RoundedBox>
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
      {PICK_PLANES.map((p) => (
        <mesh key={p.name} position={p.position} onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
          <planeGeometry args={p.size} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      ))}
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
  screenY,
}: {
  pos: [number, number, number]
  lookAt: [number, number, number]
  fov: number
  screenY: number
}) {
  const { camera } = useThree()
  // Non-pin (or zero-pin) path: apply on prop change so a slider drag
  // updates the camera immediately even while paused. With pins this
  // sets the base framing; the per-frame block below then overrides
  // with the resolved (interpolated) values.
  useEffect(() => {
    camera.position.set(...pos)
    if ('fov' in camera) {
      ;(camera as THREE.PerspectiveCamera).fov = fov
      ;(camera as THREE.PerspectiveCamera).updateProjectionMatrix()
      applyFraming(camera as THREE.PerspectiveCamera, {
        keyboardScreenY: screenY,
        cameraPos: pos,
        cameraLookAt: lookAt,
        cameraFov: fov,
      })
    }
    camera.lookAt(...lookAt)
  }, [camera, pos, lookAt, fov, screenY])
  // Follow the pin-resolved camera every frame. With zero pins the
  // resolved values equal the props, so position/fov writes are
  // idempotent and this collapses to the original "re-aim lookAt each
  // frame in case other code moved the camera" behaviour.
  const prevFov = useRef<number | null>(null)
  useFrame(() => {
    // While the user is actively orbiting / panning / wheel-dollying,
    // show the value the gesture is WRITING — the edit target: the
    // selected pin's snapshot (animatable) or base, identical to the
    // Inspector's `useEffectiveSetting`. Otherwise the playhead-time
    // resolver pulls the camera back to the interpolated state every
    // frame and the gesture can't actually move it. Idle / playback /
    // export (never a gesture) keep the time-resolved path untouched,
    // so pin animation preview and export parity are unchanged.
    let cp: readonly [number, number, number]
    let cl: readonly [number, number, number]
    let cf: number
    let cs: number
    if (isCameraGestureActive()) {
      const st = useStore.getState()
      const base = st.settings
      const kt = st.editingKeyframeTime
      const kf =
        kt !== null
          ? base.settingsKeyframes.find((p) => Math.abs(p.time - kt) < 1e-6)
          : undefined
      cp = (kf?.settings.cameraPos ?? base.cameraPos) as [number, number, number]
      cl = (kf?.settings.cameraLookAt ?? base.cameraLookAt) as [number, number, number]
      cf = kf?.settings.cameraFov ?? base.cameraFov
      cs = kf?.settings.keyboardScreenY ?? base.keyboardScreenY
    } else {
      const r = getResolvedSettings()
      cp = r.cameraPos
      cl = r.cameraLookAt
      cf = r.cameraFov
      cs = r.keyboardScreenY
    }
    const [px, py, pz] = cp
    const [lx, ly, lz] = cl
    camera.position.set(px, py, pz)
    if ('fov' in camera) {
      const persp = camera as THREE.PerspectiveCamera
      if (persp.fov !== cf || prevFov.current !== cf) {
        persp.fov = cf
        persp.updateProjectionMatrix()
        prevFov.current = cf
      }
      applyFraming(persp, {
        keyboardScreenY: cs,
        cameraPos: cp,
        cameraLookAt: cl,
        cameraFov: cf,
      })
    }
    camera.lookAt(lx, ly, lz)
  })
  return null
}

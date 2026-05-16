import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import * as THREE from 'three'
import { useSettingsSlice, useStore } from '../store'
import { useHandVideo } from '../notes/handVideo'
import { useHandVideoMenu } from '../ui/HandVideoContextMenu'
import { audioEngine } from '../audio/engine'

const HAND_VIDEO_KEYS = [
  'handVideoEnabled',
  'handVideoOpacity',
  'handVideoBrightness',
  'handVideoPosX',
  'handVideoPosY',
  'handVideoScale',
  'handVideoOffsetSec',
  'handVideoTrimStartSec',
  'handVideoTrimEndSec',
] as const

// Painted BEFORE the hit line (renderOrder 0) and falling notes (2) — a
// negative renderOrder with depthTest off makes the composited footage
// sit behind those overlays, so the hit line stays visible on top of
// the hand video (it still covers the opaque keyboard / background,
// which render in the earlier opaque pass regardless of renderOrder).
const OVERLAY_Z = 0.5
const OVERLAY_RENDER_ORDER = -1

// Realtime drift tolerance. `<video>` playback runs on its own media
// clock; we only hard-seek when it diverges from the transport by more
// than this, so we don't stutter the clip every frame.
const DRIFT_TOLERANCE_SEC = 0.15

// Editing frame thickness, in world units.
const BORDER_WIDTH_WU = 0.018
// Only the outer sliver (|normalised local| past this) is a resize
// grab ("near the frame"); anything more central is a move.
const RESIZE_EDGE_FRACTION = 0.85

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uOpacity;
  uniform float uBrightness;
  uniform float uBorder;       // 0 = hidden, 1 = shown (editing)
  uniform vec2  uSize;         // plane size in world units
  uniform vec3  uBorderColor;
  varying vec2 vUv;
  void main() {
    vec4 c = texture2D(uMap, vUv);
    // Clamp post-brightness so an over-bright clip doesn't detonate the
    // bloom pass into a white screen.
    vec3 rgb = clamp(c.rgb * uBrightness, 0.0, 1.0);
    vec4 col = vec4(rgb, c.a * uOpacity);
    if (uBorder > 0.5) {
      // Distance to the nearest edge in world units, so the frame has
      // even thickness regardless of the clip's aspect ratio.
      float dx = min(vUv.x, 1.0 - vUv.x) * uSize.x;
      float dy = min(vUv.y, 1.0 - vUv.y) * uSize.y;
      float edge = min(dx, dy);
      if (edge < ${BORDER_WIDTH_WU.toFixed(3)}) {
        col = mix(col, vec4(uBorderColor, 1.0), 0.9);
      }
    }
    gl_FragColor = col;
  }
`

export function HandVideoOverlay() {
  const s = useSettingsSlice(HAND_VIDEO_KEYS)
  const texture = useHandVideo((st) => st.texture)
  const videoEl = useHandVideo((st) => st.videoEl)
  const aspect = useHandVideo((st) => st.aspect)
  const duration = useHandVideo((st) => st.duration)
  const exporting = useHandVideo((st) => st.exporting)
  const transport = useStore((st) => st.transport)
  const { camera, size, gl } = useThree()
  const dragRef = useRef<{
    mode: 'move' | 'scale'
    startX: number
    startY: number
    startPosX: number
    startPosY: number
    startScale: number
    radialX: number
    radialY: number
  } | null>(null)
  // The frame shows only while the clip is *selected* (clicked), not on
  // mere hover. Selection is dropped by clicking elsewhere
  // (onPointerMissed), pressing Escape, or starting playback.
  const [selected, setSelected] = useState(false)
  const [dragging, setDragging] = useState(false)

  const material = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: null as THREE.Texture | null },
        uOpacity: { value: 1 },
        uBrightness: { value: 1 },
        uBorder: { value: 0 },
        uSize: { value: new THREE.Vector2(1, 1) },
        uBorderColor: { value: new THREE.Color('#38bdf8') }, // sky-400 (theme)
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
    })
    // uniforms are mutated below; deps deliberately empty.
  }, [])

  useEffect(() => () => material.dispose(), [material])

  useEffect(() => {
    material.uniforms.uMap.value = texture
  }, [material, texture])
  useEffect(() => {
    material.uniforms.uOpacity.value = s.handVideoOpacity
  }, [material, s.handVideoOpacity])
  useEffect(() => {
    material.uniforms.uBrightness.value = s.handVideoBrightness
  }, [material, s.handVideoBrightness])
  // The editing frame is only meaningful when the clip is directly
  // manipulable — i.e. not during playback (then the click belongs to
  // the play/pause area behind it).
  const editable = transport !== 'playing'
  // Drop selection when it can no longer be acted on (playback) or on
  // Escape.
  useEffect(() => {
    if (!editable) setSelected(false)
  }, [editable])
  useEffect(() => {
    if (!selected) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelected(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected])
  useEffect(() => {
    material.uniforms.uBorder.value =
      editable && (selected || dragging) ? 1 : 0
  }, [material, editable, selected, dragging])

  // Realtime transport sync. The clip plays at `currentSongTime() -
  // offset`; the trim window bounds where it's visible. (The offline
  // exporter swaps `texture` for a decoder-fed canvas and drives the
  // frame externally, so this branch is inert there — `videoEl` still
  // exists but the exporter doesn't read the <video>.)
  useFrame(() => {
    // Bind the live texture from the store every frame, not just via the
    // texture-change effect. The offline exporter swaps the texture
    // synchronously right before driving frames; relying on React's
    // effect flush would leave the first exported frames bound to the
    // (now disposed) realtime VideoTexture.
    material.uniforms.uMap.value = useHandVideo.getState().texture
    // During offline export the texture is a canvas the exporter draws
    // decoded frames into; the <video> element must not be touched.
    if (exporting) return
    if (!videoEl || !s.handVideoEnabled) return
    const srcTime = audioEngine.currentSongTime() - s.handVideoOffsetSec
    const trimEnd = s.handVideoTrimEndSec ?? (duration || Infinity)
    const within =
      srcTime >= s.handVideoTrimStartSec &&
      srcTime < trimEnd &&
      srcTime >= 0 &&
      (duration === 0 || srcTime <= duration)

    if (audioEngine.isPlaying() && within) {
      if (videoEl.paused) void videoEl.play().catch(() => {})
      if (Math.abs(videoEl.currentTime - srcTime) > DRIFT_TOLERANCE_SEC) {
        videoEl.currentTime = srcTime
      }
    } else {
      if (!videoEl.paused) videoEl.pause()
      // Keep the visible frame correct while paused / scrubbing.
      const want = Math.min(Math.max(srcTime, 0), duration || 0)
      if (Math.abs(videoEl.currentTime - want) > 0.001) {
        videoEl.currentTime = want
        if (texture) texture.needsUpdate = true
      }
    }
  })

  // ── Direct manipulation: drag the centre to move, drag near the
  // frame to resize ("pinch near the frame"). ──
  // World-units-per-CSS-pixel at the overlay's depth, so a pointer
  // delta maps 1:1 to a position / width delta regardless of zoom.
  const worldPerPixel = () => {
    const persp = camera as THREE.PerspectiveCamera
    const dist = Math.abs(camera.position.z - OVERLAY_Z)
    const halfH = dist * Math.tan((persp.fov * Math.PI) / 360)
    return size.height > 0 ? (2 * halfH) / size.height : 0
  }

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      const wpp = worldPerPixel()
      const dx = (e.clientX - d.startX) * wpp
      const dy = (e.clientY - d.startY) * wpp
      if (d.mode === 'move') {
        useStore.getState().updateSettings({
          handVideoPosX: d.startPosX + dx,
          handVideoPosY: d.startPosY - dy, // screen-y is inverted
        })
      } else {
        // Project the drag onto the outward direction from the clip
        // centre to the grab point — dragging the frame outward grows,
        // inward shrinks. ×2 because the centre stays put while both
        // sides move.
        const proj = dx * d.radialX + -dy * d.radialY
        useStore.getState().updateSettings({
          handVideoScale: Math.max(0.2, d.startScale + 2 * proj),
        })
      }
    }
    const endDrag = () => {
      if (!dragRef.current) return
      dragRef.current = null
      setDragging(false)
      useStore.getState().endSettingsEdit()
      gl.domElement.style.cursor = ''
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', endDrag)
    window.addEventListener('pointercancel', endDrag)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', endDrag)
      window.removeEventListener('pointercancel', endDrag)
      endDrag()
    }
  }, [camera, size, gl])

  if (!texture || !s.handVideoEnabled) return null

  const width = s.handVideoScale
  const height = width / (aspect || 16 / 9)
  material.uniforms.uSize.value.set(width, height)

  // Normalised local grab position → the resize cursor for that edge /
  // corner, or 'grab' for the central move zone.
  const cursorFor = (lx: number, ly: number): string => {
    const nx = Math.abs(lx) > RESIZE_EDGE_FRACTION
    const ny = Math.abs(ly) > RESIZE_EDGE_FRACTION
    if (nx && ny)
      return Math.sign(lx) === Math.sign(ly) ? 'nesw-resize' : 'nwse-resize'
    if (nx) return 'ew-resize'
    if (ny) return 'ns-resize'
    return 'grab'
  }
  const localOf = (e: ThreeEvent<PointerEvent>) => {
    const cfg = useStore.getState().settings
    return {
      lx: (e.point.x - cfg.handVideoPosX) / (width / 2),
      ly: (e.point.y - cfg.handVideoPosY) / (height / 2),
    }
  }

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    // While playing, the click belongs to the play/pause toggle area
    // behind the overlay — don't stopPropagation, let it fall through.
    if (useStore.getState().transport === 'playing') return
    if (e.nativeEvent.button !== 0) return
    e.stopPropagation()
    const cfg = useStore.getState().settings
    const { lx, ly } = localOf(e)
    // Resize only once the clip is already selected (the frame is
    // visible to aim at); the first click just selects + can move.
    const nearFrame =
      selected &&
      (Math.abs(lx) > RESIZE_EDGE_FRACTION ||
        Math.abs(ly) > RESIZE_EDGE_FRACTION)
    const len = Math.hypot(lx, ly) || 1
    dragRef.current = {
      mode: nearFrame ? 'scale' : 'move',
      startX: e.nativeEvent.clientX,
      startY: e.nativeEvent.clientY,
      startPosX: cfg.handVideoPosX,
      startPosY: cfg.handVideoPosY,
      startScale: cfg.handVideoScale,
      radialX: lx / len,
      radialY: ly / len,
    }
    setSelected(true)
    setDragging(true)
    // One begin/end pair per gesture → the whole drag is one undo entry.
    useStore.getState().beginSettingsEdit()
    gl.domElement.style.cursor = nearFrame ? cursorFor(lx, ly) : 'grabbing'
  }
  const onPointerMove = (e: ThreeEvent<PointerEvent>) => {
    if (dragRef.current || !editable) return
    e.stopPropagation()
    // Resize cursors only matter when the frame is up (selected);
    // otherwise it's a plain grab.
    const { lx, ly } = localOf(e)
    gl.domElement.style.cursor = selected ? cursorFor(lx, ly) : 'grab'
  }
  const onPointerOver = () => {
    if (!editable) return
    if (!dragRef.current) gl.domElement.style.cursor = 'grab'
  }
  const onPointerOut = () => {
    if (!dragRef.current) gl.domElement.style.cursor = ''
  }
  const onPointerMissed = () => setSelected(false)
  const onContextMenu = (e: ThreeEvent<MouseEvent>) => {
    if (useStore.getState().transport === 'playing') return
    e.stopPropagation()
    e.nativeEvent.preventDefault()
    useHandVideoMenu
      .getState()
      .openAt(e.nativeEvent.clientX, e.nativeEvent.clientY)
  }

  return (
    <mesh
      position={[s.handVideoPosX, s.handVideoPosY, OVERLAY_Z]}
      renderOrder={OVERLAY_RENDER_ORDER}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerOver={onPointerOver}
      onPointerOut={onPointerOut}
      onPointerMissed={onPointerMissed}
      onContextMenu={onContextMenu}
    >
      <planeGeometry args={[width, height]} />
      <primitive object={material} attach="material" />
    </mesh>
  )
}

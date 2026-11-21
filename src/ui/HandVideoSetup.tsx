import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as THREE from 'three'
import { useStore } from '../store'
import { Slider, SliderTrack } from 'react-aria-components'
import { Button, Divider, Icon, Island, KnobThumb } from './kit'
import { useHandVideo } from '../video/handVideo'
import { HAND_VIDEO_PLANE_Z, PLANE_KEY_LENGTH, applyH, type Mat3, type Vec2 } from '../video/geometry'
import {
  MAX_RANGE_FRONT,
  OCTAVE,
  currentH,
  pictureExtent,
  makePins,
  planeToWorld,
  refit,
  shiftFits,
  shiftH,
  visibleKeys,
  whiteKeyName,
  worldToPlane,
  type DisplayRange,
  type Pin,
} from '../video/setupGeometry'
import {
  automaticPlacement,
  cancelHandVideoSetup,
  finishHandVideoSetup,
  handVideoEdit,
  placeAtCurrentFrame,
  restoreAutomatic,
  handVideoSetupIsNew,
  setHandVideoSetupStep,
  setSetupTransparency,
  setupVideoTime,
  useSetupTransparency,
} from '../video/setup'
import { getR3FState } from '../scene/exportBridge'

/**
 * The hand video setup, one temporary mode over the scene with one strong-glass bar at the top
 * (state in `video/setup.ts`, placement maths in `video/setupGeometry.ts`):
 * - finding: the detector is running;
 * - confirm: the finished look; the octave stepper / sideways drag when the detector could not see
 *   the keyboard's ends; the see-through slider; "Fix by hand";
 * - failure: nothing found, Cancel or place by hand;
 * - fix: four white pins on key corners of the video, dragged onto the same key corners of the 3D
 *   keys; the video is refitted to them live (the overlay below is only the pins and the pointer
 *   surface, the picture itself is `scene/HandVideoLayer`).
 */
export function HandVideoSetup() {
  const step = useHandVideo((s) => s.editing)
  if (step === null) return null
  return <SetupMode step={step} />
}

/** Screen ↔ keyboard plane for the canvas as it is now (camera, lens shift). */
function projector() {
  const state = getR3FState()
  if (!state) return null
  const { camera, gl } = state
  const rect = gl.domElement.getBoundingClientRect()
  const toScreen = (plane: Vec2): Vec2 => {
    const w = planeToWorld(plane)
    const v = new THREE.Vector3(w[0], w[1], HAND_VIDEO_PLANE_Z).project(camera)
    return [rect.left + ((v.x + 1) / 2) * rect.width, rect.top + ((1 - v.y) / 2) * rect.height]
  }
  const fromScreen = (cx: number, cy: number): Vec2 | null => {
    const ndc = new THREE.Vector3(((cx - rect.left) / rect.width) * 2 - 1, 1 - ((cy - rect.top) / rect.height) * 2, 0.5).unproject(camera)
    const dir = ndc.sub(camera.position)
    if (Math.abs(dir.z) < 1e-9) return null
    const k = (HAND_VIDEO_PLANE_Z - camera.position.z) / dir.z
    if (k <= 0) return null
    return worldToPlane([camera.position.x + dir.x * k, camera.position.y + dir.y * k])
  }
  return { toScreen, fromScreen }
}

function aspectOf(): number {
  const el = useHandVideo.getState().element
  return (el?.videoWidth || 16) / (el?.videoHeight || 9)
}

function liveH(): Mat3 {
  return currentH(useStore.getState().settings.handVideoKeys, setupVideoTime(), aspectOf())
}

function SetupMode({ step }: { step: 'confirm' | 'fix' | 'range' }) {
  const { t } = useTranslation('video')
  const detect = useHandVideo((s) => s.detect)
  const keys = useStore((s) => s.settings.handVideoKeys)
  const bend = useStore((s) => s.settings.handVideoBend)
  const octaveKnown = useStore((s) => s.settings.handVideoOctaveKnown)
  const transparency = useSetupTransparency((s) => s.transparency)
  const softness = useStore((s) => s.settings.handVideoRangeSoftness)
  const hasRange = useStore((s) => s.settings.handVideoRange !== null)
  const finding = step !== 'range' && detect.state === 'finding'
  const failed = step === 'confirm' && detect.state === 'failed'

  // Esc cancels, Enter is OK (unless a button has the focus: then Enter presses it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        cancelHandVideoSetup()
      } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement) && !finding && !failed) {
        e.preventDefault()
        e.stopImmediatePropagation()
        finishHandVideoSetup()
      } else if (e.key === ' ' && !e.shiftKey && !finding && !failed && !(e.target instanceof HTMLElement && e.target.closest('button, input, textarea, [role="slider"]'))) {
        // Space plays / pauses the video in Fix; in Confirm it does nothing.
        e.preventDefault()
        e.stopImmediatePropagation()
        if (step === 'fix' || step === 'range') {
          const el = useHandVideo.getState().element
          if (el) void (el.paused ? el.play().catch(() => {}) : el.pause())
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [finding, failed, step])

  const aspect = aspectOf()
  const H = useMemo(() => currentH(keys, setupVideoTime(), aspect), [keys, aspect])
  const range = useMemo(() => visibleKeys(H, bend, aspect), [H, bend, aspect])
  const rangeLabel = range ? `${whiteKeyName(range.lo)} – ${whiteKeyName(range.hi)}` : '–'

  const stepOctave = (d: number) => {
    const h = liveH()
    if (!shiftFits(h, useStore.getState().settings.handVideoBend, aspect, OCTAVE * d)) return
    handVideoEdit(() => placeAtCurrentFrame(shiftH(h, OCTAVE * d), 'manual'))
  }
  const canStep = (d: number) => shiftFits(H, bend, aspect, OCTAVE * d)

  const [pins, setPins] = useState<Pin[]>([])
  useEffect(() => {
    if (step === 'fix') setPins(makePins(liveH(), useStore.getState().settings.handVideoBend, aspectOf()))
    // Pins are taken once per entry into the step (and after "Back to automatic").
  }, [step])
  const backToAutomatic = () => {
    restoreAutomatic()
    setPins(makePins(liveH(), useStore.getState().settings.handVideoBend, aspectOf()))
  }

  const softnessEdit = useRef(false)
  const transparencySlider = (
    <BarSlider label={t('setup.transparency')} value={transparency} min={0} max={0.95} step={0.05} onChange={setSetupTransparency} />
  )
  const softnessSlider = (
    <BarSlider
      label={t('setup.softness')}
      value={softness}
      min={0}
      max={2}
      step={0.05}
      onChange={(v) => {
        // One undo entry per slider gesture: opened by its first change, closed when it ends.
        if (!softnessEdit.current) {
          softnessEdit.current = true
          useStore.getState().beginSettingsEdit()
        }
        useStore.getState().updateSettings({ handVideoRangeSoftness: v })
      }}
      onChangeEnd={() => {
        if (softnessEdit.current) useStore.getState().endSettingsEdit()
        softnessEdit.current = false
      }}
    />
  )

  let bar: React.ReactNode
  if (step === 'range') {
    bar = (
      <>
        <Message title={t('setup.rangeTitle')} />
        <Divider vertical />
        {softnessSlider}
        <Divider vertical />
        <Button isDisabled={!hasRange} onPress={() => handVideoEdit(() => useStore.getState().updateSettings({ handVideoRange: null }))}>
          {t('setup.rangeReset')}
        </Button>
        <Button variant="primary" icon={<Icon.CheckIcon />} onPress={finishHandVideoSetup}>
          {t('setup.done')}
        </Button>
      </>
    )
  } else if (finding) {
    bar = (
      <>
        <span aria-hidden className="mx-2 h-4 w-4 flex-none animate-spin rounded-full border-2 border-ink-faint border-t-ink" />
        <Message title={t('setup.finding')} />
        <Divider vertical />
        <Button onPress={cancelHandVideoSetup}>{t('setup.cancel')}</Button>
      </>
    )
  } else if (failed) {
    bar = (
      <>
        <Message title={t('setup.failedTitle')} />
        <Divider vertical />
        <Button variant="primary" onPress={cancelHandVideoSetup}>
          {t(handVideoSetupIsNew() ? 'setup.failedRemove' : 'setup.failedClose')}
        </Button>
      </>
    )
  } else if (step === 'confirm') {
    bar = (
      <>
        <Message title={t('setup.foundTitle')} />
        <Divider vertical />
        {transparencySlider}
        <Divider vertical />
        {!octaveKnown && (
          <>
            <span className="flex flex-none items-center">
              <Button size="sm" className="px-1.5" aria-label={t('setup.octaveDown')} isDisabled={!canStep(-1)} onPress={() => stepOctave(-1)}>
                <Icon.ChevronLeftIcon className="h-4 w-4" />
              </Button>
              <span className="min-w-[88px] text-center tabular-nums" aria-live="polite">
                {rangeLabel}
              </span>
              <Button size="sm" className="px-1.5" aria-label={t('setup.octaveUp')} isDisabled={!canStep(1)} onPress={() => stepOctave(1)}>
                <Icon.ChevronRightIcon className="h-4 w-4" />
              </Button>
            </span>
            <Divider vertical />
          </>
        )}
        <Button onPress={() => setHandVideoSetupStep('fix')}>{t('setup.fix')}</Button>
        <Button variant="primary" icon={<Icon.CheckIcon />} onPress={finishHandVideoSetup}>
          {t('setup.ok')}
        </Button>
      </>
    )
  } else {
    bar = (
      <>
        <Message title={t('setup.fixTitle')} />
        <Divider vertical />
        {transparencySlider}
        <Divider vertical />
        {automaticPlacement() && <Button onPress={backToAutomatic}>{t('setup.backToAutomatic')}</Button>}
        <Button variant="primary" icon={<Icon.CheckIcon />} onPress={finishHandVideoSetup}>
          {t('setup.ok')}
        </Button>
      </>
    )
  }

  return (
    <>
      {step === 'range' ? (
        <RangeSurface />
      ) : (
        <Surface step={step} dragOctaves={step === 'confirm' && !finding && !failed && !octaveKnown} pins={step === 'fix' ? pins : null} />
      )}
      <div className="pointer-events-none fixed inset-x-0 top-4 z-30 flex justify-center">
        <Island strong role="group" aria-label={t('setup.label')} className="nf-enter-fade pointer-events-auto max-w-[calc(100vw-32px)]">
          {bar}
        </Island>
      </div>
    </>
  )
}

function BarSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  onChangeEnd,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  onChangeEnd?: () => void
}) {
  return (
    <Slider
      aria-label={label}
      value={value}
      minValue={min}
      maxValue={max}
      step={step}
      onChange={onChange}
      onChangeEnd={onChangeEnd && (() => onChangeEnd())}
      className="flex flex-none items-center gap-2 px-2"
    >
      <span className="text-label">{label}</span>
      <SliderTrack className="relative h-7 w-24 cursor-pointer">
        {({ state }) => (
          <>
            <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-[2px] bg-fill-track" />
            <div className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-[2px] bg-ink" style={{ width: `${state.getThumbPercent(0) * 100}%` }} />
            <KnobThumb small />
          </>
        )}
      </SliderTrack>
    </Slider>
  )
}

// One short line per step: the controls beside it say the rest (the user found two-line captions dense).
function Message({ title }: { title: string }) {
  return <span className="min-w-0 truncate px-3 font-medium">{title}</span>
}

/**
 * The pointer surface over the canvas (the keys under it are a play surface, so nothing reaches
 * them while the setup is open): the sideways octave drag in confirm, the pins in fix.
 */
function Surface({ step, dragOctaves, pins }: { step: 'confirm' | 'fix'; dragOctaves: boolean; pins: Pin[] | null }) {
  const pinEls = useRef<(HTMLDivElement | null)[]>([])
  const drag = useRef<
    | { kind: 'octave'; id: number; h0: Mat3; x0: number; perOctave: number; applied: number }
    | { kind: 'pin'; id: number; index: number; h0: Mat3; offset: Vec2 }
    | null
  >(null)

  // Keep the pins on the picture points they are fixed to (follows undo, the camera, resizes).
  useEffect(() => {
    if (!pins) return
    let raf = 0
    const loop = () => {
      const proj = projector()
      if (proj) {
        const h = liveH()
        pins.forEach((pin, i) => {
          const el = pinEls.current[i]
          const p = applyH(h, pin.src)
          if (!el || !p) return
          const [x, y] = proj.toScreen(p)
          el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`
          el.style.visibility = 'visible'
        })
      }
      raf = requestAnimationFrame(loop)
    }
    loop()
    return () => cancelAnimationFrame(raf)
  }, [pins])

  const end = () => {
    if (!drag.current) return
    drag.current = null
    useStore.getState().endSettingsEdit()
  }
  useEffect(() => () => end(), [])

  const onSurfaceDown = (e: React.PointerEvent) => {
    if (!dragOctaves || e.button !== 0) return
    const proj = projector()
    if (!proj) return
    const [a, b] = [proj.toScreen([26, 1]), proj.toScreen([26 + OCTAVE, 1])]
    const perOctave = b[0] - a[0]
    if (Math.abs(perOctave) < 1) return
    e.currentTarget.setPointerCapture(e.pointerId)
    useStore.getState().beginSettingsEdit()
    drag.current = { kind: 'octave', id: e.pointerId, h0: liveH(), x0: e.clientX, perOctave, applied: 0 }
  }
  // The pin last grabbed is the one the arrow keys nudge (Shift = ×10, in screen pixels).
  const selected = useRef(0)
  useEffect(() => {
    if (!pins) return
    const onKey = (e: KeyboardEvent) => {
      const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key]
      if (!d || e.metaKey || e.ctrlKey || e.altKey || drag.current) return
      if (e.target instanceof HTMLElement && e.target.closest('input, textarea, [role="slider"]')) return
      const proj = projector()
      const h0 = liveH()
      const here = applyH(h0, pins[selected.current].src)
      if (!proj || !here) return
      e.preventDefault()
      e.stopImmediatePropagation()
      const step = e.shiftKey ? 10 : 1
      const [x, y] = proj.toScreen(here)
      const to = proj.fromScreen(x + d[0] * step, y + d[1] * step)
      if (!to) return
      const targets = pins.map((p, i) => (i === selected.current ? to : applyH(h0, p.src)))
      if (targets.some((p) => p === null)) return
      const h = refit(pins, targets as Vec2[])
      if (h) handVideoEdit(() => placeAtCurrentFrame(h, 'manual'))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [pins])
  const onPinDown = (e: React.PointerEvent, index: number) => {
    if (!pins || e.button !== 0) return
    selected.current = index
    const proj = projector()
    const h0 = liveH()
    const here = applyH(h0, pins[index].src)
    const ptr = proj?.fromScreen(e.clientX, e.clientY)
    if (!proj || !here || !ptr) return
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    useStore.getState().beginSettingsEdit()
    drag.current = { kind: 'pin', id: e.pointerId, index, h0, offset: [ptr[0] - here[0], ptr[1] - here[1]] }
  }
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    if (d.kind === 'octave') {
      const n = Math.round((e.clientX - d.x0) / d.perOctave)
      if (n === d.applied) return
      const bend = useStore.getState().settings.handVideoBend
      if (!shiftFits(d.h0, bend, aspectOf(), OCTAVE * n)) return
      d.applied = n
      placeAtCurrentFrame(n === 0 ? d.h0 : shiftH(d.h0, OCTAVE * n), 'manual')
    } else if (pins) {
      const ptr = projector()?.fromScreen(e.clientX, e.clientY)
      if (!ptr) return
      const targets = pins.map((p, i) => (i === d.index ? ([ptr[0] - d.offset[0], ptr[1] - d.offset[1]] as Vec2) : applyH(d.h0, p.src)))
      if (targets.some((p) => p === null)) return
      const h = refit(pins, targets as Vec2[])
      if (h) placeAtCurrentFrame(h, 'manual')
    }
  }

  return (
    <div
      className="fixed inset-0 z-20 touch-none select-none"
      style={{ cursor: dragOctaves ? 'ew-resize' : undefined }}
      data-hand-video-setup={step}
      onPointerDown={onSurfaceDown}
      onPointerMove={onMove}
      onPointerUp={end}
      onPointerCancel={end}
    >
      {pins?.map((_, i) => (
        <div
          key={i}
          ref={(el) => {
            pinEls.current[i] = el
          }}
          data-pin={i}
          style={{ visibility: 'hidden' }}
          className="fixed left-0 top-0 grid h-9 w-9 cursor-grab place-items-center active:cursor-grabbing"
          onPointerDown={(e) => onPinDown(e, i)}
        >
          <span className="h-[18px] w-[18px] rounded-round border-2 border-on-ink bg-ink shadow-knob" />
        </div>
      ))}
    </div>
  )
}

type Side = 'left' | 'right' | 'front'

/**
 * The display range editor's pointer surface: a frame outline over the 3D keyboard (plane coordinates, so it
 * stays on the keys whatever the camera does) with three handles. Left / right snap to white-key boundaries
 * (Shift = free) and show the key name at the edge while dragged; front is free. ⌘-click a handle puts that
 * side back to the whole video (what the picture covers). The cut itself is drawn by the video layer.
 */
function RangeSurface() {
  const { t } = useTranslation('video')
  const poly = useRef<SVGPolygonElement>(null)
  const handles = useRef<Record<Side, HTMLDivElement | null>>({ left: null, right: null, front: null })
  const tag = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState<Side | null>(null)
  const drag = useRef<{ side: Side; id: number; base: DisplayRange } | null>(null)
  const extentCache = useRef<{ key: string; value: DisplayRange } | null>(null)

  /** What the picture covers now: the range's starting point and what ⌘-click returns a side to. */
  const extent = (): DisplayRange => {
    const h = liveH()
    const bend = useStore.getState().settings.handVideoBend
    const aspect = aspectOf()
    const key = `${h.join(',')}|${bend}|${aspect}`
    const proj = projector()
    // Not below the bottom of the window, so the front handle stays within reach.
    const bottom = proj?.fromScreen(window.innerWidth / 2, window.innerHeight - 56)
    const cap = bottom ? Math.max(0.5, -bottom[1]) : MAX_RANGE_FRONT
    const full = `${key}|${cap.toFixed(2)}`
    if (extentCache.current?.key !== full) {
      const e = pictureExtent(h, bend, aspect)
      extentCache.current = { key: full, value: { ...e, front: Math.min(e.front, cap) } }
    }
    return extentCache.current.value
  }
  const current = (): DisplayRange => useStore.getState().settings.handVideoRange ?? extent()

  useEffect(() => {
    let raf = 0
    const loop = () => {
      const proj = projector()
      if (proj) {
        const r = current()
        const top = PLANE_KEY_LENGTH
        const corners = [proj.toScreen([r.left, top]), proj.toScreen([r.right, top]), proj.toScreen([r.right, -r.front]), proj.toScreen([r.left, -r.front])]
        poly.current?.setAttribute('points', corners.map((c) => `${c[0]},${c[1]}`).join(' '))
        const mid = (top - r.front) / 2
        const at: Record<Side, Vec2> = { left: [r.left, mid], right: [r.right, mid], front: [(r.left + r.right) / 2, -r.front] }
        for (const side of ['left', 'right', 'front'] as const) {
          const el = handles.current[side]
          if (!el) continue
          const [x0, y0] = proj.toScreen(at[side])
          // Kept inside the window (the frame can reach past it).
          const x = Math.min(window.innerWidth - 24, Math.max(24, x0))
          const y = Math.min(window.innerHeight - 24, Math.max(24, y0))
          el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`
          el.style.visibility = 'visible'
        }
        const a = drag.current?.side
        if (tag.current && a && a !== 'front') {
          const [x, y] = proj.toScreen(at[a])
          tag.current.textContent = whiteKeyName(a === 'left' ? Math.min(51, Math.floor(r.left + 0.5)) : Math.max(0, Math.ceil(r.right - 0.5) - 1))
          tag.current.style.transform = `translate(${x}px, ${y}px) translate(${a === 'left' ? 'calc(-100% - 16px)' : '16px'}, -50%)`
        }
      }
      raf = requestAnimationFrame(loop)
    }
    loop()
    return () => cancelAnimationFrame(raf)
  }, [])

  const end = () => {
    if (!drag.current) return
    drag.current = null
    setActive(null)
    useStore.getState().endSettingsEdit()
  }
  useEffect(() => () => end(), [])

  const onDown = (e: React.PointerEvent, side: Side) => {
    if (e.button !== 0) return
    e.stopPropagation()
    if (e.metaKey || e.ctrlKey) {
      // Put this side back to the whole video.
      const r = useStore.getState().settings.handVideoRange
      if (!r) return
      const ext = extent()
      handVideoEdit(() => useStore.getState().updateSettings({ handVideoRange: { ...r, [side]: ext[side] } }))
      return
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    useStore.getState().beginSettingsEdit()
    drag.current = { side, id: e.pointerId, base: current() }
    setActive(side)
  }
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    const ptr = projector()?.fromScreen(e.clientX, e.clientY)
    if (!ptr) return
    const free = e.shiftKey
    const b = d.base
    const minSpan = free ? 0.25 : 1
    let next: DisplayRange
    if (d.side === 'left') {
      const v = Math.max(0, Math.min(b.right - minSpan, free ? ptr[0] : Math.round(ptr[0])))
      next = { ...b, left: v }
    } else if (d.side === 'right') {
      const v = Math.min(52, Math.max(b.left + minSpan, free ? ptr[0] : Math.round(ptr[0])))
      next = { ...b, right: v }
    } else {
      next = { ...b, front: Math.max(0, Math.min(MAX_RANGE_FRONT, Math.round(-ptr[1] * 20) / 20)) }
    }
    useStore.getState().updateSettings({ handVideoRange: next })
  }

  const knob = (side: Side, label: string, cursor: string) => (
    <div
      key={side}
      ref={(el) => {
        handles.current[side] = el
      }}
      data-range-handle={side}
      role="slider"
      aria-label={label}
      style={{ visibility: 'hidden', cursor }}
      className="fixed left-0 top-0 grid h-9 w-9 place-items-center"
      onPointerDown={(e) => onDown(e, side)}
    >
      <span className="h-[18px] w-[18px] rounded-round border-2 border-on-ink bg-ink shadow-knob" />
    </div>
  )

  return (
    <div className="fixed inset-0 z-20 touch-none select-none" data-hand-video-setup="range" onPointerMove={onMove} onPointerUp={end} onPointerCancel={end}>
      <svg aria-hidden className="pointer-events-none absolute inset-0 h-full w-full">
        <polygon ref={poly} fill="none" className="stroke-ink" strokeWidth={2} strokeDasharray="6 4" />
      </svg>
      {knob('left', t('setup.rangeLeft'), 'ew-resize')}
      {knob('right', t('setup.rangeRight'), 'ew-resize')}
      {knob('front', t('setup.rangeFront'), 'ns-resize')}
      {active && active !== 'front' && (
        <div ref={tag} className="nf-glass-strong pointer-events-none fixed left-0 top-0 rounded-field px-2 py-1 text-label tabular-nums" />
      )}
    </div>
  )
}

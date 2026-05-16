import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Slider, SliderThumb, SliderTrack } from 'react-aria-components'
import { create } from 'zustand'
import { useStore } from '../store'
import { useHandVideo } from '../notes/handVideo'
import { CloseIcon } from './icons'

/**
 * The hand-video settings menu. Shared by the timeline clip / lane
 * header right-click AND the right-click on the video overlay in the
 * 3D scene, so both surface the same controls. Visual style mirrors
 * `LaneContextMenu` (same container, slider, and button treatment) so
 * it reads as one family of menus.
 */

type MenuState = {
  open: boolean
  x: number
  y: number
  openAt: (x: number, y: number) => void
  close: () => void
}

export const useHandVideoMenu = create<MenuState>((set) => ({
  open: false,
  x: 0,
  y: 0,
  openAt: (x, y) => set({ open: true, x, y }),
  close: () => set({ open: false }),
}))

export function HandVideoContextMenu() {
  const open = useHandVideoMenu((s) => s.open)
  const x = useHandVideoMenu((s) => s.x)
  const y = useHandVideoMenu((s) => s.y)
  const close = useHandVideoMenu((s) => s.close)

  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState({ x, y })

  const opacity = useStore((s) => s.settings.handVideoOpacity)
  const brightness = useStore((s) => s.settings.handVideoBrightness)
  const updateSettings = useStore((s) => s.updateSettings)
  const beginEdit = useStore((s) => s.beginSettingsEdit)
  const endEdit = useStore((s) => s.endSettingsEdit)
  const fileName = useHandVideo((s) => s.fileName)
  const setFile = useHandVideo((s) => s.setFromFile)

  // Clamp to the viewport so a right-click near an edge still reveals
  // the full panel (measured after mount; size depends on content).
  useLayoutEffect(() => {
    if (!open) return
    const el = ref.current
    if (!el) return
    const clamp = () => {
      const rect = el.getBoundingClientRect()
      const margin = 8
      const maxX = window.innerWidth - rect.width - margin
      const maxY = window.innerHeight - rect.height - margin
      setPos({
        x: Math.max(margin, Math.min(maxX, x)),
        y: Math.max(margin, Math.min(maxY, y)),
      })
    }
    clamp()
    window.addEventListener('resize', clamp)
    return () => window.removeEventListener('resize', clamp)
  }, [open, x, y])

  // Click-outside / Esc to dismiss. Capture phase so it closes before
  // another surface starts a drag underneath.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!ref.current) return
      if (!ref.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('pointerdown', onDown, { capture: true })
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown, { capture: true })
      window.removeEventListener('keydown', onKey)
    }
  }, [open, close])

  if (!open) return null

  const sliderRow = (
    label: string,
    value: number,
    min: number,
    max: number,
    onVal: (v: number) => void,
  ) => (
    <div className="px-2 py-1.5">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-neutral-400">{label}</span>
        <span className="font-mono text-[11px] text-neutral-300">
          {value.toFixed(2)}
        </span>
      </div>
      <Slider
        value={value}
        minValue={min}
        maxValue={max}
        step={0.01}
        onChange={(v) => onVal(typeof v === 'number' ? v : v[0])}
        onChangeEnd={() => endEdit()}
        aria-label={label}
      >
        <SliderTrack className="relative flex h-3 w-full cursor-pointer items-center">
          {({ state }) => (
            <>
              <div className="relative h-1 w-full overflow-visible rounded-full bg-neutral-700">
                <div
                  className="h-full rounded-full bg-sky-500/80"
                  style={{ width: `${state.getThumbPercent(0) * 100}%` }}
                />
              </div>
              <SliderThumb className="sr-only" />
            </>
          )}
        </SliderTrack>
      </Slider>
    </div>
  )

  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-50 w-60 rounded-md border border-white/10 bg-neutral-900/95 p-1.5 text-xs text-neutral-200 shadow-xl backdrop-blur-md"
      style={{ left: pos.x, top: pos.y }}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        className="mb-1 truncate px-2 pt-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-500"
        title={fileName ?? 'Hand video'}
      >
        {fileName ?? 'Hand video'}
      </div>
      {sliderRow('Opacity', opacity, 0, 1, (v) => {
        beginEdit()
        updateSettings({ handVideoOpacity: v })
      })}
      {sliderRow('Brightness', brightness, 0, 3, (v) => {
        beginEdit()
        updateSettings({ handVideoBrightness: v })
      })}
      <button
        type="button"
        onClick={() => {
          beginEdit()
          updateSettings({ handVideoOpacity: 1, handVideoBrightness: 1 })
          endEdit()
        }}
        className="flex w-full items-center rounded px-2 py-1.5 text-left text-neutral-300 hover:bg-neutral-700/60"
      >
        Reset opacity / brightness
      </button>
      <button
        type="button"
        onClick={() => {
          void setFile(null)
          close()
        }}
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-rose-300 hover:bg-rose-900/30"
      >
        <CloseIcon className="h-2.5 w-2.5" /> Remove video
      </button>
    </div>
  )
}

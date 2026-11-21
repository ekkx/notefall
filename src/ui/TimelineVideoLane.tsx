import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useUNSAFE_PortalContext } from 'react-aria'
import { useTranslation } from 'react-i18next'
import { useStore } from '../store'
import { useHandVideo, type HandVideoThumbs } from '../video/handVideo'
import { openHandVideoSetup } from '../video/setup'
import { Icon } from './kit'

/**
 * The hand video's timeline lane: the clip as a strip of thumbnails (the
 * picture at each moment, not a waveform), dragged to move it in time and
 * trimmed at its ends, like the audio clip. Placement keys (camera drift,
 * `handVideoKeys`) show as ◆ along its foot. Rendered by `Timeline.tsx`,
 * which owns the shared time axis.
 */

const MIN_CLIP_DURATION = 0.05

/** Thumbnails tiled along the clip; tile k always shows the same video time, so scrolling doesn't shimmer. */
function ThumbStrip({
  thumbs,
  width,
  height,
  pxPerSec,
  startInVideoSec,
}: {
  thumbs: HandVideoThumbs | null
  width: number
  height: number
  pxPerSec: number
  startInVideoSec: number
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    cv.width = Math.max(1, Math.round(width * dpr))
    cv.height = Math.max(1, Math.round(height * dpr))
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    if (!thumbs || pxPerSec <= 0) return
    const tw = Math.max(8, (height * thumbs.width) / thumbs.height)
    const x0 = startInVideoSec * pxPerSec
    for (let k = Math.floor(x0 / tw); k * tw - x0 < width; k++) {
      const x = k * tw - x0
      const tMid = (k * tw + tw / 2) / pxPerSec
      const img = thumbs.images[Math.max(0, Math.min(thumbs.images.length - 1, Math.floor(tMid / thumbs.step)))]
      if (img) ctx.drawImage(img, x, 0, tw, height)
    }
  }, [thumbs, width, height, pxPerSec, startInVideoSec])
  return <canvas ref={ref} className="pointer-events-none absolute left-0 top-0" style={{ width, height }} />
}

function EdgeHandle({
  side,
  height,
  label,
  onDown,
  onMove,
  onUp,
}: {
  side: 'left' | 'right'
  height: number
  label: string
  onDown: (e: React.PointerEvent<HTMLDivElement>) => void
  onMove: (e: React.PointerEvent<HTMLDivElement>) => void
  onUp: (e: React.PointerEvent<HTMLDivElement>) => void
}) {
  const { t } = useTranslation('timeline')
  return (
    <div
      aria-label={label}
      title={t('trim.drag')}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      className="group absolute top-0 z-10 cursor-ew-resize"
      style={{ [side]: 0, width: 10, height, touchAction: 'none' }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink-muted shadow-knob transition-colors group-hover:bg-ink"
        style={{ width: 3, height: Math.round(height * 0.55) }}
      />
    </div>
  )
}

export function HandVideoLane({
  height,
  areaWidth,
  pxPerSec,
  clampedScroll,
  viewDuration,
  onContextMenu,
}: {
  height: number
  areaWidth: number
  pxPerSec: number
  clampedScroll: number
  viewDuration: number
  onContextMenu: (e: React.MouseEvent) => void
}) {
  const { t } = useTranslation('video')
  const duration = useHandVideo((s) => s.duration)
  const thumbs = useHandVideo((s) => s.thumbs)
  const offset = useStore((s) => s.settings.handVideoOffsetSec)
  const trimStart = useStore((s) => s.settings.handVideoTrimStartSec)
  const trimEndRaw = useStore((s) => s.settings.handVideoTrimEndSec)
  const keys = useStore((s) => s.settings.handVideoKeys)
  const enabled = useStore((s) => s.settings.handVideoEnabled)
  const trimEnd = trimEndRaw ?? duration

  const clipStart = offset + trimStart
  const clipEnd = offset + trimEnd
  const visStart = Math.max(clampedScroll, clipStart)
  const visEnd = Math.min(clampedScroll + viewDuration, clipEnd)
  const left = (visStart - clampedScroll) * pxPerSec
  const width = Math.max(0, (visEnd - visStart) * pxPerSec)
  const startInVideo = Math.max(0, visStart - offset)

  const drag = useRef<{ kind: 'move' | 'left' | 'right'; x: number; offset: number; trimStart: number; trimEnd: number } | null>(null)
  const begin = (kind: 'move' | 'left' | 'right') => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.stopPropagation()
    drag.current = { kind, x: e.clientX, offset, trimStart, trimEnd }
    e.currentTarget.setPointerCapture(e.pointerId)
    useStore.getState().beginSettingsEdit()
  }
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    e.stopPropagation()
    const dt = pxPerSec > 0 ? (e.clientX - d.x) / pxPerSec : 0
    const update = useStore.getState().updateSettings
    if (d.kind === 'move') {
      // The trimmed head may not go before the timeline's start.
      update({ handVideoOffsetSec: Math.max(-d.trimStart, d.offset + dt) })
    } else if (d.kind === 'left') {
      update({ handVideoTrimStartSec: Math.max(0, Math.min(d.trimEnd - MIN_CLIP_DURATION, d.trimStart + dt)) })
    } else {
      const next = Math.max(d.trimStart + MIN_CLIP_DURATION, Math.min(duration, d.trimEnd + dt))
      update({ handVideoTrimEndSec: next >= duration - 0.001 ? null : next })
    }
  }
  const end = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    e.stopPropagation()
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }
    drag.current = null
    useStore.getState().endSettingsEdit()
  }

  const laneH = height
  const showKeys = keys.length > 1
  // A camera move is two auto keys a few samples apart (the old place held, then the new one): show it once, at the new place.
  const marks = keys
    .slice()
    .sort((a, b) => a.t - b.t)
    .filter((k, i, all) => !(k.source === 'auto' && all[i + 1] && all[i + 1].source === 'auto' && all[i + 1].t - k.t < 4))

  return (
    <div
      onContextMenu={onContextMenu}
      className="group relative overflow-hidden rounded-field bg-white/5"
      style={{ height }}
    >
      {areaWidth > 0 && width > 0 && (
        <div
          onPointerDown={begin('move')}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          className={`absolute top-0 cursor-grab overflow-hidden rounded-field bg-canvas shadow-[inset_0_0_0_1px_var(--glass-edge)] active:cursor-grabbing ${enabled ? '' : 'opacity-30 grayscale'}`}
          style={{ left, width, height: laneH, touchAction: 'none' }}
          title={t('lane.title')}
        >
          <ThumbStrip thumbs={thumbs} width={width} height={laneH} pxPerSec={pxPerSec} startInVideoSec={startInVideo} />
          {showKeys &&
            marks.map((k) => {
              const x = (offset + k.t - visStart) * pxPerSec
              if (x < -6 || x > width + 6) return null
              return (
                <span
                  key={k.t}
                  aria-hidden
                  className="pointer-events-none absolute bottom-1 h-2.5 w-2.5 -translate-x-1/2 rotate-45 rounded-[1px] border-[1.5px] border-ink bg-canvas shadow-[0_0_0_1.5px_rgb(0_0_0/0.45)]"
                  style={{ left: x }}
                />
              )
            })}
          <EdgeHandle side="left" height={laneH} label={t('lane.trimHead')} onDown={begin('left')} onMove={move} onUp={end} />
          <EdgeHandle side="right" height={laneH} label={t('lane.trimTail')} onDown={begin('right')} onMove={move} onUp={end} />
        </div>
      )}
    </div>
  )
}

/** The lane's menu: line it up with the keys again, or remove the video. */
export function HandVideoLaneMenu({ position, onClose }: { position: { x: number; y: number }; onClose: () => void }) {
  const { t } = useTranslation('video')
  const ref = useRef<HTMLDivElement>(null)
  const { getContainer } = useUNSAFE_PortalContext()
  const [pos, setPos] = useState(position)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      x: Math.max(8, Math.min(window.innerWidth - r.width - 8, position.x)),
      y: Math.max(8, Math.min(window.innerHeight - r.height - 8, position.y)),
    })
  }, [position])
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])
  // The timeline panel is glass (backdrop-filter), which makes it the containing block of `fixed`
  // children: inside it the menu landed a panel-height below the click, off screen. Portal it out
  // (to the fullscreen root when fullscreen, like react-aria's overlays).
  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="nf-glass-strong fixed z-50 w-[240px] rounded-panel p-1.5 text-body text-ink"
      style={{ left: pos.x, top: pos.y }}
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onClose()
          openHandVideoSetup('confirm')
        }}
        className="flex w-full items-center rounded-field px-2 py-1.5 text-left hover:bg-fill-hover"
      >
        {t('lane.lineUp')}
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onClose()
          openHandVideoSetup('range')
        }}
        className="flex w-full items-center rounded-field px-2 py-1.5 text-left hover:bg-fill-hover"
      >
        {t('lane.range')}
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onClose()
          useHandVideo.getState().clear()
          useStore.getState().markDirty()
        }}
        className="flex w-full items-center gap-2 rounded-field px-2 py-1.5 text-left text-danger hover:bg-fill-hover"
      >
        <Icon.CloseIcon className="h-4 w-4" /> {t('lane.removeVideo')}
      </button>
    </div>,
    getContainer?.() ?? document.body,
  )
}

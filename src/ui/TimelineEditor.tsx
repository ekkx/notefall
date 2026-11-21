import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '../store'
import { useUserAudio } from '../audio/userAudio'
import { audioEngine } from '../audio/engine'
import { useHandVideoSetupOpen } from './shell/takeFocus'
import { useHandVideo } from '../video/handVideo'
import { Button, GEOMETRY, Icon, IconButton, Panel, ToggleButton, usePresence } from './kit'
import { useShell } from './shell/uiState'
import { Timeline } from './Timeline'

/**
 * Resize handle pinned to the top edge of the editor. Drag UP to
 * grow the lane heights (`settings.timelineLaneScale`); the minimum
 * is the natural lane heights, so the user can't shrink past the
 * default. Dragging is anchored to the pointer's wall-clock Y
 * delta, divided by the combined natural height of the three lanes
 * — that way one pixel of drag translates to one pixel of total
 * editor growth, giving a "the handle follows my cursor" feel.
 */
function TimelineResizeHandle() {
  const { t } = useTranslation('timeline')
  const laneScale = useStore((s) => s.settings.timelineLaneScale)
  const updateSettings = useStore((s) => s.updateSettings)
  const dragRef = useRef<{ startY: number; startScale: number } | null>(null)
  // Natural total height of all three lanes (MIDI + audio + speed)
  // at scale=1. Drag pixel ↔ scale change uses this so the cursor
  // tracks the visual growth 1:1.
  const BASE_LANE_TOTAL = 56 + 48 + 32
  const MAX_SCALE = 4
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.stopPropagation()
    dragRef.current = { startY: e.clientY, startScale: laneScale }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d) return
    e.stopPropagation()
    const dy = e.clientY - d.startY // +ve = downward = shrink
    const nextScale = Math.max(
      1,
      Math.min(MAX_SCALE, d.startScale - dy / BASE_LANE_TOTAL),
    )
    if (nextScale !== laneScale) {
      updateSettings({ timelineLaneScale: nextScale })
    }
  }
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    e.stopPropagation()
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* capture may already be released — ignore */
    }
    dragRef.current = null
  }
  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      title={t('editor.resizeLanes')}
      aria-label={t('editor.resizeAria')}
      style={{ touchAction: 'none' }}
      className="absolute inset-x-0 top-0 z-10 h-1.5 cursor-ns-resize bg-transparent transition-colors hover:bg-fill-selected"
    />
  )
}

/**
 * Floating glass panel above the transport pill holding the multi-row
 * timeline (minimap + ruler + keyframes + MIDI / speed / audio lanes).
 * Renders nothing without a song or hand video, or while closed; the open/close
 * toggle lives in the transport pill (`settings.timelineEditorOpen`).
 */
export function TimelineEditor() {
  const { t } = useTranslation('timeline')
  const song = useStore((s) => s.song)
  const open = useStore((s) => s.settings.timelineEditorOpen)
  const follow = useStore((s) => s.settings.followPlayhead)
  const updateSettings = useStore((s) => s.updateSettings)
  const lookOpen = useShell((s) => s.lookOpen)
  const audioBuffer = useUserAudio((s) => s.buffer)
  const audioLoaded = !!audioBuffer
  // Auto-open the editor when an accompaniment becomes available —
  // sync is the editor's headline feature and the user just signalled
  // intent by loading audio. Fires on the no-audio→audio transition,
  // so manually closing afterwards stays sticky.
  useEffect(() => {
    if (audioLoaded) {
      useStore.getState().updateSettings({ timelineEditorOpen: true })
    }
  }, [audioLoaded])
  const setupOpen = useHandVideoSetupOpen()
  // A hand video alone also opens it (its lane is usable without a song).
  const hasVideo = useHandVideo((s) => s.element !== null)
  const usable = !!song || hasVideo
  const { mounted, leaving } = usePresence(open && usable && !setupOpen)
  if (!mounted || !usable) return null
  return (
    <Panel
      data-timeline-panel
      className={`nf-enter-up fixed z-20 px-3.5 py-3 transition-[right] duration-200 ease-[var(--ease-out)] ${leaving ? 'nf-leaving' : ''}`}
      style={{
        left: GEOMETRY.EDGE,
        bottom: GEOMETRY.PILL_BOTTOM + GEOMETRY.PILL + GEOMETRY.GAP,
        right: lookOpen ? GEOMETRY.EDGE + GEOMETRY.PANEL + GEOMETRY.GAP : GEOMETRY.EDGE,
      }}
    >
      <TimelineResizeHandle />
      <div className="mb-1.5 flex h-[34px] items-center gap-1">
        <h2 className="mr-auto text-heading">{t('editor.title')}</h2>
        {song && (
        <Button
            size="sm"
            icon={<Icon.PlusIcon />}
            onPress={() =>
              useStore.getState().addKeyframe(audioEngine.currentSongTime())
            }
          >
            {t('addKeyframe.label')}
          </Button>
        )}
        <ToggleButton
          isSelected={follow}
          onChange={(v) => updateSettings({ followPlayhead: v })}
          className="h-control-sm px-2.5"
        >
          {t('follow.label')}
        </ToggleButton>
        <IconButton
          size="sm"
          label={t('editor.close')}
          onPress={() => updateSettings({ timelineEditorOpen: false })}
        >
          <Icon.CloseIcon />
        </IconButton>
      </div>
      <Timeline />
    </Panel>
  )
}

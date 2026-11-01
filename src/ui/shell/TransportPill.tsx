import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useUNSAFE_PortalContext } from 'react-aria'
import { Slider, SliderTrack } from 'react-aria-components'
import clsx from 'clsx'
import { defaultSettings, useStore } from '../../store'
import { audioEngine } from '../../audio/engine'
import { pauseSong, playSong } from '../../audio/playback'
import { useCurrentTime } from '../../audio/useCurrentTime'
import { Button, Divider, GEOMETRY, Icon, IconButton, KnobThumb, ToggleButton, Tooltip } from '../kit'
import { useChromeHidden, useIdle } from './idle'
import { useTakeInProgress } from './takeFocus'
import { toggleFullscreen, useIsFullscreen } from './fullscreen'
import { shortcutLabel } from './platform'
import { useShell } from './uiState'

const SKIP_SECONDS = 10
const KEY_SEEK_SECONDS = 5
const HOVER_CLOSE_DELAY_MS = 150

/** m:ss (minutes keep counting past 59). */
function fmt(t: number): string {
  if (!isFinite(t) || t < 0) return '0:00'
  const s = Math.floor(t)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const fmtSpeed = (v: number) => {
  const r = Number(v.toFixed(2))
  return `${Number.isInteger(r) ? r.toFixed(1) : r}×`
}
const fmtVolume = (v: number) => `${Math.round(v * 100)}%`

function seekTo(t: number): void {
  audioEngine.seek(t)
  useStore.getState().setCurrentTime(t)
}

/** Current-time readout; owns the per-frame subscription so the pill itself stays still. */
function TimeNow() {
  const t = useCurrentTime()
  return <span className="ml-2 min-w-10 flex-none text-right tabular-nums">{fmt(t)}</span>
}

function Scrubber({ duration, enabled, label }: { duration: number; enabled: boolean; label: string }) {
  const t = useCurrentTime()
  const dragging = useRef(false)
  const frac = duration > 0 ? Math.max(0, Math.min(1, t / duration)) : 0

  const seekFromX = (clientX: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    seekTo(Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * duration)
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!enabled) return
    const cur = audioEngine.currentSongTime()
    let next: number | null = null
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = cur + KEY_SEEK_SECONDS
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = cur - KEY_SEEK_SECONDS
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = duration
    if (next === null) return
    e.preventDefault()
    // Keep the editor's own arrow shortcuts (note nudge) from also firing.
    e.stopPropagation()
    seekTo(Math.max(0, Math.min(duration, next)))
  }

  return (
    <div
      role="slider"
      tabIndex={enabled ? 0 : -1}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(t)}
      aria-valuetext={`${fmt(t)} / ${fmt(duration)}`}
      aria-disabled={!enabled}
      onPointerDown={(e) => {
        if (!enabled || e.button !== 0) return
        dragging.current = true
        e.currentTarget.setPointerCapture(e.pointerId)
        seekFromX(e.clientX, e.currentTarget)
      }}
      onPointerMove={(e) => {
        if (dragging.current) seekFromX(e.clientX, e.currentTarget)
      }}
      onPointerUp={(e) => {
        dragging.current = false
        try {
          e.currentTarget.releasePointerCapture(e.pointerId)
        } catch {
          /* capture already released */
        }
      }}
      onPointerCancel={() => {
        dragging.current = false
      }}
      onKeyDown={onKeyDown}
      style={{ touchAction: 'none' }}
      className={clsx(
        'nf-focus relative mx-3 h-7 w-[300px] min-w-24 shrink rounded-round outline-none',
        enabled ? 'cursor-pointer' : 'opacity-40',
      )}
    >
      <span className="absolute inset-x-0 top-3 h-1 rounded-[2px] bg-fill-track" />
      <span className="absolute left-0 top-3 h-1 rounded-[2px] bg-ink" style={{ width: `${frac * 100}%` }} />
      {enabled && (
        <span
          className="absolute top-[7px] -ml-[7px] h-3.5 w-3.5 rounded-full bg-ink"
          style={{ left: `${frac * 100}%` }}
        />
      )}
    </div>
  )
}

/**
 * Volume / speed: a compact slider that opens on hover (or press, for touch) above the
 * button. Portaled so it is not nested inside the pill's glass; closing is delayed so the
 * cursor can travel from the button to the popover.
 */
function HoverSlider({
  id,
  trigger,
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  id: string
  trigger: (p: {
    ref: React.RefObject<HTMLButtonElement>
    onHoverStart: () => void
    onHoverEnd: () => void
    open: () => void
  }) => ReactNode
  label: string
  value: number
  min: number
  max: number
  step: number
  format: (v: number) => string
  onChange: (v: number) => void
}) {
  const ref = useRef<HTMLButtonElement>(null)
  const timer = useRef<number | null>(null)
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null)
  const { getContainer } = useUNSAFE_PortalContext()

  const cancel = () => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
  }
  const open = () => {
    cancel()
    const r = ref.current?.getBoundingClientRect()
    if (r) setPos({ left: r.left + r.width / 2, bottom: window.innerHeight - r.top + 12 })
  }
  const scheduleClose = () => {
    cancel()
    timer.current = window.setTimeout(() => setPos(null), HOVER_CLOSE_DELAY_MS)
  }
  useEffect(() => cancel, [])
  useEffect(() => {
    useIdle.getState().hold(id, pos !== null)
    return () => useIdle.getState().hold(id, false)
  }, [id, pos])
  // Dismiss on Escape or an outside press (touch has no hover-out).
  useEffect(() => {
    if (!pos) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPos(null)
    const onDown = (e: PointerEvent) => {
      const el = e.target as HTMLElement | null
      if (!el?.closest(`[data-hover-slider="${id}"]`) && !ref.current?.contains(el)) setPos(null)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onDown)
    }
  }, [pos, id])

  const container = getContainer?.() ?? document.body
  return (
    <>
      {trigger({ ref, onHoverStart: open, onHoverEnd: scheduleClose, open })}
      {pos &&
        container &&
        createPortal(
          <div
            data-hover-slider={id}
            onMouseEnter={cancel}
            onMouseLeave={scheduleClose}
            className="nf-glass-strong nf-enter-up fixed z-[90] w-52 -translate-x-1/2 rounded-[14px] p-3.5 text-body text-ink"
            style={{ left: pos.left, bottom: pos.bottom }}
          >
            <Slider
              aria-label={label}
              value={value}
              minValue={min}
              maxValue={max}
              step={step}
              onChange={onChange}
              className="grid gap-1"
            >
              <div className="flex items-baseline justify-between">
                <span className="text-label">{label}</span>
                <span className="tabular-nums text-ink-muted">{format(value)}</span>
              </div>
              <SliderTrack className="relative h-7 w-full cursor-pointer">
                {({ state }) => (
                  <>
                    <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-[2px] bg-fill-track" />
                    <div
                      className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-[2px] bg-ink"
                      style={{ width: `${state.getThumbPercent(0) * 100}%` }}
                    />
                    <KnobThumb small />
                  </>
                )}
              </SliderTrack>
            </Slider>
          </div>,
          container,
        )}
    </>
  )
}

export function TransportPill() {
  const { t } = useTranslation('common')
  const song = useStore((s) => s.song)
  const transport = useStore((s) => s.transport)
  const loading = useStore((s) => s.loadStatus.state === 'loading')
  const loop = useStore((s) => s.loop)
  const setLoop = useStore((s) => s.setLoop)
  const volume = useStore((s) => s.settings.volume)
  const playbackRate = useStore((s) => s.settings.playbackRate)
  const timelineOpen = useStore((s) => s.settings.timelineEditorOpen)
  const updateSettings = useStore((s) => s.updateSettings)
  const beginEdit = useStore((s) => s.beginSettingsEdit)
  const endEdit = useStore((s) => s.endSettingsEdit)
  const lookOpen = useShell((s) => s.lookOpen)
  const setLookOpen = useShell((s) => s.setLookOpen)
  const takeInProgress = useTakeInProgress()
  const hidden = useChromeHidden() || takeInProgress
  const isFullscreen = useIsFullscreen()
  // The slider rescales when the speed curve or clip offset changes the TL_audio length.
  useStore((s) => s.settings.midiSpeedAutomation)
  useStore((s) => s.settings.midiOffsetSec)

  const hasSong = song !== null
  const playing = transport === 'playing'
  const duration = song ? audioEngine.midiTimeToTimeline(song.duration) : 0

  // Last audible volume, restored when un-muting.
  const lastVolume = useRef(volume > 0.001 ? volume : 0.5)
  useEffect(() => {
    if (volume > 0.001) lastVolume.current = volume
  }, [volume])
  const toggleMute = () => updateSettings({ volume: volume > 0.001 ? 0 : lastVolume.current })

  const resetCamera = () => {
    beginEdit()
    updateSettings({
      cameraFov: defaultSettings.cameraFov,
      cameraPos: defaultSettings.cameraPos,
      cameraLookAt: defaultSettings.cameraLookAt,
    })
    endEdit()
  }

  const playLabel = playing ? t('transport.pause') : t('transport.play')

  return (
    <div
      role="group"
      aria-label={t('transport.label')}
      style={{ bottom: GEOMETRY.PILL_BOTTOM }}
      className={clsx(
        'nf-glass fixed inset-x-0 z-30 mx-auto box-border flex h-pill w-max max-w-[calc(100vw-32px)] items-center gap-1 rounded-round px-3 py-2.5 text-body text-ink transition-[opacity,visibility] duration-200',
        hidden ? 'invisible opacity-0 [transition-delay:0s,200ms]' : 'visible opacity-100',
      )}
    >
      <IconButton label={t('transport.rewindToStart')} isDisabled={!hasSong} onPress={() => seekTo(0)}>
        <Icon.SkipStartIcon />
      </IconButton>
      <IconButton
        label={t('transport.rewind10')}
        isDisabled={!hasSong}
        onPress={() => seekTo(Math.max(0, audioEngine.currentSongTime() - SKIP_SECONDS))}
      >
        <Icon.Back10Icon />
      </IconButton>
      <IconButton
        size="play"
        className="data-[disabled]:!bg-ink"
        label={playLabel}
        shortcut="Space"
        isDisabled={!hasSong || loading}
        onPress={() => void (playing ? pauseSong() : playSong())}
      >
        {playing ? <Icon.PauseIcon /> : <Icon.PlayIcon />}
      </IconButton>
      <IconButton
        label={t('transport.forward10')}
        isDisabled={!hasSong}
        onPress={() => seekTo(Math.min(duration, audioEngine.currentSongTime() + SKIP_SECONDS))}
      >
        <Icon.Forward10Icon />
      </IconButton>

      <TimeNow />
      <Scrubber duration={duration} enabled={hasSong} label={t('transport.seek')} />
      <span className="min-w-10 flex-none tabular-nums text-ink-muted">{fmt(duration)}</span>

      <Divider vertical />

      <HoverSlider
        id="speed"
        label={t('transport.speed')}
        value={playbackRate}
        min={0.25}
        max={2}
        step={0.05}
        format={fmtSpeed}
        onChange={(v) => updateSettings({ playbackRate: v })}
        trigger={({ ref, onHoverStart, onHoverEnd, open }) => (
          <Button
            ref={ref}
            aria-label={t('transport.playbackSpeed')}
            onPress={open}
            onHoverStart={onHoverStart}
            onHoverEnd={onHoverEnd}
            className="tabular-nums"
          >
            {fmtSpeed(playbackRate)}
          </Button>
        )}
      />
      <HoverSlider
        id="volume"
        label={t('transport.volume')}
        value={volume}
        min={0}
        max={1.5}
        step={0.01}
        format={fmtVolume}
        onChange={(v) => updateSettings({ volume: v })}
        trigger={({ ref, onHoverStart, onHoverEnd }) => (
          <IconButton
            ref={ref}
            tooltip={false}
            label={volume > 0.001 ? t('transport.mute') : t('transport.unmute')}
            onPress={toggleMute}
            onHoverStart={onHoverStart}
            onHoverEnd={onHoverEnd}
          >
            {volume > 0.001 ? <Icon.VolumeIcon /> : <Icon.VolumeMuteIcon />}
          </IconButton>
        )}
      />
      <IconButton
        label={loop ? t('transport.disableLoop') : t('transport.enableLoop')}
        isDisabled={!hasSong}
        aria-pressed={loop}
        className={loop ? 'bg-fill-selected' : undefined}
        onPress={() => setLoop(!loop)}
      >
        <Icon.LoopIcon />
      </IconButton>
      <IconButton label={t('transport.resetCameraView')} onPress={resetCamera}>
        <Icon.ResetViewIcon />
      </IconButton>
      <IconButton
        label={isFullscreen ? t('transport.exitFullscreen') : t('transport.enterFullscreen')}
        onPress={() => void toggleFullscreen()}
      >
        {isFullscreen ? <Icon.FullscreenExitIcon /> : <Icon.FullscreenIcon />}
      </IconButton>

      <Divider vertical />

      <ToggleButton icon={<Icon.CustomizeIcon />} isSelected={lookOpen} onChange={setLookOpen}>
        {t('transport.look')}
      </ToggleButton>
      <Tooltip label={t('transport.timeline')} shortcut={shortcutLabel('B', { mod: true })}>
        <ToggleButton
          icon={<Icon.TimelineIcon />}
          isDisabled={!hasSong}
          isSelected={timelineOpen && hasSong}
          onChange={(v) => updateSettings({ timelineEditorOpen: v })}
        >
          {t('transport.timeline')}
        </ToggleButton>
      </Tooltip>
    </div>
  )
}

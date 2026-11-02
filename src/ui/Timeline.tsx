import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Slider, SliderThumb, SliderTrack } from 'react-aria-components'
import { useStore } from '../store'
import { audioEngine } from '../audio/engine'
import { useUserAudio, type UserAudioPeaks } from '../audio/userAudio'
import { pickAndImportUserAudio } from '../projects/actions'
import { showAlert } from './confirm'
import { useCurrentDisplayTime } from '../audio/useCurrentTime'
import type { NoteEvent } from '../midi/types'
import {
  buildSpeedMap,
  midiToTimeline,
  timelineToMidi,
  speedAt,
  MIN_SPEED,
  MAX_SPEED,
  MIN_CURVATURE,
  MAX_CURVATURE,
  type SpeedMap,
  type SpeedPoint,
} from '../midi/speedMap'
import { Button, Icon } from './kit'
import { SettingsPinLane, PIN_LANE_HEIGHT } from './SettingsPinLane'
import { resolveNoteTintAt } from '../midi/settingsKeyframes'
import { NoteColorResolver, noteColoringDeps } from '../notes/noteColor'
import { useShallow } from 'zustand/react/shallow'

/**
 * Multi-row timeline that replaces the legacy single-slider seek bar.
 *
 * Three rows on a shared x-axis covering `[0, max(song.duration, audioEnd)]`:
 *
 *   1. **Seek bar** — a thin clickable progress strip; the primary
 *      scrubbing surface. Visually distinct from the lanes below so
 *      it reads as the "ruler", not part of any track.
 *   2. **MIDI lane** — piano-roll preview. Each note is drawn as a
 *      short horizontal segment at its pitch height, mirroring DAWs
 *      like Ableton's clip preview. Read-only in this MVP, but still
 *      accepts click-to-seek as a convenience.
 *   3. **Audio lane** — the user-provided accompaniment waveform.
 *      The whole strip is draggable horizontally; releasing commits
 *      the new `userAudioOffsetSec` as one undo entry. Hidden when no
 *      accompaniment is loaded.
 *
 * A single absolutely-positioned vertical playhead spans all rows so
 * the eye can follow time across them. Negative offsets are
 * intentionally not supported in this MVP.
 */

// Tiny full-song minimap row at the very top of the editor. Click
// or drag pans the visible window; does NOT seek (seek lives on the
// ruler + the canvas-overlay progress slider). Keeps the user
// oriented in long songs while zoomed in for fine work.
/** `--ink` token as an rgba() string for canvas chrome (fallback = the token's value). */
function inkRgba(alpha: number): string {
  let hex = '#f3f2ee'
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim()
    if (/^#[0-9a-f]{6}$/i.test(v)) hex = v
  } catch {
    /* no DOM — keep the fallback */
  }
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}

const MINIMAP_HEIGHT = 6
// Time ruler — fine-grained scrub surface that maps to the visible
// window. The full-song progress slider lives in the transport
// overlay (SeekBar.tsx) and is no longer part of this row stack.
const RULER_HEIGHT = 20
// All lanes start the same height. Per-lane ratios (stored in
// settings) skew this for the user — divider handles between adjacent
// lane headers drag the ratio without changing the running total.
const LANE_HEIGHT_BASE = 48
// Minimum per-lane height after divider redistribution. Sized so the
// header's title row and its mute / kebab button row stay vertically
// separated (title ~14px + buttons ~16px + py-1.5×2 padding + a small
// breathing gap) — below this they'd visually overlap.
const LANE_MIN_HEIGHT = 44
// Vertical gap between rows.
const ROW_GAP = 4
// Left-column track-header width. The headers carry the lane label
// (MIDI / Speed / Audio) plus mute + kebab controls — primary lane
// controls live here, mirroring DAW track layout. Lane clips and the
// ruler / minimap sit to the right of this column so headers line up
// vertically with their lane.
const HEADER_WIDTH = 120

/**
 * Pre-computed peaks → canvas. Repaints whenever peaks, dimensions,
 * or the visible time window change. The min/max bucket array is
 * downsampled at draw time: each pixel column reduces the buckets
 * inside it to a single min/max pair so the waveform reads correctly
 * at any width.
 */
function WaveformCanvas({
  peaks,
  width,
  height,
  pxPerSec,
  /** Where in the buffer to start drawing — lets us window the
   *  rendering to just the visible portion when zoomed in. */
  startInBufferSec,
  color,
}: {
  peaks: UserAudioPeaks
  width: number
  height: number
  pxPerSec: number
  startInBufferSec: number
  color: string
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.max(1, Math.floor(width * dpr))
    canvas.height = Math.max(1, Math.floor(height * dpr))
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, width, height)
    if (width <= 0 || pxPerSec <= 0) return

    ctx.fillStyle = color
    const mid = height / 2
    const halfH = height / 2 - 1
    const bucketsPerPx = 1 / (peaks.bucketDurationSec * pxPerSec)
    // Bucket index at canvas x = 0.
    const startBucketF = Math.max(0, startInBufferSec) / peaks.bucketDurationSec
    for (let x = 0; x < width; x++) {
      const startBucket = Math.floor(startBucketF + x * bucketsPerPx)
      const endBucket = Math.min(
        peaks.bucketCount,
        Math.ceil(startBucketF + (x + 1) * bucketsPerPx),
      )
      if (startBucket >= peaks.bucketCount) break
      if (endBucket <= 0) continue
      let mn = 0
      let mx = 0
      for (let b = Math.max(0, startBucket); b < endBucket; b++) {
        const lo = peaks.buckets[b * 2]
        const hi = peaks.buckets[b * 2 + 1]
        if (lo < mn) mn = lo
        if (hi > mx) mx = hi
      }
      const top = mid - mx * halfH
      const bot = mid - mn * halfH
      ctx.fillRect(x, top, 1, Math.max(1, bot - top))
    }
  }, [peaks, width, height, pxPerSec, startInBufferSec, color])

  return (
    <canvas
      ref={canvasRef}
      style={{ width, height, display: 'block' }}
      aria-hidden
    />
  )
}

/**
 * Piano-roll preview of the loaded MIDI. Each note becomes a short
 * horizontal segment whose y is its pitch and whose width is its
 * duration. The pitch axis is auto-fit to the song's actual range
 * with a small pad — using a fixed 88-key range would leave most
 * songs (which use 30–60 semitones) looking like a thin band.
 *
 * Repaints only on dimensions / song / color change. Intermediate
 * scrubs don't trigger a repaint — the playhead overlay is drawn by
 * a separate React element, not on the canvas.
 */
function MidiPreviewCanvas({
  notes,
  width,
  height,
  pxPerSec,
  /** MIDI-time at canvas x = 0. The timeline editor's x-axis is in
   *  natural MIDI-time (speed automation only affects WHEN audio
   *  fires, not where notes appear), so this is simply
   *  `visStart - midiOffset`. */
  startTimeSec,
  color,
  /** Per-track colour overrides. Sparse map keyed by track index.
   *  Notes whose track has no override fall back to `color`. */
  trackColors,
  /** Optional per-note resolved tint, aligned to `notes` by index.
   *  Set when timeline pins animate the colour — each note is then
   *  drawn in the pin-resolved colour at its OWN time so the whole
   *  automation shows as a static gradient. `null` (no pins) falls
   *  back to the `color` / `trackColors` path (unchanged behaviour). */
  noteColors,
}: {
  notes: NoteEvent[]
  width: number
  height: number
  pxPerSec: number
  startTimeSec: number
  color: string
  trackColors: Record<string, string>
  noteColors: string[] | null
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.max(1, Math.floor(width * dpr))
    canvas.height = Math.max(1, Math.floor(height * dpr))
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, width, height)
    if (notes.length === 0 || width <= 0 || pxPerSec <= 0) return

    // Pitch range: song's actual span plus a small padding above /
    // below so the notes don't kiss the lane edges. Computed over
    // ALL notes (not just visible) so panning/zooming doesn't shift
    // the y-axis around — that would feel disorienting.
    let minMidi = 127
    let maxMidi = 0
    for (const n of notes) {
      if (n.midi < minMidi) minMidi = n.midi
      if (n.midi > maxMidi) maxMidi = n.midi
    }
    const PAD = 1
    minMidi = Math.max(0, minMidi - PAD)
    maxMidi = Math.min(127, maxMidi + PAD)
    const pitchSpan = Math.max(1, maxMidi - minMidi)
    const rowHeight = Math.max(1.5, height / (pitchSpan + 1))
    const noteThickness = Math.max(1.5, rowHeight * 0.85)

    // Visible window in natural MIDI-time.
    const endTimeSec = startTimeSec + width / pxPerSec
    // Resolved per-track colour cache. Tracks without an override
    // resolve to `color` (the global noteColor passed in). Misses are
    // cached so we don't repeat the lookup per note in a thousand-note
    // song.
    const tintCache = new Map<number, string>()
    const resolveColor = (trackIdx: number): string => {
      const cached = tintCache.get(trackIdx)
      if (cached) return cached
      const v = trackColors[String(trackIdx)] ?? color
      tintCache.set(trackIdx, v)
      return v
    }
    // Set the default colour once; only call set when the track's
    // resolved colour actually differs from the previous note's.
    ctx.fillStyle = color
    let currentFill = color
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i]
      const noteEnd = n.time + n.duration
      if (noteEnd < startTimeSec) continue
      if (n.time > endTimeSec) continue
      const x = (n.time - startTimeSec) * pxPerSec
      const w = Math.max(1, n.duration * pxPerSec)
      const yCenter =
        ((maxMidi - n.midi) / pitchSpan) * (height - rowHeight) + rowHeight / 2
      const y = yCenter - noteThickness / 2
      // Pin-resolved per-note tint when present; else the per-track
      // (or global) colour as before.
      const fill = noteColors ? noteColors[i] : resolveColor(n.track)
      if (fill !== currentFill) {
        ctx.fillStyle = fill
        currentFill = fill
      }
      // Per-note alpha follows velocity so dynamics show up in the
      // preview — Ableton's clip preview does the same. Min alpha
      // 0.35 keeps soft notes legible.
      ctx.globalAlpha = 0.35 + 0.65 * Math.max(0, Math.min(1, n.velocity))
      ctx.fillRect(x, y, w, noteThickness)
    }
    ctx.globalAlpha = 1
  }, [notes, width, height, pxPerSec, startTimeSec, color, trackColors, noteColors])

  return (
    <canvas
      ref={canvasRef}
      style={{ width, height, display: 'block' }}
      aria-hidden
    />
  )
}

/**
 * Time ruler — tick marks + labels mapped to the visible window so
 * clicking lands on precise sub-second positions even when the seek
 * bar above (full-song scale) is too coarse. Tick interval auto-
 * scales with zoom: aim for ~10 major divisions across the view.
 */
function pickTickInterval(viewDuration: number): number {
  // Round-number candidates spanning hundreds of milliseconds to
  // minutes. We pick the smallest one ≥ viewDuration/10 so a typical
  // view shows 10–20 major divisions — dense enough for targeting,
  // sparse enough that labels don't collide.
  const candidates = [
    0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300,
  ]
  const target = viewDuration / 10
  for (const c of candidates) if (c >= target) return c
  return candidates[candidates.length - 1]
}

/** m:ss.s for the ruler's hover chip. */
function formatClock(t: number): string {
  const s = Math.max(0, t)
  const m = Math.floor(s / 60)
  const sec = s - m * 60
  return `${m}:${sec < 10 ? '0' : ''}${sec.toFixed(1)}`
}

function formatRulerLabel(t: number, major: number): string {
  if (major < 0.1) return `${t.toFixed(2)}s`
  if (major < 1) return `${t.toFixed(1)}s`
  // mm:ss for ≥1s steps.
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function RulerCanvas({
  width,
  height,
  startTimeSec,
  pxPerSec,
  speedMap,
  midiOffsetSec,
}: {
  width: number
  height: number
  /** Display-time at canvas x=0 (natural-MIDI-time + offset, the
   *  editor's x-axis). */
  startTimeSec: number
  pxPerSec: number
  /** Speed automation curve — used to map display-time positions to
   *  TL_audio for the visible labels. */
  speedMap: SpeedMap
  midiOffsetSec: number
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.max(1, Math.floor(width * dpr))
    canvas.height = Math.max(1, Math.floor(height * dpr))
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, width, height)
    if (width <= 0 || pxPerSec <= 0) return

    // Ticks are spaced at uniform TL_audio intervals so the labels
    // read as honest elapsed-time (e.g. "0:10" lands exactly where
    // 10 wall-clock seconds will have passed). On the display-time
    // axis, that means the SPACING in pixels varies — wider in
    // speed-up regions, narrower in slow-down regions — matching
    // how fast the cursor moves through that area.
    const visStartMidi = startTimeSec - midiOffsetSec
    const visEndMidi = visStartMidi + width / pxPerSec
    const visStartAudio = midiOffsetSec + midiToTimeline(speedMap, visStartMidi)
    const visEndAudio = midiOffsetSec + midiToTimeline(speedMap, visEndMidi)
    const audioVisDur = Math.max(1e-6, visEndAudio - visStartAudio)
    const major = pickTickInterval(audioVisDur)

    /** TL_audio → x-pixel on the (display-time-based) canvas. */
    const audioToX = (audioT: number): number => {
      const midiT = timelineToMidi(speedMap, audioT - midiOffsetSec)
      const displayT = midiT + midiOffsetSec
      return Math.round((displayT - startTimeSec) * pxPerSec)
    }

    // Labels only (no tick marks): the lanes below carry the grid.
    ctx.fillStyle = inkRgba(0.44)
    ctx.font = '12px "Geist Variable", Geist, system-ui, sans-serif'
    ctx.textBaseline = 'middle'
    const firstMajor = Math.ceil(visStartAudio / major) * major
    for (let t = firstMajor; t <= visEndAudio + 1e-6; t += major) {
      ctx.fillText(formatRulerLabel(t, major), audioToX(t) + 2, height / 2)
    }
  }, [width, height, startTimeSec, pxPerSec, speedMap, midiOffsetSec])
  return (
    <canvas
      ref={canvasRef}
      style={{ width, height, display: 'block' }}
      aria-hidden
    />
  )
}

// Linear gain → dB string. -∞ for 0.
function formatDb(volume: number): string {
  if (volume <= 0.001) return '−∞ dB'
  const db = 20 * Math.log10(volume)
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`
}

/**
 * Right-click panel for MIDI / Audio lane controls. Replaces the
 * legacy left-rail headers — the lanes themselves identify their
 * track via waveform / piano-roll, so the labels and always-visible
 * sliders were redundant. Adjustable here:
 *   - mute / unmute
 *   - volume slider (0..1.5) with a unity (0 dB) tick mark and dB
 *     numeric readout
 *   - reset to unity (0 dB)
 *   - remove audio (audio lane only)
 *
 * Dismissed on outside pointerdown, Escape, or selecting an action.
 */
function LaneContextMenu({
  target,
  position,
  onClose,
}: {
  target: 'midi' | 'audio'
  position: { x: number; y: number }
  onClose: () => void
}) {
  const { t } = useTranslation('timeline')
  const ref = useRef<HTMLDivElement | null>(null)
  // Clamp the menu's actual position to the viewport so right-clicks
  // near the edges still reveal the full panel. Measured after mount
  // (size depends on content) and re-applied on window resize.
  const [pos, setPos] = useState<{ x: number; y: number }>(position)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const clamp = () => {
      const rect = el.getBoundingClientRect()
      const margin = 8
      const maxX = window.innerWidth - rect.width - margin
      const maxY = window.innerHeight - rect.height - margin
      setPos({
        x: Math.max(margin, Math.min(maxX, position.x)),
        y: Math.max(margin, Math.min(maxY, position.y)),
      })
    }
    clamp()
    window.addEventListener('resize', clamp)
    return () => window.removeEventListener('resize', clamp)
  }, [position])
  const midiEnabled = useStore((s) => s.settings.midiEnabled)
  const midiVolume = useStore((s) => s.settings.midiVolume)
  const audioVolume = useStore((s) => s.settings.userAudioVolume)
  const audioFileName = useUserAudio((s) => s.fileName)
  const clearAudio = useUserAudio((s) => s.clear)
  const updateSettings = useStore((s) => s.updateSettings)
  const beginEdit = useStore((s) => s.beginSettingsEdit)
  const endEdit = useStore((s) => s.endSettingsEdit)

  // Audio mute toggle ducks volume to 0 and restores the last non-zero
  // level on toggle back — same pattern as the legacy header.
  const lastNonZeroAudioRef = useRef(audioVolume > 0.001 ? audioVolume : 1.0)
  useEffect(() => {
    if (audioVolume > 0.001) lastNonZeroAudioRef.current = audioVolume
  }, [audioVolume])

  // Click-outside / Esc to dismiss. Capture phase so a click on
  // another lane's hover button (which would open a different menu)
  // closes this one first.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current) return
      if (!ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('pointerdown', onDown, { capture: true })
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown, { capture: true })
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const isMidi = target === 'midi'
  const enabled = isMidi ? midiEnabled : audioVolume > 0.001
  const volume = isMidi ? midiVolume : audioVolume
  const titleText = isMidi ? t('lane.midi') : (audioFileName ?? t('lane.audio'))

  const onToggleMute = () => {
    beginEdit()
    if (isMidi) {
      updateSettings({ midiEnabled: !midiEnabled })
    } else {
      updateSettings({
        userAudioVolume: audioVolume > 0.001 ? 0 : lastNonZeroAudioRef.current,
      })
    }
    endEdit()
  }
  const onVolumeChange = (v: number) => {
    beginEdit()
    if (isMidi) updateSettings({ midiVolume: v })
    else updateSettings({ userAudioVolume: v })
  }
  const onVolumeCommit = () => endEdit()
  const onReset = () => {
    beginEdit()
    if (isMidi) updateSettings({ midiVolume: 1.0, midiEnabled: true })
    else updateSettings({ userAudioVolume: 1.0 })
    endEdit()
  }

  return (
    <div
      ref={ref}
      role="menu"
      className="nf-glass-strong fixed z-50 w-60 rounded-panel p-1.5 text-body text-ink"
      style={{ left: pos.x, top: pos.y }}
      // Stop the surrounding lane / seek bar from receiving the
      // pointerdown that targets the menu (would otherwise start a
      // drag underneath us).
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        className="mb-1 truncate px-2 pt-1 text-heading text-ink"
        title={titleText}
      >
        {titleText}
      </div>
      <button
        type="button"
        onClick={onToggleMute}
        className="flex w-full items-center gap-2 rounded-field px-2 py-1.5 text-left hover:bg-fill-hover"
      >
        {enabled ? <Icon.VolumeIcon className="h-4 w-4" /> : <Icon.VolumeMuteIcon className="h-4 w-4" />}
        <span>{enabled ? t('context.mute') : t('context.unmute')}</span>
      </button>
      <div className="px-2 py-1.5">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-ink-muted">{t('context.volume')}</span>
          <span className="text-caption text-ink-muted">
            {formatDb(volume)}
          </span>
        </div>
        <Slider
          value={volume}
          minValue={0}
          maxValue={1.5}
          step={0.01}
          onChange={(v) => onVolumeChange(typeof v === 'number' ? v : v[0])}
          onChangeEnd={onVolumeCommit}
          aria-label={t('context.volume')}
        >
          <SliderTrack className="relative flex h-3 w-full cursor-pointer items-center">
            {({ state }) => (
              <>
                <div className="relative h-1 w-full overflow-visible rounded-full bg-fill-track">
                  <div
                    className={
                      enabled
                        ? 'h-full rounded-full bg-ink'
                        : 'h-full rounded-full bg-ink-faint'
                    }
                    style={{ width: `${state.getThumbPercent(0) * 100}%` }}
                  />
                  {/* Unity (0 dB / 1.0) tick — the gain level the user
                      most often wants to land back at. */}
                  <div
                    aria-hidden
                    className="absolute -top-0.5 h-2 w-px bg-ink-faint"
                    style={{ left: `${(1 / 1.5) * 100}%` }}
                  />
                </div>
                <SliderThumb className="sr-only" />
              </>
            )}
          </SliderTrack>
        </Slider>
      </div>
      <button
        type="button"
        onClick={onReset}
        className="flex w-full items-center rounded-field px-2 py-1.5 text-left hover:bg-fill-hover"
      >
        {t('context.resetToUnity')}
      </button>
      {!isMidi && audioFileName && (
        <button
          type="button"
          onClick={() => {
            clearAudio()
            onClose()
          }}
          className="flex w-full items-center gap-2 rounded-field px-2 py-1.5 text-left text-danger hover:bg-fill-hover"
        >
          <Icon.CloseIcon className="h-4 w-4" /> {t('context.removeAudio')}
        </button>
      )}
    </div>
  )
}


/**
 * Left-column track header. Each lane has a matching header card
 * showing the track name, a mute toggle (where mute makes sense),
 * and a kebab that opens the lane's context menu (volume / reset /
 * remove). Speed-automation passes `target={null}` so it renders as
 * a label-only header (no mute / no menu).
 */
function LaneHeader({
  title,
  height,
  muted,
  enabled,
  onToggleMute,
  onOpenMenu,
}: {
  title: string
  height: number
  muted?: boolean
  enabled?: boolean
  onToggleMute?: () => void
  onOpenMenu?: (e: React.MouseEvent) => void
}) {
  const { t } = useTranslation('timeline')
  const dimmed = muted || enabled === false
  return (
    <div
      style={{ height }}
      className="group/lane relative flex items-center gap-1 pr-1"
      onContextMenu={onOpenMenu}
    >
      <span
        className={`truncate text-body ${dimmed ? 'text-ink-faint' : 'text-ink-muted'}`}
        title={title}
      >
        {title}
      </span>
      {onToggleMute && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onToggleMute()
          }}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label={muted ? t('lane.unmute') : t('lane.mute')}
          title={muted ? t('lane.unmute') : t('lane.mute')}
          className={`nf-focus nf-press grid h-6 w-6 flex-none place-items-center rounded-round outline-none hover:bg-fill-hover ${muted ? 'text-ink-faint' : 'text-ink-muted hover:text-ink'}`}
        >
          {muted ? <Icon.VolumeMuteIcon className="h-4 w-4" /> : <Icon.VolumeIcon className="h-4 w-4" />}
        </button>
      )}
      {onOpenMenu && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onOpenMenu(e)
          }}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label={t('lane.options')}
          title={t('lane.options')}
          className="nf-focus nf-press ml-auto grid h-6 w-6 flex-none place-items-center rounded-round text-ink-muted opacity-0 outline-none transition-opacity duration-150 hover:bg-fill-hover hover:text-ink focus-visible:opacity-100 group-hover/lane:opacity-100"
        >
          <Icon.ChevronIcon className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}

/**
 * Drag handle between two adjacent lane headers. Dragging vertically
 * shifts pixel height between the upper and lower lane while keeping
 * their sum constant — so the editor's overall height stays pinned
 * to the user's resize handle and only the *split* changes. Drag up
 * → upper lane shrinks, lower lane grows; drag down → vice versa.
 * The element occupies the same vertical space as the ROW_GAP it
 * replaces, so swapping a plain gap for a divider doesn't shift any
 * other row.
 */
type LaneRatioKey =
  | 'timelineMidiLaneRatio'
  | 'timelineSpeedLaneRatio'
  | 'timelineAudioLaneRatio'

function LaneDivider({
  upperKey,
  lowerKey,
}: {
  upperKey: LaneRatioKey
  lowerKey: LaneRatioKey
}) {
  const { t } = useTranslation('timeline')
  const laneScale = useStore((s) => s.settings.timelineLaneScale)
  const upperRatio = useStore((s) => s.settings[upperKey])
  const lowerRatio = useStore((s) => s.settings[lowerKey])
  const updateSettings = useStore((s) => s.updateSettings)
  const beginEdit = useStore((s) => s.beginSettingsEdit)
  const endEdit = useStore((s) => s.endSettingsEdit)
  const laneUnit = LANE_HEIGHT_BASE * laneScale
  const dragRef = useRef<{ y: number; upH: number; loH: number } | null>(null)

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    beginEdit()
    dragRef.current = {
      y: e.clientY,
      upH: upperRatio * laneUnit,
      loH: lowerRatio * laneUnit,
    }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    const dy = e.clientY - d.y
    const total = d.upH + d.loH
    const minH = Math.min(LANE_MIN_HEIGHT, total / 2)
    let upH = d.upH + dy
    upH = Math.max(minH, Math.min(total - minH, upH))
    const loH = total - upH
    updateSettings({
      [upperKey]: upH / laneUnit,
      [lowerKey]: loH / laneUnit,
    } as Partial<import('../store').Settings>)
  }
  const onPointerUp = (e: React.PointerEvent) => {
    if (!dragRef.current) return
    dragRef.current = null
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      // Capture may already be released (e.g. element unmounting); ignore.
    }
    endEdit()
  }
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      title={t('lane.resizeLanes')}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{ height: ROW_GAP, touchAction: 'none' }}
      className="group relative cursor-ns-resize"
    >
      <div className="pointer-events-none absolute inset-x-1 top-1/2 h-px -translate-y-1/2 bg-transparent transition-colors group-hover:bg-ink-faint group-active:bg-ink-muted" />
    </div>
  )
}

// Y-axis mapping for the speed automation lane. Log₂-scaled so 0.5×
// and 2× sit equidistant from 1.0 — natural for tempo-ish quantities.
// `rangeLog2` is the user-tunable half-range: the visible y span
// covers `[2^-r, 2^r]`. Larger `r` = coarser editing (more headroom
// for big speed changes); smaller `r` = finer rubato edits.
// Y-axis maps `[2^(center-range), 2^(center+range)]` to `[height, 0]`.
// `center` defaults to 0 (i.e. centred on 1.0×) and drifts when the
// user zooms in over a breakpoint whose value isn't 1.0× — see the
// wheel handler in `SpeedAutomationLane` for the cursor-anchored
// derivation.
function speedToY(
  speed: number,
  height: number,
  rangeLog2: number,
  centerLog2: number,
): number {
  const clamped = Math.max(MIN_SPEED, Math.min(MAX_SPEED, speed))
  const l = Math.log2(clamped) // negative below 1, positive above
  const t = (centerLog2 + rangeLog2 - l) / (rangeLog2 * 2)
  return Math.max(0, Math.min(height, t * height))
}
function yToSpeed(
  y: number,
  height: number,
  rangeLog2: number,
  centerLog2: number,
): number {
  const t = Math.max(0, Math.min(1, y / height))
  const l = centerLog2 + rangeLog2 - t * rangeLog2 * 2
  return Math.max(MIN_SPEED, Math.min(MAX_SPEED, Math.pow(2, l)))
}

/**
 * Visual lane underneath the MIDI clip — shows the speed automation
 * curve and lets the user edit it. Each breakpoint is a small dot
 * the user can drag (changes time AND speed value); clicking empty
 * area adds a new breakpoint at that location; right-click or Alt-
 * click on a dot removes it.
 *
 * The curve is rendered on a canvas (sampled per pixel because
 * linear-in-MIDI-time is non-linear in timeline-time when the speed
 * isn't constant); breakpoints are React divs so hit-testing /
 * accessibility / cursor styles come for free.
 */
function SpeedAutomationLane({
  points,
  speedMap,
  areaWidth,
  laneHeight,
  pxPerSec,
  clampedScroll,
  viewDuration,
  midiOffsetSec,
  songDuration,
  yRangeLog2,
  yCenterLog2,
  onPointsChange,
  beginEdit,
  endEdit,
}: {
  points: readonly SpeedPoint[]
  speedMap: SpeedMap
  areaWidth: number
  laneHeight: number
  pxPerSec: number
  clampedScroll: number
  viewDuration: number
  midiOffsetSec: number
  songDuration: number
  yRangeLog2: number
  yCenterLog2: number
  onPointsChange: (next: SpeedPoint[]) => void
  beginEdit: () => void
  endEdit: () => void
}) {
  const { t } = useTranslation('timeline')
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  // Curve repaint — samples speed at each pixel column. The
  // timeline x-axis is in NATURAL MIDI-time (with offset), so each
  // pixel column maps directly to a MIDI-time without any inverse
  // map lookup.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.max(1, Math.floor(areaWidth * dpr))
    canvas.height = Math.max(1, Math.floor(laneHeight * dpr))
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, areaWidth, laneHeight)
    if (areaWidth <= 0 || pxPerSec <= 0) return

    // Unity (1.0) reference line — quickly tells the user where
    // "no change" is on the y-axis.
    const unityY = speedToY(1, laneHeight, yRangeLog2, yCenterLog2)
    ctx.strokeStyle = inkRgba(0.14)
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, unityY + 0.5)
    ctx.lineTo(areaWidth, unityY + 0.5)
    ctx.stroke()

    // The curve. Sample one MIDI-time per pixel column. With
    // points.length===0, `speedAt` returns 1 everywhere, so the
    // canvas just shows the unity line above and a flat curve at
    // the same height — fine.
    ctx.strokeStyle = inkRgba(0.85)
    ctx.lineWidth = 1.5
    ctx.beginPath()
    for (let x = 0; x < areaWidth; x++) {
      const midiAtX = clampedScroll + x / pxPerSec - midiOffsetSec
      const v = speedAt(speedMap, midiAtX)
      const y = speedToY(v, laneHeight, yRangeLog2, yCenterLog2)
      if (x === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }, [
    areaWidth,
    laneHeight,
    pxPerSec,
    clampedScroll,
    speedMap,
    midiOffsetSec,
    yRangeLog2,
    yCenterLog2,
  ])

  // Drag state for a breakpoint move. We snapshot the surrounding
  // ARRAY so each move just rewrites the dragged index — keeps
  // commits idempotent and avoids accumulating tiny float deltas.
  const dragRef = useRef<{
    index: number
    snapshot: SpeedPoint[]
    didMove: boolean
  } | null>(null)

  const onDotPointerDown =
    (index: number) => (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      e.stopPropagation()
      dragRef.current = {
        index,
        snapshot: [...points],
        didMove: false,
      }
      e.currentTarget.setPointerCapture(e.pointerId)
      beginEdit()
    }
  const onDotPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d) return
    // If we re-enter the lane after the user released the button
    // outside (where pointer capture sometimes fails to deliver the
    // pointerup), buttons===0 — treat that as the missed release so
    // the drag doesn't stay armed.
    if ((e.buttons & 1) === 0) {
      onDotPointerUp(e)
      return
    }
    const wrap = wrapRef.current
    if (!wrap) return
    e.stopPropagation()
    const rect = wrap.getBoundingClientRect()
    const localX = e.clientX - rect.left
    const localY = e.clientY - rect.top
    // x → MIDI-time directly (natural timeline). No inverse map.
    const rawMidi = Math.max(0, clampedScroll + localX / pxPerSec - midiOffsetSec)
    // Prevent neighbour-crossing — breakpoints must stay in time
    // order so the drag's index reference stays valid and the
    // speed-map sort doesn't re-shuffle (which would otherwise jump
    // the drag onto a different point mid-gesture). Adjacent
    // breakpoints can stack at the exact same time but not cross.
    const idx = d.index
    const prevTime = idx > 0 ? d.snapshot[idx - 1].time : 0
    const nextTime =
      idx < d.snapshot.length - 1
        ? d.snapshot[idx + 1].time
        : Number.POSITIVE_INFINITY
    const midiTime = Math.max(prevTime, Math.min(nextTime, rawMidi))
    const value = yToSpeed(localY, laneHeight, yRangeLog2, yCenterLog2)
    const next = d.snapshot.slice()
    // Preserve the breakpoint's existing curvature so dragging
    // doesn't accidentally straighten an in-progress curve edit.
    next[idx] = { ...d.snapshot[idx], time: midiTime, value }
    d.didMove = true
    onPointsChange(next)
  }
  const onDotPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    e.stopPropagation()
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* capture may already be released — ignore */
    }
    dragRef.current = null
    endEdit()
  }
  const onDotContextMenu =
    (index: number) => (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault()
      e.stopPropagation()
      if (dragRef.current) return
      beginEdit()
      const next = points.slice()
      next.splice(index, 1)
      onPointsChange(next)
      endEdit()
    }

  // Click on empty lane → add a breakpoint at the click position
  // with a value matching the curve's current speed there. That way
  // the curve doesn't visually jump on point-add (it just gains a
  // new draggable handle along the same shape). The PREDECESSOR
  // point's curvature is reset to 0 because its old curvature
  // applied to the now-replaced segment — keeping it would carry the
  // previous segment's "bend" into the truncated half, which feels
  // surprising. Both sides of the new point start as straight lines.
  const onLanePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    if (dragRef.current) return
    const wrap = wrapRef.current
    if (!wrap) return
    e.stopPropagation()
    const rect = wrap.getBoundingClientRect()
    const localX = e.clientX - rect.left
    const localY = e.clientY - rect.top
    const midiTime = Math.max(0, clampedScroll + localX / pxPerSec - midiOffsetSec)
    const cappedMidi = songDuration > 0 ? Math.min(songDuration, midiTime) : midiTime
    // Use the click's Y position for the value (so the dot lands
    // exactly where the cursor is) rather than the current curve's
    // value at that x.
    const value = yToSpeed(localY, laneHeight, yRangeLog2, yCenterLog2)
    const newPoint: SpeedPoint = { time: cappedMidi, value }
    const merged: SpeedPoint[] = [...points, newPoint].sort(
      (a, b) => a.time - b.time,
    )
    const newIdx = merged.indexOf(newPoint)
    if (newIdx > 0) {
      // Reset the predecessor's curvature so its segment to the new
      // point becomes a straight line (default).
      merged[newIdx - 1] = { ...merged[newIdx - 1], curvature: 0 }
    }
    beginEdit()
    onPointsChange(merged)
    // Arm a drag on the just-created point so the same gesture can
    // both create and reposition without releasing the mouse button.
    // endEdit fires on pointerup (via onDotPointerUp).
    dragRef.current = {
      index: newIdx,
      snapshot: merged,
      didMove: false,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const visEnd = clampedScroll + viewDuration

  // Drag state for midpoint curvature edit. Same gesture model as
  // the breakpoint drag — beginEdit at pointerdown, per-move writes
  // through `setSongPreview`-equivalent updates, endEdit on
  // pointerup — so the whole drag collapses to a single undo entry.
  const midDragRef = useRef<{
    index: number
    startCurvature: number
  } | null>(null)

  // Per-segment midpoint handle geometry. Recomputed each render so
  // points / view changes flow through naturally.
  type MidHandle = {
    /** Index of the FROM-point of the segment (curvature stored on
     *  this point applies to the segment going to point[i+1]). */
    index: number
    x: number
    y: number
    curvature: number
  }
  const midHandles: MidHandle[] = []
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    const midTime = (a.time + b.time) / 2
    const midTl = midiOffsetSec + midTime
    if (midTl < clampedScroll || midTl > visEnd) continue
    const midX = (midTl - clampedScroll) * pxPerSec
    const midValue = speedAt(speedMap, midTime)
    const midY = speedToY(midValue, laneHeight, yRangeLog2, yCenterLog2)
    midHandles.push({
      index: i,
      x: midX,
      y: midY,
      curvature: a.curvature ?? 0,
    })
  }

  // Wheel-on-lane = adjust curvature of the nearest midpoint handle.
  // No vertical scroll behaviour; the lane swallows wheel only to
  // both (a) edit curvature when over a midpoint, and (b) prevent
  // the surrounding timeline from interpreting the wheel as
  // horizontal zoom on top of our handles.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      // Find the closest midpoint handle to the cursor; only adjust
      // when the cursor is actually within a sensible hit radius.
      const rect = el.getBoundingClientRect()
      const cursorX = e.clientX - rect.left
      const cursorY = e.clientY - rect.top
      let bestI = -1
      let bestD = Infinity
      for (const h of midHandles) {
        const d = Math.hypot(cursorX - h.x, cursorY - h.y)
        if (d < bestD) {
          bestD = d
          bestI = h.index
        }
      }
      if (bestI < 0 || bestD > 18) return
      e.preventDefault()
      e.stopPropagation()
      const cur = points[bestI].curvature ?? 0
      const step = Math.sign(e.deltaY) * 0.05
      const next = Math.max(MIN_CURVATURE, Math.min(MAX_CURVATURE, cur + step))
      if (next === cur) return
      beginEdit()
      const nextPts = points.slice()
      nextPts[bestI] = { ...points[bestI], curvature: next }
      onPointsChange(nextPts)
      endEdit()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [points, midHandles, beginEdit, endEdit, onPointsChange])

  // Speed range labels — visible reminders of what the y-axis spans
  // at the current range + centre.
  const topSpeed = Math.pow(2, yCenterLog2 + yRangeLog2)
  const botSpeed = Math.pow(2, yCenterLog2 - yRangeLog2)
  return (
    <div
      ref={wrapRef}
      onPointerDown={onLanePointerDown}
      onPointerMove={onDotPointerMove}
      onPointerUp={onDotPointerUp}
      onPointerCancel={onDotPointerUp}
      style={{ height: laneHeight, touchAction: 'none' }}
      className="group/speed relative overflow-hidden rounded-field bg-white/5"
      aria-label={t('speed.automationAria')}
      title={t('speed.automationTitle')}
    >
      <canvas
        ref={canvasRef}
        style={{ width: areaWidth, height: laneHeight, display: 'block' }}
        aria-hidden
      />
      {points.map((p, i) => {
        const tl = midiOffsetSec + p.time
        if (tl < clampedScroll || tl > visEnd) return null
        const x = (tl - clampedScroll) * pxPerSec
        const y = speedToY(p.value, laneHeight, yRangeLog2, yCenterLog2)
        // Label sits ABOVE the dot when the dot is in the lower
        // half, BELOW it otherwise — keeps the readout from being
        // clipped off the top/bottom of the lane.
        const labelBelow = y < laneHeight * 0.4
        return (
          <div
            key={i}
            className="absolute"
            style={{ left: x, top: y, touchAction: 'none' }}
          >
            <div
              onPointerDown={onDotPointerDown(i)}
              onPointerMove={onDotPointerMove}
              onPointerUp={onDotPointerUp}
              onPointerCancel={onDotPointerUp}
              onContextMenu={onDotContextMenu(i)}
              onDoubleClick={(e) => {
                e.stopPropagation()
                // Double-click resets the value to 1.00× — quick way
                // to "neutralise" a breakpoint without removing it.
                if (Math.abs(p.value - 1) < 1e-6) return
                beginEdit()
                const next = points.slice()
                next[i] = { ...points[i], value: 1 }
                onPointsChange(next)
                endEdit()
              }}
              title={t('speed.breakpointTitle', {
                value: p.value.toFixed(2),
                time: p.time.toFixed(2),
              })}
              className="absolute -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full bg-ink ring-2 ring-fill-selected hover:bg-ink active:cursor-grabbing"
              style={{ width: 8, height: 8, touchAction: 'none' }}
            />
            <div
              aria-hidden
              className="pointer-events-none absolute -translate-x-1/2 whitespace-nowrap rounded-field bg-canvas/80 px-1 text-caption text-ink opacity-0 transition-opacity duration-150 group-hover/speed:opacity-100"
              style={{ top: labelBelow ? 8 : -18 }}
            >
              {p.value.toFixed(2)}×
            </div>
          </div>
        )
      })}
      {/* Per-segment curvature handles. Sit at the curve's value at
          u=0.5 — moving them isn't supported (they snap to the curve)
          but SCROLLING over them adjusts the segment's curvature
          (handled in the wheel listener above). */}
      {midHandles.map((h) => {
        const resetCurvature = () => {
          if (h.curvature === 0) return
          beginEdit()
          const next = points.slice()
          next[h.index] = { ...points[h.index], curvature: 0 }
          onPointsChange(next)
          endEdit()
        }
        const onMidPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
          e.stopPropagation()
          if (e.button !== 0) return
          midDragRef.current = { index: h.index, startCurvature: h.curvature }
          e.currentTarget.setPointerCapture(e.pointerId)
          beginEdit()
        }
        const onMidPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
          const d = midDragRef.current
          if (!d) return
          if ((e.buttons & 1) === 0) {
            onMidPointerUp(e)
            return
          }
          e.stopPropagation()
          const wrap = wrapRef.current
          if (!wrap) return
          const a = points[d.index]
          const b = points[d.index + 1]
          if (!a || !b) return
          // A flat segment (c1 == c2) has no shape to bend — the
          // midpoint sits at the same speed value regardless of
          // curvature, so leave the curvature alone.
          const log2c1 = Math.log2(a.value)
          const log2c2 = Math.log2(b.value)
          const logRatio = log2c2 - log2c1
          if (Math.abs(logRatio) < 1e-6) return
          const rect = wrap.getBoundingClientRect()
          const cursorY = e.clientY - rect.top
          const targetSpeed = yToSpeed(
            cursorY,
            laneHeight,
            yRangeLog2,
            yCenterLog2,
          )
          // Invert applyCurvature at u=0.5 to recover the curvature
          // that would land the midpoint on `targetSpeed`:
          //   u' = (log2(target) − log2(c1)) / log2(c2/c1)
          //   if u' < 0.5: u' = 0.5^k → curvature = (log(u')/log(0.5) − 1) / 3
          //   if u' > 0.5: 1 − u' = 0.5^k → curvature = −((log(1−u')/log(0.5)) − 1) / 3
          let uPrime = (Math.log2(targetSpeed) - log2c1) / logRatio
          uPrime = Math.max(0.001, Math.min(0.999, uPrime))
          let newCurvature: number
          if (Math.abs(uPrime - 0.5) < 0.005) {
            newCurvature = 0
          } else if (uPrime < 0.5) {
            const k = Math.log(uPrime) / Math.log(0.5)
            newCurvature = (k - 1) / 3
          } else {
            const k = Math.log(1 - uPrime) / Math.log(0.5)
            newCurvature = -(k - 1) / 3
          }
          newCurvature = Math.max(
            MIN_CURVATURE,
            Math.min(MAX_CURVATURE, newCurvature),
          )
          if (newCurvature === (a.curvature ?? 0)) return
          const next = points.slice()
          next[d.index] = { ...points[d.index], curvature: newCurvature }
          onPointsChange(next)
        }
        const onMidPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
          if (!midDragRef.current) return
          e.stopPropagation()
          try {
            e.currentTarget.releasePointerCapture(e.pointerId)
          } catch {
            /* capture may already be released — ignore */
          }
          midDragRef.current = null
          endEdit()
        }
        return (
          <div
            key={`mid-${h.index}`}
            onPointerDown={onMidPointerDown}
            onPointerMove={onMidPointerMove}
            onPointerUp={onMidPointerUp}
            onPointerCancel={onMidPointerUp}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              resetCurvature()
            }}
            title={t('speed.curveTitle', {
              curvature: `${h.curvature >= 0 ? '+' : ''}${h.curvature.toFixed(2)}`,
            })}
            className="absolute -translate-x-1/2 -translate-y-1/2 cursor-ns-resize rounded-full bg-ink-muted ring-1 ring-glass-edge hover:bg-ink active:bg-ink"
            style={{
              left: h.x,
              top: h.y,
              width: 6,
              height: 6,
              touchAction: 'none',
            }}
          />
        )
      })}
      {/* Y-axis bounds — the current visible range (what wheel-zoom has
          set), shown while the pointer is over the lane. */}
      <div
        aria-hidden
        className="pointer-events-none absolute right-1.5 top-0.5 text-caption text-ink-faint opacity-0 transition-opacity duration-150 group-hover/speed:opacity-100"
      >
        {topSpeed.toFixed(2)}×
      </div>
      <div
        aria-hidden
        className="pointer-events-none absolute bottom-0.5 right-1.5 text-caption text-ink-faint opacity-0 transition-opacity duration-150 group-hover/speed:opacity-100"
      >
        {botSpeed.toFixed(2)}×
      </div>
    </div>
  )
}

/**
 * Scrollbar-thumb–style trim handle. A short rounded vertical pill
 * inset slightly from the clip edge, centred vertically and shorter
 * than the lane. The visible pill is decorative (pointer-events:
 * none); the surrounding transparent wrapper carries the hit area so
 * the grab target is comfortably wider than the visual.
 */
function TrimHandle({
  side,
  laneHeight,
  ariaLabel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: {
  side: 'left' | 'right'
  laneHeight: number
  ariaLabel: string
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void
  onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void
}) {
  const { t } = useTranslation('timeline')
  const HIT_WIDTH = 10
  const INSET = 0
  const pillHeight = Math.round(laneHeight * 0.55)
  return (
    <div
      aria-label={ariaLabel}
      title={t('trim.drag')}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className="group absolute top-1/2 -translate-y-1/2 cursor-ew-resize"
      style={{
        [side]: INSET,
        width: HIT_WIDTH,
        height: laneHeight,
        touchAction: 'none',
      }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink-muted transition-colors group-hover:bg-ink"
        style={{ width: 3, height: pillHeight }}
      />
    </div>
  )
}

// Zoom limits. 1 = fit-to-width; the upper bound is generous enough
// to land at ~10 px / 100 ms for a 4-minute song in a 1000 px-wide
// timeline (still useful for sub-second sync work without making the
// canvases unreasonably wide).
const MIN_ZOOM = 1
const MAX_ZOOM = 100
// Wheel deltaY → zoom factor exponent. Tuned so a single mouse wheel
// notch (~100 px) gives ~1.25× zoom, and a trackpad pinch-equivalent
// reaches the visible range in a fluent gesture.
const ZOOM_PER_DELTA = 0.002

export function Timeline() {
  const { t } = useTranslation('timeline')
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [areaWidth, setAreaWidth] = useState(0)

  const song = useStore((s) => s.song)
  const transport = useStore((s) => s.transport)
  const baseNoteColor = useStore((s) => s.settings.noteColor)
  const baseTrackColors = useStore((s) => s.settings.trackColors)
  const peaks = useUserAudio((s) => s.peaks)
  const audioFileName = useUserAudio((s) => s.fileName)
  const audioLoading = useUserAudio((s) => s.loading)
  const audioError = useUserAudio((s) => s.error)
  const offsetSec = useStore((s) => s.settings.userAudioOffsetSec)
  const updateSettings = useStore((s) => s.updateSettings)
  const shiftKeyframes = useStore((s) => s.shiftKeyframes)
  const beginEdit = useStore((s) => s.beginSettingsEdit)
  const endEdit = useStore((s) => s.endSettingsEdit)
  // Cursor position on the editor's natural-MIDI-time x-axis. NOT
  // TL_audio — the cursor sits at the MIDI position the audio is
  // currently playing (which advances at the speed-curve rate),
  // while the SeekBar's elapsed-time readout uses the TL_audio hook.
  const currentTime = useCurrentDisplayTime()
  const midiEnabled = useStore((s) => s.settings.midiEnabled)
  const midiVolume = useStore((s) => s.settings.midiVolume)
  const audioVolume = useStore((s) => s.settings.userAudioVolume)
  const midiMuted = !midiEnabled || midiVolume <= 0.001
  const audioMuted = audioVolume <= 0.001
  const lastNonZeroAudioRef = useRef(audioVolume > 0.001 ? audioVolume : 1.0)
  useEffect(() => {
    if (audioVolume > 0.001) lastNonZeroAudioRef.current = audioVolume
  }, [audioVolume])

  // ── Right-click menu ──
  // Single shared menu state so opening one closes the other.
  // Position is in viewport coords (the menu uses `position: fixed`).
  const [menu, setMenu] = useState<{
    target: 'midi' | 'audio'
    x: number
    y: number
  } | null>(null)
  const openMenuAt = (
    target: 'midi' | 'audio',
    e: React.MouseEvent,
  ) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ target, x: e.clientX, y: e.clientY })
  }
  const closeMenu = () => setMenu(null)

  // ── Zoom + pan state ──
  // `zoom` is a multiplier on the fit-to-width pxPerSec; `scrollSec`
  // is the song time at the timeline area's left edge. Together they
  // determine the visible window without re-fitting on song changes.
  const [zoom, setZoom] = useState(1)
  const [scrollSec, setScrollSec] = useState(0)

  const songDuration = song?.duration ?? 0
  const audioDuration = peaks?.totalDurationSec ?? 0
  const midiOffsetSec = useStore((s) => s.settings.midiOffsetSec)
  const midiTrimStartSec = useStore((s) => s.settings.midiTrimStartSec)
  const midiTrimEndSecRaw = useStore((s) => s.settings.midiTrimEndSec)
  const userAudioTrimStartSec = useStore(
    (s) => s.settings.userAudioTrimStartSec,
  )
  const userAudioTrimEndSecRaw = useStore(
    (s) => s.settings.userAudioTrimEndSec,
  )
  const midiTrimEndSec = midiTrimEndSecRaw ?? songDuration
  const audioTrimEndSec = userAudioTrimEndSecRaw ?? audioDuration
  // Speed automation — empty array means constant 1.0. The compiled
  // map is memoised against the breakpoint array reference so a
  // zustand-stable points list doesn't reshape the map every render.
  const laneScale = useStore((s) => s.settings.timelineLaneScale)
  const midiLaneRatio = useStore((s) => s.settings.timelineMidiLaneRatio)
  const speedLaneRatio = useStore((s) => s.settings.timelineSpeedLaneRatio)
  const audioLaneRatio = useStore((s) => s.settings.timelineAudioLaneRatio)
  // Per-lane height = base × overall scale × per-lane ratio. The
  // ratios start equal so all lanes share one height; the divider
  // drag (see `LaneDivider` below) shifts ratio between two adjacent
  // lanes while preserving their sum, so total editor height stays
  // pinned to the user's resize handle.
  const laneUnit = LANE_HEIGHT_BASE * laneScale
  const midiLaneH = laneUnit * midiLaneRatio
  const audioLaneH = laneUnit * audioLaneRatio
  const speedLaneH = laneUnit * speedLaneRatio
  const speedPoints = useStore((s) => s.settings.midiSpeedAutomation)
  const speedYRangeLog2 = useStore(
    (s) => s.settings.midiSpeedAutomationYRangeLog2,
  )
  const speedYCenterLog2 = useStore(
    (s) => s.settings.midiSpeedAutomationYCenterLog2,
  )
  const speedMap = useMemo(() => buildSpeedMap(speedPoints), [speedPoints])
  // Timeline pins (settings keyframes). `time` is TL_audio; the pin
  // strip converts to the editor's display-time x-axis itself.
  const settingsKeyframes = useStore((s) => s.settings.settingsKeyframes)
  // The selected pin (what the Inspector edits) — explicit, set by
  // clicking a pin / adding one. `null` = editing the base default.
  // The lane glows this pin so the selection is visible.
  const pinEditTargetTime = useStore((s) => s.editingKeyframeTime)

  // Per-note tint for the timeline MIDI clip: each note is coloured by
  // the pin-resolved tint at its OWN time, so the whole colour
  // automation reads as a static gradient along the clip even while
  // paused — not a single playhead colour. Memoised on the inputs that
  // actually change it (notes / pins / base tint / speed map / MIDI
  // offset) — NOT the playhead — so scrubbing/playing never recomputes
  // it or repaints the canvas. `null` when there are no pins → the
  // canvas falls back to the plain base colour exactly as before (zero
  // behaviour change, zero cost). A note's TL_audio time (the pin axis)
  // is `midiOffset + midiToTimeline(speedMap, n.time)` — the same
  // MIDI-time → TL_audio mapping the pin strip uses, so a note sitting
  // under a pin gets that pin's colour.
  // Gradient / random colouring always takes the per-note path (each
  // note's colour depends on its key / id, not just its track).
  const noteColoring = useStore(useShallow((s) => noteColoringDeps(s.settings)))
  const midiNoteTints = useMemo<string[] | null>(() => {
    const base = useStore.getState().settings
    if (!song || (settingsKeyframes.length === 0 && base.noteColorMode === 'solid')) return null
    const out = new Array<string>(song.notes.length)
    const resolver = new NoteColorResolver()
    for (let i = 0; i < song.notes.length; i++) {
      const n = song.notes[i]
      const audioT = midiOffsetSec + midiToTimeline(speedMap, n.time)
      resolver.update(resolveNoteTintAt(base, settingsKeyframes, audioT))
      out[i] = resolver.hex(n.midi, n.track, n.id)
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song, settingsKeyframes, baseNoteColor, baseTrackColors, noteColoring, speedMap, midiOffsetSec])
  // Visible window endpoints — collapse to the trimmed range so the
  // timeline reflects what will actually play / be exported. The
  // x-axis stays in NATURAL-MIDI-time (no speed-curve stretching);
  // speed automation only changes when audio fires, not where notes
  // appear on the editor's timeline. This keeps editing operations
  // (drag, click, etc.) predictable when curves are aggressive.
  const audioEnd = audioDuration > 0 ? offsetSec + audioTrimEndSec : 0
  const midiEnd = songDuration > 0 ? midiTrimEndSec + midiOffsetSec : 0
  const totalDuration = Math.max(0.001, midiEnd, audioEnd)

  // With a song loaded the audio lane is always shown — empty, it holds
  // the "add audio" affordance so the accompaniment feature is
  // discoverable without knowing about drag-and-drop.
  const showAudioLane =
    !!song || !!audioFileName || !!audioLoading || !!audioError || !!peaks
  // Also shown after a failed decode, next to the error, so the user can retry.
  const audioEmpty = !peaks && !audioLoading
  const onAddAudio = async () => {
    const result = await pickAndImportUserAudio()
    if (result.kind === 'error') {
      void showAlert({ title: result.title ?? t('lane.addAudioFailed'), message: result.message, tone: 'error' })
    }
  }

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setAreaWidth(el.clientWidth)
    })
    ro.observe(el)
    setAreaWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  // Effective scale + visible window. `pxPerSec` is what every drawing
  // calculation reads — applying zoom here lets the rest of the layout
  // stay zoom-agnostic. `scrollSec` is clamped so the right edge can't
  // scroll past the song (the "extra empty space" UX is unhelpful for
  // a fixed-duration timeline).
  // Anchor the visual scale to the tracks' NATURAL durations (no
  // offsets). That way dragging an offset slides the clip along the
  // timeline without rescaling — the MIDI's pixel width stays the
  // same when the user shifts the audio (and vice versa). The full
  // timeline (`totalDuration`, which includes offsets) is still used
  // for scroll extents below, so the user can pan to see clips that
  // have been pushed past the original end.
  // Auto-fit anchored to the longest natural track. Speed automation
  // doesn't affect the editor's x-scale; stretching the timeline on
  // every curve edit makes coarse moves unwieldy.
  const baseDuration = Math.max(0.001, songDuration, audioDuration)
  const fitPxPerSec = areaWidth / baseDuration
  const pxPerSec = fitPxPerSec * zoom
  const viewDuration = areaWidth > 0 ? areaWidth / pxPerSec : totalDuration
  const maxScroll = Math.max(0, totalDuration - viewDuration)
  const clampedScroll = Math.max(0, Math.min(maxScroll, scrollSec))
  // Snap state when the clamp differs by more than a frame's worth —
  // happens when zooming out past the current scroll, or when the
  // song shrinks underneath us. Avoids drifting state.
  useEffect(() => {
    if (Math.abs(clampedScroll - scrollSec) > 0.001) setScrollSec(clampedScroll)
  }, [clampedScroll, scrollSec])

  // Snap zoom back to 1 (and scroll to 0) whenever the song becomes
  // null — a fresh / empty session shouldn't keep the prior zoom.
  useEffect(() => {
    if (!song) {
      setZoom(1)
      setScrollSec(0)
    }
  }, [song])

  const playheadInView = currentTime - clampedScroll
  const playheadVisible =
    playheadInView >= 0 && playheadInView <= viewDuration
  const playheadX = playheadInView * pxPerSec

  // ── Auto-follow during playback ──
  // Opt-in via `settings.followPlayhead`. When on, the timeline
  // glides continuously under a stationary playhead — the playhead
  // is anchored at the centre of the visible window and the scroll
  // is recomputed every frame to match. Near the song's edges the
  // scroll clamps and the playhead drifts off-centre naturally
  // (no fake snap-back). Off by default so manual minimap edits
  // aren't hijacked.
  const followPlayhead = useStore((s) => s.settings.followPlayhead)
  // Suspend follow while the pointer is over the minimap. Without
  // this, the visible-window indicator (and the handles attached to
  // its edges) glides under the cursor as the playhead advances —
  // which reads as "hovering changes the zoom" because the handle
  // appears to move out from under the cursor. Toggle state itself
  // is preserved; follow resumes the moment the pointer leaves.
  const [minimapHovered, setMinimapHovered] = useState(false)
  useEffect(() => {
    if (!followPlayhead) return
    if (minimapHovered) return
    if (transport !== 'playing') return
    if (zoom <= 1.001) return
    const target = currentTime - viewDuration * 0.5
    const next = Math.max(0, Math.min(maxScroll, target))
    setScrollSec(next)
  }, [followPlayhead, minimapHovered, currentTime, transport, zoom, viewDuration, maxScroll])

  // ── Wheel: zoom (default) / pan (shift or horizontal delta) ──
  // Refs mirror state so we can attach the wheel listener once with
  // `passive: false` (required for preventDefault) instead of re-
  // binding on every change.
  const stateRef = useRef({
    zoom,
    scrollSec: clampedScroll,
    pxPerSec,
    fitPxPerSec,
    totalDuration,
    areaWidth,
    viewDuration,
    maxScroll,
    songLoaded: !!song,
  })
  stateRef.current = {
    zoom,
    scrollSec: clampedScroll,
    pxPerSec,
    fitPxPerSec,
    totalDuration,
    areaWidth,
    viewDuration,
    maxScroll,
    songLoaded: !!song,
  }
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      const s = stateRef.current
      if (!s.songLoaded || s.areaWidth <= 0) return
      // preventDefault stops the canvas-area wheel-to-seek listener
      // (Viewport.tsx) from firing under the timeline AND blocks the
      // browser's default page scroll. stopPropagation is belt-and-
      // braces for nested listeners.
      e.preventDefault()
      e.stopPropagation()
      const rect = el.getBoundingClientRect()
      const cursorX = e.clientX - rect.left
      // Treat horizontal trackpad gestures and shift+wheel as pan.
      // Most mice produce only deltaY; pure-vertical wheel = zoom.
      const dominantHorizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY)
      const wantsPan = e.shiftKey || dominantHorizontal
      if (wantsPan) {
        const dx = dominantHorizontal ? e.deltaX : e.deltaY
        const dt = dx / s.pxPerSec
        const next = Math.max(0, Math.min(s.maxScroll, s.scrollSec + dt))
        setScrollSec(next)
        return
      }
      // Zoom centered on the cursor's current time so the time under
      // the cursor stays put across the gesture — natural fine-detail
      // workflow.
      const cursorTime = s.scrollSec + cursorX / s.pxPerSec
      const factor = Math.exp(-e.deltaY * ZOOM_PER_DELTA)
      const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, s.zoom * factor))
      setZoom(newZoom)
      const newPxPerSec = s.fitPxPerSec * newZoom
      const newViewDuration = s.areaWidth / newPxPerSec
      const newMaxScroll = Math.max(0, s.totalDuration - newViewDuration)
      const newScroll = cursorTime - cursorX / newPxPerSec
      setScrollSec(Math.max(0, Math.min(newMaxScroll, newScroll)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // ── Pin shortcuts ──
  // `P` drops a pin at the playhead; Delete/Backspace removes the
  // currently-selected pin. Bubble phase + the same text-input guard
  // useGlobalShortcuts uses, so typing in the search box / a slider
  // never triggers it. Gated on a loaded song.
  useEffect(() => {
    const isEditable = (t: EventTarget | null): boolean => {
      if (!(t instanceof HTMLElement)) return false
      const tag = t.tagName
      if (tag === 'TEXTAREA' || t.isContentEditable) return true
      if (tag === 'INPUT') {
        const type = (t as HTMLInputElement).type.toLowerCase()
        return !['checkbox', 'radio', 'range', 'button', 'color'].includes(type)
      }
      return false
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (isEditable(e.target)) return
      const s = useStore.getState()
      if (!s.song) return
      // Shift+K: plain letters play the PC-keyboard piano (P is a key), Shift is the shortcut layer.
      if (e.code === 'KeyK' && e.shiftKey && !e.repeat) {
        e.preventDefault()
        s.addKeyframe(audioEngine.currentSongTime())
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        // Delete the targeted keyframe, but only when no notes are selected: with a selection the
        // key deletes the notes (useGlobalShortcuts) and must not take a keyframe with them.
        // (defaultPrevented: the note handler ran first and already cleared the selection)
        if (s.editingKeyframeTime !== null && s.selection.size === 0 && !e.defaultPrevented) {
          e.preventDefault()
          s.removeKeyframe(s.editingKeyframeTime)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ── Seek interactions ──
  // Both surfaces (seek bar + MIDI lane) ultimately produce the same
  // (cursor x → song time) mapping, so a click at the same screen x
  // on either surface lands on the same time.
  //
  // The seek bar spans the full song while the MIDI lane spans only
  // the visible window. We bridge that asymmetry by *auto-panning*
  // the visible window when the seek bar is clicked: the new scroll
  // is set so the cursor's seek-bar fraction matches the cursor's
  // visible-window fraction (`scroll = fraction × maxScroll`). After
  // that adjustment, the playhead lands at the same x in both
  // surfaces — clicking the seek bar at 50% drops the playhead at
  // 50% of the seek bar AND 50% of the MIDI lane, on the same time.
  // The MIDI lane handler is unchanged: it already uses the visible-
  // window mapping, which is correct for clicks that land inside the
  // current view (no pan needed).
  const seekFraction = (clientX: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    return (clientX - r.left) / r.width
  }
  const seekToTime = (displayTime: number) => {
    // The ruler / minimap / progress slider all operate in the
    // editor's natural-MIDI-time + offset coords (display-time);
    // the engine's seek API expects TL_audio. Map through the speed
    // curve so a click on a TL_audio ruler tick actually seeks to
    // the elapsed-time that tick represents.
    const clamped = Math.max(0, Math.min(totalDuration, displayTime))
    const tlAudio =
      midiOffsetSec + midiToTimeline(speedMap, clamped - midiOffsetSec)
    audioEngine.seek(tlAudio)
    useStore.getState().setCurrentTime(tlAudio)
  }
  const seekVisibleWindow = (clientX: number, el: HTMLElement) => {
    seekToTime(clampedScroll + seekFraction(clientX, el) * viewDuration)
  }
  const seekDraggingRef = useRef<boolean>(false)
  // Ghost playhead + time chip under the pointer while it is over the ruler, showing where a
  // click will seek (the ruler has no other "this is a seek bar" cue). Updated imperatively:
  // this component is large and must not re-render on every pointer move.
  const hoverChipRef = useRef<HTMLSpanElement>(null)
  const hoverLineRef = useRef<HTMLDivElement>(null)
  const showRulerHover = (displayTime: number | null) => {
    const chip = hoverChipRef.current
    const line = hoverLineRef.current
    if (!chip || !line) return
    if (displayTime === null) {
      chip.style.display = line.style.display = 'none'
      return
    }
    const x = `${(displayTime - clampedScroll) * pxPerSec}px`
    chip.style.left = line.style.left = x
    chip.style.display = line.style.display = 'block'
    chip.textContent = formatClock(midiOffsetSec + midiToTimeline(speedMap, displayTime - midiOffsetSec))
  }
  const rulerHandlers = {
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
      if (!song) return
      // Right-click is reserved for the lane context menu; ignore so
      // we don't grab pointer capture and trigger an unwanted seek.
      if (e.button !== 0) return
      seekDraggingRef.current = true
      e.currentTarget.setPointerCapture(e.pointerId)
      seekVisibleWindow(e.clientX, e.currentTarget)
    },
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
      if (song) showRulerHover(clampedScroll + Math.max(0, Math.min(1, seekFraction(e.clientX, e.currentTarget))) * viewDuration)
      if (!seekDraggingRef.current) return
      seekVisibleWindow(e.clientX, e.currentTarget)
    },
    onPointerLeave: () => showRulerHover(null),
    onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => {
      if (!seekDraggingRef.current) return
      seekDraggingRef.current = false
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        /* capture may already be released — ignore */
      }
    },
  }

  // ── Audio clip drag (positive offset only in this MVP) ──
  const audioDragRef = useRef<{
    startX: number
    startOffset: number
    captured: boolean
  } | null>(null)
  const onAudioPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!peaks) return
    if (e.button !== 0) return
    audioDragRef.current = {
      startX: e.clientX,
      startOffset: offsetSec,
      captured: false,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    audioDragRef.current.captured = true
    beginEdit()
  }
  const onAudioPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = audioDragRef.current
    if (!drag || !peaks) return
    if ((e.buttons & 1) === 0) {
      onAudioPointerUp(e)
      return
    }
    const dx = e.clientX - drag.startX
    const dt = pxPerSec > 0 ? dx / pxPerSec : 0
    // Same as the MIDI clip: trimmed head shouldn't pin the visible
    // left edge above 0 on the timeline.
    const minOffset = -userAudioTrimStartSec
    const next = Math.max(minOffset, drag.startOffset + dt)
    if (next !== offsetSec) updateSettings({ userAudioOffsetSec: next })
  }
  const onAudioPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = audioDragRef.current
    if (!drag) return
    if (drag.captured) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        /* capture may already be released — ignore */
      }
    }
    audioDragRef.current = null
    endEdit()
  }

  // Disable follow on intentional minimap interactions (pan drag,
  // edge resize). Wheel zoom + wheel pan deliberately don't disable
  // — zoom-around-cursor with follow on still produces a sensible
  // "zoom around the playhead" feel because follow re-centers on the
  // next frame, and pan is a transient gesture that the user can
  // toggle Follow off explicitly if they want it to stick.
  const disableFollowIfOn = () => {
    const s = useStore.getState()
    if (s.settings.followPlayhead) {
      s.updateSettings({ followPlayhead: false })
    }
  }

  // ── Minimap pan (full-song overview → visible window position) ──
  // Clicking jumps the visible window so its centre lines up with the
  // click; subsequent drag pans continuously. NEVER seeks — the
  // playhead stays where it is so a glance at the minimap doesn't
  // accidentally interrupt playback. The thin playhead line drawn
  // inside is purely an orientation aid.
  const minimapDragRef = useRef<{ startX: number; startScroll: number } | null>(
    null,
  )
  const onMinimapPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!song) return
    if (e.button !== 0) return
    if (areaWidth <= 0 || maxScroll <= 0) return
    disableFollowIfOn()
    const rect = e.currentTarget.getBoundingClientRect()
    const fraction = (e.clientX - rect.left) / rect.width
    const target = fraction * totalDuration - viewDuration / 2
    const clampedTarget = Math.max(0, Math.min(maxScroll, target))
    setScrollSec(clampedTarget)
    minimapDragRef.current = {
      startX: e.clientX,
      startScroll: clampedTarget,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onMinimapPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = minimapDragRef.current
    if (!drag) return
    const dx = e.clientX - drag.startX
    const dt = (dx / areaWidth) * totalDuration
    const next = Math.max(0, Math.min(maxScroll, drag.startScroll + dt))
    setScrollSec(next)
  }
  const onMinimapPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!minimapDragRef.current) return
    minimapDragRef.current = null
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* capture may already be released — ignore */
    }
  }

  // ── Minimap edge resize (drag the visible-window edges → zoom) ──
  // Dragging the left edge moves the window's start (right edge fixed):
  // dragging right zooms in, left zooms out. The right edge is the
  // mirror. Lets the user reframe the view directly on the overview
  // bar without going through wheel-zoom + pan.
  const minimapResizeRef = useRef<{
    side: 'left' | 'right'
    startX: number
    startScroll: number
    startView: number
  } | null>(null)
  const onMinimapEdgePointerDown =
    (side: 'left' | 'right') =>
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!song || e.button !== 0) return
      if (areaWidth <= 0 || totalDuration <= 0) return
      e.stopPropagation()
      disableFollowIfOn()
      minimapResizeRef.current = {
        side,
        startX: e.clientX,
        startScroll: clampedScroll,
        startView: viewDuration,
      }
      e.currentTarget.setPointerCapture(e.pointerId)
    }
  const onMinimapEdgePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = minimapResizeRef.current
    if (!drag || areaWidth <= 0 || totalDuration <= 0) return
    e.stopPropagation()
    const dx = e.clientX - drag.startX
    // Map minimap-x delta (in px) to song-time delta. The minimap
    // covers `[0, totalDuration]` across `areaWidth` px.
    const dt = (dx / areaWidth) * totalDuration
    // Min view = the smallest window any zoom level allows.
    const minView = totalDuration / MAX_ZOOM
    if (drag.side === 'left') {
      const end = drag.startScroll + drag.startView
      let newStart = drag.startScroll + dt
      newStart = Math.max(0, Math.min(end - minView, newStart))
      const newView = end - newStart
      setZoom(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, totalDuration / newView)))
      setScrollSec(newStart)
    } else {
      const start = drag.startScroll
      let newEnd = start + drag.startView + dt
      newEnd = Math.max(start + minView, Math.min(totalDuration, newEnd))
      const newView = newEnd - start
      setZoom(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, totalDuration / newView)))
      setScrollSec(start)
    }
  }
  const onMinimapEdgePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!minimapResizeRef.current) return
    e.stopPropagation()
    minimapResizeRef.current = null
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* capture may already be released — ignore */
    }
  }

  // ── Trim handles (drag clip head/tail to hide content) ──
  // Trim is non-destructive: notes / audio samples outside the window
  // are silenced at playback time but the underlying ParsedSong /
  // AudioBuffer is untouched. Dragging the right handle leftward
  // shortens the audible tail; dragging the left handle rightward
  // hides the head. The clip BODY drag still controls offset, so the
  // gesture taxonomy is: edge = trim, body = position.
  const MIN_CLIP_DURATION = 0.05
  const midiTrimDragRef = useRef<{
    side: 'left' | 'right'
    startX: number
    startTrimStart: number
    startTrimEnd: number
  } | null>(null)
  const onMidiTrimPointerDown =
    (side: 'left' | 'right') =>
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!song || e.button !== 0) return
      e.stopPropagation()
      midiTrimDragRef.current = {
        side,
        startX: e.clientX,
        startTrimStart: midiTrimStartSec,
        startTrimEnd: midiTrimEndSec,
      }
      e.currentTarget.setPointerCapture(e.pointerId)
      beginEdit()
    }
  const onMidiTrimPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = midiTrimDragRef.current
    if (!d || !song) return
    if ((e.buttons & 1) === 0) {
      onMidiTrimPointerUp(e)
      return
    }
    e.stopPropagation()
    // Pointer delta is timeline-pixels → timeline-seconds (and since
    // the timeline x-axis is natural MIDI-time, the delta IS the
    // MIDI-time delta — no speed-map conversion needed).
    const dt = pxPerSec > 0 ? (e.clientX - d.startX) / pxPerSec : 0
    if (d.side === 'left') {
      const max = d.startTrimEnd - MIN_CLIP_DURATION
      const clamped = Math.max(0, Math.min(max, d.startTrimStart + dt))
      if (clamped !== midiTrimStartSec) {
        updateSettings({ midiTrimStartSec: clamped })
      }
    } else {
      const min = d.startTrimStart + MIN_CLIP_DURATION
      const clamped = Math.max(min, Math.min(songDuration, d.startTrimEnd + dt))
      // Collapse "trimmed exactly to natural end" back to null so the
      // value stays meaningful if the underlying song's duration
      // changes later (live-edited note past the previous end, etc.).
      const stored = clamped >= songDuration - 0.001 ? null : clamped
      if (stored !== midiTrimEndSecRaw) {
        updateSettings({ midiTrimEndSec: stored })
      }
    }
  }
  const onMidiTrimPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!midiTrimDragRef.current) return
    e.stopPropagation()
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* capture may already be released — ignore */
    }
    midiTrimDragRef.current = null
    endEdit()
  }

  const audioTrimDragRef = useRef<{
    side: 'left' | 'right'
    startX: number
    startTrimStart: number
    startTrimEnd: number
  } | null>(null)
  const onAudioTrimPointerDown =
    (side: 'left' | 'right') =>
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!peaks || e.button !== 0) return
      e.stopPropagation()
      audioTrimDragRef.current = {
        side,
        startX: e.clientX,
        startTrimStart: userAudioTrimStartSec,
        startTrimEnd: audioTrimEndSec,
      }
      e.currentTarget.setPointerCapture(e.pointerId)
      beginEdit()
    }
  const onAudioTrimPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = audioTrimDragRef.current
    if (!d || !peaks) return
    if ((e.buttons & 1) === 0) {
      onAudioTrimPointerUp(e)
      return
    }
    e.stopPropagation()
    const dt = pxPerSec > 0 ? (e.clientX - d.startX) / pxPerSec : 0
    if (d.side === 'left') {
      const max = d.startTrimEnd - MIN_CLIP_DURATION
      const next = Math.max(0, Math.min(max, d.startTrimStart + dt))
      if (next !== userAudioTrimStartSec) {
        updateSettings({ userAudioTrimStartSec: next })
      }
    } else {
      const min = d.startTrimStart + MIN_CLIP_DURATION
      const next = Math.max(min, Math.min(audioDuration, d.startTrimEnd + dt))
      const stored = next >= audioDuration - 0.001 ? null : next
      if (stored !== userAudioTrimEndSecRaw) {
        updateSettings({ userAudioTrimEndSec: stored })
      }
    }
  }
  const onAudioTrimPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!audioTrimDragRef.current) return
    e.stopPropagation()
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* capture may already be released — ignore */
    }
    audioTrimDragRef.current = null
    endEdit()
  }

  // ── MIDI clip drag (positive offset only, like audio) ──
  const midiDragRef = useRef<{
    startX: number
    startOffset: number
  } | null>(null)
  const onMidiPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!song) return
    if (e.button !== 0) return
    e.stopPropagation()
    midiDragRef.current = {
      startX: e.clientX,
      startOffset: midiOffsetSec,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    beginEdit()
  }
  const onMidiPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = midiDragRef.current
    if (!drag || !song) return
    if ((e.buttons & 1) === 0) {
      onMidiPointerUp(e)
      return
    }
    const dx = e.clientX - drag.startX
    const dt = pxPerSec > 0 ? dx / pxPerSec : 0
    // The clip's visible left edge sits at `offset + trimStart` on
    // the natural-duration timeline; clamp so it can reach 0. No
    // speed-map conversion needed since the editor's x-axis is in
    // natural MIDI-time.
    const minOffset = -midiTrimStartSec
    const next = Math.max(minOffset, drag.startOffset + dt)
    if (next !== midiOffsetSec) {
      // Move the pins with the clip by exactly the applied delta so
      // the colour automation stays glued to the notes (offset is a
      // pure additive shift of every note's TL_audio time). Both
      // mutations sit inside this drag's begin/endSettingsEdit
      // bracket, so the whole move collapses to one undo entry.
      shiftKeyframes(next - midiOffsetSec)
      updateSettings({ midiOffsetSec: next })
    }
  }
  const onMidiPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!midiDragRef.current) return
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* capture may already be released — ignore */
    }
    midiDragRef.current = null
    endEdit()
  }

  // Visible-window clip rectangles. Shared windowing math: only the
  // portion of each clip overlapping the visible window gets drawn,
  // keeping canvas memory bounded at high zoom levels (without this, a
  // 4-minute clip at 50× zoom would allocate a 200 000-px-wide canvas).
  // Clip starts/ends include the trim window — content outside the
  // trim is hidden visually (mirroring engine playback) so the
  // drawable surface shrinks to the trimmed range.
  const audioClipStart = offsetSec + userAudioTrimStartSec
  const audioClipEnd = offsetSec + audioTrimEndSec
  const audioVisStart = Math.max(clampedScroll, audioClipStart)
  const audioVisEnd = Math.min(clampedScroll + viewDuration, audioClipEnd)
  const audioClipLeft = (audioVisStart - clampedScroll) * pxPerSec
  const audioClipWidth = Math.max(0, (audioVisEnd - audioVisStart) * pxPerSec)
  // Buffer offset = timeline offset from the *natural* audio start
  // (NOT the trimmed start). Trim only hides; the underlying buffer
  // origin doesn't move, so the waveform under the trimmed clip still
  // matches the corresponding samples in the audio file.
  const audioStartInBuffer = Math.max(0, audioVisStart - offsetSec)

  const midiClipStart = midiOffsetSec + midiTrimStartSec
  const midiClipEnd = midiOffsetSec + midiTrimEndSec
  const midiVisStart = Math.max(clampedScroll, midiClipStart)
  const midiVisEnd = Math.min(clampedScroll + viewDuration, midiClipEnd)
  const midiClipLeft = (midiVisStart - clampedScroll) * pxPerSec
  const midiClipWidth = Math.max(0, (midiVisEnd - midiVisStart) * pxPerSec)
  // Canvas's "time at x = 0" — in TIMELINE coordinates relative to
  // the MIDI clip's natural t=0 (offset removed). The canvas's note
  // drawing maps each note's MIDI-time through `speedMap` itself, so
  // we hand it the timeline origin and let it convert per-note.
  const midiStartInSong = Math.max(0, midiVisStart - midiOffsetSec)
  // Speed automation lane lives directly under the MIDI lane and
  // only appears when there's a MIDI to automate. Sits inside the
  // playhead-spanning section so the playhead line covers it too.
  const showSpeedLane = !!song
  // Pin strip — fixed thin height, sits directly under the ruler so
  // it reads as part of the time scale. Only meaningful with a song.
  const showPinLane = !!song
  const totalRowHeight =
    MINIMAP_HEIGHT +
    ROW_GAP +
    RULER_HEIGHT +
    (showPinLane ? ROW_GAP + PIN_LANE_HEIGHT : 0) +
    ROW_GAP +
    midiLaneH +
    (showSpeedLane ? ROW_GAP + speedLaneH : 0) +
    (showAudioLane ? ROW_GAP + audioLaneH : 0)

  const onToggleMidiMute = () => {
    beginEdit()
    updateSettings({ midiEnabled: !midiEnabled })
    endEdit()
  }
  const onToggleAudioMute = () => {
    beginEdit()
    updateSettings({
      userAudioVolume: audioMuted ? lastNonZeroAudioRef.current : 0,
    })
    endEdit()
  }

  return (
    <div className="relative flex w-full select-none" style={{ gap: 10 }}>
      {/* Left track-header column — track names + mute controls per
          lane, FL-Studio-style. Heights mirror the right-column row
          stack 1:1 so each header aligns with its lane. Inter-header
          gaps are LaneDivider elements (same height as the right
          column's ROW_GAP) so total column heights match while the
          dividers also serve as drag handles to redistribute lane
          height. Ruler and minimap rows are plain spacers. */}
      <div
        className="flex shrink-0 flex-col"
        style={{ width: HEADER_WIDTH }}
      >
        <div style={{ height: RULER_HEIGHT }} />
        {showPinLane && (
          <>
            <div style={{ height: ROW_GAP }} />
            <div
              className="flex items-center"
              style={{ height: PIN_LANE_HEIGHT }}
            >
              <span className="truncate text-body text-ink-muted">
                {t('lane.keyframes')}
              </span>
            </div>
          </>
        )}
        <div style={{ height: ROW_GAP }} />
        <LaneHeader
          title={t('lane.midi')}
          height={midiLaneH}
          muted={midiMuted}
          enabled={midiEnabled}
          onToggleMute={song ? onToggleMidiMute : undefined}
          onOpenMenu={song ? (e) => openMenuAt('midi', e) : undefined}
        />
        {showSpeedLane ? (
          <>
            <LaneDivider
              upperKey="timelineMidiLaneRatio"
              lowerKey="timelineSpeedLaneRatio"
            />
            <LaneHeader
              title={t('lane.speed')}
              height={speedLaneH}
            />
            {showAudioLane && (
              <>
                <LaneDivider
                  upperKey="timelineSpeedLaneRatio"
                  lowerKey="timelineAudioLaneRatio"
                />
                <LaneHeader
                  title={audioFileName ?? t('lane.audio')}
                  height={audioLaneH}
                  muted={audioMuted}
                  onToggleMute={peaks ? onToggleAudioMute : undefined}
                  onOpenMenu={
                    peaks ? (e) => openMenuAt('audio', e) : undefined
                  }
                />
              </>
            )}
          </>
        ) : (
          showAudioLane && (
            <>
              <LaneDivider
                upperKey="timelineMidiLaneRatio"
                lowerKey="timelineAudioLaneRatio"
              />
              <LaneHeader
                title={audioFileName ?? t('lane.audio')}
                height={audioLaneH}
                muted={audioMuted}
                onToggleMute={peaks ? onToggleAudioMute : undefined}
                onOpenMenu={
                  peaks ? (e) => openMenuAt('audio', e) : undefined
                }
              />
            </>
          )
        )}
        <div style={{ height: ROW_GAP }} />
        <div style={{ height: MINIMAP_HEIGHT }} />
      </div>
      {/* Timeline area — stacked lane rows + single playhead overlay.
          Widths measured off this wrapper (not the outer flex row) so
          areaWidth excludes the header column. */}
      <div className="relative min-w-0 flex-1" ref={wrapRef}>
        <div
          className="flex flex-col"
          style={{ height: totalRowHeight, gap: ROW_GAP }}
        >
          {/* Time ruler — maps to the visible window for sub-second
              targeting. The full-song progress slider lives in the
              transport overlay (see SeekBar.tsx); this ruler is the
              fine-grained editing scrub surface and stays visible at
              all times alongside the lanes. Click + drag scrubs.
              Double-click resets zoom + scroll. */}
          <div
            onPointerDown={rulerHandlers.onPointerDown}
            onPointerMove={rulerHandlers.onPointerMove}
            onPointerUp={rulerHandlers.onPointerUp}
            onPointerCancel={rulerHandlers.onPointerUp}
            onPointerLeave={rulerHandlers.onPointerLeave}
            onDoubleClick={() => {
              setZoom(1)
              setScrollSec(0)
            }}
            style={{ height: RULER_HEIGHT, touchAction: 'none' }}
            className={
              song
                ? 'relative cursor-pointer overflow-hidden'
                : 'relative overflow-hidden'
            }
            aria-label={t('ruler.seekAria')}
            title={song ? t('ruler.seekTitle') : undefined}
          >
            {song && areaWidth > 0 && (
              <RulerCanvas
                width={areaWidth}
                height={RULER_HEIGHT}
                startTimeSec={clampedScroll}
                pxPerSec={pxPerSec}
                speedMap={speedMap}
                midiOffsetSec={midiOffsetSec}
              />
            )}
            {song && (
              <span
                ref={hoverChipRef}
                aria-hidden
                className="nf-glass-strong pointer-events-none absolute top-px z-10 -translate-x-1/2 rounded-field px-1.5 text-caption tabular-nums text-ink"
                style={{ display: 'none' }}
              />
            )}
            {/* Fit / reset-zoom affordance — visible when zoomed in
                so the user has a one-click way back to the overview.
                Double-clicking the ruler does the same, but that's
                undiscoverable. Pinned to the right edge so the ruler
                labels on the left don't compete with it. */}
            {song && zoom > 1.001 && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  setZoom(1)
                  setScrollSec(0)
                }}
                onPointerDown={(e) => e.stopPropagation()}
                aria-label={t('ruler.resetZoomAria')}
                title={t('ruler.resetZoomTitle')}
                className="absolute right-1 top-1/2 z-10 flex h-4 -translate-y-1/2 items-center nf-focus rounded-field bg-fill-field px-1.5 text-caption text-ink outline-none hover:bg-fill-selected"
              >
                1×
              </button>
            )}
          </div>

          {/* Pin strip — settings-snapshot markers. Sits directly
              under the ruler so it reads as part of the time scale;
              inside the playhead-spanning section so the playhead
              line crosses it too. Pin time is TL_audio; the strip
              maps to the editor's display-time x-axis internally. */}
          {showPinLane && (
            <SettingsPinLane
              keyframes={settingsKeyframes}
              editingTime={pinEditTargetTime}
              speedMap={speedMap}
              laneHeight={PIN_LANE_HEIGHT}
              pxPerSec={pxPerSec}
              clampedScroll={clampedScroll}
              viewDuration={viewDuration}
              midiOffsetSec={midiOffsetSec}
              totalDuration={totalDuration}
            />
          )}

          {/* MIDI lane — piano-roll preview as a draggable clip,
              mirroring the audio lane's interaction model. Click-to-
              seek belongs to the seek bar above; the lane itself is
              drag-only so the gesture is unambiguous. Right-click
              opens the lane context menu (mute / volume / reset). */}
          <div
            onContextMenu={(e) => openMenuAt('midi', e)}
            style={{ height: midiLaneH }}
            className="group relative overflow-hidden rounded-field bg-white/5"
          >
            {song && areaWidth > 0 && midiClipWidth > 0 && (
              <div
                onPointerDown={onMidiPointerDown}
                onPointerMove={onMidiPointerMove}
                onPointerUp={onMidiPointerUp}
                onPointerCancel={onMidiPointerUp}
                className="absolute top-0 cursor-grab rounded-field bg-fill-field shadow-[inset_0_0_0_1px_var(--glass-edge)] active:cursor-grabbing"
                style={{
                  left: midiClipLeft,
                  width: midiClipWidth,
                  height: midiLaneH,
                  touchAction: 'none',
                }}
                title={t('clip.syncTitle', { offset: midiOffsetSec.toFixed(2) })}
              >
                <MidiPreviewCanvas
                  notes={song.notes}
                  width={midiClipWidth}
                  height={midiLaneH}
                  pxPerSec={pxPerSec}
                  startTimeSec={midiStartInSong}
                  color={baseNoteColor}
                  trackColors={baseTrackColors}
                  noteColors={midiNoteTints}
                />
                <TrimHandle
                  side="left"
                  laneHeight={midiLaneH}
                  ariaLabel={t('trim.midiHead')}
                  onPointerDown={onMidiTrimPointerDown('left')}
                  onPointerMove={onMidiTrimPointerMove}
                  onPointerUp={onMidiTrimPointerUp}
                />
                <TrimHandle
                  side="right"
                  laneHeight={midiLaneH}
                  ariaLabel={t('trim.midiTail')}
                  onPointerDown={onMidiTrimPointerDown('right')}
                  onPointerMove={onMidiTrimPointerMove}
                  onPointerUp={onMidiTrimPointerUp}
                />
              </div>
            )}
          </div>

          {/* Speed automation lane — only meaningful with a MIDI
              loaded. Sits between the MIDI clip and the audio clip
              so the user sees the curve directly under the notes it
              affects. */}
          {showSpeedLane && (
            <SpeedAutomationLane
              points={speedPoints}
              speedMap={speedMap}
              areaWidth={areaWidth}
              laneHeight={speedLaneH}
              pxPerSec={pxPerSec}
              clampedScroll={clampedScroll}
              viewDuration={viewDuration}
              midiOffsetSec={midiOffsetSec}
              songDuration={songDuration}
              yRangeLog2={speedYRangeLog2}
              yCenterLog2={speedYCenterLog2}
              onPointsChange={(next) =>
                updateSettings({ midiSpeedAutomation: next })
              }
              beginEdit={beginEdit}
              endEdit={endEdit}
            />
          )}

          {/* Audio lane — waveform clip the user can drag. Right-click
              opens the lane context menu. */}
          {showAudioLane && (
            <div
              onContextMenu={(e) => openMenuAt('audio', e)}
              className="group relative overflow-hidden rounded-field bg-white/5"
              style={{ height: audioLaneH }}
            >
              {peaks && areaWidth > 0 && audioClipWidth > 0 && (
                <div
                  onPointerDown={onAudioPointerDown}
                  onPointerMove={onAudioPointerMove}
                  onPointerUp={onAudioPointerUp}
                  onPointerCancel={onAudioPointerUp}
                  className={`absolute top-0 cursor-grab rounded-field bg-fill-field shadow-[inset_0_0_0_1px_var(--glass-edge)] transition-opacity active:cursor-grabbing ${
                    audioMuted ? 'opacity-30 grayscale' : ''
                  }`}
                  style={{
                    left: audioClipLeft,
                    width: audioClipWidth,
                    height: audioLaneH,
                    touchAction: 'none',
                  }}
                  title={t('clip.syncTitle', { offset: offsetSec.toFixed(2) })}
                >
                  <WaveformCanvas
                    peaks={peaks}
                    width={audioClipWidth}
                    height={audioLaneH}
                    pxPerSec={pxPerSec}
                    startInBufferSec={audioStartInBuffer}
                    color={inkRgba(0.7)}
                  />
                  <TrimHandle
                    side="left"
                    laneHeight={audioLaneH}
                    ariaLabel={t('trim.audioHead')}
                    onPointerDown={onAudioTrimPointerDown('left')}
                    onPointerMove={onAudioTrimPointerMove}
                    onPointerUp={onAudioTrimPointerUp}
                  />
                  <TrimHandle
                    side="right"
                    laneHeight={audioLaneH}
                    ariaLabel={t('trim.audioTail')}
                    onPointerDown={onAudioTrimPointerDown('right')}
                    onPointerMove={onAudioTrimPointerMove}
                    onPointerUp={onAudioTrimPointerUp}
                  />
                </div>
              )}
              {/* Filename overlay — pinned top-right so the mute
                  affordance at top-left isn't crowded. Faded; click-
                  through so the underlying drag still works. */}
              {audioFileName && !audioLoading && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute right-2 top-1 max-w-[60%] truncate text-caption text-ink-muted"
                  title={audioFileName}
                >
                  {audioFileName}
                </div>
              )}
              {audioLoading && (
                <div className="flex h-full items-center justify-center text-caption text-ink-muted">
                  {t('lane.decoding')}
                </div>
              )}
              {audioEmpty && (
                <div className="flex h-full flex-col items-center justify-center gap-1 px-2 text-caption text-ink-faint">
                  {audioError && <span className="text-center text-danger">{audioError}</span>}
                  <span className="flex items-center gap-2">
                    <Button
                      variant="field"
                      size="sm"
                      onPress={() => void onAddAudio()}
                    >
                      {t('lane.addAudio')}
                    </Button>
                    <span>{t('lane.addAudioHint')}</span>
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Minimap — full-song overview, pan-only. Sits below the
              lanes so the playhead in the timeline (visible-window
              scale) doesn't visually compete with the minimap's
              full-song scale. The minimap carries its own playhead
              line internally for orientation. Disabled (no cursor
              change) at 1× zoom since the visible window already
              equals the full song. */}
          <div
            onPointerDown={onMinimapPointerDown}
            onPointerMove={onMinimapPointerMove}
            onPointerUp={onMinimapPointerUp}
            onPointerCancel={onMinimapPointerUp}
            onPointerEnter={() => setMinimapHovered(true)}
            onPointerLeave={() => setMinimapHovered(false)}
            style={{ height: MINIMAP_HEIGHT, touchAction: 'none' }}
            className={
              song && maxScroll > 0
                ? 'relative cursor-grab rounded-round bg-white/5 active:cursor-grabbing'
                : 'relative rounded-round bg-white/5'
            }
            aria-label={t('minimap.panAria')}
            title={
              song
                ? maxScroll > 0
                  ? t('minimap.panTitle')
                  : t('minimap.zoomToEnable')
                : undefined
            }
          >
            {song && areaWidth > 0 && totalDuration > 0 && (
              <>
                <div
                  className="absolute inset-y-0 rounded-round bg-fill-track"
                  style={{
                    left: `${(clampedScroll / totalDuration) * 100}%`,
                    width: `${(viewDuration / totalDuration) * 100}%`,
                  }}
                >
                  {/* Round resize handles centred on each edge of
                      the visible-window box. Half of each circle
                      sticks out into the dark area so they remain
                      grabbable when the window itself is narrow at
                      high zoom. The minimap container is overflow-
                      visible so the circles aren't clipped at the
                      track ends. stopPropagation in their handlers
                      prevents the surrounding minimap from also
                      starting a pan. */}
                  <div
                    aria-label={t('minimap.resizeFromLeft')}
                    onPointerDown={onMinimapEdgePointerDown('left')}
                    onPointerMove={onMinimapEdgePointerMove}
                    onPointerUp={onMinimapEdgePointerUp}
                    onPointerCancel={onMinimapEdgePointerUp}
                    className={`absolute top-1/2 z-10 h-3 w-3 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-full bg-ink shadow-knob transition-opacity duration-150 ${minimapHovered ? 'opacity-100' : 'opacity-0'}`}
                    style={{ left: 0, touchAction: 'none' }}
                  />
                  <div
                    aria-label={t('minimap.resizeFromRight')}
                    onPointerDown={onMinimapEdgePointerDown('right')}
                    onPointerMove={onMinimapEdgePointerMove}
                    onPointerUp={onMinimapEdgePointerUp}
                    onPointerCancel={onMinimapEdgePointerUp}
                    className={`absolute top-1/2 z-10 h-3 w-3 -translate-y-1/2 translate-x-1/2 cursor-ew-resize rounded-full bg-ink shadow-knob transition-opacity duration-150 ${minimapHovered ? 'opacity-100' : 'opacity-0'}`}
                    style={{ right: 0, touchAction: 'none' }}
                  />
                </div>
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-y-0 w-px bg-ink"
                  style={{
                    left: `${(currentTime / totalDuration) * 100}%`,
                  }}
                />
              </>
            )}
          </div>
        </div>
        {/* Main playhead — spans the ruler + lanes only. Stops short
            of the minimap because the minimap uses full-song scale
            (different x mapping); a continuous line from there would
            visually break. Hidden when the playhead is outside the
            visible window so it doesn't pin to an edge while the user
            has scrolled away. */}
        {song && (
          <div
            ref={hoverLineRef}
            aria-hidden
            className="pointer-events-none absolute w-px"
            style={{
              display: 'none',
              top: RULER_HEIGHT,
              height: totalRowHeight - (MINIMAP_HEIGHT + ROW_GAP) - RULER_HEIGHT,
              background: 'var(--ink-faint)',
            }}
          />
        )}
        {song && playheadVisible && (
          <div
            aria-hidden
            className="pointer-events-none absolute w-0.5 -translate-x-px bg-ink"
            style={{
              left: playheadX,
              top: 0,
              height:
                totalRowHeight - (MINIMAP_HEIGHT + ROW_GAP),
            }}
          >
            {/* The playhead's head in the ruler: a grip that says "drag me". */}
            <span className="absolute left-1/2 top-[3px] h-3.5 w-2.5 -translate-x-1/2 rounded-[3px] bg-ink shadow-knob" />
          </div>
        )}
      </div>
      {menu && (
        <LaneContextMenu
          target={menu.target}
          position={{ x: menu.x, y: menu.y }}
          onClose={closeMenu}
        />
      )}
    </div>
  )
}

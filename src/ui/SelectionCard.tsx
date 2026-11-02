import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Slider, SliderTrack } from 'react-aria-components'
import { useStore } from '../store'
import { previewNote } from '../audio/preview'
import { deleteNotes, setNotesFinger, setNotesHand, setNotesVelocity } from '../midi/edit'
import type { Finger, Hand, ParsedSong } from '../midi/types'
import { midiToName } from '../midi/noteName'
import { selectionScreenRect } from '../scene/selectionBounds'
import { Button, GEOMETRY, Icon, KnobThumb, Panel, SegmentedControl } from './kit'
import { useShell } from './shell/uiState'
import { KEY } from './shell/platform'

const CARD_W = 252
const GAP = 14
const PAD = 8

const toMidiVel = (v: number) => Math.max(1, Math.min(127, Math.round(v * 127)))

/**
 * The card beside the selected notes while paused: header, velocity (value field + slider) and
 * Delete. It tracks the selection's on-screen bounding box every frame (seek / scroll move the
 * notes), sits on the side with room and is hidden while a pointer gesture is in flight.
 *
 * Velocity: dragging shifts every selected note by the same delta (differences kept, clamped
 * 1..127); typing a number sets them all. One gesture = one undo entry (snapshot at the first
 * change, previews during, nothing to commit afterwards).
 */
export function SelectionCard({ wrapEl }: { wrapEl: HTMLElement | null }) {
  const { t } = useTranslation('editor')
  const song = useStore((s) => s.song)
  const selection = useStore((s) => s.selection)
  const cardFor = useStore((s) => s.selectionCardFor)
  const transport = useStore((s) => s.transport)
  const transpose = useStore((s) => s.settings.transpose)

  const selected = useMemo(
    () => (song ? song.notes.filter((n) => selection.has(n.id)) : []),
    [song, selection],
  )
  const open = !!wrapEl && !!song && transport !== 'playing' && selected.length > 0 && cardFor === selection

  const cardRef = useRef<HTMLDivElement>(null)
  const pointerDownRef = useRef(false)

  // The card opens on a double-click on a note (`openSelectionCard`) and closes on any press outside it;
  // the selection itself stays (a selection change closes it too). Presses on the card (slider drag)
  // must not close it.
  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => {
      if (cardRef.current?.contains(e.target as Node)) return
      pointerDownRef.current = true
      useStore.getState().closeSelectionCard()
    }
    const up = () => {
      pointerDownRef.current = false
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', up, true)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointercancel', up, true)
      pointerDownRef.current = false
    }
  }, [open])

  // The canvas scrubs time on wheel; scrolling over the card must not.
  useEffect(() => {
    const card = cardRef.current
    if (!open || !card) return
    const stop = (e: WheelEvent) => e.stopPropagation()
    card.addEventListener('wheel', stop)
    return () => card.removeEventListener('wheel', stop)
  }, [open])

  // Fades out instead of popping; stays in place so a quick re-show doesn't jump.
  const hideCard = (card: HTMLElement) => {
    card.style.opacity = '0'
    card.style.pointerEvents = 'none'
  }

  // Placement loop.
  useLayoutEffect(() => {
    if (!open || !wrapEl) return
    let raf = 0
    const place = () => {
      raf = requestAnimationFrame(place)
      const card = cardRef.current
      if (!card) return
      const rect = selectionScreenRect()
      const w = wrapEl.getBoundingClientRect()
      const h = card.offsetHeight
      const hide = !rect || pointerDownRef.current || !!useStore.getState().rangeSelectRect
      if (hide || !rect) {
        hideCard(card)
        return
      }
      const l = rect.left - w.left
      const r = rect.right - w.left
      const top = rect.top - w.top
      const bottom = rect.bottom - w.top
      if (r < 0 || l > w.width || bottom < 0 || top > w.height) {
        hideCard(card)
        return
      }
      // Free area: inside the canvas, below the top islands, above the pill, left of the Look panel.
      const { EDGE, BAR, GAP: SURFACE_GAP, PILL, PILL_BOTTOM, PANEL } = GEOMETRY
      const minX = Math.max(PAD, EDGE - w.left)
      const maxX =
        Math.min(w.width, window.innerWidth - (useShell.getState().lookOpen ? EDGE + PANEL + SURFACE_GAP : EDGE) - w.left) -
        CARD_W
      const minY = Math.max(PAD, EDGE + BAR + SURFACE_GAP - w.top)
      const timeline = document.querySelector('[data-timeline-panel]')
      const bottomEdge = timeline
        ? timeline.getBoundingClientRect().top - SURFACE_GAP
        : window.innerHeight - (PILL_BOTTOM + PILL + SURFACE_GAP)
      const maxY = Math.min(w.height - PAD, bottomEdge - w.top) - h
      const roomRight = maxX - (r + GAP)
      const roomLeft = l - GAP - CARD_W - minX
      let x: number
      if (roomRight >= 0) x = r + GAP
      else if (roomLeft >= 0) x = l - GAP - CARD_W
      else x = roomRight >= roomLeft ? r + GAP : l - GAP - CARD_W
      x = Math.max(minX, Math.min(x, maxX))
      const cy = (Math.max(top, 0) + Math.min(bottom, w.height)) / 2
      const y = Math.max(minY, Math.min(cy - h / 2, maxY))
      card.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
      card.style.visibility = 'visible'
      card.style.opacity = '1'
      card.style.pointerEvents = ''
    }
    place()
    return () => cancelAnimationFrame(raf)
  }, [open, wrapEl])

  // Velocity preview ticker: replays the selection every 500 ms while the slider is dragged so the
  // loudness change is audible (distinct pitches only).
  const previewTimer = useRef<number | null>(null)
  const firePreview = () => {
    const st = useStore.getState()
    if (!st.song || st.selection.size === 0) return
    const seen = new Set<number>()
    for (const n of st.song.notes) {
      if (!st.selection.has(n.id)) continue
      const midi = n.midi + st.settings.transpose
      if (seen.has(midi)) continue
      seen.add(midi)
      void previewNote(midi, n.velocity, 200)
    }
  }
  const startPreviewLoop = () => {
    if (previewTimer.current !== null) return
    firePreview()
    previewTimer.current = window.setInterval(firePreview, 500)
  }
  const stopPreviewLoop = () => {
    if (previewTimer.current !== null) {
      window.clearInterval(previewTimer.current)
      previewTimer.current = null
    }
  }
  useEffect(() => stopPreviewLoop, [])

  // Slider gesture: base song + the selection's midpoint when it started.
  const gesture = useRef<{ base: NonNullable<typeof song>; mid: number } | null>(null)

  const vels = selected.map((n) => toMidiVel(n.velocity))
  const lo = vels.length ? Math.min(...vels) : 1
  const hi = vels.length ? Math.max(...vels) : 1
  const mixed = lo !== hi
  const mid = (lo + hi) / 2

  const onSlide = (raw: number | number[]) => {
    const value = typeof raw === 'number' ? raw : raw[0]
    const st = useStore.getState()
    if (!st.song) return
    if (!gesture.current) {
      st.pushUndoSnapshot(st.song)
      gesture.current = { base: st.song, mid }
    }
    const { base, mid: mid0 } = gesture.current
    const delta = Math.round(value - mid0)
    st.setSongPreview(
      setNotesVelocity(base, st.selection, (v) => {
        const nv = Math.max(1, Math.min(127, Math.round(v * 127) + delta))
        return nv / 127
      }),
    )
    startPreviewLoop()
  }
  const onSlideEnd = () => {
    gesture.current = null
    stopPreviewLoop()
  }

  const setAll = (value: number) => {
    const st = useStore.getState()
    if (!st.song) return
    const v = Math.max(1, Math.min(127, Math.round(value)))
    const next = setNotesVelocity(st.song, st.selection, () => v / 127)
    if (next === st.song) return
    st.pushUndoSnapshot(st.song)
    st.setSongPreview(next)
    firePreview()
  }

  const applyToSelection = (edit: (song: ParsedSong, ids: Set<number>) => ParsedSong) => {
    const st = useStore.getState()
    if (!st.song || st.selection.size === 0) return
    const next = edit(st.song, st.selection)
    if (next !== st.song) st.applySongEdit(next)
  }

  const doDelete = () => {
    const st = useStore.getState()
    if (!st.song || st.selection.size === 0) return
    const next = deleteNotes(st.song, st.selection)
    if (next === st.song) return
    st.applySongEdit(next)
    st.replaceSelection([])
  }

  if (!open) return null

  const count = selected.length
  return (
    <Panel
      strong
      ref={cardRef}
      role="group"
      aria-label={t('selection.groupLabel', { count })}
      className="absolute left-0 top-0 z-50 invisible opacity-0 transition-opacity duration-150 ease-[var(--ease-out)]"
      style={{ width: CARD_W }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="flex items-baseline justify-between px-4 pb-1 pt-[14px] font-semibold">
        <span>{t('selection.notes', { count })}</span>
        {count === 1 && (
          <span className="font-normal text-ink-muted">{midiToName(selected[0].midi + transpose)}</span>
        )}
      </div>
      <div className="grid gap-[14px] px-4 pb-[14px] pt-2">
        <div className="grid gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-ink-muted">{t('selection.velocity')}</span>
            <VelocityField lo={lo} hi={hi} onCommit={setAll} />
          </div>
          <Slider
            aria-label={t(mixed ? 'selection.velocityRange' : 'selection.velocity')}
            value={mid}
            minValue={1}
            maxValue={127}
            step={1}
            onChange={onSlide}
            onChangeEnd={onSlideEnd}
          >
            <SliderTrack className="relative h-5 w-full cursor-ew-resize touch-none">
              {({ state }) => {
                const pct = (v: number) => ((v - 1) / 126) * 100
                return (
                  <>
                    <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-sm bg-fill-track" />
                    {mixed ? (
                      <div
                        className="absolute top-1/2 h-1 -translate-y-1/2 rounded-sm bg-ink-muted"
                        style={{ left: `${pct(lo)}%`, width: `${pct(hi) - pct(lo)}%` }}
                      />
                    ) : (
                      <div
                        className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-sm bg-ink"
                        style={{ width: `${state.getThumbPercent(0) * 100}%` }}
                      />
                    )}
                    <KnobThumb className={mixed ? 'opacity-0 data-[dragging]:opacity-100' : undefined} />
                  </>
                )
              }}
            </SliderTrack>
          </Slider>
        </div>
        <ChoiceRow
          label={t('selection.hand')}
          values={selected.map((n) => n.hand)}
          options={HANDS.map((h) => ({ value: h, label: t(`selection.hands.${h}`) }))}
          onChange={(h) => applyToSelection((song, ids) => setNotesHand(song, ids, h))}
          onClear={() => applyToSelection((song, ids) => setNotesHand(song, ids, undefined))}
        />
        <ChoiceRow
          label={t('selection.finger')}
          values={selected.map((n) => (n.finger === undefined ? undefined : (String(n.finger) as FingerKey)))}
          options={FINGERS.map((f) => ({ value: f, label: f }))}
          onChange={(f) => applyToSelection((song, ids) => setNotesFinger(song, ids, Number(f) as Finger))}
          onClear={() => applyToSelection((song, ids) => setNotesFinger(song, ids, undefined))}
        />
      </div>
      <div className="border-t border-glass-edge p-1.5">
        <Button
          variant="danger"
          className="w-full justify-start rounded-[10px]"
          icon={<Icon.TrashIcon />}
          hint={KEY.del}
          onPress={doDelete}
        >
          {t('selection.delete', { count })}
        </Button>
      </div>
    </Panel>
  )
}

const HANDS = ['L', 'R'] as const satisfies readonly Hand[]
type FingerKey = '1' | '2' | '3' | '4' | '5'
const FINGERS: FingerKey[] = ['1', '2', '3', '4', '5']

/**
 * Hand / finger: segments for the choices. All selected notes agree → that value is selected; they differ → nothing
 * is selected, the values in use are ringed and the row says "Mixed"; none set → nothing selected. Choosing sets all;
 * pressing the selected value again clears it from every selected note.
 */
function ChoiceRow<T extends string>({
  label,
  values,
  options,
  onChange,
  onClear,
}: {
  label: string
  values: (T | undefined)[]
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  onClear: () => void
}) {
  const { t } = useTranslation('editor')
  const present = new Set(values.filter((v): v is T => v !== undefined))
  const uniform = present.size === 1 && values.every((v) => v !== undefined)
  const mixed = present.size > 1 || (present.size === 1 && !uniform)
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-ink-muted">{label}</span>
        {mixed && <span className="text-caption text-ink-faint">{t('selection.mixed')}</span>}
      </div>
      <SegmentedControl
        aria-label={label}
        value={uniform ? [...present][0] : null}
        present={mixed ? present : undefined}
        options={options}
        onChange={onChange}
        onClear={onClear}
      />
    </div>
  )
}

/** Value field: the single value, or "64–92" when mixed; typing a number sets every selected note. */
function VelocityField({ lo, hi, onCommit }: { lo: number; hi: number; onCommit: (v: number) => void }) {
  const { t } = useTranslation('editor')
  const display = lo === hi ? String(lo) : `${lo}–${hi}`
  const [draft, setDraft] = useState<string | null>(null)
  // Esc blurs too; this keeps that blur from committing the abandoned text.
  const cancelled = useRef(false)
  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false
    } else if (draft !== null) {
      const n = Number(draft)
      if (draft.trim() !== '' && Number.isFinite(n)) onCommit(n)
    }
    setDraft(null)
  }
  return (
    <input
      aria-label={t('selection.velocity')}
      inputMode="numeric"
      value={draft ?? display}
      onFocus={(e) => {
        setDraft('')
        e.currentTarget.select()
      }}
      onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ''))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        else if (e.key === 'Escape') {
          cancelled.current = true
          setDraft(null)
          e.currentTarget.blur()
        }
        e.stopPropagation()
      }}
      placeholder={display}
      className="nf-focus h-[26px] min-w-16 max-w-20 rounded-field bg-fill-field px-2 text-right text-ink outline-none placeholder:text-ink"
    />
  )
}

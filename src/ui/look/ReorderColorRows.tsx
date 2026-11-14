import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { useStore, type Settings } from '../../store'
import { BoundColorRow, effectiveSettingOf, useRowMatchesQuery } from '../controls'
import { Icon } from '../kit'

/** pointer travel (px) before a press on a row becomes a drag */
const DRAG_PX = 4

type ColorKey = { [K in keyof Settings]: Settings[K] extends string ? K : never }[keyof Settings]

/**
 * Colour rows whose ORDER can be changed: drag a row anywhere but its buttons (the grip in the left margin shows on hover), or focus the grip and press ↑ / ↓.
 * Only the colours move between the slots (a gradient's stop positions stay where they are); the whole move is one
 * undo entry and edits what the rows show (the targeted keyframe, else the default look).
 */
export function ReorderColorRows({
  keys,
  label,
  onRemove,
}: {
  /** the colour settings of the visible rows, in order */
  keys: readonly ColorKey[]
  label: (i: number) => string
  /** a × per row (e.g. gradient stops above two) */
  onRemove?: (i: number) => void
}) {
  const { t } = useTranslation('inspector')
  const listRef = useRef<HTMLDivElement>(null)
  type Drag = { from: number; to: number; dy: number; heights: number[] }
  const [drag, setDragState] = useState<Drag | null>(null)
  const dragRef = useRef<Drag | null>(null)
  const setDrag = (d: Drag | null) => { dragRef.current = d; setDragState(d) }

  const move = (from: number, to: number) => {
    if (from === to) return
    const s = useStore.getState()
    const colors = keys.map((k) => effectiveSettingOf(s, k) as string)
    const [c] = colors.splice(from, 1)
    colors.splice(to, 0, c)
    const patch: Partial<Settings> = {}
    keys.forEach((k, i) => { (patch as Record<string, string>)[k] = colors[i] })
    s.beginSettingsEdit()
    s.updateSettings(patch)
    s.endSettingsEdit()
  }

  // (the row the dragged one's centre is over, from the rows' heights at the start of the drag)
  const targetOf = (from: number, dy: number, heights: number[]) => {
    const tops: number[] = []
    let y = 0
    for (const h of heights) { tops.push(y); y += h }
    const centre = tops[from] + heights[from] / 2 + dy
    let to = 0
    while (to + 1 < heights.length && centre > tops[to] + heights[to]) to++
    return to
  }

  // A press on the row (not on its buttons / fields) or on the grip arms a drag; it starts after DRAG_PX of movement, so a click or the label's
  // double-click (reset) still work as before.
  const onDown = (i: number) => (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    if (!target.closest('[data-grip]') && target.closest('button, input, [role="button"], [role="slider"]')) return
    const el = e.currentTarget, y0 = e.clientY, id = e.pointerId
    const onMove = (ev: globalThis.PointerEvent) => {
      const dy = ev.clientY - y0
      let d = dragRef.current
      if (!d) {
        if (Math.abs(dy) < DRAG_PX) return
        // (captured only now: capturing at the press would take the label's double-click away)
        try { el.setPointerCapture(id) } catch { /* (no active pointer: synthetic events) */ }
        const rows = Array.from(listRef.current?.children ?? []) as HTMLElement[]
        d = { from: i, to: i, dy: 0, heights: rows.map((r) => r.getBoundingClientRect().height + 12) } // + the stack's gap
      }
      ev.preventDefault()
      setDrag({ ...d, dy, to: targetOf(d.from, dy, d.heights) })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      const d = dragRef.current
      if (!d) return
      setDrag(null)
      move(d.from, d.to)
    }
    // (on the window: before the drag starts the pointer is not captured and may leave the row)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  const onKey = (i: number) => (e: KeyboardEvent<HTMLDivElement>) => {
    const to = e.key === 'ArrowUp' ? i - 1 : e.key === 'ArrowDown' ? i + 1 : -1
    if (to < 0 || to >= keys.length) return
    e.preventDefault()
    e.stopPropagation()
    move(i, to)
    // (the grip of the moved colour keeps the focus)
    requestAnimationFrame(() => (listRef.current?.children[to]?.querySelector('[data-grip]') as HTMLElement | null)?.focus())
  }

  // shift of each row while dragging: the dragged one follows the pointer, the ones it passed make room
  const shift = (i: number) => {
    if (!drag) return 0
    if (i === drag.from) return drag.dy
    const h = drag.heights[drag.from]
    if (drag.from < drag.to && i > drag.from && i <= drag.to) return -h
    if (drag.from > drag.to && i < drag.from && i >= drag.to) return h
    return 0
  }

  return (
    <div ref={listRef} className="grid gap-3">
      {keys.map((k, i) => (
        <Row
          key={k}
          label={label(i)}
          settingKey={k}
          onRemove={onRemove ? () => onRemove(i) : undefined}
          dragging={drag?.from === i}
          active={!!drag}
          shift={shift(i)}
          gripLabel={t('coloring.moveColor', { label: label(i) })}
          onGripDown={onDown(i)}
          onGripKey={onKey(i)}
        />
      ))}
    </div>
  )
}

function Row({
  label, settingKey, onRemove, dragging, active, shift, gripLabel, onGripDown, onGripKey,
}: {
  label: string
  settingKey: ColorKey
  onRemove?: () => void
  dragging: boolean
  active: boolean
  shift: number
  gripLabel: string
  onGripDown: (e: PointerEvent<HTMLDivElement>) => void
  onGripKey: (e: KeyboardEvent<HTMLDivElement>) => void
}) {
  // (while searching, a row that doesn't match is not drawn, and neither is its grip)
  if (!useRowMatchesQuery(label)) return null
  return (
    <div
      onPointerDown={onGripDown}
      className={clsx('group relative touch-none', dragging ? 'z-10 cursor-grabbing' : 'cursor-grab transition-transform duration-150 ease-[var(--ease-out)]')}
      style={{ translate: shift ? `0 ${shift}px` : undefined }}
    >
      <div
        data-grip
        role="button"
        tabIndex={0}
        aria-label={gripLabel}
        title={gripLabel}
        onKeyDown={onGripKey}
        className={clsx(
          'nf-focus absolute -left-4 top-0 grid h-[26px] w-4 place-items-center rounded-field text-ink-faint outline-none',
          dragging ? 'text-ink' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
          active && !dragging && 'opacity-0',
        )}
      >
        <Icon.GripIcon className="h-3.5 w-3.5" />
      </div>
      <BoundColorRow label={label} settingKey={settingKey} onRemove={onRemove} />
    </div>
  )
}

import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { useStore, type Settings } from '../../store'
import { BoundColorRow, effectiveSettingOf, useRowMatchesQuery } from '../controls'
import { Icon } from '../kit'

type ColorKey = { [K in keyof Settings]: Settings[K] extends string ? K : never }[keyof Settings]

/**
 * Colour rows whose ORDER can be changed: drag a row by the grip in the left margin (or focus the grip and press ↑ / ↓).
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

  const onDown = (i: number) => (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const rows = Array.from(listRef.current?.children ?? []) as HTMLElement[]
    const heights = rows.map((r) => r.getBoundingClientRect().height + 12) // + the stack's gap
    const y0 = e.clientY
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* (no active pointer: synthetic events) */ }
    setDrag({ from: i, to: i, dy: 0, heights })
    const el = e.currentTarget
    const onMove = (ev: globalThis.PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      const dy = ev.clientY - y0
      setDrag({ ...d, dy, to: targetOf(d.from, dy, d.heights) })
    }
    const onUp = () => {
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      const d = dragRef.current
      setDrag(null)
      if (d) move(d.from, d.to)
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
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
      className={clsx('group relative', dragging ? 'z-10' : 'transition-transform duration-150 ease-[var(--ease-out)]')}
      style={{ translate: shift ? `0 ${shift}px` : undefined }}
    >
      <div
        data-grip
        role="button"
        tabIndex={0}
        aria-label={gripLabel}
        title={gripLabel}
        onPointerDown={onGripDown}
        onKeyDown={onGripKey}
        className={clsx(
          'nf-focus absolute -left-4 top-0 grid h-[26px] w-4 touch-none place-items-center rounded-field text-ink-faint outline-none',
          dragging ? 'cursor-grabbing text-ink' : 'cursor-grab opacity-0 hover:text-ink-muted group-hover:opacity-100 focus-visible:opacity-100',
          active && !dragging && 'opacity-0',
        )}
      >
        <Icon.GripIcon className="h-3.5 w-3.5" />
      </div>
      <BoundColorRow label={label} settingKey={settingKey} onRemove={onRemove} />
    </div>
  )
}

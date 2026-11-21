import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import clsx from 'clsx'
import { usePresence } from './usePresence'
import { Button as AriaButton } from 'react-aria-components'

/**
 * One toast at a time, centred just above the transport pill. A new toast replaces the
 * current one. Callable from non-React code (`showToast`).
 */
export type ToastSpec = {
  message: string
  /** e.g. Undo after a delete. */
  action?: { label: string; onAction: () => void; /** Shortcut shown after the label, e.g. ⌘Z. */ hint?: string }
  durationMs?: number
}

type Live = ToastSpec & { id: number }

let current: Live | null = null
let nextId = 1
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export function showToast(spec: ToastSpec): void {
  current = { ...spec, id: nextId++ }
  emit()
}

export function dismissToast(): void {
  if (!current) return
  current = null
  emit()
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

/**
 * Mount once in the shell. `bottom` = distance from the bottom edge in px. `clearOf` = a selector for a
 * floating surface the toast must not cover (the timeline): when it is on screen the toast sits above it.
 */
export function ToastHost({ bottom, clearOf, gap = 12 }: { bottom: number; clearOf?: string; gap?: number }) {
  const toast = useSyncExternalStore(subscribe, () => current)
  const [lifted, setLifted] = useState(bottom)
  useLayoutEffect(() => {
    const el = toast && clearOf ? document.querySelector(clearOf) : null
    const top = el ? el.getBoundingClientRect().top : null
    setLifted(top === null ? bottom : Math.max(bottom, window.innerHeight - top + gap))
  }, [toast, clearOf, bottom, gap])
  // The last toast stays rendered while it fades out.
  const [shown, setShown] = useState<Live | null>(toast)
  if (toast && toast !== shown) setShown(toast)
  const { mounted, leaving } = usePresence(toast !== null)
  const [hovered, setHovered] = useState(false)
  useEffect(() => {
    // Hovering holds the toast (it is about to be clicked).
    if (!toast || hovered) return
    const t = window.setTimeout(() => {
      if (current?.id === toast.id) dismissToast()
    }, toast.durationMs ?? (toast.action ? 6000 : 3000))
    return () => clearTimeout(t)
  }, [toast, hovered])
  const live = toast ?? shown
  return (
    <div
      aria-live="polite"
      // z-45: over the islands / panels (≤ 40), under every menu, popover and dialog (≥ 50), so a toast never covers an open menu.
      className="pointer-events-none fixed inset-x-0 z-[45] flex justify-center"
      style={{ bottom: lifted }}
    >
      {mounted && live && (
        <div
          key={live.id}
          onPointerEnter={() => setHovered(true)}
          onPointerLeave={() => setHovered(false)}
          className={clsx(
            'nf-glass-strong nf-enter-up pointer-events-auto inline-flex h-11 items-center gap-2.5 rounded-round pl-4 pr-1.5 text-body text-ink',
            leaving && 'nf-leaving',
          )}
          style={!live.action ? { paddingRight: 16 } : undefined}
        >
          <span>{live.message}</span>
          {live.action && (
            <AriaButton
              onPress={() => {
                live.action!.onAction()
                dismissToast()
              }}
              className="nf-focus nf-press inline-flex h-control-sm cursor-pointer items-center gap-1.5 rounded-round bg-fill-selected px-2.5 font-medium text-ink outline-none data-[hovered]:brightness-125"
            >
              {live.action.label}
              {live.action.hint && <span className="font-normal text-ink-faint">{live.action.hint}</span>}
            </AriaButton>
          )}
        </div>
      )}
    </div>
  )
}

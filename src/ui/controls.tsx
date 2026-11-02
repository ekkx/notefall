import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react'
import {
  Button,
  ColorArea,
  ColorField,
  ColorPicker,
  ColorSlider,
  ColorSwatch,
  ColorThumb,
  Dialog,
  DialogTrigger,
  Input,
  Label,
  Slider,
  SliderTrack,
} from 'react-aria-components'
import clsx from 'clsx'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { defaultSettings, useStore, type Settings } from '../store'
import { isAnimatableKey, resolveSettingsAt } from '../midi/settingsKeyframes'
import { collectSongColors } from './look/songColors'
import { shortcutLabel } from './shell/platform'
import { Disclosure, GEOMETRY, Icon, KnobThumb, Menu, MenuItem, MenuSeparator, Popover, SegmentedControl, Select, Switch } from './kit'

/**
 * Value an Inspector control should DISPLAY: the SELECTED pin's
 * snapshot value when a pin is selected and the key is animatable,
 * otherwise the base default. Mirrors `updateSettings`' write routing
 * so a control always shows exactly what it edits (selecting a pin
 * shows that pin; with none selected it shows the base default —
 * never silently the wrong one).
 */
export function useEffectiveSetting<K extends keyof Settings>(
  key: K,
): Settings[K] {
  return useStore((s) => {
    const t = s.editingKeyframeTime
    if (t !== null && isAnimatableKey(key)) {
      const kf = s.settings.settingsKeyframes.find(
        (p) => Math.abs(p.time - t) < 1e-6,
      )
      if (kf && key in kf.settings) return kf.settings[key] as Settings[K]
    }
    return s.settings[key]
  })
}

/**
 * Wrap an atomic settings mutation in a begin/end pair so it produces
 * exactly one undo entry. Use for switches, selects, single-shot button
 * presses; for continuous gestures (slider drag, color popover session)
 * call begin/end directly around the gesture span instead.
 */
const commitAtomic = (apply: () => void): void => {
  const s = useStore.getState()
  s.beginSettingsEdit()
  apply()
  s.endSettingsEdit()
}

// ── Search / collapse infrastructure ──────────────────────────────────
//
// Inspector wraps its content in a `SearchProvider`; nested sections and
// rows read the current query from context. Rows whose label doesn't
// fuzzy-match return null; sections detect they've gone empty by
// counting `[data-search-label]` descendants after layout. When a
// section's TITLE matches, it relays an empty query to its children so
// every row inside stays visible (intuitive: matching "Audio" shows the
// whole Audio section, not just rows whose label happens to contain
// "audio").
const SearchContext = createContext<string>('')

export function SearchProvider({
  query,
  children,
}: {
  query: string
  children: ReactNode
}) {
  return (
    <SearchContext.Provider value={query.trim().toLowerCase()}>
      {children}
    </SearchContext.Provider>
  )
}

export function useSearchQuery(): string {
  return useContext(SearchContext)
}

// Name of the control a `SearchGroup`'s rows hang off. Rows inside a
// group drop the redundant prefix from what they DISPLAY — "Intensity"
// under a Glow toggle, not "Glow Intensity" — so the group name is kept
// here and folded back in for MATCHING. Searching "glow" still finds
// every row under it.
const SearchGroupContext = createContext<string>('')

export function SearchGroup({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <SearchGroupContext.Provider value={label}>
      {children}
    </SearchGroupContext.Provider>
  )
}

export function rowMatchesQuery(label: string, query: string): boolean {
  if (!query) return true
  return label.toLowerCase().includes(query)
}

/** `rowMatchesQuery` widened by the enclosing `SearchGroup`'s name. */
export function useRowMatchesQuery(label: string): boolean {
  const query = useSearchQuery()
  const group = useContext(SearchGroupContext)
  if (!query) return true
  const haystack = group ? `${group} ${label}` : label
  return haystack.toLowerCase().includes(query)
}

/**
 * Wrap a non-standard control (EQ bands, custom-image picker, etc.) so it
 * participates in the search filter. The wrapped block carries a virtual
 * `label` for matching and emits `data-search-label` so the surrounding
 * Section's "any visible row?" check sees it. Returns null when the query
 * is non-empty and doesn't match — mirroring the *Row components.
 */
export function SearchableBlock({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  if (!useRowMatchesQuery(label)) return null
  return <div data-search-label={label}>{children}</div>
}

/**
 * The Look panel's element: colour pickers open beside it (outside the panel, so
 * glass never sits on glass) instead of beside their own row.
 */
export const LookAnchorContext = createContext<RefObject<HTMLElement | null> | null>(null)

// ── Keyframe state of a row ───────────────────────────────────────────

type KfState = 'set' | 'carried' | 'whole' | null

/**
 * While a keyframe is targeted: 'set' = the key is in its snapshot, 'carried' = interpolated from the keyframes
 * around it, 'whole' = a key a keyframe can't hold. `null` without a keyframe target (or a row with no key).
 */
function useKfState(key?: keyof Settings): KfState {
  return useStore((st): KfState => {
    const t = st.editingKeyframeTime
    if (t === null || !key) return null
    if (!isAnimatableKey(key)) return 'whole'
    const kf = st.settings.settingsKeyframes.find((p) => Math.abs(p.time - t) < 1e-6)
    return kf && key in kf.settings ? 'set' : 'carried'
  })
}

/** Store the value this key has at the targeted keyframe's time into that keyframe. */
function setAtKeyframe(key: keyof Settings): void {
  const st = useStore.getState()
  const t = st.editingKeyframeTime
  if (t === null) return
  const value = resolveSettingsAt(st.settings, st.settings.settingsKeyframes, t)[key]
  commitAtomic(() => writeSetting(key, value as Settings[typeof key]))
}

/** The ◆ before a row's label: filled = set at this keyframe, hollow = carried in (press to set it here). */
export function KfMark({ settingKey }: { settingKey?: keyof Settings }) {
  const { t } = useTranslation('inspector')
  const state = useKfState(settingKey)
  if (state !== 'set' && state !== 'carried') return null
  const diamond = (filled: boolean) => (
    <span
      className={clsx(
        'h-2 w-2 rotate-45 rounded-[1.5px] border-[1.5px]',
        filled ? 'border-ink bg-ink' : 'border-ink-muted',
      )}
    />
  )
  if (state === 'set') {
    return (
      <span title={t('keyframes.own')} className="grid h-4 w-3 flex-none place-items-center">
        {diamond(true)}
      </span>
    )
  }
  return (
    <Button
      aria-label={t('keyframes.set')}
      onPress={() => settingKey && setAtKeyframe(settingKey)}
      className="nf-focus -my-1 grid h-5 w-3 flex-none cursor-pointer place-items-center rounded-field p-0 outline-none"
    >
      <span title={t('keyframes.carried')} className="grid place-items-center">
        {diamond(false)}
      </span>
    </Button>
  )
}

/** "Can't change over time" line under a field whose key a keyframe can't hold (only while one is targeted). */
export function ScopeNote({ settingKey }: { settingKey?: keyof Settings }) {
  const { t } = useTranslation('inspector')
  if (useKfState(settingKey) !== 'whole') return null
  return <p className="text-caption text-ink-faint">{t('scope.note')}</p>
}

// ── Slider ────────────────────────────────────────────────────────────

/**
 * Menu at the cursor for a slider: enter a value, copy / paste, reset. Built on the kit Menu, anchored to a
 * zero-size element at the click point.
 */
function SliderContextMenu({
  x,
  y,
  value,
  min,
  max,
  step,
  defaultValue,
  defaultLabel,
  onChange,
  onClose,
}: {
  x: number
  y: number
  value: number
  min: number
  max: number
  step: number
  defaultValue: number | undefined
  defaultLabel: string | undefined
  onChange: (v: number) => void
  onClose: () => void
}) {
  const { t } = useTranslation('inspector')
  const anchorRef = useRef<HTMLSpanElement>(null)
  // Two-step UX: the menu first shows action items; "Enter value…" swaps the body for the numeric input.
  const [mode, setMode] = useState<'menu' | 'input'>('menu')
  // Initial value uses a precision that matches the slider's step.
  const decimals = step >= 1 ? 0 : step >= 0.01 ? 2 : step >= 0.001 ? 3 : 4
  const [text, setText] = useState(() => (Number.isFinite(value) ? value.toFixed(decimals) : ''))
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (mode === 'input') {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [mode])

  // While this menu is open the page below the popover takes no pointer events, so a right-click on another bar would
  // get the browser's menu. Hand it to the bar under the cursor instead: close this menu and replay the right-click there.
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      if (e.target instanceof Element && e.target.closest('[data-value-menu-popover]')) {
        e.preventDefault()
        return
      }
      // by geometry: while the popover is open the page below it doesn't take pointer events (elementsFromPoint misses it)
      const host = [...document.querySelectorAll<HTMLElement>('[data-value-menu]')].find((el) => {
        const r = el.getBoundingClientRect()
        return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
      })
      if (!host) return
      e.preventDefault()
      e.stopPropagation()
      onClose()
      const { clientX, clientY } = e
      requestAnimationFrame(() =>
        host.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX, clientY })),
      )
    }
    window.addEventListener('contextmenu', onContextMenu, true)
    return () => window.removeEventListener('contextmenu', onContextMenu, true)
  }, [onClose])

  const clamp = (v: number) => Math.max(min, Math.min(max, v))
  const commit = () => {
    const parsed = parseFloat(text)
    if (Number.isFinite(parsed)) onChange(clamp(parsed))
    onClose()
  }

  const valueText = Number.isFinite(value) ? value.toFixed(decimals) : ''
  const handlePaste = async () => {
    try {
      const clip = await navigator.clipboard?.readText()
      const parsed = parseFloat(clip ?? '')
      if (Number.isFinite(parsed)) onChange(clamp(parsed))
    } catch {
      // Permission denied / unsupported: the menu closes and the value stays.
    }
    onClose()
  }

  const onAction = (key: React.Key) => {
    if (key === 'enter') {
      setMode('input')
      return
    }
    if (key === 'copy') {
      void navigator.clipboard?.writeText(valueText)
      onClose()
    } else if (key === 'paste') {
      void handlePaste()
    } else if (key === 'reset' && defaultValue !== undefined) {
      onChange(defaultValue)
      onClose()
    }
  }

  return (
    <>
      {/* Portalled out of the panel: its backdrop-filter makes it the containing block of `position: fixed`
          children, which put the menu a panel-offset away from the cursor. */}
      {createPortal(
        <span
          ref={anchorRef}
          aria-hidden
          style={{ position: 'fixed', left: x, top: y, width: 0, height: 0, pointerEvents: 'none' }}
        />,
        document.fullscreenElement ?? document.body,
      )}
      <Popover
        triggerRef={anchorRef}
        isOpen
        onOpenChange={(open) => {
          if (!open) onClose()
        }}
        placement="bottom start"
        offset={2}
        className="rounded-[14px]"
        data-value-menu-popover
      >
        {mode === 'menu' ? (
          <Menu aria-label={t('slider.value')} autoFocus="first" onAction={onAction}>
            <MenuItem id="enter" hint={valueText}>
              {t('slider.enterValue')}
            </MenuItem>
            <MenuSeparator />
            <MenuItem id="copy" hint={valueText}>
              {t('slider.copy')}
            </MenuItem>
            <MenuItem id="paste">{t('slider.paste')}</MenuItem>
            {defaultValue !== undefined && (
              <>
                <MenuSeparator />
                <MenuItem id="reset" hint={shortcutLabel(t('slider.click'), { mod: true })}>
                  {t('reset.resetToDefault')}
                  {defaultLabel !== undefined && ` (${defaultLabel})`}
                </MenuItem>
              </>
            )}
          </Menu>
        ) : (
          <div className="grid w-[240px] gap-2 p-3">
            <div className="flex items-center justify-between text-caption text-ink-faint">
              <span>{t('slider.value')}</span>
              <span>
                {min}…{max}
              </span>
            </div>
            <input
              ref={inputRef}
              type="text"
              inputMode="decimal"
              aria-label={t('slider.value')}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commit()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  e.stopPropagation()
                  setMode('menu')
                }
              }}
              className="nf-focus h-8 w-full rounded-field bg-fill-field px-2.5 text-body tabular-nums text-ink outline-none"
            />
            <div className="flex items-center justify-between text-caption text-ink-faint">
              <span>{t('slider.apply')}</span>
              <button
                type="button"
                onClick={() => setMode('menu')}
                className="nf-focus rounded-field px-1.5 py-0.5 text-ink-muted outline-none hover:bg-fill-hover hover:text-ink"
              >
                {t('slider.back')}
              </button>
            </div>
          </div>
        )}
      </Popover>
    </>
  )
}

/**
 * Returns a ref to attach to a SliderTrack — when the user Cmd/Ctrl+clicks
 * inside it, the slider snaps to `defaultValue` instead of jumping to the
 * click position. Right-clicks open a small context menu offering the same
 * reset, with the keyboard shortcut shown.
 *
 * Implementation: registers a NATIVE pointerdown listener in the capture
 * phase + stopImmediatePropagation, so react-aria's own pointerdown
 * (which would jump-to-click) never sees the event. React's synthetic
 * onPointerDownCapture isn't strong enough here — react-aria attaches its
 * handlers via direct DOM listeners that React can't pre-empt.
 */
function useSliderTrackGestures({
  value,
  min,
  max,
  step,
  defaultValue,
  onChange,
  format,
}: {
  value: number
  min: number
  max: number
  step: number
  defaultValue: number | undefined
  onChange: (v: number) => void
  format?: (v: number) => string
}): { ref: React.RefObject<HTMLDivElement>; menuNode: ReactNode } {
  const ref = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  // Keep latest values in a ref so the listener (registered once) sees fresh
  // closures without re-attaching on every render.
  const latest = useRef({ defaultValue, onChange })
  latest.current = { defaultValue, onChange }
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const downHandler = (e: PointerEvent) => {
      // Right-click: swallow the pointerdown so react-aria's slider doesn't
      // jump to the click position — the contextmenu handler below will
      // open our menu instead.
      if (e.button === 2) {
        e.preventDefault()
        e.stopImmediatePropagation()
        return
      }
      if (e.button !== 0) return
      const { defaultValue, onChange } = latest.current
      if (defaultValue === undefined) return
      if (!(e.metaKey || e.ctrlKey)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      commitAtomic(() => onChange(defaultValue))
    }
    const ctxHandler = (e: MouseEvent) => {
      e.preventDefault()
      // On macOS, Ctrl+click fires contextmenu but is already handled as
      // the reset gesture via pointerdown when a default exists. Don't
      // open the menu in that case.
      if (e.ctrlKey && latest.current.defaultValue !== undefined) return
      setMenu({ x: e.clientX, y: e.clientY })
    }
    el.dataset.valueMenu = ''
    el.addEventListener('pointerdown', downHandler, true)
    el.addEventListener('contextmenu', ctxHandler)
    return () => {
      el.removeEventListener('pointerdown', downHandler, true)
      el.removeEventListener('contextmenu', ctxHandler)
    }
  }, [])

  const menuNode = menu ? (
    <SliderContextMenu
      x={menu.x}
      y={menu.y}
      value={value}
      min={min}
      max={max}
      step={step}
      defaultValue={defaultValue}
      defaultLabel={
        defaultValue !== undefined
          ? format
            ? format(defaultValue)
            : defaultValue.toFixed(step < 1 ? 2 : 0)
          : undefined
      }
      onChange={(v) => commitAtomic(() => latest.current.onChange(v))}
      onClose={() => setMenu(null)}
    />
  ) : null

  return { ref, menuNode }
}

/** Typed-value field of a slider row: commits on Enter / blur, Esc reverts, ↑ / ↓ nudge by one step. */
function ValueField({
  label,
  shown,
  value,
  min,
  max,
  step,
  onCommit,
}: {
  label: string
  shown: string
  value: number
  min: number
  max: number
  step: number
  onCommit: (v: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const clamp = (v: number) => Math.max(min, Math.min(max, v))
  const decimals = step >= 1 ? 0 : step >= 0.01 ? 2 : step >= 0.001 ? 3 : 4
  const commit = () => {
    if (draft === null) return
    const parsed = parseFloat(draft.replace(/[^\d.+\-eE]/g, ''))
    setDraft(null)
    if (Number.isFinite(parsed) && parsed !== value) onCommit(clamp(parsed))
  }
  return (
    <input
      type="text"
      inputMode="decimal"
      aria-label={label}
      value={draft ?? shown}
      onFocus={(e) => {
        setDraft(shown)
        e.currentTarget.select()
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          e.currentTarget.blur()
        } else if (e.key === 'Escape') {
          setDraft(null)
          e.currentTarget.blur()
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault()
          const base = draft !== null && Number.isFinite(parseFloat(draft)) ? parseFloat(draft) : value
          const next = clamp(base + (e.key === 'ArrowUp' ? step : -step))
          setDraft(next.toFixed(decimals))
          onCommit(next)
        }
      }}
      className="nf-focus h-[26px] w-[76px] flex-none rounded-field border-0 bg-fill-field px-2 text-right text-body tabular-nums text-ink outline-none"
    />
  )
}

type SliderRowProps = {
  label: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  format?: (v: number) => string
  /** Double-clicking the label resets to this. */
  defaultValue?: number
  /** The setting this row edits: drives the ◆ mark and the "can't change over time" line while a keyframe is targeted. */
  scopeKey?: keyof Settings
}

export function SliderRow({ label, value, min, max, step = 0.01, onChange, format, defaultValue, scopeKey }: SliderRowProps) {
  const { t } = useTranslation('inspector')
  const visible = useRowMatchesQuery(label)
  const { ref: trackRef, menuNode } = useSliderTrackGestures({
    value,
    min,
    max,
    step,
    defaultValue,
    onChange,
    format,
  })
  // Bracket the gesture (drag OR keyboard nudge) so the whole interaction
  // produces one undo entry. begin is idempotent — first onChange opens
  // the gesture; onChangeEnd closes it. react-aria fires onChangeEnd for
  // both pointer release AND keyboard arrows, so each press of an arrow
  // key also commits as its own entry.
  const gestureOpen = useRef(false)
  if (!visible) return null
  const shown = format ? format(value) : value.toFixed(step < 1 ? 2 : 0)
  return (
    <Slider
      data-search-label={label}
      value={value}
      minValue={min}
      maxValue={max}
      step={step}
      onChange={(v) => {
        if (!gestureOpen.current) {
          gestureOpen.current = true
          useStore.getState().beginSettingsEdit()
        }
        onChange(typeof v === 'number' ? v : v[0])
      }}
      onChangeEnd={() => {
        if (gestureOpen.current) {
          gestureOpen.current = false
          useStore.getState().endSettingsEdit()
        }
      }}
      className="grid gap-1.5"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <KfMark settingKey={scopeKey} />
          <Label
            className="select-none truncate text-ink-muted"
            onDoubleClick={defaultValue !== undefined ? () => commitAtomic(() => onChange(defaultValue)) : undefined}
            title={defaultValue !== undefined ? t('reset.doubleClickReset') : undefined}
          >
            {label}
          </Label>
        </span>
        <ValueField
          label={label}
          shown={shown}
          value={value}
          min={min}
          max={max}
          step={step}
          onCommit={(v) => commitAtomic(() => onChange(v))}
        />
      </div>
      <SliderTrack ref={trackRef} className="relative h-5 w-full cursor-pointer">
        {({ state }) => (
          <>
            <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-[2px] bg-fill-track" />
            <div
              className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-[2px] bg-ink"
              style={{ width: `${state.getThumbPercent(0) * 100}%` }}
            />
            <KnobThumb />
          </>
        )}
      </SliderTrack>
      <ScopeNote settingKey={scopeKey} />
      {menuNode}
    </Slider>
  )
}

// ── Switch / Select / Color rows ──────────────────────────────────────

type SwitchRowProps = {
  label: string
  value: boolean
  onChange: (v: boolean) => void
  /** Double-clicking the label resets to this. */
  defaultValue?: boolean
  scopeKey?: keyof Settings
}

export function SwitchRow({ label, value, onChange, defaultValue, scopeKey }: SwitchRowProps) {
  const { t } = useTranslation('inspector')
  if (!useRowMatchesQuery(label)) return null
  return (
    <div data-search-label={label} className="grid gap-1.5">
      <div className="flex items-center gap-1.5">
        <KfMark settingKey={scopeKey} />
        <Switch
          isSelected={value}
          onChange={(v) => commitAtomic(() => onChange(v))}
          className="min-w-0 flex-1"
        >
          <span
            className="select-none truncate text-ink-muted"
            // Stop the propagating click so the toggle doesn't flip on the
            // double-click; then apply the default.
            onDoubleClick={
              defaultValue !== undefined
                ? (e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    commitAtomic(() => onChange(defaultValue))
                  }
                : undefined
            }
            title={defaultValue !== undefined ? t('reset.doubleClickReset') : undefined}
          >
            {label}
          </span>
        </Switch>
      </div>
      <ScopeNote settingKey={scopeKey} />
    </div>
  )
}

/** Where a colour picker opens: its own row, or beside the Look panel when the panel provides an anchor. */
function usePickerPlacement(triggerRef: RefObject<HTMLElement | null>) {
  const anchor = useContext(LookAnchorContext)
  const [crossOffset, setCrossOffset] = useState(0)
  const measure = () => {
    const a = anchor?.current
    const r = triggerRef.current
    if (a && r) setCrossOffset(Math.max(0, r.getBoundingClientRect().top - a.getBoundingClientRect().top - 8))
  }
  return anchor
    ? {
        measure,
        props: {
          triggerRef: anchor as RefObject<HTMLElement>,
          placement: 'left top' as const,
          offset: 12,
          crossOffset,
          // Keep the picker above the transport pill (never glass on glass).
          containerPadding: GEOMETRY.PILL_BOTTOM + GEOMETRY.PILL + GEOMETRY.GAP,
        },
      }
    : { measure, props: { placement: 'bottom end' as const, offset: 8, crossOffset: 0 } }
}

function PickerBody({ label, value, onPick }: { label: string; value: string; onPick: (hex: string) => void }) {
  const { t } = useTranslation('inspector')
  const songColors = useMemo(() => collectSongColors(value), [value])
  const thumb =
    'nf-focus h-[18px] w-[18px] rounded-full border-2 border-ink shadow-knob outline-none box-border'
  return (
    <Dialog aria-label={label} className="grid w-[280px] gap-3 p-3.5 outline-none">
      <ColorArea
        colorSpace="hsb"
        xChannel="saturation"
        yChannel="brightness"
        className="relative h-[180px] w-full rounded-[10px]"
      >
        <ColorThumb className={thumb} />
      </ColorArea>
      <ColorSlider colorSpace="hsb" channel="hue">
        <SliderTrack className="relative h-3.5 w-full rounded-[7px]">
          <ColorThumb className={clsx(thumb, 'top-1/2')} />
        </SliderTrack>
      </ColorSlider>
      <div className="flex items-center gap-2">
        <ColorField aria-label={t('color.hex')} className="flex-1">
          <Input className="nf-focus h-8 w-full rounded-field bg-fill-field px-2.5 text-body uppercase tabular-nums text-ink outline-none" />
        </ColorField>
        <ColorSwatch className="h-8 w-8 flex-none rounded-field" />
      </div>
      {songColors.length > 0 && (
        <div className="grid gap-1.5">
          <span className="text-caption text-ink-faint">{t('color.inSong')}</span>
          <div className="flex flex-wrap gap-1.5">
            {songColors.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={c}
                title={c}
                onClick={() => onPick(c)}
                className="nf-focus h-7 w-7 cursor-pointer rounded-field border-0 p-0 outline-none"
                style={{ background: c }}
              />
            ))}
          </div>
        </div>
      )}
    </Dialog>
  )
}

/**
 * The colour picker as a controlled popover anchored to any element (a gradient stop handle, say). The whole open
 * session is one undo entry, like ColorRow's.
 */
export function ColorPickerPopover({
  triggerRef,
  isOpen,
  onOpenChange,
  label,
  value,
  onChange,
}: {
  triggerRef: RefObject<HTMLElement | null>
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  label: string
  value: string
  onChange: (v: string) => void
}) {
  const placement = usePickerPlacement(triggerRef)
  const session = useRef(false)
  useEffect(() => {
    const s = useStore.getState()
    if (isOpen && !session.current) {
      session.current = true
      placement.measure()
      s.beginSettingsEdit()
    } else if (!isOpen && session.current) {
      session.current = false
      s.endSettingsEdit()
    }
  })
  useEffect(
    () => () => {
      if (session.current) useStore.getState().endSettingsEdit()
    },
    [],
  )
  return (
    <ColorPicker value={value} onChange={(color) => onChange(color.toString('hex'))}>
      <Popover
        triggerRef={triggerRef as RefObject<HTMLElement>}
        {...placement.props}
        isOpen={isOpen}
        onOpenChange={onOpenChange}
        className="rounded-panel"
      >
        <PickerBody label={label} value={value} onPick={onChange} />
      </Popover>
    </ColorPicker>
  )
}

type ColorRowProps = {
  label: string
  value: string
  onChange: (v: string) => void
  /** Double-clicking the label resets to this. */
  defaultValue?: string
  /**
   * Overrides the reset action. When provided, the label / reset
   * button invokes this instead of `onChange(defaultValue)`. Useful
   * for callers that want reset semantics richer than "just write
   * the default value" — e.g. per-track colour rows that need to
   * REMOVE their entry from the overrides map so subsequent theme
   * changes propagate, not freeze a snapshot of the current default.
   */
  onReset?: () => void
  /**
   * Explicit modified-state override. Defaults to a hex-equality
   * comparison against `defaultValue`. Callers that store state
   * out-of-band (e.g. presence of a key in an overrides map) can
   * pass this to drive the reset-chip visibility correctly even
   * when `value` happens to equal `defaultValue`.
   */
  isModified?: boolean
  scopeKey?: keyof Settings
  /** Shows a remove button after the swatch (a gradient stop, a palette colour). */
  onRemove?: () => void
}

export function ColorRow({
  label,
  value,
  onChange,
  defaultValue,
  onReset,
  isModified: isModifiedOverride,
  scopeKey,
  onRemove,
}: ColorRowProps) {
  const { t } = useTranslation('inspector')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const placement = usePickerPlacement(triggerRef)
  const reset =
    onReset !== undefined
      ? () => commitAtomic(onReset)
      : defaultValue !== undefined
        ? () => commitAtomic(() => onChange(defaultValue))
        : undefined
  // A "reset to default" button is rendered inline next to the swatch
  // only when the value is considered modified — same affordance the
  // SliderRow's context menu offers, but visible without right-click.
  // Default detection is hex-equality against `defaultValue` (case-
  // insensitive — ColorPicker may emit either case); callers with
  // out-of-band override storage can pass `isModified` explicitly.
  const isModified =
    isModifiedOverride !== undefined
      ? isModifiedOverride
      : defaultValue !== undefined &&
        value.toLowerCase() !== defaultValue.toLowerCase()
  if (!useRowMatchesQuery(label)) return null
  return (
    <div data-search-label={label} className="grid gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <KfMark settingKey={scopeKey} />
          <span
            className={clsx('select-none truncate text-ink-muted', reset && 'cursor-pointer')}
            onDoubleClick={reset}
            title={reset ? t('reset.doubleClickReset') : undefined}
          >
            {label}
          </span>
        </span>
        <div className="flex flex-none items-center gap-1">
          {reset && isModified && (
            <Button
              onPress={reset}
              aria-label={t('reset.resetRowToDefault', { label })}
              className="nf-focus grid h-6 w-6 cursor-pointer place-items-center rounded-field text-ink-muted outline-none data-[hovered]:bg-fill-hover data-[hovered]:text-ink"
            >
              <Icon.ResetIcon className="h-4 w-4" />
            </Button>
          )}
          <ColorPicker value={value} onChange={(color) => onChange(color.toString('hex'))}>
            <DialogTrigger
              onOpenChange={(open) => {
                // A whole color-picker session (popover open → close) is one
                // undo entry, regardless of how many drags / hex-field edits
                // happened inside. Drags inside the popover fire onChange
                // ~60×/s, so per-change history would saturate the stack.
                const s = useStore.getState()
                if (open) {
                  placement.measure()
                  s.beginSettingsEdit()
                } else s.endSettingsEdit()
              }}
            >
              <Button
                ref={triggerRef}
                aria-label={t('color.editAria', { label })}
                className="nf-focus flex h-[26px] cursor-pointer items-center gap-2 rounded-field bg-fill-field pl-2 pr-[3px] text-body uppercase tabular-nums text-ink outline-none data-[hovered]:bg-fill-selected"
              >
                {value}
                <ColorSwatch className="h-5 w-5 rounded-[6px]" />
              </Button>
              <Popover {...placement.props} className="rounded-panel">
                <PickerBody label={label} value={value} onPick={onChange} />
              </Popover>
            </DialogTrigger>
          </ColorPicker>
          {onRemove && (
            <Button
              onPress={onRemove}
              aria-label={t('color.remove', { label })}
              className="nf-focus grid h-6 w-6 cursor-pointer place-items-center rounded-field text-ink-muted outline-none data-[hovered]:bg-fill-hover data-[hovered]:text-ink"
            >
              <Icon.CloseIcon className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
      <ScopeNote settingKey={scopeKey} />
    </div>
  )
}

type SelectRowProps<T extends string> = {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  /** Double-clicking the label resets to this. */
  defaultValue?: T
  scopeKey?: keyof Settings
}

// Rough text width in "em": CJK counts double.
const textUnits = (s: string) => [...s].reduce((n, c) => n + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0)

/** 2–3 short options read side by side; anything longer is a dropdown. */
const fitsSegmented = (options: { label: string }[]) =>
  options.length >= 2 &&
  // Up to three words, or up to five very short ones (counts like 2 3 4 5).
  options.length <= (options.every((o) => textUnits(o.label) <= 2) ? 5 : 3) &&
  options.every((o) => textUnits(o.label) <= 12) &&
  options.reduce((n, o) => n + textUnits(o.label), 0) <= 28

export function SelectRow<T extends string>({ label, value, options, onChange, defaultValue, scopeKey }: SelectRowProps<T>) {
  const { t } = useTranslation('inspector')
  const reset =
    defaultValue !== undefined
      ? () => commitAtomic(() => onChange(defaultValue))
      : undefined
  if (!useRowMatchesQuery(label)) return null
  const apply = (v: T) => commitAtomic(() => onChange(v))
  return (
    <div data-search-label={label} className="grid gap-1.5">
      <span className="flex min-w-0 items-center gap-1.5">
        <KfMark settingKey={scopeKey} />
        <span
          className={clsx('select-none truncate text-ink-muted', reset && 'cursor-pointer')}
          onDoubleClick={reset}
          title={reset ? t('reset.doubleClickReset') : undefined}
        >
          {label}
        </span>
      </span>
      {fitsSegmented(options) ? (
        <SegmentedControl value={value} onChange={apply} options={options} aria-label={label} />
      ) : (
        <Select value={value} onChange={apply} options={options} aria-label={label} />
      )}
      <ScopeNote settingKey={scopeKey} />
    </div>
  )
}

function useStoredBool(
  key: string,
  defaultValue: boolean,
): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    if (typeof window === 'undefined') return defaultValue
    try {
      const stored = window.localStorage.getItem(key)
      if (stored === null) return defaultValue
      return stored === '1'
    } catch {
      return defaultValue
    }
  })
  const set = (v: boolean) => {
    setValue(v)
    try {
      window.localStorage.setItem(key, v ? '1' : '0')
    } catch {
      /* storage unavailable (private mode, ITP) — collapse state is
         ephemeral. Not worth surfacing. */
    }
  }
  return [value, set]
}

/**
 * Titled group of settings: heading (13/600) with the feature's on/off switch, a `glass-edge` rule between
 * neighbours. Title click folds the body, persisted to localStorage under `inspector.section.<title>`.
 * `enabledKey` puts the feature's switch in the heading: while it is off the body stays closed and the title dims.
 * Plays into the Inspector's search bar: when a query is active, the group force-expands; if no descendant row
 * carries `data-search-label` matching the query AND the title itself doesn't match, the whole group is hidden.
 * When the title matches, every row inside renders regardless of label match (a relayed empty query via
 * SearchContext.Provider).
 */
export function Section({
  title,
  action,
  enabledKey,
  defaultOpen = true,
  children,
}: {
  title: string
  action?: ReactNode
  enabledKey?: BooleanKeys
  defaultOpen?: boolean
  children: ReactNode
}) {
  const { t } = useTranslation('inspector')
  const q = useSearchQuery()
  const titleMatches = !q || title.toLowerCase().includes(q)
  const [storedOpen, setStoredOpen] = useStoredBool(
    `inspector.section.${title}`,
    defaultOpen,
  )
  const enabled = useEffectiveSetting(enabledKey ?? 'notesEnabled') as boolean
  const isOn = !enabledKey || enabled
  const open = q ? true : storedOpen && isOn
  const contentRef = useRef<HTMLDivElement>(null)
  const [hasRow, setHasRow] = useState(true)
  useLayoutEffect(() => {
    if (!q) {
      setHasRow(true)
      return
    }
    const c = contentRef.current
    setHasRow(!!c && c.querySelector('[data-search-label]') !== null)
    // Dep on `q` only — without this the effect runs on every render, so a
    // single slider drag (which re-renders Inspector at 60fps) would do
    // ~13 `querySelector` calls per frame for no reason.
  }, [q])
  const visible = !q || titleMatches || hasRow
  if (!visible) return null
  // When the title itself matches, relay an empty query so every child
  // row renders (no per-row filter applied inside this section).
  const childQuery = titleMatches && q ? '' : q
  return (
    <section data-search-label={title} className="group/section border-b border-glass-edge px-4 py-3 last:border-b-0">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setStoredOpen(!storedOpen)}
          disabled={!!q || !isOn}
          aria-expanded={open}
          className={clsx(
            'nf-focus -ml-1 flex min-w-0 items-center gap-0.5 rounded-field pl-1 pr-1.5 text-heading outline-none disabled:cursor-default',
            isOn ? 'text-ink' : 'text-ink-muted',
          )}
        >
          <span className="truncate">{title}</span>
          {/* The fold chevron shows only when it says something: on hover, or while folded. */}
          <Icon.ChevronRightIcon
            className={clsx(
              'h-4 w-4 flex-none text-ink-faint transition-[transform,opacity] duration-150 motion-reduce:transition-none',
              open ? 'rotate-90 opacity-0 group-hover/section:opacity-100' : 'opacity-100',
              (q || !isOn) && '!opacity-0',
            )}
          />
        </button>
        <div className="flex flex-none items-center gap-2">
          {action}
          {enabledKey && (
            <Switch
              aria-label={`${title}: ${t('row.enabled')}`}
              isSelected={enabled}
              onChange={(v) => {
                commitAtomic(() => writeSetting(enabledKey, v as Settings[BooleanKeys]))
                if (v) setStoredOpen(true)
              }}
            />
          )}
        </div>
      </div>
      {/* Folds by animating the row track (0fr ↔ 1fr), so the content keeps its natural height. */}
      <div
        className={clsx(
          'grid transition-[grid-template-rows,opacity] duration-200 ease-[var(--ease-out)] motion-reduce:transition-none',
          open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
        )}
        {...((!open ? { inert: '' } : {}) as Record<string, string>)}
      >
        {/* Clip box widened to the section's padding so knobs and focus rings at the edges aren't cut. */}
        <div className="-mx-4 min-h-0 overflow-hidden px-4 pb-1">
          <div ref={contentRef} className="grid grid-cols-[minmax(0,1fr)] gap-3 pt-3">
            <SearchContext.Provider value={childQuery}>
              {children}
            </SearchContext.Provider>
          </div>
        </div>
      </div>
    </section>
  )
}

/**
 * "More" disclosure inside a section: the section shows its everyday rows, the rest waits behind this toggle (open
 * state persisted per `id`; always open while searching so matches inside are visible).
 */
export function Detail({ id, label, children }: { id: string; label?: string; children: ReactNode }) {
  const { t } = useTranslation('inspector')
  const q = useSearchQuery()
  const [storedOpen, setStoredOpen] = useStoredBool(`inspector.detail.${id}`, false)
  if (q) return <div className="grid gap-3">{children}</div>
  return (
    <Disclosure
      label={label ?? (storedOpen ? t('detail.hide') : t('detail.show'))}
      isExpanded={storedOpen}
      onExpandedChange={setStoredOpen}
    >
      {children}
    </Disclosure>
  )
}

type VerticalSliderBandsProps = {
  values: number[]
  labels: string[]
  min: number
  max: number
  step?: number
  onChange: (index: number, value: number) => void
  /** Pixel height of the slider track. */
  trackHeight?: number
  /** Per-band default — double-clicking the band's readout resets it. */
  defaultValues?: number[]
}

/**
 * Graphic-EQ-style row of vertical sliders. Each slider shows a value
 * readout above and a frequency / category label below. The fill grows
 * from a center line at value=0 in either direction so the user can see
 * cuts and boosts symmetrically (mixer convention).
 *
 * Range is symmetric around 0 (e.g. min=-12, max=+12); the center-line
 * fill assumes that. Asymmetric ranges will still work but the fill won't
 * align with "neutral".
 */
export function VerticalSliderBands({
  values,
  labels,
  min,
  max,
  step = 0.5,
  onChange,
  trackHeight = 96,
  defaultValues,
}: VerticalSliderBandsProps) {
  return (
    <div className="flex items-stretch justify-between gap-1 py-1">
      {labels.map((label, i) => (
        <Band
          key={label}
          label={label}
          value={values[i] ?? 0}
          min={min}
          max={max}
          step={step}
          trackHeight={trackHeight}
          defaultValue={defaultValues?.[i]}
          onChange={(v) => onChange(i, v)}
        />
      ))}
    </div>
  )
}

type BandProps = {
  label: string
  value: number
  min: number
  max: number
  step: number
  trackHeight: number
  defaultValue?: number
  onChange: (v: number) => void
}

/**
 * Single column inside VerticalSliderBands. Split out so each band can own
 * its own ref + reset listener (the modifier-click hook needs a stable ref
 * per element, which doesn't compose with the .map() in the parent).
 */
function Band({ label, value, min, max, step, trackHeight, defaultValue, onChange }: BandProps) {
  const fmt = (v: number) => (v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1))
  const { ref: trackRef, menuNode } = useSliderTrackGestures({
    value,
    min,
    max,
    step,
    defaultValue,
    onChange,
    format: fmt,
  })
  const gestureOpen = useRef(false)
  return (
    <div className="flex flex-1 flex-col items-center gap-1.5">
      <span className="select-none text-caption tabular-nums text-ink-muted">
        {fmt(value)}
      </span>
      <Slider
        orientation="vertical"
        aria-label={label}
        value={value}
        minValue={min}
        maxValue={max}
        step={step}
        onChange={(v) => {
          if (!gestureOpen.current) {
            gestureOpen.current = true
            useStore.getState().beginSettingsEdit()
          }
          onChange(typeof v === 'number' ? v : v[0])
        }}
        onChangeEnd={() => {
          if (gestureOpen.current) {
            gestureOpen.current = false
            useStore.getState().endSettingsEdit()
          }
        }}
      >
        <SliderTrack
          ref={trackRef}
          className="relative w-4 cursor-pointer"
          style={{ height: trackHeight }}
        >
          {({ state }) => {
            const percent = state.getThumbPercent(0)
            // Fill from the 50% line out to the thumb position.
            // percent: 0 = bottom (min), 1 = top (max), 0.5 = center.
            const fillStyle: CSSProperties =
              percent >= 0.5
                ? { bottom: '50%', height: `${(percent - 0.5) * 100}%` }
                : { top: '50%', height: `${(0.5 - percent) * 100}%` }
            return (
              <>
                <div className="absolute inset-y-0 left-1/2 w-1 -translate-x-1/2 rounded-[2px] bg-fill-track" />
                {/* Center reference line (0 dB) */}
                <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-ink-faint" />
                <div
                  className="absolute left-1/2 w-1 -translate-x-1/2 rounded-[2px] bg-ink"
                  style={fillStyle}
                />
                <KnobThumb vertical small />
              </>
            )
          }}
        </SliderTrack>
      </Slider>
      <span className="select-none text-caption text-ink-faint">{label}</span>
      {menuNode}
    </div>
  )
}

// ── Setting-bound row wrappers ────────────────────────────────────────
//
// These subscribe to a single settings key via Zustand's selector, so
// each row only re-renders when ITS value changes. The Inspector itself
// no longer needs to subscribe to the whole `settings` object — which
// was the dominant cost during slider drags (a single setting change
// re-rendered the Inspector and forced all ~80 rows through React's
// reconciliation, even though only one of them actually changed).

export type NumericKeys = {
  [K in keyof Settings]: Settings[K] extends number ? K : never
}[keyof Settings]
export type BooleanKeys = {
  [K in keyof Settings]: Settings[K] extends boolean ? K : never
}[keyof Settings]
export type StringKeys = {
  [K in keyof Settings]: Settings[K] extends string ? K : never
}[keyof Settings]

const writeSetting = <K extends keyof Settings>(key: K, value: Settings[K]) => {
  useStore.getState().updateSettings({ [key]: value } as Partial<Settings>)
}

/** A small whole-number setting (a count of colours, stops…) as segments rather than a slider. */
export function BoundCountRow({ label, settingKey, min, max }: { label: string; settingKey: NumericKeys; min: number; max: number }) {
  const value = String(Math.round(useEffectiveSetting(settingKey) as number))
  const options = Array.from({ length: max - min + 1 }, (_, i) => ({ value: String(min + i), label: String(min + i) }))
  return (
    <SelectRow
      label={label}
      value={value}
      options={options}
      onChange={(v) => writeSetting(settingKey, Number(v) as Settings[NumericKeys])}
      defaultValue={String(defaultSettings[settingKey])}
      scopeKey={settingKey}
    />
  )
}

export function BoundSliderRow({
  label,
  settingKey,
  min,
  max,
  step,
  format,
}: {
  label: string
  settingKey: NumericKeys
  min: number
  max: number
  step?: number
  format?: (v: number) => string
}) {
  const value = useEffectiveSetting(settingKey) as number
  return (
    <SliderRow
      label={label}
      value={value}
      min={min}
      max={max}
      step={step}
      format={format}
      onChange={(v) => writeSetting(settingKey, v as Settings[NumericKeys])}
      defaultValue={defaultSettings[settingKey] as number}
      scopeKey={settingKey}
    />
  )
}

export function BoundSwitchRow({
  label,
  settingKey,
}: {
  label: string
  settingKey: BooleanKeys
}) {
  const value = useEffectiveSetting(settingKey) as boolean
  return (
    <SwitchRow
      label={label}
      value={value}
      onChange={(v) => writeSetting(settingKey, v as Settings[BooleanKeys])}
      defaultValue={defaultSettings[settingKey] as boolean}
      scopeKey={settingKey}
    />
  )
}

export function BoundColorRow({
  label,
  settingKey,
  onRemove,
}: {
  label: string
  settingKey: StringKeys
  onRemove?: () => void
}) {
  const value = useEffectiveSetting(settingKey) as string
  return (
    <ColorRow
      label={label}
      value={value}
      onChange={(v) => writeSetting(settingKey, v as Settings[StringKeys])}
      defaultValue={defaultSettings[settingKey] as string}
      scopeKey={settingKey}
      onRemove={onRemove}
    />
  )
}

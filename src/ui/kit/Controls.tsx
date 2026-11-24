import { useState, type ReactNode } from 'react'
import {
  Button as AriaButton,
  ListBox,
  ListBoxItem,
  ProgressBar,
  Radio,
  RadioGroup,
  SelectionIndicator,
  SharedElementTransition,
  Select as AriaSelect,
  SelectValue,
  SliderThumb,
  Switch as AriaSwitch,
  type Key,
} from 'react-aria-components'
import clsx from 'clsx'
import { CheckIcon, ChevronIcon, ChevronRightIcon } from './icons'
import { Popover } from './Menu'

/** On/off switch. Pass `children` for a visible label, or `aria-label`. */
export function Switch({
  isSelected,
  onChange,
  children,
  isDisabled,
  className,
  'aria-label': ariaLabel,
}: {
  isSelected: boolean
  onChange: (v: boolean) => void
  children?: ReactNode
  isDisabled?: boolean
  className?: string
  'aria-label'?: string
}) {
  return (
    <AriaSwitch
      isSelected={isSelected}
      onChange={onChange}
      isDisabled={isDisabled}
      aria-label={ariaLabel}
      className={clsx(
        'group relative flex cursor-pointer items-center justify-between gap-2 outline-none data-[disabled]:cursor-default data-[disabled]:opacity-40',
        className,
      )}
    >
      {children}
      <span className="relative h-5 w-[34px] flex-none rounded-round bg-fill-track transition-colors duration-150 group-data-[selected]:bg-ink group-data-[focus-visible]:outline group-data-[focus-visible]:outline-2 group-data-[focus-visible]:outline-offset-2 group-data-[focus-visible]:outline-[var(--focus)]">
        <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-ink transition-transform duration-150 group-data-[selected]:translate-x-[14px] group-data-[selected]:bg-on-ink motion-reduce:transition-none" />
      </span>
    </AriaSwitch>
  )
}

export type SegmentOption<T extends string> = { value: T; label: ReactNode; isDisabled?: boolean }

/**
 * Side-by-side choices (2–4). `present` rings values held by part of a mixed selection;
 * pass `value = null` with `present` for "Mixed". `onClear` makes the choice optional: pressing the
 * selected segment again clears it.
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  present,
  onClear,
  'aria-label': ariaLabel,
  className,
}: {
  value: T | null
  onChange: (v: T) => void
  options: SegmentOption<T>[]
  present?: ReadonlySet<T>
  onClear?: () => void
  'aria-label': string
  className?: string
}) {
  return (
    <SharedElementTransition>
      <RadioGroup
        aria-label={ariaLabel}
        value={value ?? ''}
        onChange={(v) => onChange(v as T)}
        orientation="horizontal"
        className={clsx('grid auto-cols-fr grid-flow-col gap-0.5 rounded-[11px] bg-fill-field p-[3px]', className)}
      >
        {options.map((o) => (
          <Radio
            key={o.value}
            value={o.value}
            isDisabled={o.isDisabled}
            // a radio group never deselects on its own; a press on the selected segment does it here
            onPress={onClear && o.value === value ? onClear : undefined}
            data-present={present?.has(o.value) || undefined}
            className={clsx(
              'nf-press relative grid h-[30px] cursor-pointer place-items-center whitespace-nowrap rounded-field px-2 font-medium text-ink-muted outline-none',
              'data-[hovered]:text-ink data-[selected]:text-ink',
              'data-[present]:text-ink data-[present]:shadow-[inset_0_0_0_1.5px_var(--ink-muted)]',
              'data-[focus-visible]:outline data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-[var(--focus)]',
              'data-[disabled]:cursor-default data-[disabled]:opacity-40',
            )}
          >
            {/* The selected fill slides between segments. */}
            <SelectionIndicator className="absolute inset-0 rounded-field bg-fill-selected shadow-[inset_0_0_0_1px_var(--glass-edge)] transition-[translate,width] duration-200 ease-[var(--ease-out)] motion-reduce:transition-none" />
            <span className="relative">{o.label}</span>
          </Radio>
        ))}
      </RadioGroup>
    </SharedElementTransition>
  )
}

export type SelectOption<T extends string> = { value: T; label: string }

/** Dropdown for one of many. `inline` = compact width for use inside a row. */
export function Select<T extends string>({
  value,
  onChange,
  options,
  inline,
  'aria-label': ariaLabel,
  className,
  isDisabled,
}: {
  value: T
  onChange: (v: T) => void
  options: SelectOption<T>[]
  inline?: boolean
  'aria-label': string
  className?: string
  isDisabled?: boolean
}) {
  return (
    <AriaSelect
      aria-label={ariaLabel}
      selectedKey={value}
      onSelectionChange={(k: Key | null) => k != null && onChange(k as T)}
      isDisabled={isDisabled}
      className={clsx(inline ? 'inline-block' : 'block w-full', className)}
    >
      <AriaButton
        className={clsx(
          'nf-focus flex cursor-pointer items-center justify-between gap-2 rounded-field bg-fill-field px-2.5 text-body text-ink outline-none data-[hovered]:bg-fill-selected data-[disabled]:cursor-default data-[disabled]:opacity-40',
          inline ? 'h-control-sm' : 'h-8 w-full',
        )}
      >
        <SelectValue className="truncate" />
        <ChevronIcon className="h-4 w-4 flex-none text-ink-muted" />
      </AriaButton>
      <Popover placement="bottom start" className="min-w-[--trigger-width] rounded-[14px]">
        <ListBox className="max-h-[360px] overflow-auto p-1.5 outline-none">
          {options.map((o) => (
            <ListBoxItem
              key={o.value}
              id={o.value}
              textValue={o.label}
              className="group flex h-[34px] cursor-default select-none items-center gap-2.5 rounded-field px-2.5 outline-none data-[focused]:bg-fill-selected"
            >
              <span className="grid w-4 flex-none place-items-center">
                <CheckIcon className="hidden h-4 w-4 group-data-[selected]:block" />
              </span>
              <span className="truncate">{o.label}</span>
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </AriaSelect>
  )
}

/** A row that folds content away ("Advanced", "More"). Uncontrolled unless `isExpanded` is passed. */
export function Disclosure({
  label,
  children,
  defaultExpanded = false,
  isExpanded,
  onExpandedChange,
}: {
  label: ReactNode
  children: ReactNode
  defaultExpanded?: boolean
  isExpanded?: boolean
  onExpandedChange?: (v: boolean) => void
}) {
  const [inner, setInner] = useState(defaultExpanded)
  const open = isExpanded ?? inner
  const set = (v: boolean) => {
    setInner(v)
    onExpandedChange?.(v)
  }
  return (
    <div className="grid gap-3">
      <AriaButton
        aria-expanded={open}
        onPress={() => set(!open)}
        className="nf-focus group inline-flex w-fit cursor-pointer items-center gap-1.5 rounded-field text-ink-muted outline-none data-[hovered]:text-ink"
      >
        <ChevronRightIcon className="h-4 w-4 transition-transform duration-150 group-aria-expanded:rotate-90 motion-reduce:transition-none" />
        {label}
      </AriaButton>
      {open && children}
    </div>
  )
}

/** Determinate bar (`value` 0..1). */
export function Progress({
  value,
  label,
  thin,
  className,
}: {
  value: number
  label: string
  thin?: boolean
  className?: string
}) {
  return (
    <ProgressBar
      aria-label={label}
      value={Math.round(Math.max(0, Math.min(1, value)) * 100)}
      className={clsx('relative overflow-hidden rounded-[3px] bg-fill-track', thin ? 'h-1' : 'h-1.5', className)}
    >
      {({ percentage }) => (
        <div className="absolute inset-y-0 left-0 rounded-[3px] bg-ink" style={{ width: `${percentage ?? 0}%` }} />
      )}
    </ProgressBar>
  )
}

/** Thin rule between groups inside one glass surface. */
export function Divider({ vertical, className }: { vertical?: boolean; className?: string }) {
  return vertical ? (
    <span aria-hidden className={clsx('mx-1.5 h-[22px] w-px flex-none bg-glass-edge', className)} />
  ) : (
    <div aria-hidden className={clsx('h-px w-full bg-glass-edge', className)} />
  )
}

/**
 * Slider knob for react-aria `SliderThumb`. The thumb itself is a 24px transparent hit area
 * centred on the track (react-aria translates it by -50%/-50%); the visible 16px ink dot grows
 * a little on hover and while dragging. Place the track's centre line at the thumb's `top`.
 */
export function KnobThumb({
  vertical,
  small,
  className,
}: {
  vertical?: boolean
  small?: boolean
  className?: string
}) {
  return (
    <SliderThumb
      className={clsx(
        'group/knob grid h-6 w-6 cursor-grab place-items-center outline-none data-[dragging]:cursor-grabbing',
        vertical ? 'left-1/2' : 'top-1/2',
        className,
      )}
    >
      <span
        className={clsx(
          'block rounded-full bg-ink shadow-knob transition-transform duration-150 ease-out',
          'group-data-[hovered]/knob:scale-110 group-data-[dragging]/knob:scale-[1.18]',
          'group-data-[focus-visible]/knob:outline group-data-[focus-visible]/knob:outline-2 group-data-[focus-visible]/knob:outline-offset-2 group-data-[focus-visible]/knob:outline-[var(--focus)]',
          'motion-reduce:transition-none',
          small ? 'h-3.5 w-3.5' : 'h-4 w-4',
        )}
      />
    </SliderThumb>
  )
}

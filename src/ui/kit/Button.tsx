import { forwardRef, type ReactNode } from 'react'
import {
  Button as AriaButton,
  ToggleButton as AriaToggleButton,
  type ButtonProps as AriaButtonProps,
  type ToggleButtonProps as AriaToggleButtonProps,
} from 'react-aria-components'
import clsx from 'clsx'
import { Tooltip } from './Tooltip'

export type ButtonVariant = 'quiet' | 'primary' | 'field' | 'danger'

const VARIANT: Record<ButtonVariant, string> = {
  quiet: 'bg-transparent text-ink data-[hovered]:bg-fill-hover data-[pressed]:bg-fill-selected',
  primary: 'bg-ink text-on-ink data-[hovered]:brightness-[1.06] data-[pressed]:brightness-95',
  field: 'bg-fill-field text-ink data-[hovered]:bg-fill-selected data-[pressed]:bg-fill-selected',
  danger: 'bg-transparent text-danger data-[hovered]:bg-fill-hover data-[pressed]:bg-fill-selected',
}

/** Shared state classes: selected / open toggles, disabled (40%, fill kept), focus ring. */
export const CONTROL_STATES =
  'nf-focus outline-none data-[selected]:bg-fill-selected aria-expanded:bg-fill-selected data-[disabled]:cursor-default data-[disabled]:opacity-40'

export type ButtonProps = Omit<AriaButtonProps, 'className' | 'children'> & {
  variant?: ButtonVariant
  size?: 'sm' | 'md'
  /** Leading icon (17px). */
  icon?: ReactNode
  /** Trailing hint text, e.g. a shortcut ("⌫"). */
  hint?: ReactNode
  className?: string
  children?: ReactNode
}

/** Text button. App-specific actions always carry a text label. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'quiet', size = 'md', icon, hint, className, children, ...rest },
  ref,
) {
  return (
    <AriaButton
      ref={ref}
      {...rest}
      className={clsx(
        'nf-press inline-flex flex-none cursor-pointer items-center gap-[7px] whitespace-nowrap rounded-round font-medium',
        size === 'md' ? 'h-control px-3.5' : 'h-control-sm px-2.5',
        VARIANT[variant],
        CONTROL_STATES,
        className,
      )}
    >
      {icon && <span className="grid h-[17px] w-[17px] flex-none place-items-center [&>svg]:h-full [&>svg]:w-full">{icon}</span>}
      {children}
      {hint && <span className="ml-auto pl-3 font-normal text-ink-faint">{hint}</span>}
    </AriaButton>
  )
})

export type IconButtonProps = Omit<AriaButtonProps, 'className' | 'children'> & {
  /** Required: icon-only controls are named for screen readers and get a tooltip. */
  label: string
  /** Shown after the label in the tooltip, e.g. "Space". */
  shortcut?: string
  size?: 'sm' | 'md' | 'play'
  children: ReactNode
  className?: string
  tooltip?: boolean
}

const ICON_SIZE = {
  sm: 'h-control-sm w-control-sm text-ink data-[hovered]:bg-fill-hover data-[pressed]:bg-fill-selected [&>svg]:h-4 [&>svg]:w-4',
  md: 'h-icon-btn w-icon-btn text-ink data-[hovered]:bg-fill-hover data-[pressed]:bg-fill-selected [&>svg]:h-5 [&>svg]:w-5',
  play: 'h-play w-play text-ink data-[hovered]:bg-fill-hover data-[pressed]:bg-fill-selected [&>svg]:h-9 [&>svg]:w-9',
}

/** Icon-only button. Only for universal media / window controls (play, skip, volume, close, reset, undo, redo). */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, shortcut, size = 'md', children, className, tooltip = true, ...rest },
  ref,
) {
  const button = (
    <AriaButton
      ref={ref}
      aria-label={label}
      {...rest}
      className={clsx(
        'nf-press inline-grid flex-none cursor-pointer place-items-center rounded-round p-0',
        ICON_SIZE[size],
        CONTROL_STATES,
        className,
      )}
    >
      {children}
    </AriaButton>
  )
  return tooltip ? <Tooltip label={label} shortcut={shortcut}>{button}</Tooltip> : button
})

export type ToggleButtonProps = Omit<AriaToggleButtonProps, 'className' | 'children'> & {
  icon?: ReactNode
  className?: string
  children?: ReactNode
}

/** Labelled toggle (Look, Timeline). Pressed = `fill-selected`. */
export function ToggleButton({ icon, className, children, ...rest }: ToggleButtonProps) {
  return (
    <AriaToggleButton
      {...rest}
      className={clsx(
        'nf-press inline-flex h-control flex-none cursor-pointer items-center gap-[7px] whitespace-nowrap rounded-round px-3.5 font-medium text-ink data-[hovered]:bg-fill-hover data-[pressed]:bg-fill-selected',
        CONTROL_STATES,
        className,
      )}
    >
      {icon && <span className="grid h-[17px] w-[17px] flex-none place-items-center [&>svg]:h-full [&>svg]:w-full">{icon}</span>}
      {children}
    </AriaToggleButton>
  )
}

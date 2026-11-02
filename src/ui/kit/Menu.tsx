import type { ReactNode } from 'react'
import {
  Header,
  Menu as AriaMenu,
  MenuItem as AriaMenuItem,
  MenuSection as AriaMenuSection,
  Popover as AriaPopover,
  Separator,
  type MenuItemProps as AriaMenuItemProps,
  type MenuProps as AriaMenuProps,
  type PopoverProps as AriaPopoverProps,
} from 'react-aria-components'
import clsx from 'clsx'
import { CheckIcon } from './icons'

export { MenuTrigger, SubmenuTrigger } from 'react-aria-components'

/** Strong-glass floating surface beside its trigger (menus, pickers, the takes list). Never on top of other glass. */
export function Popover({ className, ...props }: Omit<AriaPopoverProps, 'className'> & { className?: string }) {
  return (
    <AriaPopover
      offset={8}
      {...props}
      // a caller's own radius (menus: 14px) replaces the panel default; with both classes the panel one won
      className={clsx(
        'nf-glass-strong nf-pop z-[90] text-body text-ink outline-none',
        !/(^|\s)rounded-/.test(className ?? '') && 'rounded-panel',
        className,
      )}
    />
  )
}

export function Menu<T extends object>({ className, ...props }: Omit<AriaMenuProps<T>, 'className'> & { className?: string }) {
  return (
    <AriaMenu
      {...props}
      // Width: 240px minimum unless the caller sets its own (short submenus, fixed-width menus).
      className={clsx('box-border max-h-[inherit] overflow-auto p-1.5 outline-none', className ?? 'min-w-[240px]')}
    />
  )
}

/** Popover + Menu in one, for the common case. */
export function MenuPopover<T extends object>({
  placement = 'bottom start',
  children,
  menuClassName,
  ...menuProps
}: Omit<AriaMenuProps<T>, 'className'> & { placement?: AriaPopoverProps['placement']; menuClassName?: string }) {
  return (
    <Popover placement={placement} className="rounded-[14px]">
      <Menu {...menuProps} className={menuClassName}>
        {children}
      </Menu>
    </Popover>
  )
}

export type MenuItemProps = Omit<AriaMenuItemProps, 'className' | 'children'> & {
  icon?: ReactNode
  /** Shortcut shown at the right edge, in `ink-faint`. */
  hint?: ReactNode
  danger?: boolean
  /** Reserve the check column and show a check when true (radio / toggle rows). */
  checked?: boolean
  /** A second line under the label, in `ink-faint` (the row grows to fit). */
  description?: ReactNode
  children: ReactNode
}

export function MenuItem({ icon, hint, danger, checked, description, children, ...props }: MenuItemProps) {
  const textValue = props.textValue ?? (typeof children === 'string' ? children : undefined)
  return (
    <AriaMenuItem
      {...props}
      textValue={textValue}
      className={clsx(
        'flex cursor-default select-none items-center gap-2.5 rounded-field px-2.5 outline-none data-[focused]:bg-fill-selected data-[open]:bg-fill-selected data-[disabled]:text-ink-faint',
        description ? 'py-2' : 'h-[34px] whitespace-nowrap',
        danger ? 'text-danger' : 'text-ink',
      )}
    >
      {({ hasSubmenu }) => (
        <>
          {checked !== undefined && (
            <span className="grid w-4 flex-none place-items-center">{checked && <CheckIcon className="h-4 w-4" />}</span>
          )}
          {icon && <span className="grid h-4 w-4 flex-none place-items-center [&>svg]:h-full [&>svg]:w-full">{icon}</span>}
          {description ? (
            <span className="grid min-w-0 flex-1 gap-0.5">
              <span>{children}</span>
              <span className="text-caption text-ink-faint">{description}</span>
            </span>
          ) : (
            <span className="min-w-0 flex-1 truncate">{children}</span>
          )}
          {hint && <span className="ml-auto pl-6 text-ink-faint">{hint}</span>}
          {hasSubmenu && (
            <svg viewBox="0 0 24 24" className="ml-auto h-4 w-4 flex-none text-ink-muted" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M9 6l6 6-6 6" />
            </svg>
          )}
        </>
      )}
    </AriaMenuItem>
  )
}

export function MenuSeparator() {
  return <Separator className="mx-1 my-1.5 h-px bg-glass-edge" />
}

export function MenuSection<T extends object>({ title, children }: { title?: string; children: ReactNode; items?: Iterable<T> }) {
  return (
    <AriaMenuSection>
      {title && <Header className="px-2.5 pb-1 pt-2 text-caption text-ink-faint">{title}</Header>}
      {children}
    </AriaMenuSection>
  )
}

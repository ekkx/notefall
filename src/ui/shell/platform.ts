// Key labels for tooltips, menu hints and the shortcut sheet. Apple platforms get the glyphs (⌘ ⇧ ⌥ ⌫,
// run together: ⇧⌘S); Windows / Linux get words joined by "+" (Ctrl+Shift+S). The handlers accept
// both Cmd and Ctrl everywhere, so only the labels differ.

export const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '')

/** Single key-cap labels (the shortcut sheet draws each in its own cap). */
export const KEY = {
  mod: IS_MAC ? '⌘' : 'Ctrl',
  shift: IS_MAC ? '⇧' : 'Shift',
  alt: IS_MAC ? '⌥' : 'Alt',
  del: IS_MAC ? '⌫' : 'Del',
} as const

/**
 * One shortcut as a single hint string, in each platform's own order: ⇧⌘S / Ctrl+Shift+S. A word
 * (Click) keeps a space after the glyphs on a Mac: ⌘ Click.
 */
export function shortcutLabel(key: string, mods: { mod?: boolean; shift?: boolean; alt?: boolean } = {}): string {
  if (IS_MAC) {
    const glyphs = `${mods.alt ? '⌥' : ''}${mods.shift ? '⇧' : ''}${mods.mod ? '⌘' : ''}`
    return glyphs && key.length > 1 ? `${glyphs} ${key}` : glyphs + key
  }
  return [mods.mod && 'Ctrl', mods.alt && 'Alt', mods.shift && 'Shift', key].filter(Boolean).join('+')
}

/** Redo: ⇧⌘Z on a Mac, Ctrl+Y elsewhere (both work everywhere). */
export const REDO_LABEL = IS_MAC ? shortcutLabel('Z', { mod: true, shift: true }) : shortcutLabel('Y', { mod: true })

/**
 * Whether this browser has never opened notefall: nothing is stored for the site yet. Read before anything writes
 * (main.tsx imports this first; the language is stored as soon as i18n starts). False when storage is unavailable.
 */
export const firstVisit: boolean = (() => {
  try {
    return window.localStorage.length === 0
  } catch {
    return false
  }
})()

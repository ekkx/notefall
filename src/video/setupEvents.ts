/**
 * "The hand video setup closed with OK" as a plain signal, so the background checks that follow it
 * (`autotrack.ts`) need not know the setup UI. `finishHandVideoSetup()` (video/setup.ts) calls
 * `notifyHandVideoSetupFinished()`; Cancel does not.
 */
const listeners = new Set<() => void>()

export function onHandVideoSetupFinished(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function notifyHandVideoSetupFinished(): void {
  for (const cb of [...listeners]) cb()
}

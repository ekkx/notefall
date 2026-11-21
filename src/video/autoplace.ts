import { useStore } from '../store'
import { useHandVideo } from './handVideo'
import { detectKeyboard } from './autodetect/client'
import './autotrack' // the drift check that follows the setup's OK (registers itself)
import type { KeyboardFit } from './autodetect/protocol'

/**
 * Lay the hand video on the keyboard automatically: a one-shot detection (≈1 s, a few frames near
 * `at`, default the start) in the worker, then the result goes into the settings as one `auto` key
 * plus the lens bend. On failure the video stays keyboard-wide in the middle (no key) as a starting
 * point for placing it by hand. Progress is `useHandVideo.detect`. A newer call, or the video going
 * away, abandons the one in flight.
 *
 * `keepDirty` is for re-detecting after a project opened: the project is not "changed" by that.
 */

let running: AbortController | null = null
let autoFit: KeyboardFit | null = null

/** The detector's answer for the current video (what the setup's "Back to automatic" restores). */
export function lastAutoFit(): KeyboardFit | null {
  return autoFit
}

useHandVideo.subscribe((state, prev) => {
  if (state.element !== prev.element) {
    running?.abort()
    autoFit = null
  }
})

export async function autoPlaceHandVideo(opts: { at?: number; keepDirty?: boolean } = {}): Promise<void> {
  const video = useHandVideo.getState()
  const { blob, element } = video
  if (!blob || !element) return
  running?.abort()
  const ctl = new AbortController()
  running = ctl
  video.setDetect({ state: 'finding' })

  const current = () => !ctl.signal.aborted && useHandVideo.getState().element === element
  let outcome
  try {
    outcome = await detectKeyboard(blob, { at: opts.at, signal: ctl.signal })
  } catch (e) {
    if (current()) useHandVideo.getState().setDetect({ state: 'failed', reason: e instanceof Error ? e.message : String(e) })
    return
  } finally {
    if (running === ctl) running = null
  }
  if (!current()) return

  const store = useStore.getState()
  const wasDirty = store.dirty
  // Re-finding the keys of an opened project is not an edit: no undo entry, and it never overwrites a placement
  // the user is making in a setup opened meanwhile.
  if (opts.keepDirty && useHandVideo.getState().editing !== null) return
  const undoable = !opts.keepDirty
  if (undoable) store.beginSettingsEdit()
  if (outcome.ok) {
    const { fit } = outcome
    autoFit = fit
    store.updateSettings({
      handVideoKeys: [{ t: fit.t, H: fit.H, source: 'auto' }],
      handVideoBend: fit.bend,
      handVideoOctaveKnown: fit.octaveKnown,
    })
    useHandVideo.getState().setDetect({ state: 'found', octaveKnown: fit.octaveKnown })
  } else {
    store.updateSettings({ handVideoKeys: [], handVideoBend: 0, handVideoOctaveKnown: true })
    useHandVideo.getState().setDetect({ state: 'failed', reason: outcome.reason })
  }
  if (undoable) store.endSettingsEdit()
  if (opts.keepDirty && !wasDirty) useStore.setState({ dirty: false })
}

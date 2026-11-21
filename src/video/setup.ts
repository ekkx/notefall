import { create } from 'zustand'
import { useStore, type Settings } from '../store'
import { pauseSong } from '../audio/playback'
import { useHandVideo, type HandVideoSetupStep } from './handVideo'
import { lastAutoFit } from './autoplace'
import { withKeyAt } from './setupGeometry'
import type { Mat3 } from './geometry'
import { notifyHandVideoSetupFinished } from './setupEvents'

/**
 * The hand video setup session (the UI is `ui/HandVideoSetup.tsx`): while a session is open every
 * gesture is its own undo entry (⌘Z works), Cancel puts the settings back as they were and drops the
 * session's undo entries (for a video that was just added it removes the video again), Finish keeps
 * everything.
 *
 * `openHandVideoSetup('confirm')` is the one entry point callers use (after an import, Customize's
 * "Line up again", the timeline lane menu). With nothing placed yet it opens the by-hand step instead.
 */

type Baseline = { before: Settings; wasDirty: boolean; historyLength: number }

/** `undoFloor`: the history length at the session's start (undo stops there); `historyLength` is what Cancel restores. */
let session: (Baseline & { undoFloor: number; isNew: boolean }) | null = null

/** The state to put back on Cancel. A caller that edits the project BEFORE opening the session (an import) takes this first. */
export function captureHandVideoBaseline(): Baseline {
  const store = useStore.getState()
  return { before: store.settings, wasDirty: store.dirty, historyLength: store.editHistory.length }
}

export function openHandVideoSetup(step: HandVideoSetupStep, opts: { isNew?: boolean; baseline?: Baseline } = {}): void {
  const video = useHandVideo.getState()
  if (!video.element) return
  if (!session) {
    pauseSong()
    session = { ...(opts.baseline ?? captureHandVideoBaseline()), undoFloor: useStore.getState().editHistory.length, isNew: !!opts.isNew }
  }
  // Nothing to confirm when no placement exists (and none is being found or failed): go straight to placing by hand.
  // A failed detection keeps the confirm step, whose bar says so and only closes.
  const placed = useStore.getState().settings.handVideoKeys.length > 0
  video.setEditing(step === 'confirm' && !placed && video.detect.state !== 'finding' && video.detect.state !== 'failed' ? 'fix' : step)
}

/** True while the open session is for a just-added video (closing it then removes the video). */
export function handVideoSetupIsNew(): boolean {
  return session?.isNew ?? false
}

/** False while an open session has no undo entries of its own left: ⌘Z must not reach back before the session. */
export function handVideoSetupCanUndo(): boolean {
  return !session || useStore.getState().editHistory.length > session.undoFloor
}

/** True while a setup session is open. */
export function handVideoSetupOpen(): boolean {
  return session !== null
}

export function setHandVideoSetupStep(step: HandVideoSetupStep): void {
  if (session) useHandVideo.getState().setEditing(step)
}

export function finishHandVideoSetup(): void {
  if (!session) return
  const { isNew } = session
  const wasRange = useHandVideo.getState().editing === 'range'
  session = null
  useHandVideo.getState().setEditing(null)
  // A new video changes the project even when no setting moved.
  if (isNew) useStore.getState().markDirty()
  // Starts the camera-drift check over the whole video (autotrack.ts); Cancel never does.
  // (Not after the display range: the framing is unchanged.)
  if (!wasRange) notifyHandVideoSetupFinished()
}

export function cancelHandVideoSetup(): void {
  if (!session) return
  const { before, wasDirty, historyLength, isNew } = session
  session = null
  useStore.setState((st) => ({
    settings: before,
    dirty: wasDirty,
    editHistory: st.editHistory.slice(0, historyLength),
    editFuture: [],
  }))
  useHandVideo.getState().setEditing(null)
  if (isNew) useHandVideo.getState().clear()
}

/** Run `apply` as one undo entry (a click, a typed value, a drag). */
export function handVideoEdit(apply: () => void): void {
  const store = useStore.getState()
  store.beginSettingsEdit()
  try {
    apply()
  } finally {
    store.endSettingsEdit()
  }
}

/** The video time on screen while the setup is open (the element is left alone by live sync). */
export function setupVideoTime(): number {
  return useHandVideo.getState().element?.currentTime ?? 0
}

function seekVideo(t: number): void {
  const el = useHandVideo.getState().element
  if (el && Math.abs(el.currentTime - t) > 0.02) el.currentTime = t
}

/** Write the placement for the frame on screen (one key at its video time) and its octave flag. */
export function placeAtCurrentFrame(h: Mat3, source: 'auto' | 'manual', patch: { bend?: number; octaveKnown?: boolean } = {}): void {
  const st = useStore.getState()
  st.updateSettings({
    handVideoKeys: withKeyAt(st.settings.handVideoKeys, setupVideoTime(), { H: h, source }),
    ...(patch.bend !== undefined ? { handVideoBend: patch.bend } : {}),
    ...(patch.octaveKnown !== undefined ? { handVideoOctaveKnown: patch.octaveKnown } : {}),
  })
}

/** The detector's own answer for this video, if there is one ("Back to automatic"). */
export function automaticPlacement(): { H: Mat3; bend: number; octaveKnown: boolean } | null {
  const fit = lastAutoFit()
  return fit ? { H: fit.H as Mat3, bend: fit.bend, octaveKnown: fit.octaveKnown } : null
}

export function restoreAutomatic(): void {
  const auto = automaticPlacement()
  if (!auto) return
  handVideoEdit(() => placeAtCurrentFrame(auto.H, 'auto', { bend: auto.bend, octaveKnown: auto.octaveKnown }))
}

// ── See-through level of the setup (Confirm and Fix) ─────────────────────────────────

const TRANSPARENCY_KEY = 'nf:handVideoSetupTransparency'
/** Before the slider read as transparency it stored opacity under this key (migrated once). */
const OLD_OPACITY_KEY = 'nf:handVideoSetupOpacity'
export const SETUP_TRANSPARENCY_DEFAULT = 0.45
const MAX_TRANSPARENCY = 0.95

function loadSetupTransparency(): number {
  try {
    const raw = localStorage.getItem(TRANSPARENCY_KEY)
    if (raw !== null && Number.isFinite(Number(raw))) return Math.min(MAX_TRANSPARENCY, Math.max(0, Number(raw)))
    const old = localStorage.getItem(OLD_OPACITY_KEY)
    if (old !== null && Number.isFinite(Number(old))) return Math.min(MAX_TRANSPARENCY, Math.max(0, 1 - Number(old)))
  } catch {
    /* storage unavailable: the default */
  }
  return SETUP_TRANSPARENCY_DEFAULT
}

/**
 * How see-through the video is while the setup is open, Confirm and Fix alike (0 = solid, the keys behind show
 * through more to the right). A view aid only: it never changes the finished look (`handVideoOpacity`) and is not
 * saved in the project; it is remembered in this browser.
 */
export const useSetupTransparency = create<{ transparency: number }>(() => ({ transparency: loadSetupTransparency() }))

export function setSetupTransparency(transparency: number): void {
  useSetupTransparency.setState({ transparency })
  try {
    localStorage.setItem(TRANSPARENCY_KEY, String(transparency))
  } catch {
    /* ignore */
  }
}

/** The video's opacity while the setup is open. */
export function setupOpacity(): number {
  return 1 - useSetupTransparency.getState().transparency
}

// The detector answered while the setup waits: show the frame it looked at.
useHandVideo.subscribe((state, prev) => {
  if (!session || state.detect === prev.detect || state.detect.state !== 'found') return
  const first = useStore.getState().settings.handVideoKeys[0]
  if (first) seekVideo(first.t)
})

// The video went away under an open session (New, Open, Remove): close it.
useHandVideo.subscribe((state) => {
  if (session && !state.element) session = null
})

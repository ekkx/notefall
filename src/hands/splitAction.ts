// The "split into left and right hand" action: asks, runs the planner, applies one undo entry. Entry points: the File menu,
// the Customize colouring row, and choosing the "By hand" colouring.
import { create } from 'zustand'
import i18n from '../i18n'
import { buildSpeedMap } from '../midi/speedMap'
import { useStore } from '../store'
import { showAlert, showConfirm } from '../ui/confirm'
import { showToast } from '../ui/kit/Toast'
import { applySongHands, planSongHands, splitsTracks, unassignedCount } from './split'

/** A run is shown as busy only when it takes longer than this. */
const SLOW_MS = 300

export const useHandSplit = create<{ running: boolean; slow: boolean }>(() => ({ running: false, slow: false }))

export type SplitOutcome = 'ok' | 'cancelled' | 'error'

/** Splits the loaded song's hands. `replace` plans every note again (the hands set before are dropped). */
export async function splitHands(opt: { replace?: boolean } = {}): Promise<SplitOutcome> {
  const st = useStore.getState()
  const song = st.song
  if (!song || song.notes.length === 0 || useHandSplit.getState().running) return 'cancelled'
  const s = st.settings
  const map = {
    speedMap: buildSpeedMap(s.midiSpeedAutomation),
    midiOffsetSec: s.midiOffsetSec,
    trimStartSec: s.midiTrimStartSec,
    trimEndSec: s.midiTrimEndSec ?? song.duration,
    transpose: s.transpose,
  }
  const ctl = new AbortController()
  // another song replaced this one meanwhile: drop the result (edits to the same song keep it valid; they share `tracks`)
  const unsub = useStore.subscribe((state) => {
    if (state.song?.tracks !== song.tracks) ctl.abort()
  })
  useHandSplit.setState({ running: true, slow: false })
  const slowTimer = window.setTimeout(() => useHandSplit.setState({ slow: true }), SLOW_MS)
  try {
    const result = await planSongHands(song, map, { signal: ctl.signal, replace: opt.replace })
    const cur = useStore.getState().song
    if (ctl.signal.aborted || !cur || cur.tracks !== song.tracks) return 'cancelled'
    const oldTrack = cur.notes[0]?.track
    const colour = oldTrack === undefined ? undefined : useStore.getState().settings.trackColors[String(oldTrack)]
    const retrack = splitsTracks(cur)
    useStore.getState().applySongEdit((prev) => applySongHands(prev, result.hands, opt.replace))
    if (retrack) {
      const store = useStore.getState()
      // the split tracks keep the old track's colour, so the solid look stays the same
      if (colour && oldTrack !== undefined) {
        const next: Record<string, string> = { ...store.settings.trackColors, '0': colour, '1': colour }
        if (oldTrack > 1) delete next[String(oldTrack)]
        store.beginSettingsEdit()
        store.updateSettings({ trackColors: next })
        store.endSettingsEdit()
      }
      if (store.lastNoteParams.track > 1) store.setLastNoteParams({ ...store.lastNoteParams, track: 0 })
    }
    const byHand = useStore.getState().settings.noteColorMode === 'hand'
    showToast({
      message: i18n.t(byHand ? 'dialogs:handSplit.done' : 'dialogs:handSplit.doneHint', { right: result.right, left: result.left }),
      durationMs: byHand ? undefined : 7000,
    })
    return 'ok'
  } catch (e) {
    if ((e as Error).name === 'AbortError') return 'cancelled'
    console.error('hand split failed', e)
    void showAlert({
      tone: 'error',
      title: i18n.t('dialogs:handSplit.errorTitle'),
      message: i18n.t('dialogs:handSplit.errorMessage'),
    })
    return 'error'
  } finally {
    window.clearTimeout(slowTimer)
    unsub()
    useHandSplit.setState({ running: false, slow: false })
  }
}

/** After choosing the "By hand" colouring: offers the split when some notes have no hand. Declining changes nothing. */
export async function offerHandSplit(): Promise<void> {
  const count = unassignedCount(useStore.getState().song)
  if (count === 0) return
  const ok = await showConfirm({
    title: i18n.t('dialogs:handSplit.askTitle'),
    message: i18n.t('dialogs:handSplit.askMessage', { count }),
    confirmLabel: i18n.t('dialogs:handSplit.askConfirm'),
    cancelLabel: i18n.t('dialogs:handSplit.askCancel'),
  })
  if (ok) await splitHands()
}

/** The command (File menu): splits what has no hand; with every note already set it asks before replacing them. */
export async function splitHandsCommand(): Promise<void> {
  const song = useStore.getState().song
  if (!song || song.notes.length === 0) return
  if (unassignedCount(song) > 0) {
    await splitHands()
    return
  }
  const ok = await showConfirm({
    title: i18n.t('dialogs:handSplit.redoTitle'),
    message: i18n.t('dialogs:handSplit.redoMessage'),
    confirmLabel: i18n.t('dialogs:handSplit.redoConfirm'),
    cancelLabel: i18n.t('dialogs:handSplit.askCancel'),
    destructive: true,
  })
  if (ok) await splitHands({ replace: true })
}

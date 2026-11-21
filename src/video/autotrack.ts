import i18n from '../i18n'
import { useStore } from '../store'
import { showToast } from '../ui/kit/Toast'
import { useHandVideo } from './handVideo'
import { trackKeyboard } from './autodetect/client'
import { KEY_EPS, cleanTrack, planKeys } from './autodetect/drift'
import { onHandVideoSetupFinished } from './setupEvents'

/**
 * Drift tracking. After the setup closes with OK, the worker follows the keyboard through the whole video
 * (a fit every 4 s, refined to 2 s where it moved, on a few workers: `autodetect/client.ts`); `autodetect/drift.ts`
 * turns that into framing keys wherever the camera moved or drifted by more than 0.04 white key, anchored on the
 * placement the user just confirmed. Progress is
 * `useHandVideo.track`; the end is one notice.
 *
 * The keys go in as ONE undo entry (⌘Z takes the following away again; the history is never wiped).
 * Writing without an entry would leave older history entries holding the old keys, so undoing an earlier
 * edit would silently drop them. Manual keys are never touched; previous auto keys are replaced.
 * A newer run, or the video going away, abandons the one in flight.
 */

let running: AbortController | null = null

useHandVideo.subscribe((state, prev) => {
  if (state.element !== prev.element) {
    running?.abort()
    running = null
    if (state.track.state !== 'idle') state.setTrack({ state: 'idle' })
  }
})

onHandVideoSetupFinished(() => void trackHandVideoDrift())

const clock = (sec: number) => {
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function notice(moves: Array<{ t: number; size: number }>, drift: number, offset: number): string {
  if (moves.length === 0) return i18n.t(drift > KEY_EPS ? 'video:track.drifted' : 'video:track.still')
  const times = moves.map((m) => clock(offset + m.t))
  const big = moves.some((m) => m.size > 1)
  const when =
    times.length <= 3
      ? i18n.t('video:track.at', { list: new Intl.ListFormat(i18n.language, { style: 'long', type: 'conjunction' }).format(times) })
      : i18n.t('video:track.times', { count: times.length })
  return i18n.t(big ? 'video:track.movedBig' : 'video:track.moved', { when })
}

export async function trackHandVideoDrift(): Promise<void> {
  const video = useHandVideo.getState()
  const { blob, element } = video
  if (!blob || !element) return
  // Nothing placed (a failed detection): there is no placement to carry along the video.
  if (useStore.getState().settings.handVideoKeys.length === 0) return
  running?.abort()
  const ctl = new AbortController()
  running = ctl
  video.setTrack({ state: 'running', fraction: 0 })
  const current = () => !ctl.signal.aborted && useHandVideo.getState().element === element
  let outcome
  try {
    outcome = await trackKeyboard(blob, {
      signal: ctl.signal,
      onProgress: (fraction) => {
        if (current()) useHandVideo.getState().setTrack({ state: 'running', fraction })
      },
    })
  } catch {
    // aborted, or the worker failed: the video stays as placed
    if (running === ctl) running = null
    if (current()) useHandVideo.getState().setTrack({ state: 'idle' })
    return
  }
  if (running === ctl) running = null
  if (!current()) return
  useHandVideo.getState().setTrack({ state: 'idle' })
  if (!outcome.ok) return
  // A setup reopened meanwhile owns the keys; its OK starts a fresh check.
  if (useHandVideo.getState().editing !== null) return

  const store = useStore.getState()
  const { handVideoKeys, handVideoBend, handVideoOffsetSec } = store.settings
  const plan = planKeys(handVideoKeys, cleanTrack(outcome.samples, outcome.aspect), outcome.aspect, handVideoBend)
  if (!plan.reliable) {
    showToast({ message: i18n.t('video:track.unsure'), durationMs: 8000 })
    return
  }
  if (JSON.stringify(plan.keys) !== JSON.stringify(handVideoKeys)) {
    store.beginSettingsEdit()
    store.updateSettings({ handVideoKeys: plan.keys })
    store.endSettingsEdit()
  }
  showToast({ message: notice(plan.moves, plan.drift, handVideoOffsetSec), durationMs: 9000 })
}

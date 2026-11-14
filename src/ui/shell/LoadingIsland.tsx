import { useEffect, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '../../store'
import { getHandsStatus, subscribeHandsStatus } from '../../hands/motion'
import { GEOMETRY, Progress, showToast } from '../kit'

/** Making a song's motion is often over in a moment (an edit of a short piece): its row shows only once it has run this long. */
const WORKING_SHOW_MS = 400

/** The hands' row: their data loading (download, then unpacking, as one bar) or a song's motion being made; null otherwise. */
function useHandsRow(): { label: string; fraction: number } | null {
  const { t } = useTranslation('common')
  const on = useStore((s) => s.settings.handsEnabled)
  const st = useSyncExternalStore(subscribeHandsStatus, getHandsStatus)
  const working = on && st.state === 'working'
  // (straight on from the loading row, without the delay: the island must not blink between the two)
  const [late, setLate] = useState(false)
  const [wasLoading, setWasLoading] = useState(false)
  if (on && st.state === 'loading' && !wasLoading) setWasLoading(true)
  if (!(on && (st.state === 'loading' || st.state === 'working')) && wasLoading) setWasLoading(false)
  useEffect(() => {
    if (!working) { setLate(false); return }
    const id = window.setTimeout(() => setLate(true), WORKING_SHOW_MS)
    return () => window.clearTimeout(id)
  }, [working])
  // (a failure is said once, wherever the user is; Customize keeps the line under the hands' section)
  const failed = on && st.state === 'error'
  useEffect(() => {
    if (failed) showToast({ message: t('hands.error', { ns: 'inspector' }) })
  }, [failed, t])
  if (!on) return null
  if (st.state === 'loading') return { label: t('loadingIsland.handsLoading'), fraction: st.stage === 'download' ? 0.5 * st.fraction : 0.5 + 0.5 * st.fraction }
  if (st.state === 'working' && (late || wasLoading)) return { label: t('loadingIsland.handsWorking'), fraction: st.fraction }
  return null
}

/**
 * Small island at the top centre while something the picture needs is being prepared: the piano sounds, the hands' motion
 * (one row each when both run). Never blocks the app: only playback waits for the sounds (the Viewport's click-eater guards
 * destructive canvas gestures); hands simply appear when their motion is ready.
 */
export function LoadingIsland() {
  const { t } = useTranslation('common')
  const status = useStore((s) => s.loadStatus)
  const hands = useHandsRow()
  const rows: { key: string; label: string; fraction: number }[] = []
  if (status.state === 'loading') rows.push({ key: 'piano', label: t('loadingIsland.title'), fraction: status.total > 0 ? status.loaded / status.total : 0 })
  if (hands) rows.push({ key: 'hands', ...hands })
  if (!rows.length) return null
  return (
    <div
      role="status"
      // (under the top islands, not between them: a long song name reaches the centre)
      style={{ top: GEOMETRY.EDGE + GEOMETRY.BAR + GEOMETRY.GAP }}
      className="nf-glass-strong pointer-events-none fixed left-1/2 z-40 box-border grid min-h-11 -translate-x-1/2 grid-cols-[auto_140px] items-center gap-x-3.5 gap-y-1.5 rounded-round px-5 py-[13px] text-body text-ink"
    >
      {rows.map((r) => (
        <div key={r.key} className="contents">
          <span className="whitespace-nowrap">{r.label}</span>
          <Progress value={r.fraction} label={r.label} className="w-[140px]" />
        </div>
      ))}
    </div>
  )
}

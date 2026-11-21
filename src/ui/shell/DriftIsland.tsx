import { useTranslation } from 'react-i18next'
import { useStore } from '../../store'
import { useHandVideo } from '../../video/handVideo'
import { GEOMETRY, Progress } from '../kit'

/**
 * Small island at the top centre while the camera's drift in the hand video is being checked in the
 * background (`video/autotrack.ts`). Never blocks anything. Sits under the piano-sounds island when both show.
 */
export function DriftIsland() {
  const { t } = useTranslation('video')
  const track = useHandVideo((s) => s.track)
  const editing = useHandVideo((s) => s.editing)
  const loading = useStore((s) => s.loadStatus.state === 'loading')
  if (track.state !== 'running' || editing) return null
  const top = GEOMETRY.EDGE + (loading ? 44 + GEOMETRY.GAP : 0)
  return (
    <div
      role="status"
      style={{ top }}
      className="nf-glass-strong pointer-events-none fixed left-1/2 z-40 box-border flex h-11 -translate-x-1/2 items-center gap-3.5 rounded-round px-5 text-body text-ink"
    >
      <span className="whitespace-nowrap">{t('track.checking')}</span>
      <Progress value={track.fraction} label={t('track.checking')} className="w-[140px]" />
    </div>
  )
}

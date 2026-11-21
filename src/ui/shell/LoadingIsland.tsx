import { useTranslation } from 'react-i18next'
import { useStore } from '../../store'
import { GEOMETRY, Progress } from '../kit'
import { useHandVideoSetupOpen } from './takeFocus'

/**
 * Small island at the top centre while the piano sounds download. Never blocks the app:
 * only playback waits (the Viewport's click-eater guards destructive canvas gestures).
 */
export function LoadingIsland() {
  const { t } = useTranslation('common')
  const status = useStore((s) => s.loadStatus)
  // The hand video setup has the top of the screen to itself (its bar sits where this island would).
  const setupOpen = useHandVideoSetupOpen()
  if (status.state !== 'loading' || setupOpen) return null
  const fraction = status.total > 0 ? status.loaded / status.total : 0
  return (
    <div
      role="status"
      style={{ top: GEOMETRY.EDGE }}
      className="nf-glass-strong pointer-events-none fixed left-1/2 z-40 box-border flex h-11 -translate-x-1/2 items-center gap-3.5 rounded-round px-5 text-body text-ink"
    >
      <span className="whitespace-nowrap">{t('loadingIsland.title')}</span>
      <Progress value={fraction} label={t('loadingIsland.title')} className="w-[140px]" />
    </div>
  )
}

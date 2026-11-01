import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { COUNT_IN_BEATS } from '../../audio/recordControl'

/**
 * The count-in before a take: a glass disc in the middle of the screen counting down the beats.
 * Esc cancels it (the same as pressing Record again).
 */
export function CountIn({ beat, onCancel }: { beat: number; onCancel: () => void }) {
  const { t } = useTranslation('toolbar')
  useEffect(() => {
    if (beat === 0) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onCancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [beat, onCancel])
  if (beat === 0) return null
  return (
    <div className="pointer-events-none fixed inset-0 z-40 grid place-items-center pb-[20vh]">
      <div
        role="status"
        aria-live="assertive"
        className="nf-glass-strong nf-enter-fade grid h-[180px] w-[180px] place-items-center rounded-full text-center"
      >
        <div>
          <div className="text-[72px] font-semibold leading-[72px] tabular-nums">{COUNT_IN_BEATS - beat + 1}</div>
          <div className="mt-1 text-ink-muted">{t('record.countInHint')}</div>
        </div>
      </div>
    </div>
  )
}

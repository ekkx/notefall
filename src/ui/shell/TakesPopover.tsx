import { useState } from 'react'
import { Dialog as AriaDialog, DialogTrigger } from 'react-aria-components'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import clsx from 'clsx'
import { pauseSong, playSong } from '../../audio/playback'
import type { useRecorder } from '../../audio/useRecorder'
import { Button, Divider, Icon, IconButton, Popover, Switch, showToast } from '../kit'
import { showConfirm } from '../confirm'

export function fmtElapsed(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/** "Today 18:42", "Yesterday 18:42", else the short date and time in the UI language. */
function fmtCreatedAt(epochMs: number, t: TFunction<'toolbar'>, lang: string): string {
  const d = new Date(epochMs)
  const time = new Intl.DateTimeFormat(lang, { hour: 'numeric', minute: '2-digit' }).format(d)
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86_400_000)
  if (days === 0) return t('recordings.today', { time })
  if (days === 1) return t('recordings.yesterday', { time })
  return new Intl.DateTimeFormat(lang, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d)
}

/**
 * The ▾ half of the Record split button: "Takes" with the count-in switch beside it, then the
 * takes list (play, rename, save as .mid, delete with Undo in a toast, unread dots, clear all after a confirm).
 */
export function TakesPopover({
  rec,
  transport,
  activeRecordingId,
  countInEnabled,
  onCountInChange,
  countInLocked,
  onPickRecording,
  onLoadAndPlayRecording,
}: {
  rec: ReturnType<typeof useRecorder>
  transport: string
  activeRecordingId: string | null
  countInEnabled: boolean
  onCountInChange: (v: boolean) => void
  countInLocked: boolean
  onPickRecording: (id: string, name: string) => void
  onLoadAndPlayRecording: (id: string, name: string) => void
}) {
  const { t, i18n } = useTranslation('toolbar')
  // Controlled so the close transition can `markAllRead`: clearing on close (not open)
  // lets the user see WHICH rows are unread before the dots disappear.
  const [open, setOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingDraft, setEditingDraft] = useState('')
  // One press deletes; the toast offers Undo for a slip.
  const onDelete = (id: string) => {
    const take = rec.recordings.find((r) => r.id === id)
    if (!take) return
    rec.delete(id)
    showToast({
      message: t('recordings.deleted', { name: take.name }),
      action: { label: t('recordings.undo'), onAction: () => rec.restore(take) },
    })
  }

  return (
    <DialogTrigger
      isOpen={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) rec.markAllRead()
      }}
    >
      <div className="relative inline-flex">
        {/* the seam between Record and ▾, shown while the pill is hovered */}
        <span
          aria-hidden
          className="pointer-events-none absolute left-0 top-1/2 h-4 w-px -translate-y-1/2 bg-glass-edge opacity-0 transition-opacity duration-150 group-has-[[data-hovered]]/split:opacity-100"
        />
        <IconButton
          size="sm"
          tooltip={false}
          label={
            rec.unreadCount > 0
              ? t('recordings.triggerWithNew', { count: rec.unreadCount })
              : t('recordings.trigger')
          }
          className="!h-control w-8 rounded-l-none pr-0.5 data-[hovered]:!bg-transparent data-[pressed]:!bg-fill-selected aria-expanded:!bg-fill-selected"
        >
          <Icon.ChevronIcon />
        </IconButton>
        {rec.unreadCount > 0 && (
          <span
            aria-hidden
            className="pointer-events-none absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-ink px-1 text-caption font-semibold leading-none text-on-ink"
          >
            {rec.unreadCount > 99 ? '99+' : rec.unreadCount}
          </span>
        )}
      </div>
      <Popover placement="bottom end" className="rounded-[14px]">
        <AriaDialog aria-label={t('recordings.heading')} className="flex w-[380px] flex-col p-1.5 outline-none">
          <div className="flex items-center justify-between gap-3 px-2.5 pb-2 pt-1.5">
            <span className="text-heading">{t('recordings.heading')}</span>
            <Switch isSelected={countInEnabled} onChange={onCountInChange} isDisabled={countInLocked}>
              <span className="text-ink-muted">{t('record.countIn')}</span>
            </Switch>
          </div>
          {rec.recordings.length === 0 ? (
            <p className="px-2.5 pb-2.5 pt-1 text-ink-muted">{t('recordings.empty')}</p>
          ) : (
            <div className="scroll-thin flex max-h-80 flex-col gap-0.5 overflow-y-auto">
              {rec.recordings.map((r) => {
                const isActive = r.id === activeRecordingId
                const isPlayingThis = isActive && transport === 'playing'
                return (
                  <div
                    key={r.id}
                    // Whole-row click = load only (no auto-play). Clicks that originate on an
                    // action button are ignored: those run their own handler.
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest('button')) return
                      if (isActive) return
                      onPickRecording(r.id, r.name)
                    }}
                    className={clsx(
                      'flex min-h-[52px] cursor-pointer items-center gap-3 rounded-field py-1.5 pl-2.5 pr-1',
                      isActive ? 'bg-fill-selected' : 'hover:bg-fill-hover',
                    )}
                  >
                    {/* Always reserves 8px so read / unread rows share a left edge. */}
                    <span
                      role={r.read ? undefined : 'img'}
                      aria-label={r.read ? undefined : t('recordings.unread')}
                      className={clsx('h-1.5 w-1.5 flex-none rounded-full', r.read ? 'bg-transparent' : 'bg-ink')}
                    />
                    <div className="flex min-w-0 flex-1 flex-col">
                      {editingId === r.id ? (
                        <input
                          value={editingDraft}
                          autoFocus
                          onChange={(e) => setEditingDraft(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              const next = editingDraft.trim()
                              if (next) rec.rename(r.id, next)
                              setEditingId(null)
                            } else if (e.key === 'Escape') {
                              setEditingId(null)
                            }
                            e.stopPropagation()
                          }}
                          onBlur={() => {
                            const next = editingDraft.trim()
                            if (next && next !== r.name) rec.rename(r.id, next)
                            setEditingId(null)
                          }}
                          className="nf-focus h-control-sm min-w-0 rounded-field bg-fill-field px-2 text-body text-ink outline-none"
                        />
                      ) : (
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => {
                            e.stopPropagation()
                            setEditingId(r.id)
                            setEditingDraft(r.name)
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.stopPropagation()
                              setEditingId(r.id)
                              setEditingDraft(r.name)
                            }
                          }}
                          className="nf-focus cursor-text truncate rounded-field text-ink outline-none"
                          title={t('recordings.clickToRename')}
                        >
                          {r.name}
                        </span>
                      )}
                      <span className="text-caption text-ink-faint">
                        {fmtCreatedAt(r.createdAt, t, i18n.language)} · {fmtElapsed(r.duration)}
                      </span>
                    </div>
                    <IconButton
                      size="sm"
                      label={isPlayingThis ? t('recordings.pause') : t('recordings.loadAndPlay')}
                      onPress={() => {
                        if (isPlayingThis) pauseSong()
                        else if (isActive) void playSong()
                        else onLoadAndPlayRecording(r.id, r.name)
                      }}
                    >
                      {isPlayingThis ? <Icon.PauseIcon /> : <Icon.PlayIcon />}
                    </IconButton>
                    <IconButton size="sm" label={t('recordings.saveAsMid')} onPress={() => rec.download(r.id)}>
                      <Icon.DownloadIcon />
                    </IconButton>
                    <IconButton size="sm" label={t('recordings.delete')} onPress={() => onDelete(r.id)}>
                      <Icon.TrashIcon />
                    </IconButton>
                  </div>
                )
              })}
            </div>
          )}
          {rec.recordings.length > 0 && (
            <>
              <Divider className="mx-1 my-1.5" />
              <Button
                variant="danger"
                size="sm"
                className="h-[34px] w-full justify-start rounded-field px-2.5"
                onPress={async () => {
                  setOpen(false)
                  const ok = await showConfirm({
                    title: t('recordings.clearAllTitle'),
                    message: t('recordings.clearAllMessage', { count: rec.recordings.length }),
                    confirmLabel: t('recordings.clearAllConfirm'),
                    destructive: true,
                  })
                  if (ok) rec.clearAll()
                }}
              >
                {t('recordings.clearAll')}
              </Button>
            </>
          )}
        </AriaDialog>
      </Popover>
    </DialogTrigger>
  )
}

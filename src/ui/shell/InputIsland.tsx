import { MenuTrigger } from 'react-aria-components'
import { useTranslation } from 'react-i18next'
import type { useMidiInput } from '../../audio/useMidiInput'
import type { useRecorder } from '../../audio/useRecorder'
import { Button, Divider, Icon, Island, Menu, MenuItem, Popover } from '../kit'
import { fmtElapsed, TakesPopover } from './TakesPopover'
import { useChromeHidden } from './idle'

type TakesProps = Omit<Parameters<typeof TakesPopover>[0], 'rec' | 'countInLocked'>

/** Top-right island: MIDI device menu, Record with its takes ▾, divider, Export. */
export function InputIsland({
  midi,
  rec,
  countInBeat,
  onConnect,
  onOpenMidiPanel,
  onToggleRecord,
  canExport,
  onExport,
  takes,
}: {
  midi: ReturnType<typeof useMidiInput>
  rec: ReturnType<typeof useRecorder>
  countInBeat: number
  onConnect: (deviceId: string) => void
  onOpenMidiPanel: () => void
  onToggleRecord: () => void
  canExport: boolean
  onExport: () => void
  takes: TakesProps
}) {
  const { t } = useTranslation('toolbar')
  const recording = rec.state === 'recording'
  const activeDevice = midi.devices.find((d) => d.id === midi.activeDeviceId)

  // Fades with the transport pill while a song plays and the pointer is idle.
  const chromeHidden = useChromeHidden()
  const islandClass = `fixed right-4 top-4 z-30 transition-[opacity,visibility] duration-200 ${chromeHidden ? 'invisible opacity-0 [transition-delay:0s,200ms]' : 'visible opacity-100'}`

  // While a take is being recorded the island holds only that take: elapsed time, notes so far, Stop.
  if (recording) {
    return (
      <Island className={islandClass}>
        <span className="inline-flex items-center gap-2.5 pl-2.5 pr-2">
          <span aria-hidden className="h-2.5 w-2.5 flex-none rounded-full bg-record" />
          <span className="font-semibold tabular-nums">{fmtElapsed(rec.elapsed)}</span>
          {rec.noteOnCount > 0 && (
            <span className="tabular-nums text-ink-muted">
              {t('record.notes', { count: rec.noteOnCount })}
              {rec.lastNote ? ` · ${rec.lastNote}` : ''}
            </span>
          )}
        </span>
        <Button
          aria-label={t('record.stop')}
          onPress={onToggleRecord}
          className="!bg-record text-ink data-[hovered]:brightness-110 data-[pressed]:brightness-95"
        >
          {t('record.stopLabel')}
        </Button>
      </Island>
    )
  }

  return (
    <Island className={islandClass}>
      {midi.supported && (
        <MenuTrigger onOpenChange={(open) => open && onOpenMidiPanel()}>
          <Button icon={<Icon.MidiIcon />} aria-label={t('midi.button')}>
            <span className="max-w-[160px] truncate">{activeDevice?.name ?? t('midi.button')}</span>
            <Icon.ChevronIcon className="-mr-1 h-4 w-4 text-ink-muted" />
          </Button>
          <Popover placement="bottom end" className="rounded-[14px]">
            <Menu
              aria-label={t('midi.inputDevices')}
              className="w-[280px]"
              renderEmptyState={() => <p className="px-2.5 py-2 text-ink-muted">{t('midi.noDevices')}</p>}
            >
              {midi.devices.map((d) => {
                const active = d.id === midi.activeDeviceId
                return (
                  <MenuItem
                    key={d.id}
                    id={d.id}
                    textValue={d.name}
                    checked={active}
                    hint={active ? t('midi.disconnect') : t('midi.connect')}
                    onAction={() => (active ? midi.connect(null) : onConnect(d.id))}
                  >
                    {d.name}
                  </MenuItem>
                )
              })}
            </Menu>
          </Popover>
        </MenuTrigger>
      )}

      <span className="inline-flex items-center">
        <Button
          className="pr-2"
          aria-label={countInBeat > 0 ? t('record.cancelCountIn') : t('record.start')}
          icon={
            countInBeat > 0 ? <Icon.StopIcon /> : <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-record" />
          }
          onPress={onToggleRecord}
        >
          {countInBeat > 0 ? t('record.cancelLabel') : t('record.label')}
        </Button>
        <TakesPopover
          rec={rec}
          {...takes}
          countInLocked={recording || countInBeat > 0}
        />
      </span>

      <Divider vertical />
      <Button
        variant="primary"
        icon={<Icon.ExportIcon />}
        isDisabled={!canExport}
        onPress={onExport}
        className="data-[disabled]:!bg-ink"
      >
        {t('file.exportButton')}
      </Button>
    </Island>
  )
}

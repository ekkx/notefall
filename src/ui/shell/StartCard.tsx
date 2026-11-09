import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { Button as AriaButton } from 'react-aria-components'
import { useStore } from '../../store'
import { DEMOS } from '../../demos'
import { recorder } from '../../audio/recorder'
import { midiInput } from '../../audio/midiInput'
import { toggleRecord } from '../../audio/recordControl'
import { loadDemoProject, openProject } from '../../projects/actions'
import { Button, Icon, IconButton, Menu, MenuItem, MenuTrigger, Popover, usePresence } from '../kit'
import { showAlert } from '../confirm'
import { shortcutLabel } from './platform'

// "Don't show again" on the card; kept per browser.
const HIDE_KEY = 'nf:ui:startCardHidden'
function readHidden(): boolean {
  try {
    return window.localStorage.getItem(HIDE_KEY) === '1'
  } catch {
    return false
  }
}
function writeHidden(): void {
  try {
    window.localStorage.setItem(HIDE_KEY, '1')
  } catch {
    /* storage unavailable: hidden for this session only */
  }
}

const subscribeRecorder = (cb: () => void) => recorder.addListener(cb)
const recording = () => recorder.getState() === 'recording'

/** Name of the connected MIDI keyboard, or null. */
function useMidiDeviceName(): string | null {
  const [name, setName] = useState<string | null>(null)
  useEffect(() => {
    const read = () => {
      const id = midiInput.getActiveDeviceId()
      setName(id ? (midiInput.getDevices().find((d) => d.id === id)?.name ?? null) : null)
    }
    read()
    return midiInput.addListener(read)
  }, [])
  return name
}

/**
 * What an empty notefall shows in the middle of the canvas: three ways to get a song in.
 * Gone the moment a song loads (and while a take is being recorded). Pressing anywhere outside
 * it (or Esc) puts it away until the next time the song is cleared; "Don't show again" for good.
 */
export function StartCard() {
  const { t } = useTranslation('common')
  const song = useStore((s) => s.song)
  const countingIn = useStore((s) => s.countInBeat > 0)
  const isRecording = useSyncExternalStore(subscribeRecorder, recording)
  const device = useMidiDeviceName()
  const [dismissed, setDismissed] = useState(false)
  const [hidden, setHidden] = useState(readHidden)
  const cardRef = useRef<HTMLElement>(null)
  // A loaded song resets it, so clearing the song later brings the card back.
  useEffect(() => {
    if (song) setDismissed(false)
  }, [song])
  const shown = !song && !isRecording && !countingIn && !dismissed && !hidden
  const { mounted, leaving } = usePresence(shown)
  useEffect(() => {
    if (!shown) return
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null
      // its own demo menu is portaled outside the card
      if (cardRef.current?.contains(target) || target?.closest('[role="menu"], [role="dialog"]')) return
      // While the demo menu is open the page under it doesn't receive the press (the target is the body), so a
      // press on the card itself only closes the menu: test the card's area instead of the target.
      const r = cardRef.current?.getBoundingClientRect()
      if (r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return
      setDismissed(true)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDismissed(true)
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [shown])
  if (!mounted) return null

  const onOpen = async () => {
    const result = await openProject()
    if (result.kind === 'error') {
      void showAlert({ title: result.title ?? t('startCard.couldNotOpenTitle'), message: result.message, tone: 'error' })
    }
  }
  const onDemo = async (label: string, url: string) => {
    const result = await loadDemoProject(label, url)
    if (result.kind === 'error') {
      void showAlert({ title: t('startCard.couldNotLoadDemoTitle'), message: result.message, tone: 'error' })
    }
  }
  const action = 'h-12 w-full justify-start rounded-[12px] px-4'

  return (
    <div className="pointer-events-none fixed inset-0 z-20 grid place-items-center p-6">
      <section
        ref={cardRef}
        aria-labelledby="nf-start-title"
        className={`nf-glass nf-enter-fade ${leaving ? 'nf-leaving' : ''} pointer-events-auto box-border grid w-[520px] max-w-full gap-4 rounded-panel px-7 py-[26px] text-body text-ink`}
      >
        <div className="grid gap-2">
          {/* Close: the way out for someone with no file or MIDI keyboard at hand (a press outside or Esc does the same) */}
          <div className="flex items-start justify-between gap-3">
            <h2 id="nf-start-title" className="text-display">
              {t('startCard.title')}
            </h2>
            <IconButton label={t('close')} shortcut="Esc" size="sm" className="-mr-2 -mt-1" onPress={() => setDismissed(true)}>
              <Icon.CloseIcon />
            </IconButton>
          </div>
          <p className="text-ink-muted">{t('startCard.text')}</p>
        </div>
        <div className="grid gap-2">
          <Button variant="field" icon={<Icon.FileIcon />} hint={shortcutLabel('O', { mod: true })} className={action} onPress={() => void onOpen()}>
            {t('startCard.open')}
          </Button>
          {DEMOS.length > 0 && (
            <MenuTrigger>
              <Button variant="field" icon={<Icon.PlayIcon />} hint={<Icon.ChevronRightIcon className="h-4 w-4" />} className={action}>
                {t('startCard.demo')}
              </Button>
              {/* as wide as the row it drops from */}
              <Popover placement="bottom start" offset={6} className="w-[--trigger-width] rounded-[14px]">
                <Menu aria-label={t('startCard.demoMenu')} className="max-h-72 w-full">
                  {DEMOS.map((demo) => (
                    <MenuItem key={demo.url} textValue={demo.label} onAction={() => void onDemo(demo.label, demo.url)}>
                      {demo.label}
                    </MenuItem>
                  ))}
                </Menu>
              </Popover>
            </MenuTrigger>
          )}
          {/* Recording works from a MIDI keyboard or the computer keyboard, so it's offered everywhere. */}
          <Button
            variant="field"
            icon={<span className="h-2.5 w-2.5 rounded-full bg-record" />}
            hint={device ? t('startCard.deviceConnected', { name: device }) : undefined}
            className={action}
            onPress={() => void toggleRecord()}
          >
            {t('startCard.record')}
          </Button>
        </div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-caption text-ink-faint">{t('startCard.note')}</p>
          <AriaButton
            onPress={() => {
              writeHidden()
              setHidden(true)
            }}
            className="nf-focus flex-none cursor-pointer rounded-field text-caption text-ink-faint underline decoration-ink-faint underline-offset-2 outline-none data-[hovered]:text-ink-muted"
          >
            {t('startCard.dontShowAgain')}
          </AriaButton>
        </div>
      </section>
    </div>
  )
}

import { Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, IconButton, Icon, Kbd } from '../kit'
import { useShell } from './uiState'
import { IS_MAC, KEY } from './platform'

// The one place that lists every keyboard shortcut and note gesture. Each row mirrors a
// real handler: `useGlobalShortcuts.ts` (keys), `scene/EditTools.tsx` + `notes/FallingNotes.tsx`
// (mouse on notes), `ui/Viewport.tsx` (scroll), `scene/CameraControls.tsx` (camera zoom).

const { mod: MOD, alt: ALT, shift: SHIFT, del: DEL } = KEY

type Row = { label: string; keys: string[] }
type Group = { title: string; rows: Row[] }

export function ShortcutSheet() {
  const { t } = useTranslation('dialogs')
  const isOpen = useShell((s) => s.shortcutsOpen)
  const setOpen = useShell((s) => s.setShortcutsOpen)

  const groups: Group[] = [
    {
      title: t('shortcuts.playback'),
      rows: [
        { label: t('shortcuts.play'), keys: ['Space'] },
        { label: t('shortcuts.scrub'), keys: [t('shortcuts.scrubKey')] },
        { label: t('shortcuts.ff'), keys: [t('shortcuts.ffKey')] },
        { label: t('shortcuts.timeline'), keys: [MOD, 'B'] },
      ],
    },
    {
      title: t('shortcuts.editing'),
      rows: [
        { label: t('shortcuts.undo'), keys: [MOD, 'Z'] },
        { label: t('shortcuts.redo'), keys: IS_MAC ? [SHIFT, MOD, 'Z'] : [MOD, 'Y'] },
        { label: t('shortcuts.delete'), keys: [DEL] },
        { label: t('shortcuts.clear'), keys: ['Esc'] },
        { label: t('shortcuts.nudgeTime'), keys: ['↑', '↓'] },
        { label: t('shortcuts.nudgePitch'), keys: ['←', '→'] },
        { label: t('shortcuts.keyframe'), keys: [SHIFT, 'K'] },
      ],
    },
    {
      title: t('shortcuts.file'),
      rows: [
        { label: t('shortcuts.open'), keys: [MOD, 'O'] },
        { label: t('shortcuts.save'), keys: [MOD, 'S'] },
        { label: t('shortcuts.saveAs'), keys: IS_MAC ? [SHIFT, MOD, 'S'] : [MOD, SHIFT, 'S'] },
        { label: t('shortcuts.record'), keys: [SHIFT, 'R'] },
        { label: t('shortcuts.sheet'), keys: ['?'] },
      ],
    },
    {
      title: t('shortcuts.mouse'),
      rows: [
        { label: t('shortcuts.add'), keys: [t('shortcuts.click')] },
        { label: t('shortcuts.select'), keys: [t('shortcuts.selectKey')] },
        { label: t('shortcuts.resize'), keys: [t('shortcuts.resizeKey')] },
        { label: t('shortcuts.menu'), keys: [t('shortcuts.menuKey')] },
        { label: t('shortcuts.addSelect'), keys: [MOD, t('shortcuts.click')] },
        { label: t('shortcuts.rangeSelect'), keys: [MOD, t('shortcuts.rangeKey')] },
        { label: t('shortcuts.split'), keys: [ALT, t('shortcuts.click')] },
        { label: t('shortcuts.del'), keys: [t('shortcuts.delKey')] },
        { label: t('shortcuts.erase'), keys: [t('shortcuts.eraseKey')] },
        { label: t('shortcuts.camera'), keys: [MOD, t('shortcuts.cameraKey')] },
      ],
    },
  ]

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={setOpen}
      title={t('shortcuts.title')}
      width={1180}
      className="relative gap-[18px] px-7"
    >
      <IconButton
        label={t('shortcuts.close')}
        size="sm"
        tooltip={false}
        onPress={() => setOpen(false)}
        className="absolute right-4 top-[18px]"
      >
        <Icon.CloseIcon />
      </IconButton>
      <div className="grid grid-cols-4 gap-7 max-[1100px]:grid-cols-2">
        {groups.map((g) => (
          <section key={g.title} className="grid content-start gap-2">
            <h3 className="m-0 text-heading text-ink">{g.title}</h3>
            {g.rows.map((r) => (
              <div key={r.label} className="flex items-center justify-between gap-3 text-ink-muted">
                <span>{r.label}</span>
                <span className="inline-flex flex-none gap-1">
                  {r.keys.map((k, i) => (
                    <Kbd key={i}>{k}</Kbd>
                  ))}
                </span>
              </div>
            ))}
          </section>
        ))}
      </div>
      <div className="flex items-center gap-3 border-t border-glass-edge pt-3.5 text-ink-muted">
        <span>{t('shortcuts.piano')}</span>
        <span className="inline-flex gap-1">
          {t('shortcuts.pianoKeys')
            .split(/[,、]\s*/)
            .map((k, i) => (
              <Fragment key={i}>
                <Kbd>{k}</Kbd>
              </Fragment>
            ))}
        </span>
      </div>
    </Dialog>
  )
}

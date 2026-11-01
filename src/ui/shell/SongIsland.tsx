import { useEffect, useRef, useState } from 'react'
import { MenuTrigger, SubmenuTrigger } from 'react-aria-components'
import { useTranslation } from 'react-i18next'
import { useStore } from '../../store'
import { DEMOS } from '../../demos'
import { hasFileSystemAccess } from '../../projects/io'
import { clearAllRecent, type RecentEntry } from '../../projects/recent'
import {
  Button,
  Divider,
  Icon,
  IconButton,
  Island,
  MenuItem,
  MenuPopover,
  MenuSeparator,
} from '../kit'
import type { ReportKind } from '../../feedback/report'
import { AppMenu } from './AppMenu'
import { useChromeHidden } from './idle'
import { useTakeInProgress } from './takeFocus'

// Mac gets the ⌘ / ⇧ glyphs; elsewhere "Ctrl+ / Shift+" word labels.
const IS_MAC =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '')
const SHORTCUT_OPEN = IS_MAC ? '⌘O' : 'Ctrl+O'
const SHORTCUT_SAVE = IS_MAC ? '⌘S' : 'Ctrl+S'
const SHORTCUT_SAVE_AS = IS_MAC ? '⇧⌘S' : 'Ctrl+Shift+S'
const SHORTCUT_UNDO = IS_MAC ? '⌘Z' : 'Ctrl+Z'
const SHORTCUT_REDO = IS_MAC ? '⇧⌘Z' : 'Ctrl+Shift+Z'

// Recent files rely on persisted `FileSystemFileHandle`s: Safari / Firefox can't reopen by
// handle, so the submenu would be a dead end there. FSA support doesn't change at runtime.
const RECENT_AVAILABLE = hasFileSystemAccess()

export type FileActions = {
  onNew: () => void
  onOpen: () => void
  onSave: () => void
  onSaveAs: () => void
  onImportAudio: () => void
  onSaveMidi: () => void
  onExport: () => void
  onLoadDemo: (label: string, url: string) => void
  onOpenRecent: (entry: RecentEntry) => void
}

/** Top-left island: app menu, File, song name + unsaved dot, Undo, Redo. */
export function SongIsland({
  actions,
  recents,
  recording,
  hasSong,
  exportBusy,
  fallbackName,
  onFeedback,
}: {
  actions: FileActions
  recents: readonly RecentEntry[]
  recording: boolean
  hasSong: boolean
  exportBusy: boolean
  fallbackName: string | null
  onFeedback: (kind: ReportKind) => void
}) {
  const { t } = useTranslation('toolbar')
  const dirty = useStore((s) => s.dirty)
  const projectName = useStore((s) => s.projectName)
  const setProjectName = useStore((s) => s.setProjectName)
  const canUndo = useStore((s) => s.editHistory.length > 0)
  const canRedo = useStore((s) => s.editFuture.length > 0)
  const undoEdit = useStore((s) => s.undoEdit)
  const redoEdit = useStore((s) => s.redoEdit)

  // Fades with the transport pill while a song plays and the pointer is idle, and steps aside for a take.
  const idleHidden = useChromeHidden()
  const takeInProgress = useTakeInProgress()
  const chromeHidden = idleHidden || takeInProgress
  return (
    <Island className={`fixed left-4 top-4 z-30 transition-[opacity,visibility] duration-200 ${chromeHidden ? 'invisible opacity-0 [transition-delay:0s,200ms]' : 'visible opacity-100'}`}>
      <AppMenu onFeedback={onFeedback} />
      <MenuTrigger>
        <Button isDisabled={recording}>
          {t('file.menuButton')}
          <Icon.ChevronIcon className="-mr-1 h-4 w-4 text-ink-muted" />
        </Button>
        <MenuPopover aria-label={t('file.menuLabel')} placement="bottom start" menuClassName="w-[260px]">
          <MenuItem onAction={actions.onNew}>{t('file.new')}</MenuItem>
          <MenuItem hint={SHORTCUT_OPEN} onAction={actions.onOpen}>
            {t('file.open')}
          </MenuItem>
          {RECENT_AVAILABLE && recents.length > 0 && (
            <SubmenuTrigger>
              <MenuItem textValue={t('file.openRecent')}>{t('file.openRecent')}</MenuItem>
              <MenuPopover aria-label={t('file.openRecentLabel')} placement="end top" menuClassName="w-[280px]">
                {recents.map((entry) => (
                  <MenuItem key={entry.id} textValue={entry.name} onAction={() => actions.onOpenRecent(entry)}>
                    {entry.name}
                  </MenuItem>
                ))}
                <MenuSeparator />
                <MenuItem danger onAction={() => clearAllRecent()}>
                  {t('file.clearRecent')}
                </MenuItem>
              </MenuPopover>
            </SubmenuTrigger>
          )}
          {DEMOS.length > 0 && (
            <SubmenuTrigger>
              <MenuItem textValue={t('file.demoSongs')}>{t('file.demoSongs')}</MenuItem>
              <MenuPopover aria-label={t('file.demoSongsLabel')} placement="end top" menuClassName="w-[280px]">
                {DEMOS.map((demo) => (
                  <MenuItem key={demo.url} textValue={demo.label} onAction={() => actions.onLoadDemo(demo.label, demo.url)}>
                    {demo.label}
                  </MenuItem>
                ))}
              </MenuPopover>
            </SubmenuTrigger>
          )}
          <MenuSeparator />
          <MenuItem hint={SHORTCUT_SAVE} onAction={actions.onSave}>
            {t('file.save')}
          </MenuItem>
          <MenuItem hint={SHORTCUT_SAVE_AS} onAction={actions.onSaveAs}>
            {t('file.saveAs')}
          </MenuItem>
          <MenuSeparator />
          <MenuItem isDisabled={!hasSong} onAction={actions.onImportAudio}>
            {t('file.addAudio')}
          </MenuItem>
          <MenuItem isDisabled={!hasSong} onAction={actions.onSaveMidi}>
            {t('file.saveSongAsMidi')}
          </MenuItem>
          <MenuSeparator />
          <MenuItem isDisabled={!hasSong || exportBusy} onAction={actions.onExport}>
            {t('file.export')}
          </MenuItem>
        </MenuPopover>
      </MenuTrigger>

      {fallbackName !== null && (
        <span className="inline-flex min-w-0 max-w-[340px] items-center gap-2 pl-1.5 pr-2.5 text-ink-muted">
          <ProjectNameField
            projectName={projectName}
            fallback={fallbackName}
            placeholder={t('projectName.untitled')}
            onCommit={setProjectName}
          />
          {dirty && (
            <span
              role="img"
              aria-label={t('badge.unsavedAria')}
              title={t('badge.unsavedAria')}
              className="h-1.5 w-1.5 flex-none rounded-full bg-ink-muted"
            />
          )}
        </span>
      )}

      <Divider vertical />
      <IconButton label={t('history.undo')} shortcut={SHORTCUT_UNDO} isDisabled={!canUndo} onPress={undoEdit}>
        <Icon.UndoIcon />
      </IconButton>
      <IconButton label={t('history.redo')} shortcut={SHORTCUT_REDO} isDisabled={!canRedo} onPress={redoEdit}>
        <Icon.RedoIcon />
      </IconButton>
    </Island>
  )
}

/**
 * Inline-editable project name. Renders as a button until the user clicks (or focuses via
 * Tab); becomes a text input where Enter / blur commits and Escape reverts. Empty commit
 * clears the override so the display falls back to the filename / song name.
 */
function ProjectNameField({
  projectName,
  fallback,
  placeholder,
  onCommit,
}: {
  projectName: string
  fallback: string
  placeholder: string
  onCommit: (name: string) => void
}) {
  const { t } = useTranslation('toolbar')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  const display = projectName || fallback

  const enterEdit = () => {
    setDraft(display)
    setEditing(true)
  }

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  const commit = () => {
    const trimmed = draft.trim()
    // Only push to the store if the value actually changed: a click-and-blur with no
    // edits must not mark the project dirty.
    if (trimmed !== projectName) onCommit(trimmed)
    setEditing(false)
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setEditing(false)
          }
          // Global shortcuts (Cmd+S, Space, ...) must not fire while typing here.
          e.stopPropagation()
        }}
        spellCheck={false}
        aria-label={t('projectName.aria')}
        placeholder={placeholder}
        className="nf-focus h-control-sm w-[24ch] min-w-0 max-w-full rounded-field bg-fill-field px-2 text-body text-ink outline-none"
      />
    )
  }

  return (
    <button
      type="button"
      onClick={enterEdit}
      onFocus={enterEdit}
      title={t('projectName.rename')}
      className="nf-focus min-w-0 cursor-text truncate rounded-field px-1.5 py-1 text-left text-ink-muted outline-none hover:bg-fill-hover"
    >
      {display || placeholder}
    </button>
  )
}

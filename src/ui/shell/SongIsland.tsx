import { useEffect, useRef, useState } from 'react'
import { Autocomplete, Input, MenuTrigger, SearchField, SubmenuTrigger } from 'react-aria-components'
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
  Menu,
  MenuItem,
  MenuPopover,
  Popover,
  MenuSeparator,
} from '../kit'
import { useHandSplit } from '../../hands/splitAction'
import type { ReportKind } from '../../feedback/report'
import { AppMenu } from './AppMenu'
import { useChromeHidden } from './idle'
import { useHandVideoSetupOpen, useTakeInProgress } from './takeFocus'
import { REDO_LABEL, shortcutLabel } from './platform'

const SHORTCUT_OPEN = shortcutLabel('O', { mod: true })
const SHORTCUT_SAVE = shortcutLabel('S', { mod: true })
const SHORTCUT_SAVE_AS = shortcutLabel('S', { mod: true, shift: true })
const SHORTCUT_UNDO = shortcutLabel('Z', { mod: true })
const SHORTCUT_REDO = REDO_LABEL

// Recent files rely on persisted `FileSystemFileHandle`s: Safari / Firefox can't reopen by
// handle, so the submenu would be a dead end there. FSA support doesn't change at runtime.
const RECENT_AVAILABLE = hasFileSystemAccess()

// Lower-case, strip diacritics, and drop spaces and ":" / "_" / "." / "-" so "etude op 25" finds "Étude: Op_25".
const foldText = (v: string) =>
  v
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[:_.\-\s]+/g, '')

// Short lists (production) read fine without a field.
const DEMO_SEARCH_MIN = 8

function DemoList({ onLoad }: { onLoad: (label: string, url: string) => void }) {
  const { t } = useTranslation('toolbar')
  const searchable = DEMOS.length > DEMO_SEARCH_MIN
  const menu = (
    <Menu
      aria-label={t('file.demoSongsLabel')}
      className="box-border min-h-0 w-[280px] flex-1 overflow-auto p-1.5 outline-none"
      renderEmptyState={() => <div className="px-2.5 py-2 text-body text-ink-faint">{t('file.demoSongsEmpty')}</div>}
    >
      {DEMOS.map((demo) => (
        <MenuItem key={demo.url} id={demo.url} textValue={demo.label} onAction={() => onLoad(demo.label, demo.url)}>
          {demo.label}
        </MenuItem>
      ))}
    </Menu>
  )
  if (!searchable) return menu
  return (
    <Autocomplete filter={(text, input) => foldText(text).includes(foldText(input))}>
      <div className="flex max-h-[inherit] flex-col">
        <SearchField aria-label={t('file.demoSongsSearch')} autoFocus className="relative m-1.5 mb-0 flex-none">
          <Icon.SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
          <Input
            placeholder={t('file.demoSongsSearch')}
            spellCheck={false}
            className="nf-focus h-8 w-full rounded-tab bg-fill-field pl-9 pr-3 text-body text-ink outline-none placeholder:text-ink-faint"
          />
        </SearchField>
        {menu}
      </div>
    </Autocomplete>
  )
}

export type FileActions = {
  onNew: () => void
  onOpen: () => void
  onSave: () => void
  onSaveAs: () => void
  onImportAudio: () => void
  onImportVideo: () => void
  onSaveMidi: () => void
  onSplitHands: () => void
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
  const splitRunning = useHandSplit((s) => s.running)
  const undoEdit = useStore((s) => s.undoEdit)
  const redoEdit = useStore((s) => s.redoEdit)

  // Fades with the transport pill while a song plays and the pointer is idle, and steps aside for a take.
  const idleHidden = useChromeHidden()
  const takeInProgress = useTakeInProgress()
  const setupOpen = useHandVideoSetupOpen()
  const chromeHidden = idleHidden || takeInProgress || setupOpen
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
              <Popover placement="end top" className="rounded-[14px]">
                <DemoList onLoad={actions.onLoadDemo} />
              </Popover>
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
          <MenuItem onAction={actions.onImportVideo}>
            {t('file.addHandVideo')}
          </MenuItem>
          <MenuItem isDisabled={!hasSong || splitRunning} onAction={actions.onSplitHands}>
            {t('file.splitHands')}
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

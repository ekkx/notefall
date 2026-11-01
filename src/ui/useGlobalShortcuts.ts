import { useEffect } from 'react'
import i18n from '../i18n'
import { togglePlayback } from '../audio/playback'
import { toggleRecord } from '../audio/recordControl'
import { openProject, saveProject, saveProjectAs } from '../projects/actions'
import { useStore } from '../store'
import { deleteNotes, moveNotes } from '../midi/edit'
import { showAlert } from './confirm'
import { useShell } from './shell/uiState'

/**
 * Window-level keyboard shortcuts for the app's most common actions.
 * Mounted once from Layout so the listeners exist for the whole session.
 *
 * Always-on shortcuts (any transport state):
 *   Shift+R         — toggle recording (start / stop)
 *   Space           — toggle song playback (play / pause).
 *                     Attached on the CAPTURE phase so it always wins
 *                     against react-aria buttons that swallow Space in
 *                     their own onPress handler (Tab+Space would
 *                     otherwise activate the focused button instead of
 *                     toggling playback). Use Enter to activate buttons.
 *   Cmd/Ctrl + O          — open project (file picker). Confirms first
 *                           when there are unsaved changes.
 *   Cmd/Ctrl + S          — save project (overwrite current file when one
 *                           exists; otherwise opens Save As). Capture-phase
 *                           too, so the shortcut works even when a
 *                           react-aria button has focus.
 *   Cmd/Ctrl + Shift + S  — Save As (always opens the picker / triggers a
 *                           download depending on browser support).
 *   Cmd/Ctrl + B          — toggle the bottom Timeline editor panel.
 *   ?                     — open / close the keyboard shortcut sheet.
 *
 * Edit-mode shortcuts (song loaded AND not playing):
 *   Escape                  — clear selection (closes the selection card)
 *   Cmd/Ctrl + Z            — undo last edit
 *   Cmd/Ctrl + Shift + Z    — redo
 *   Ctrl + Y                — redo (Windows convention)
 *
 * Selection-dependent (no-op when nothing is selected):
 *   Delete / Backspace      — delete selected notes
 *   ↑ / ↓                   — nudge pitch ±1 semitone
 *   ← / →                   — nudge time ±0.05 s
 *
 * Velocity is not on this list — it's edited in the selection card beside
 * the selected notes (SelectionCard.tsx).
 *
 * Why Shift+R rather than plain R: 'R' is bound in PC_KEY_NOTES to F4 for
 * playing notes via the laptop keyboard. The Shift prefix turns it into a
 * dedicated shortcut without breaking the piano keymap; Keyboard.tsx
 * skips on shiftKey so there's no double-fire.
 *
 * Skipped when:
 *   - focus is on an editable element (input, textarea, contenteditable),
 *     so the user can type freely in name fields without triggering them
 *   - for the always-on group, any non-Shift modifier is held (the user
 *     is mid-system-shortcut, don't hijack)
 */

const TIME_NUDGE_SEC = 0.05

export function useGlobalShortcuts(): void {
  useEffect(() => {
    // Only TEXT-entry surfaces should swallow global shortcuts. react-aria
    // wraps Switch / Checkbox / Slider / etc. around hidden `<input>`s
    // (type=checkbox / radio / range), so a plain INPUT check would mean
    // toggling a switch traps focus on its hidden checkbox and the next
    // Cmd+Z silently gets consumed instead of triggering undo. Filter
    // INPUT by type so only text-entering ones block.
    const TEXT_INPUT_TYPES = new Set([
      'text', 'search', 'email', 'url', 'tel', 'password', 'number',
      'date', 'datetime-local', 'month', 'time', 'week',
    ])
    const isEditable = (el: EventTarget | null): boolean => {
      if (!(el instanceof HTMLElement)) return false
      const tag = el.tagName
      if (tag === 'TEXTAREA' || el.isContentEditable) return true
      if (tag === 'INPUT') {
        const type = (el as HTMLInputElement).type.toLowerCase()
        return TEXT_INPUT_TYPES.has(type)
      }
      return false
    }

    const inEditMode = (): boolean => {
      const s = useStore.getState()
      return s.song !== null && s.transport !== 'playing'
    }

    // Capture-phase Space handler. Lives on its own listener so the
    // edit-mode shortcuts below stay in the bubble phase (where they
    // don't interfere with focused widgets that legitimately consume
    // those keys — react-aria sliders use ArrowUp/Down for value
    // adjustment, for example).
    const onSpaceCapture = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      if (e.repeat || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return
      if (isEditable(e.target)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      void togglePlayback()
    }

    // Capture-phase Cmd/Ctrl+S — same rationale as Space (must beat the
    // browser's native Save Page dialog AND any focused react-aria button
    // that might otherwise consume the key event). Cmd+Shift+S = Save As.
    const onSaveCapture = (e: KeyboardEvent) => {
      if (e.code !== 'KeyS') return
      if (e.altKey) return
      if (!(e.metaKey || e.ctrlKey)) return
      if (isEditable(e.target)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      const action = e.shiftKey ? saveProjectAs : saveProject
      void action().then((result) => {
        if (result.kind === 'error') {
          void showAlert({
            title: i18n.t('dialogs:shortcut.couldNotSaveTitle'),
            message: result.message,
            tone: 'error',
          })
        }
      })
    }

    // Capture-phase Cmd/Ctrl+B — toggle the bottom TimelineEditor
    // section. Modelled after VSCode's "toggle bottom panel" (Cmd+J in
    // some editors, Cmd+B for sidebar) — we picked Cmd+B since the
    // sidebar concept is closest to what this panel does. Capture
    // phase so it wins against the browser's default (bookmark bar
    // toggle).
    const onToggleTimelineEditorCapture = (e: KeyboardEvent) => {
      if (e.code !== 'KeyB') return
      if (e.altKey || e.shiftKey) return
      if (!(e.metaKey || e.ctrlKey)) return
      if (isEditable(e.target)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      const s = useStore.getState()
      s.updateSettings({ timelineEditorOpen: !s.settings.timelineEditorOpen })
    }

    // Capture-phase Cmd/Ctrl+O — overrides the browser's "Open File"
    // dialog (which would otherwise let the user open arbitrary files
    // into the tab and navigate away from notefall). `openProject`
    // handles the dirty-confirm internally.
    const onOpenCapture = (e: KeyboardEvent) => {
      if (e.code !== 'KeyO') return
      if (e.altKey || e.shiftKey) return
      if (!(e.metaKey || e.ctrlKey)) return
      if (isEditable(e.target)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      void openProject().then((result) => {
        if (result.kind === 'error') {
          void showAlert({
            title: result.title ?? i18n.t('dialogs:shortcut.couldNotOpenFileTitle'),
            message: result.message,
            tone: 'error',
          })
        }
      })
    }

    // Warn before navigating away whenever there are unsaved changes —
    // even for unnamed (post-New) sessions, since reloading away from a
    // dirty Untitled project loses the work just as much as a named
    // one. Earlier we gated on `currentFile !== null` to spare unnamed
    // sessions, but that made New-then-edit silently lose work; the
    // `dirty` flag itself is already specific enough — a fresh page
    // load with no edits stays clean and won't prompt.
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const { dirty } = useStore.getState()
      if (dirty) {
        e.preventDefault()
        // Required for some older browsers; modern ones ignore the string.
        e.returnValue = ''
      }
    }

    const onKey = async (e: KeyboardEvent) => {
      if (isEditable(e.target)) return

      // --- always-on record shortcut (Space is handled separately above) ---
      if (!e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.code === 'KeyR' && e.shiftKey) {
          e.preventDefault()
          void toggleRecord()
          return
        }
      }

      if (!e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey && e.key === '?') {
        e.preventDefault()
        // ? opens the sheet and closes it again
        const shell = useShell.getState()
        shell.setShortcutsOpen(!shell.shortcutsOpen)
        return
      }

      // Undo / redo run regardless of edit mode — the history mixes song
      // edits with inspector-settings edits, and the latter happen during
      // playback / before any song is loaded too. Cmd on Mac, Ctrl
      // elsewhere; handle both so muscle memory works on either platform.
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.code === 'KeyZ') {
        e.preventDefault()
        const s = useStore.getState()
        if (e.shiftKey) s.redoEdit()
        else s.undoEdit()
        return
      }
      if (mod && e.code === 'KeyY' && !e.shiftKey) {
        e.preventDefault()
        useStore.getState().redoEdit()
        return
      }

      // --- edit-mode shortcuts ---
      if (!inEditMode()) return
      const state = useStore.getState()

      // Escape: clear selection (which also closes the selection card).
      if (e.code === 'Escape' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (state.selection.size > 0) {
          e.preventDefault()
          state.clearSelection()
        }
        return
      }

      // Everything below operates on the current selection.
      if (state.selection.size === 0) return

      if (e.code === 'Delete' || e.code === 'Backspace') {
        e.preventDefault()
        if (!state.song) return
        const next = deleteNotes(state.song, state.selection)
        if (next === state.song) return
        state.applySongEdit(next)
        // Drop the selection — its ids no longer exist in the song.
        state.replaceSelection([])
        return
      }

      // Pitch / time nudges. e.repeat is allowed so holding the key
      // continues to nudge — but only with no other modifier held so the
      // gesture doesn't collide with browser shortcuts.
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (!state.song) return

      if (e.code === 'ArrowUp') {
        e.preventDefault()
        state.applySongEdit(moveNotes(state.song, state.selection, 0, +1))
        return
      }
      if (e.code === 'ArrowDown') {
        e.preventDefault()
        state.applySongEdit(moveNotes(state.song, state.selection, 0, -1))
        return
      }
      if (e.code === 'ArrowRight') {
        e.preventDefault()
        state.applySongEdit(moveNotes(state.song, state.selection, +TIME_NUDGE_SEC, 0))
        return
      }
      if (e.code === 'ArrowLeft') {
        e.preventDefault()
        state.applySongEdit(moveNotes(state.song, state.selection, -TIME_NUDGE_SEC, 0))
        return
      }
    }

    window.addEventListener('keydown', onSpaceCapture, true)
    window.addEventListener('keydown', onSaveCapture, true)
    window.addEventListener('keydown', onOpenCapture, true)
    window.addEventListener('keydown', onToggleTimelineEditorCapture, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      window.removeEventListener('keydown', onSpaceCapture, true)
      window.removeEventListener('keydown', onSaveCapture, true)
      window.removeEventListener('keydown', onOpenCapture, true)
      window.removeEventListener('keydown', onToggleTimelineEditorCapture, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [])
}

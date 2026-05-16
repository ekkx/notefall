import { audioEngine } from '../audio/engine'
import { parseMidi } from '../midi/parse'
import { serializeMidi } from '../midi/serialize'
import { useCustomTexture } from '../notes/customTexture'
import { useUserAudio } from '../audio/userAudio'
import { useHandVideo } from '../notes/handVideo'
import { useStore } from '../store'
import { showConfirm } from '../ui/confirm'
import {
  ensureExtension,
  isMidiName,
  isProjectName,
  openFromHandle,
  pack,
  saveTo,
  showOpen,
  showSaveAs,
  stripExtension,
  unpack,
} from './io'
import { addRecent, removeRecent, type RecentEntry } from './recent'
import type { FileRef, Project } from './types'
import { defaultSettings, type Settings } from '../store'

/**
 * Lenient merge of saved partial settings on top of current defaults.
 * Missing keys fill from `defaultSettings`; unknown keys drop silently
 * — that's what makes adding/removing a settings key a free change.
 * Inlined here (rather than living in a separate module) since the
 * project is pre-1.0 with no users, so we don't need a versioned
 * migration system; if a saved key is renamed in the future we'll add
 * one back at that point.
 */
function loadSettings(saved: Partial<Settings> | undefined): Settings {
  return { ...defaultSettings, ...(saved ?? {}) }
}

/**
 * Top-level project actions used by the Toolbar buttons and global
 * shortcuts (Cmd+S). They orchestrate file I/O, MIDI parse/serialize,
 * the zustand store, and the audio engine in one place so call sites
 * can stay one-liners.
 *
 * Each action returns a `Result` describing what happened — `'ok'` /
 * `'cancelled'` (user dismissed picker) / `'error'` (raised toast). The
 * Toolbar surfaces errors as inline status; the cancel case is silent.
 */

export type ActionResult =
  | { kind: 'ok' }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string; title?: string }

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message
  return 'Something went wrong'
}

function suggestedFilename(): string {
  const s = useStore.getState()
  // Explicit user-edited project name wins so Save As / new-file Save
  // both reflect a recently-typed rename even when an existing
  // currentFile is in play.
  if (s.projectName) return ensureExtension(s.projectName)
  if (s.currentFile) return s.currentFile.name
  // Prefer the loaded MIDI's filename (without .mid) as the seed; otherwise
  // a generic name. The user can rename in the Save As dialog anyway.
  if (s.song?.name) {
    const base = s.song.name.replace(/\.midi?$/i, '')
    return ensureExtension(base || 'Untitled')
  }
  return ensureExtension('Untitled')
}

function buildProjectFromState(name: string): Project {
  const s = useStore.getState()
  const tex = useCustomTexture.getState()
  const audio = useUserAudio.getState()
  const video = useHandVideo.getState()
  const now = Date.now()
  return {
    // User-edited project name takes precedence over the on-disk
    // filename so a rename without subsequent Save As still persists
    // into manifest.name.
    name: s.projectName || stripExtension(name),
    createdAt: now,
    updatedAt: now,
    settings: s.settings,
    // `preserveTracks` so per-track names (and therefore per-track
    // colours indexed by `NoteEvent.track`) survive the round-trip.
    // The user-facing "Save Song as MIDI…" download still uses the
    // single-track default — those are separate code paths.
    songMidi: s.song ? serializeMidi(s.song, { preserveTracks: true }) : null,
    // Capture the custom texture even if `noteTexture !== 'custom'` —
    // the user may have switched presets temporarily and we don't want
    // to drop their image on save. The noteTexture setting is what
    // controls *display*; the bytes are kept available either way.
    customTexture:
      tex.fileBytes && tex.fileMime && tex.fileName
        ? { bytes: tex.fileBytes, mime: tex.fileMime, fileName: tex.fileName }
        : null,
    userAudio:
      audio.fileBytes && audio.fileMime && audio.fileName
        ? {
            bytes: audio.fileBytes,
            mime: audio.fileMime,
            fileName: audio.fileName,
          }
        : null,
    // Same rationale as customTexture — keep the (normalised) video
    // bytes even when the overlay is toggled off so a save doesn't
    // drop the user's clip.
    handVideo:
      video.fileBytes && video.fileMime && video.fileName
        ? {
            bytes: video.fileBytes,
            mime: video.fileMime,
            fileName: video.fileName,
          }
        : null,
  }
}

// ───────── Open ─────────

async function confirmDiscardIfDirty(messagePrefix: string, confirmLabel: string): Promise<boolean> {
  if (!useStore.getState().dirty) return true
  return showConfirm({
    title: 'Discard unsaved changes?',
    message: `${messagePrefix} Unsaved edits will be lost.`,
    confirmLabel,
    cancelLabel: 'Cancel',
    destructive: true,
  })
}

/**
 * Shared "I have a project's bytes + a FileRef, apply it to the
 * session" path. Used by both `openProject` (file picker) and
 * `openRecent` (handle from the recents list) so the unpack / migrate /
 * audio sync / recent-list update logic stays in one place.
 */
/**
 * Apply a raw MIDI file's bytes — replaces the loaded song while
 * leaving settings and the custom texture alone (the user opened a
 * MIDI, not a whole project). `ref` is recorded so the title bar can
 * show the filename, but `currentFile` stays null since `Save` /
 * `Save As` always produce `.nfz`, never `.mid`.
 */
async function applyOpenedMidi(buf: ArrayBuffer, name: string): Promise<ActionResult> {
  let parsed
  try {
    parsed = await parseMidi(buf, name)
  } catch (e) {
    return {
      kind: 'error',
      title: 'Could not load MIDI',
      message: `"${name}" could not be parsed.\n\n${describeError(e)}`,
    }
  }
  // Seed projectName from the MIDI filename (minus extension) so a
  // subsequent Save As suggests something meaningful instead of
  // "Untitled". setSong marks dirty, so this load reads as unsaved
  // work the user must explicitly Save / Save As — same as before.
  // If the user has already typed a custom projectName for the
  // current session, keep it: opening a MIDI replaces only the song,
  // so a name they intentionally chose shouldn't be clobbered.
  const existing = useStore.getState().projectName
  const seedName = name.replace(/\.midi?$/i, '') || 'Untitled'
  useStore.getState().setSong(parsed)
  if (!existing) useStore.setState({ projectName: seedName })
  audioEngine.loadSong(parsed)
  useStore.getState().setTransport('stopped')
  return { kind: 'ok' }
}

async function applyOpenedProject(buf: ArrayBuffer, ref: FileRef | null): Promise<ActionResult> {
  let project: Project
  try {
    project = await unpack(buf)
  } catch (e) {
    return { kind: 'error', message: describeError(e) }
  }

  const settings = loadSettings(project.settings)

  let song = null
  if (project.songMidi) {
    try {
      song = await parseMidi(project.songMidi, project.name)
    } catch (e) {
      return { kind: 'error', message: `MIDI parse failed: ${describeError(e)}` }
    }
  }

  useStore.getState().loadProject(settings, song, ref, project.name)
  if (song) audioEngine.loadSong(song)
  else audioEngine.unloadSong()
  useStore.getState().setTransport('stopped')

  // Restore (or clear) the custom texture image. Goes through the
  // dedicated `setFromBytes` / `clearFromLoad` paths so it doesn't
  // re-mark the just-loaded project as dirty.
  if (project.customTexture) {
    void useCustomTexture
      .getState()
      .setFromBytes(project.customTexture.bytes, project.customTexture.mime, project.customTexture.fileName)
  } else {
    useCustomTexture.getState().clearFromLoad()
  }

  // Same pattern for the user-provided accompaniment audio. The decode
  // is async (non-trivial for MP3s); we fire-and-forget so the rest of
  // the project loads immediately. The Layout-level effect that syncs
  // the AudioBuffer into the engine picks it up once decoding finishes.
  if (project.userAudio) {
    void useUserAudio
      .getState()
      .setFromBytes(project.userAudio.bytes, project.userAudio.mime, project.userAudio.fileName)
  } else {
    useUserAudio.getState().clearFromLoad()
  }

  // And the hand video. Bytes are already H.264-normalised at import
  // time, so rehydration is a plain decode (no transcode on load).
  if (project.handVideo) {
    void useHandVideo
      .getState()
      .setFromBytes(project.handVideo.bytes, project.handVideo.mime, project.handVideo.fileName)
  } else {
    useHandVideo.getState().clearFromLoad()
  }

  // Move-to-top in the recents list. No-op on browsers without FSA
  // (ref.handle === null), see `recent.ts`. Skipped entirely for demo
  // loads (ref === null) — bundled demos aren't user files and
  // shouldn't pollute the recents menu.
  if (ref) void addRecent(ref)

  return { kind: 'ok' }
}

/**
 * Show the unified Open picker — accepts both `.nfz` projects and raw
 * MIDI files — and dispatches to the right loader by filename. `.nfz`
 * replaces the whole session (settings + song + texture); `.mid`
 * replaces only the loaded song.
 *
 * Gates on the `dirty` flag via the in-app confirm modal — opening a
 * file is destructive (it discards in-session edits) so we don't
 * proceed silently. Single source of truth so Toolbar + Cmd+O behave
 * identically.
 */
export async function openProject(): Promise<ActionResult> {
  const proceed = await confirmDiscardIfDirty(
    'Opening a file will replace the current session.',
    'Discard & Open',
  )
  if (!proceed) return { kind: 'cancelled' }

  let opened: Awaited<ReturnType<typeof showOpen>>
  try {
    opened = await showOpen()
  } catch (e) {
    return { kind: 'error', message: describeError(e) }
  }
  if (!opened) return { kind: 'cancelled' }

  if (isMidiName(opened.ref.name)) {
    return applyOpenedMidi(opened.buf, opened.ref.name)
  }
  return applyOpenedProject(opened.buf, opened.ref)
}

/**
 * Apply a file the caller already has in hand (e.g. from a drag-and-drop
 * into the canvas). Dispatches to the project or MIDI loader by
 * filename. Same dirty-confirm + apply pipeline as `openProject`, but
 * skips the picker. `handle` ends up null since dropped files don't
 * carry an FSA write handle — `Save` therefore falls through to
 * `Save As` until the user picks a destination.
 */
export async function openProjectFromFile(file: File): Promise<ActionResult> {
  const proceed = await confirmDiscardIfDirty(
    `Opening "${file.name}" will replace the current session.`,
    'Discard & Open',
  )
  if (!proceed) return { kind: 'cancelled' }

  let buf: ArrayBuffer
  try {
    buf = await file.arrayBuffer()
  } catch (e) {
    return { kind: 'error', message: describeError(e) }
  }
  if (isMidiName(file.name)) {
    return applyOpenedMidi(buf, file.name)
  }
  if (isProjectName(file.name)) {
    return applyOpenedProject(buf, { name: file.name, handle: null })
  }
  return {
    kind: 'error',
    message: `Unsupported file type: "${file.name}". Drop a .nfz or .mid/.midi file.`,
  }
}

/**
 * Reopen a project from a Recent Files entry. Same flow as `openProject`
 * but skips the picker and the dirty-confirm uses a slightly different
 * label. If the handle is stale (file moved / deleted / permission
 * denied), the entry is dropped from the recents list so the menu
 * doesn't keep showing dead items.
 */
export async function openRecent(entry: RecentEntry): Promise<ActionResult> {
  const proceed = await confirmDiscardIfDirty(
    `Opening "${entry.name}" will replace the current session.`,
    'Discard & Open',
  )
  if (!proceed) return { kind: 'cancelled' }

  const opened = await openFromHandle(entry.handle)
  if (!opened) {
    removeRecent(entry.id)
    return {
      kind: 'error',
      message: `Could not open "${entry.name}". The file may have been moved, deleted, or permission denied.`,
    }
  }

  return applyOpenedProject(opened.buf, opened.ref)
}

// ───────── Demo ─────────

/**
 * Load a bundled `.nfz` demo project from a static URL. Same dirty
 * confirm + apply pipeline as `openProjectFromFile`, but the project
 * loads with `currentFile = null` so it doesn't appear "saved" — Save
 * falls through to Save As, letting the user fork the demo into their
 * own file. Demos are not added to the recents list.
 */
export async function loadDemoProject(label: string, url: string): Promise<ActionResult> {
  const proceed = await confirmDiscardIfDirty(
    `Loading the "${label}" demo will replace the current session.`,
    'Discard & Load',
  )
  if (!proceed) return { kind: 'cancelled' }

  let buf: ArrayBuffer
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    buf = await res.arrayBuffer()
  } catch (e) {
    return { kind: 'error', message: `Could not load demo: ${describeError(e)}` }
  }
  return applyOpenedProject(buf, null)
}

// ───────── Save / Save As ─────────

/**
 * Save to the current file. On FSA browsers this overwrites without a
 * prompt; if there's no `currentFile` (or its handle isn't usable) we
 * fall through to Save As. On non-FSA browsers Save and Save As are the
 * same operation (a fresh download).
 */
export async function saveProject(): Promise<ActionResult> {
  const s = useStore.getState()
  if (s.currentFile?.handle) {
    const project = buildProjectFromState(s.currentFile.name)
    const blob = pack(project)
    const ok = await saveTo(s.currentFile.handle, blob)
    if (ok) {
      useStore.getState().markClean()
      // Bump the recents entry so this just-saved file moves to the top.
      void addRecent(s.currentFile)
      return { kind: 'ok' }
    }
    // Handle stale (file moved, permission denied, etc.) — fall through.
  }
  return saveProjectAs()
}

/**
 * Always show the Save As picker. On FSA browsers this captures a fresh
 * handle for subsequent Save calls; on the fallback path it's a download.
 */
export async function saveProjectAs(): Promise<ActionResult> {
  const suggested = suggestedFilename()
  const project = buildProjectFromState(suggested)
  const blob = pack(project)
  let ref: Awaited<ReturnType<typeof showSaveAs>>
  try {
    ref = await showSaveAs(suggested, blob)
  } catch (e) {
    return { kind: 'error', message: describeError(e) }
  }
  if (!ref) return { kind: 'cancelled' }
  useStore.getState().setCurrentFile(ref)
  useStore.getState().markClean()
  void addRecent(ref)
  return { kind: 'ok' }
}

// ───────── New ─────────

/**
 * Reset to a blank session — defaults settings, no song, no associated
 * file. Same dirty-confirm contract as `openProject`: prompts before
 * discarding unsaved work so call sites (menu / future shortcut) don't
 * each have to reimplement the gate.
 */
export async function newProject(): Promise<ActionResult> {
  if (useStore.getState().dirty) {
    const ok = await showConfirm({
      title: 'Discard unsaved changes?',
      message: 'Starting a new project will discard the current session. Unsaved edits will be lost.',
      confirmLabel: 'Discard & New',
      cancelLabel: 'Cancel',
      destructive: true,
    })
    if (!ok) return { kind: 'cancelled' }
  }
  useStore.getState().newProject()
  audioEngine.unloadSong()
  useStore.getState().setTransport('stopped')
  // Drop any image carried over from the previous session — a fresh
  // project shouldn't inherit the previous look's texture.
  useCustomTexture.getState().clearFromLoad()
  // Same for accompaniment audio — a fresh project starts with no
  // user audio attached.
  useUserAudio.getState().clearFromLoad()
  // And the hand video.
  useHandVideo.getState().clearFromLoad()
  return { kind: 'ok' }
}

// ───────── Import audio ─────────

/**
 * Apply a user-provided accompaniment audio file to the current
 * session. Unlike Open Project / Open MIDI this does NOT replace the
 * loaded song — it attaches alongside the existing MIDI so the user
 * can sync the two via the timeline. Marks the project dirty.
 */
export async function importUserAudio(file: File): Promise<ActionResult> {
  // Audio is an *accompaniment* to a MIDI track — there's no point
  // loading it standalone (there's nothing to sync against, and the
  // timeline editor only exposes the audio lane while a song is
  // loaded). Refuse early with a clear message instead of decoding
  // a buffer that would never play.
  if (!useStore.getState().song) {
    return {
      kind: 'error',
      title: 'Load a MIDI file first',
      message:
        'Audio can only be loaded as accompaniment for a MIDI track. Open or record a MIDI file before importing audio.',
    }
  }
  try {
    await useUserAudio.getState().setFromFile(file)
  } catch (e) {
    return {
      kind: 'error',
      title: 'Could not load audio',
      message: `"${file.name}" could not be decoded.\n\n${describeError(e)}`,
    }
  }
  return { kind: 'ok' }
}

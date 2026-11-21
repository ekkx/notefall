import i18n from '../i18n'
import { audioEngine } from '../audio/engine'
import { parseMidi } from '../midi/parse'
import { serializeMidi } from '../midi/serialize'
import { applyNoteHands, collectNoteHands } from '../midi/noteHands'
import { useCustomTexture } from '../notes/customTexture'
import { useStageBackground } from '../scene/stageBackground'
import { AUDIO_EXTENSIONS, isAudioName, useUserAudio } from '../audio/userAudio'
import { HandVideoError, HandVideoLoadSuperseded, VIDEO_EXTENSIONS, hasVideoTrack, isVideoName, useHandVideo } from '../video/handVideo'
import { autoPlaceHandVideo } from '../video/autoplace'
import { captureHandVideoBaseline, openHandVideoSetup } from '../video/setup'
import { validKeys } from '../video/geometry'
import { useStore } from '../store'
import { track } from '../usage'
import type { SongSource } from '../usage/events'
import { showAlert, showConfirm } from '../ui/confirm'
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
  // Copy only keys the current build knows: a plain spread would carry
  // removed / renamed keys along in memory and write them back on save.
  const known: Partial<Settings> = {}
  for (const key of Object.keys(saved ?? {}) as (keyof Settings)[]) {
    if (key in defaultSettings) (known as Record<string, unknown>)[key] = saved![key]
  }
  return { ...defaultSettings, ...known }
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
  return i18n.t('dialogs:actions.somethingWentWrong')
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

async function buildProjectFromState(name: string): Promise<Project> {
  const s = useStore.getState()
  const tex = useCustomTexture.getState()
  const background = useStageBackground.getState()
  const audio = useUserAudio.getState()
  const video = useHandVideo.getState()
  const now = Date.now()
  const videoBytes = video.blob ? new Uint8Array(await video.blob.arrayBuffer()) : null
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
    // Hands / fingers aren't representable in the SMF; they ride in the manifest.
    noteHands: s.song ? collectNoteHands(s.song) : null,
    // Capture the custom texture even if `noteTexture !== 'custom'` —
    // the user may have switched presets temporarily and we don't want
    // to drop their image on save. The noteTexture setting is what
    // controls *display*; the bytes are kept available either way.
    customTexture:
      tex.fileBytes && tex.fileMime && tex.fileName
        ? { bytes: tex.fileBytes, mime: tex.fileMime, fileName: tex.fileName }
        : null,
    stageBackground:
      background.fileBytes && background.fileMime && background.fileName
        ? {
            bytes: background.fileBytes,
            mime: background.fileMime,
            fileName: background.fileName,
          }
        : null,
    userAudio:
      audio.fileBytes && audio.fileMime && audio.fileName
        ? {
            bytes: audio.fileBytes,
            mime: audio.fileMime,
            fileName: audio.fileName,
          }
        : null,
    handVideo:
      videoBytes && video.fileName && video.mime
        ? { bytes: videoBytes, mime: video.mime, fileName: video.fileName }
        : null,
  }
}

// ───────── Open ─────────

async function confirmDiscardIfDirty(messagePrefix: string, confirmLabel: string): Promise<boolean> {
  if (!useStore.getState().dirty) return true
  return showConfirm({
    title: i18n.t('dialogs:actions.discardTitle'),
    message: i18n.t('dialogs:actions.discardMessage', { prefix: messagePrefix }),
    confirmLabel,
    cancelLabel: i18n.t('dialogs:actions.cancel'),
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
async function applyOpenedMidi(
  buf: ArrayBuffer,
  name: string,
  source: SongSource,
): Promise<ActionResult> {
  let parsed
  try {
    parsed = await parseMidi(buf, name)
  } catch (e) {
    track('error_surfaced', { context: 'midi_parse' })
    return {
      kind: 'error',
      title: i18n.t('dialogs:actions.couldNotLoadMidiTitle'),
      message: i18n.t('dialogs:actions.couldNotLoadMidiMessage', {
        name,
        detail: describeError(e),
      }),
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
  // Opening a different MIDI: drop the previous song's pins / clip
  // length / speed (they're keyed to the old timeline). Inspector
  // look is kept.
  useStore.getState().setSong(parsed, { resetTimeline: true })
  if (!existing) useStore.setState({ projectName: seedName })
  audioEngine.loadSong(parsed)
  useStore.getState().setTransport('stopped')
  track('song_opened', { source })
  return { kind: 'ok' }
}

async function applyOpenedProject(
  buf: ArrayBuffer,
  ref: FileRef | null,
  source: SongSource,
): Promise<ActionResult> {
  let project: Project
  try {
    project = await unpack(buf)
  } catch (e) {
    track('error_surfaced', { context: 'project_open' })
    return { kind: 'error', message: describeError(e) }
  }

  const settings = loadSettings(project.settings)

  let song = null
  if (project.songMidi) {
    try {
      song = applyNoteHands(await parseMidi(project.songMidi, project.name), project.noteHands)
    } catch (e) {
      track('error_surfaced', { context: 'midi_parse' })
      return {
        kind: 'error',
        message: i18n.t('dialogs:actions.midiParseFailed', { detail: describeError(e) }),
      }
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

  // Clear first so a corrupt replacement cannot leave the previous
  // project's image visible. Decoding then restores the new asset
  // asynchronously; failure falls back to the solid background colour.
  const backgroundStore = useStageBackground.getState()
  backgroundStore.clearFromLoad()
  if (project.stageBackground) {
    void backgroundStore
      .setFromBytes(
        project.stageBackground.bytes,
        project.stageBackground.mime,
        project.stageBackground.fileName,
      )
      .catch((e) => {
        track('error_surfaced', { context: 'stage_background' })
        void showAlert({
          title: i18n.t('inspector:backgroundImage.loadErrorTitle'),
          message: i18n.t('inspector:backgroundImage.loadErrorMessage', {
            name: project.stageBackground?.fileName ?? '',
            detail: describeError(e),
          }),
          tone: 'error',
        })
      })
  }

  // Same pattern for the user-provided accompaniment audio. The decode
  // is async (non-trivial for MP3s); we fire-and-forget so the rest of
  // the project loads immediately. The Layout-level effect that syncs
  // the AudioBuffer into the engine picks it up once decoding finishes.
  // Every opened project, a bundled demo included, is a different take: the hand video on screen goes with the old one.
  useHandVideo.getState().clear()
  if (project.userAudio) {
    void useUserAudio
      .getState()
      .setFromBytes(project.userAudio.bytes, project.userAudio.mime, project.userAudio.fileName)
  } else {
    useUserAudio.getState().clearFromLoad()
  }
  if (project.handVideo) {
    const { bytes, mime, fileName } = project.handVideo
    void useHandVideo
      .getState()
      .load(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }), fileName, mime)
      .then(() => {
        // A project saved before the keyboard detector has no usable placement: find it again.
        if (validKeys(useStore.getState().settings.handVideoKeys).length === 0) void autoPlaceHandVideo({ keepDirty: true })
      })
      .catch((e) => {
        // Another project was opened meanwhile: this video is no longer wanted.
        if (e instanceof HandVideoLoadSuperseded) return
        // Undecodable here (e.g. HEVC): keep the file so Save still writes it, and say so.
        useHandVideo.getState().keepUndecodable(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }), fileName, mime)
        track('error_surfaced', { context: 'hand_video' })
        void showAlert({
          title: i18n.t('video:error.loadTitle'),
          message: describeHandVideoError(e, fileName),
          tone: 'error',
        })
      })
  }

  // Move-to-top in the recents list. No-op on browsers without FSA
  // (ref.handle === null), see `recent.ts`. Skipped entirely for demo
  // loads (ref === null) — bundled demos aren't user files and
  // shouldn't pollute the recents menu.
  if (ref) void addRecent(ref)

  track('song_opened', { source })
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
  let opened: Awaited<ReturnType<typeof showOpen>>
  try {
    opened = await showOpen()
  } catch (e) {
    return { kind: 'error', message: describeError(e) }
  }
  if (!opened) return { kind: 'cancelled' }

  // Audio and video are added to the current song (accompaniment / hand
  // video) rather than replacing the session, so they skip the discard
  // prompt. That prompt therefore runs after the pick (we only know the
  // type then).
  if (await isHandVideoFile(opened.file)) return importHandVideo(opened.file)
  if (isAudioName(opened.ref.name)) return importUserAudio(opened.file)

  const proceed = await confirmDiscardIfDirty(
    i18n.t('dialogs:actions.openReplace'),
    i18n.t('dialogs:actions.discardAndOpen'),
  )
  if (!proceed) return { kind: 'cancelled' }

  let buf: ArrayBuffer
  try {
    buf = await opened.file.arrayBuffer()
  } catch (e) {
    return { kind: 'error', message: describeError(e) }
  }
  if (isMidiName(opened.ref.name)) {
    return applyOpenedMidi(buf, opened.ref.name, 'midi_file')
  }
  return applyOpenedProject(buf, opened.ref, 'project')
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
    i18n.t('dialogs:actions.openReplaceNamed', { name: file.name }),
    i18n.t('dialogs:actions.discardAndOpen'),
  )
  if (!proceed) return { kind: 'cancelled' }

  let buf: ArrayBuffer
  try {
    buf = await file.arrayBuffer()
  } catch (e) {
    return { kind: 'error', message: describeError(e) }
  }
  if (isMidiName(file.name)) {
    return applyOpenedMidi(buf, file.name, 'drop')
  }
  if (isProjectName(file.name)) {
    return applyOpenedProject(buf, { name: file.name, handle: null }, 'drop')
  }
  return {
    kind: 'error',
    message: i18n.t('dialogs:actions.unsupportedFileType', { name: file.name }),
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
    i18n.t('dialogs:actions.openReplaceNamed', { name: entry.name }),
    i18n.t('dialogs:actions.discardAndOpen'),
  )
  if (!proceed) return { kind: 'cancelled' }

  const opened = await openFromHandle(entry.handle)
  if (!opened) {
    removeRecent(entry.id)
    track('error_surfaced', { context: 'project_open' })
    return {
      kind: 'error',
      message: i18n.t('dialogs:actions.couldNotOpenNamed', { name: entry.name }),
    }
  }

  return applyOpenedProject(opened.buf, opened.ref, 'recent')
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
    i18n.t('dialogs:actions.loadDemoReplace', { label }),
    i18n.t('dialogs:actions.discardAndLoad'),
  )
  if (!proceed) return { kind: 'cancelled' }

  let buf: ArrayBuffer
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    buf = await res.arrayBuffer()
  } catch (e) {
    track('error_surfaced', { context: 'demo_load' })
    return {
      kind: 'error',
      message: i18n.t('dialogs:actions.couldNotLoadDemo', { detail: describeError(e) }),
    }
  }
  track('demo_loaded', { demo_label: label })
  return applyOpenedProject(buf, null, 'demo')
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
    const project = await buildProjectFromState(s.currentFile.name)
    const blob = pack(project)
    const ok = await saveTo(s.currentFile.handle, blob)
    if (ok) {
      useStore.getState().markClean()
      // Bump the recents entry so this just-saved file moves to the top.
      void addRecent(s.currentFile)
      track('project_saved', { mode: 'save' })
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
  const project = await buildProjectFromState(suggested)
  const blob = pack(project)
  let ref: Awaited<ReturnType<typeof showSaveAs>>
  try {
    ref = await showSaveAs(suggested, blob)
  } catch (e) {
    track('error_surfaced', { context: 'save' })
    return { kind: 'error', message: describeError(e) }
  }
  if (!ref) return { kind: 'cancelled' }
  useStore.getState().setCurrentFile(ref)
  useStore.getState().markClean()
  void addRecent(ref)
  track('project_saved', { mode: 'save_as' })
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
      title: i18n.t('dialogs:actions.newDiscardTitle'),
      message: i18n.t('dialogs:actions.newDiscardMessage'),
      confirmLabel: i18n.t('dialogs:actions.discardAndNew'),
      cancelLabel: i18n.t('dialogs:actions.cancel'),
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
  // Background imagery is project content too — a fresh project must not
  // inherit the previous session's stage.
  useStageBackground.getState().clearFromLoad()
  // Same for accompaniment audio — a fresh project starts with no
  // user audio attached.
  useUserAudio.getState().clearFromLoad()
  useHandVideo.getState().clear()
  track('project_new')
  return { kind: 'ok' }
}

// ───────── Import audio ─────────

/**
 * Apply a user-provided accompaniment audio file to the current
 * session. Unlike Open Project / Open MIDI this does NOT replace the
 * loaded song — it attaches alongside the existing MIDI so the user
 * can sync the two via the timeline. Marks the project dirty.
 */
/**
 * Pick an audio file and add it as the current song's accompaniment.
 * Uses a vanilla `<input type="file">` because callers sit inside
 * react-aria MenuItems / plain buttons where `FileTrigger` doesn't nest.
 * On Safari/Firefox a cancelled dialog never resolves — harmless, since
 * nothing waits on it.
 */
export async function pickAndImportUserAudio(): Promise<ActionResult> {
  const file = await new Promise<File | null>((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    // Extensions only: `audio/*` also matches MIDI (`audio/midi`).
    input.accept = AUDIO_EXTENSIONS.join(',')
    input.onchange = () => resolve(input.files?.[0] ?? null)
    input.click()
  })
  if (!file) return { kind: 'cancelled' }
  return importUserAudio(file)
}

export async function importUserAudio(file: File): Promise<ActionResult> {
  // Audio is an *accompaniment* to a MIDI track — there's no point
  // loading it standalone (there's nothing to sync against, and the
  // timeline editor only exposes the audio lane while a song is
  // loaded). Refuse early with a clear message instead of decoding
  // a buffer that would never play.
  if (!useStore.getState().song) {
    return {
      kind: 'error',
      title: i18n.t('dialogs:actions.loadMidiFirstTitle'),
      message: i18n.t('dialogs:actions.loadMidiFirstMessage'),
    }
  }
  if (!isAudioName(file.name)) {
    return {
      kind: 'error',
      title: i18n.t('dialogs:actions.couldNotLoadAudioTitle'),
      message: i18n.t('dialogs:actions.notAudioFile', { name: file.name }),
    }
  }
  try {
    await useUserAudio.getState().setFromFile(file)
  } catch (e) {
    track('error_surfaced', { context: 'import_audio' })
    return {
      kind: 'error',
      title: i18n.t('dialogs:actions.couldNotLoadAudioTitle'),
      message: i18n.t('dialogs:actions.couldNotLoadAudioMessage', {
        name: file.name,
        detail: describeError(e),
      }),
    }
  }
  track('custom_audio_imported')
  return { kind: 'ok' }
}

// ───────── Hand video ─────────

/** A file to treat as a hand video: a video extension, and for `.webm` (also audio) a video track. */
export async function isHandVideoFile(file: File): Promise<boolean> {
  if (!isVideoName(file.name)) return false
  if (!/\.webm$/i.test(file.name)) return true
  return hasVideoTrack(file)
}

function describeHandVideoError(e: unknown, name: string): string {
  if (e instanceof HandVideoError && e.reason === 'noVideoTrack') {
    return i18n.t('video:error.noVideoTrack', { name })
  }
  if (e instanceof HandVideoError && e.reason === 'cannotPlay') {
    return i18n.t('video:error.cannotPlay', { name })
  }
  return i18n.t('video:error.loadMessage', { name, detail: describeError(e) })
}

const HAND_VIDEO_KEYBOARD_Y = 0.3

/** Pick a video file and add it as the hand video. */
export async function pickAndImportHandVideo(): Promise<ActionResult> {
  const file = await new Promise<File | null>((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = VIDEO_EXTENSIONS.join(',')
    input.onchange = () => resolve(input.files?.[0] ?? null)
    input.click()
  })
  if (!file) return { kind: 'cancelled' }
  return importHandVideo(file)
}

/**
 * Add a video of the player's hands. Works with or without a song (in any
 * order); the video's sound is not used. A new video starts at the
 * timeline's start with a fresh placement (the look carries over) and is
 * laid on the keys by the detector (`video/autoplace.ts`, ≈1 s, in the
 * background): keyboard-wide until it answers, and when it finds nothing.
 * The setup (`ui/HandVideoSetup.tsx`) opens over the scene at once and follows the detection (find, then
 * confirm; or the failure step); Esc there removes the video again.
 */
export async function importHandVideo(file: File): Promise<ActionResult> {
  if (useHandVideo.getState().editing) return { kind: 'cancelled' }
  try {
    await useHandVideo.getState().load(file, file.name, file.type || undefined)
  } catch (e) {
    if (e instanceof HandVideoLoadSuperseded) return { kind: 'cancelled' }
    track('error_surfaced', { context: 'hand_video' })
    return { kind: 'error', title: i18n.t('video:error.loadTitle'), message: describeHandVideoError(e, file.name) }
  }
  const store = useStore.getState()
  // Taken before the import's own edit, so Cancel returns to exactly the state before the video was added.
  const baseline = captureHandVideoBaseline()
  store.beginSettingsEdit()
  store.updateSettings({
    handVideoEnabled: true,
    handVideoOffsetSec: 0,
    handVideoTrimStartSec: 0,
    handVideoTrimEndSec: null,
    handVideoBend: defaultSettings.handVideoBend,
    handVideoKeys: defaultSettings.handVideoKeys,
    handVideoOctaveKnown: defaultSettings.handVideoOctaveKnown,
    handVideoRange: defaultSettings.handVideoRange,
    // Room below the keyboard for the hands and arms (with the keyboard at
    // the bottom edge only the keys' strip of the video shows). Left alone
    // with keyframes, where this key is animated.
    ...(store.settings.settingsKeyframes.length === 0 && store.settings.keyboardScreenY < HAND_VIDEO_KEYBOARD_Y
      ? { keyboardScreenY: HAND_VIDEO_KEYBOARD_Y }
      : {}),
  })
  store.endSettingsEdit()
  track('hand_video_added')
  void autoPlaceHandVideo()
  openHandVideoSetup('confirm', { isNew: true, baseline })
  return { kind: 'ok' }
}

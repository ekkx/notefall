import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import {
  PROJECT_FILE_DESCRIPTION,
  PROJECT_FILE_EXTENSION,
  PROJECT_MIME_TYPE,
  type FileRef,
  type Project,
  type ProjectManifest,
} from './types'

/**
 * `.nfz` zip pack/unpack + the OS file dialog plumbing on top.
 *
 * Two browser tiers:
 *   - **File System Access API** (Chrome / Edge) → `showOpenFilePicker`,
 *     `showSaveFilePicker`, `FileSystemFileHandle.createWritable()`. Save
 *     overwrites the same file in place; the handle persists in JS memory
 *     so Cmd+S works after the first Save As.
 *   - **Fallback** (Safari / Firefox) → `<input type="file">` for Open and
 *     a Blob URL + `<a download>` for Save. In this tier `Save` and
 *     `Save As` are the same operation (a fresh download every time);
 *     callers should label the affordance "Save As / Download" so the
 *     user isn't surprised.
 *
 * All picker functions return `null` on user-cancel and throw on real
 * errors so callers can pattern-match on `result === null` for the
 * common case.
 */

// ───────── Pack / Unpack ─────────

/** MIME → conventional file extension. Keep in sync with `customTexture.ts`'s
 * `guessMimeFromName` so round-trips don't accidentally drop information. */
function extFromImageMime(mime: string): string {
  switch (mime) {
    case 'image/png':
      return '.png'
    case 'image/jpeg':
      return '.jpg'
    case 'image/gif':
      return '.gif'
    case 'image/webp':
      return '.webp'
    case 'image/avif':
      return '.avif'
    default:
      return '.bin'
  }
}

/** MIME → conventional file extension for user audio. Keep in sync with
 * `userAudio.ts`'s `guessAudioMimeFromName`. */
function extFromAudioMime(mime: string): string {
  switch (mime) {
    case 'audio/mpeg':
    case 'audio/mp3':
      return '.mp3'
    case 'audio/wav':
    case 'audio/x-wav':
    case 'audio/wave':
      return '.wav'
    case 'audio/ogg':
      return '.ogg'
    case 'audio/aac':
    case 'audio/mp4':
      return '.m4a'
    case 'audio/flac':
    case 'audio/x-flac':
      return '.flac'
    case 'audio/webm':
      return '.webm'
    default:
      return '.bin'
  }
}

/** MIME → conventional file extension for the hand video. The import-time
 * normalisation in `video/transcode.ts` keeps non-H.264 input from
 * reaching here, but originals already in a web container pass through
 * with their own type, so cover the common ones. */
function extFromVideoMime(mime: string): string {
  switch (mime) {
    case 'video/mp4':
      return '.mp4'
    case 'video/quicktime':
      return '.mov'
    case 'video/webm':
      return '.webm'
    default:
      return '.bin'
  }
}

export function pack(project: Project): Blob {
  const customTextureRef = project.customTexture
    ? `note-texture${extFromImageMime(project.customTexture.mime)}`
    : null
  const userAudioRef = project.userAudio
    ? `user-audio${extFromAudioMime(project.userAudio.mime)}`
    : null
  const handVideoRef = project.handVideo
    ? `hand-video${extFromVideoMime(project.handVideo.mime)}`
    : null
  const manifest: ProjectManifest = {
    appVersion: __APP_VERSION__,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    settings: project.settings,
    songRef: project.songMidi ? 'song.mid' : null,
    customTexture:
      project.customTexture && customTextureRef
        ? {
            ref: customTextureRef,
            mime: project.customTexture.mime,
            fileName: project.customTexture.fileName,
          }
        : null,
    userAudio:
      project.userAudio && userAudioRef
        ? {
            ref: userAudioRef,
            mime: project.userAudio.mime,
            fileName: project.userAudio.fileName,
          }
        : null,
    handVideo:
      project.handVideo && handVideoRef
        ? {
            ref: handVideoRef,
            mime: project.handVideo.mime,
            fileName: project.handVideo.fileName,
          }
        : null,
  }
  const files: Zippable = {
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
  }
  if (project.songMidi) {
    files['assets/song.mid'] = new Uint8Array(project.songMidi)
  }
  if (project.customTexture && customTextureRef) {
    files[`assets/${customTextureRef}`] = new Uint8Array(project.customTexture.bytes)
  }
  if (project.userAudio && userAudioRef) {
    files[`assets/${userAudioRef}`] = new Uint8Array(project.userAudio.bytes)
  }
  if (project.handVideo && handVideoRef) {
    files[`assets/${handVideoRef}`] = new Uint8Array(project.handVideo.bytes)
  }
  const zipped = zipSync(files)
  // Copy into a fresh ArrayBuffer so Blob's typing is satisfied regardless
  // of fflate's `Uint8Array<ArrayBufferLike>` return type.
  const buf = new ArrayBuffer(zipped.length)
  new Uint8Array(buf).set(zipped)
  return new Blob([buf], { type: PROJECT_MIME_TYPE })
}

export async function unpack(buf: ArrayBuffer): Promise<Project> {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(new Uint8Array(buf))
  } catch {
    throw new Error('Not a valid notefall project (zip read failed)')
  }
  const manifestBytes = files['manifest.json']
  if (!manifestBytes) {
    throw new Error('Not a valid notefall project (missing manifest.json)')
  }
  let raw: unknown
  try {
    raw = JSON.parse(strFromU8(manifestBytes))
  } catch {
    throw new Error('Not a valid notefall project (manifest.json is not JSON)')
  }
  if (!raw || typeof raw !== 'object') {
    throw new Error('Not a valid notefall project (manifest.json is not an object)')
  }
  const manifest = raw as ProjectManifest

  // Helper for asset bytes — copies into a fresh ArrayBuffer so the
  // rest of the unzipped tree can be GC'd while only the asset is kept,
  // AND so the result is typed as a plain ArrayBuffer (not ArrayBufferLike)
  // for downstream consumers like `parseMidi` and `Blob`.
  const detach = (bytes: Uint8Array): ArrayBuffer => {
    const buf = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(buf).set(bytes)
    return buf
  }

  let songMidi: ArrayBuffer | null = null
  if (manifest.songRef) {
    const songBytes = files[`assets/${manifest.songRef}`]
    if (!songBytes) {
      throw new Error(`Project asset missing: ${manifest.songRef}`)
    }
    songMidi = detach(songBytes)
  }

  let customTexture: Project['customTexture'] = null
  if (manifest.customTexture) {
    const texBytes = files[`assets/${manifest.customTexture.ref}`]
    if (texBytes) {
      customTexture = {
        bytes: detach(texBytes),
        mime: manifest.customTexture.mime,
        fileName: manifest.customTexture.fileName,
      }
    }
    // Missing texture asset is treated as "no custom texture" rather
    // than an error — the rest of the project is still usable, and the
    // user can re-pick an image via the Inspector.
  }

  let userAudio: Project['userAudio'] = null
  if (manifest.userAudio) {
    const audioBytes = files[`assets/${manifest.userAudio.ref}`]
    if (audioBytes) {
      userAudio = {
        bytes: detach(audioBytes),
        mime: manifest.userAudio.mime,
        fileName: manifest.userAudio.fileName,
      }
    }
    // Same lenient policy as customTexture — a missing audio asset
    // doesn't fail the whole project, the user can re-import via the
    // timeline.
  }

  let handVideo: Project['handVideo'] = null
  if (manifest.handVideo) {
    const videoBytes = files[`assets/${manifest.handVideo.ref}`]
    if (videoBytes) {
      handVideo = {
        bytes: detach(videoBytes),
        mime: manifest.handVideo.mime,
        fileName: manifest.handVideo.fileName,
      }
    }
    // Same lenient policy as customTexture / userAudio — a missing
    // video asset doesn't fail the whole project.
  }

  return {
    name: manifest.name,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    settings: manifest.settings,
    songMidi,
    customTexture,
    userAudio,
    handVideo,
  }
}

// ───────── Browser capability detection ─────────

export function hasFileSystemAccess(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as any).showOpenFilePicker === 'function' &&
    typeof (window as any).showSaveFilePicker === 'function'
  )
}

// FSA accept map. The key is technically a MIME type, but the picker
// only uses the extension list to filter visible files — so we pin a
// neutral `application/octet-stream` instead of `application/zip` to
// avoid the picker offering a generic "Zip Archive" filter that would
// let unrelated .zip files through. Same reason `<input accept>` below
// holds only the extension and not `application/zip`.
const PICKER_MIME = 'application/octet-stream'
const ACCEPT_TYPES = [
  {
    description: PROJECT_FILE_DESCRIPTION,
    accept: { [PICKER_MIME]: [PROJECT_FILE_EXTENSION] },
  },
]
// Accept list for the unified Open dialog: notefall projects (`.nfz`)
// and raw MIDI files combined into a single group. Splitting them into
// two entries (one per MIME) makes the picker render two filters and
// — on macOS — grays out whichever isn't currently selected. A single
// entry with all extensions keeps both file types selectable at once.
// MIME stays neutral (`application/octet-stream`) so the picker filters
// purely by the extension list.
const OPEN_ACCEPT_TYPES = [
  {
    description: 'notefall project or MIDI',
    accept: {
      [PICKER_MIME]: [PROJECT_FILE_EXTENSION, '.mid', '.midi'],
    },
  },
]

// ───────── Open ─────────

export async function showOpen(): Promise<{ buf: ArrayBuffer; ref: FileRef } | null> {
  if (hasFileSystemAccess()) {
    let handles: FileSystemFileHandle[]
    try {
      handles = await (window as any).showOpenFilePicker({
        types: OPEN_ACCEPT_TYPES,
        multiple: false,
        excludeAcceptAllOption: false,
      })
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return null
      throw e
    }
    const handle = handles[0]
    const file = await handle.getFile()
    // MIDI files don't get a write handle stored — there's no Save
    // path back to a `.mid`, so a handle would be misleading. Project
    // files keep theirs for in-place Cmd+S.
    const isMidi = isMidiName(file.name)
    return {
      buf: await file.arrayBuffer(),
      ref: { name: file.name, handle: isMidi ? null : handle },
    }
  }

  // Fallback: programmatic <input type="file">.
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = `${PROJECT_FILE_EXTENSION},.mid,.midi,audio/midi,audio/x-midi`
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) {
        resolve(null)
        return
      }
      try {
        resolve({
          buf: await file.arrayBuffer(),
          ref: { name: file.name, handle: null },
        })
      } catch (e) {
        reject(e)
      }
    }
    // `oncancel` lands on Chrome 113+ (irrelevant here — we already use FSA there)
    // and is missing on Safari/Firefox. We don't strictly need to resolve on
    // cancel; the caller treats no-call as a no-op.
    input.click()
  })
}

/** True for filenames ending in .mid / .midi (case-insensitive). */
export function isMidiName(name: string): boolean {
  return /\.midi?$/i.test(name)
}

/** True for filenames ending in `.nfz` (case-insensitive). */
export function isProjectName(name: string): boolean {
  return name.toLowerCase().endsWith(PROJECT_FILE_EXTENSION)
}

/**
 * Open a project directly from a previously-stored `FileSystemFileHandle`
 * (e.g. a Recent Files entry). Re-checks read permission — handles
 * carried across sessions are usually allowed transparently, but the
 * browser can require a fresh user-gesture grant on first reuse.
 *
 * Returns `null` when permission is denied OR the file is no longer
 * reachable (moved, deleted, drive ejected). Caller should drop the
 * stale entry from its recents list in that case.
 */
export async function openFromHandle(
  handle: FileSystemFileHandle,
): Promise<{ buf: ArrayBuffer; ref: FileRef } | null> {
  try {
    const queryFn = (handle as any).queryPermission as
      | ((opts: { mode: 'read' }) => Promise<PermissionState>)
      | undefined
    const requestFn = (handle as any).requestPermission as
      | ((opts: { mode: 'read' }) => Promise<PermissionState>)
      | undefined
    if (queryFn) {
      let perm = await queryFn.call(handle, { mode: 'read' })
      if (perm !== 'granted' && requestFn) {
        perm = await requestFn.call(handle, { mode: 'read' })
      }
      if (perm !== 'granted') return null
    }
    const file = await handle.getFile()
    return { buf: await file.arrayBuffer(), ref: { name: file.name, handle } }
  } catch {
    return null
  }
}

// ───────── Save ─────────

/**
 * Overwrite an existing file via its FSA handle. Returns false when the
 * handle isn't usable (permission denied, file moved/deleted, no FSA
 * support) so the caller can fall back to `showSaveAs`.
 */
export async function saveTo(handle: FileSystemFileHandle, blob: Blob): Promise<boolean> {
  try {
    const queryFn = (handle as any).queryPermission as
      | ((opts: { mode: 'readwrite' }) => Promise<PermissionState>)
      | undefined
    const requestFn = (handle as any).requestPermission as
      | ((opts: { mode: 'readwrite' }) => Promise<PermissionState>)
      | undefined
    if (queryFn) {
      let perm = await queryFn.call(handle, { mode: 'readwrite' })
      if (perm !== 'granted' && requestFn) {
        perm = await requestFn.call(handle, { mode: 'readwrite' })
      }
      if (perm !== 'granted') return false
    }
    const writable = await handle.createWritable()
    await writable.write(blob)
    await writable.close()
    return true
  } catch {
    return false
  }
}

/**
 * Open the Save As dialog (FSA) or trigger a browser download (fallback).
 * Returns the resulting `FileRef` so the store can adopt it as the new
 * `currentFile`. `null` on user-cancel (FSA only — the fallback always
 * "succeeds" by handing the file off to the browser's download manager).
 */
export async function showSaveAs(
  suggestedName: string,
  blob: Blob,
): Promise<FileRef | null> {
  if (hasFileSystemAccess()) {
    let handle: FileSystemFileHandle
    try {
      handle = await (window as any).showSaveFilePicker({
        suggestedName,
        types: ACCEPT_TYPES,
      })
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return null
      throw e
    }
    const writable = await handle.createWritable()
    await writable.write(blob)
    await writable.close()
    const file = await handle.getFile()
    return { name: file.name, handle }
  }

  // Fallback: download.
  const url = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = suggestedName
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  } finally {
    // Defer revoke so the browser has time to consume the URL.
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return { name: suggestedName, handle: null }
}

// ───────── Filename helpers ─────────

/** Strip the .nfz extension for display as a project name. */
export function stripExtension(filename: string): string {
  if (filename.toLowerCase().endsWith(PROJECT_FILE_EXTENSION)) {
    return filename.slice(0, -PROJECT_FILE_EXTENSION.length)
  }
  return filename
}

/** Append .nfz if missing. */
export function ensureExtension(filename: string): string {
  return filename.toLowerCase().endsWith(PROJECT_FILE_EXTENSION)
    ? filename
    : filename + PROJECT_FILE_EXTENSION
}

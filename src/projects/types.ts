import type { Settings } from '../store'

/**
 * On-disk schema for `.nfz` (notefall zip) project files.
 *
 * # Versioning policy (pre-1.0)
 *
 * No migration / schema-version system right now — the project is in
 * beta with no real users, so a breaking shape change just requires
 * re-saving any local files. Settings load via a lenient merge
 * (`actions.ts:loadSettings`) so adding/removing keys is free; renames
 * silently drop the old key. Add a migration step back in once we
 * actually ship to users.
 *
 * # Layout inside the .nfz zip
 *
 *   my-project.nfz  (zip)
 *   ├ manifest.json   ← shape described by `ProjectManifest` below
 *   └ assets/
 *      └ song.mid     ← raw SMF bytes (absent when the project has no song)
 *
 * MIDI is stored as a binary asset rather than base64 inside the manifest
 * so the zip stays self-describing on hand-extraction and avoids the 33%
 * inflation of base64 — MIDI is typically the largest payload in a project.
 */

// `.nfz` = "notefall zip". Three-letter extension matches the convention
// used by other creative tools (.psd, .fig, .als) and keeps file lists
// readable. The container is a regular zip — `unzip my.nfz` works.
export const PROJECT_FILE_EXTENSION = '.nfz' as const
export const PROJECT_FILE_DESCRIPTION = 'notefall project' as const
export const PROJECT_MIME_TYPE = 'application/zip' as const

/**
 * Reference to a binary asset inside the zip (under `assets/`). `ref` is
 * the path *relative to `assets/`* (e.g. `"note-texture.png"`); `mime`
 * preserves the content type so we can re-decode without sniffing;
 * `fileName` is the user's original filename (display only — the
 * in-zip path is normalised to a predictable name).
 */
export type AssetRef = {
  ref: string
  mime: string
  fileName: string
}

/**
 * What sits inside `manifest.json`. `songRef` holds a path *inside the zip*
 * (relative to the zip root). Asset bytes live under `assets/<songRef>`.
 *
 * Future fields (audioTrack, etc.) are added here as optional — that alone
 * doesn't need a schema bump because old loaders ignore unknown keys.
 */
export type ProjectManifest = {
  /** Diagnostic only — recorded for debugging, not used for branching. */
  appVersion: string
  name: string
  createdAt: number
  updatedAt: number
  settings: Partial<Settings>
  songRef: string | null
  /**
   * User-uploaded image for the `noteTexture: 'custom'` preset.
   * Optional — projects that never picked an image (or were saved by an
   * older build that pre-dates this field) simply omit it.
   */
  customTexture?: AssetRef | null
  /**
   * User-provided accompaniment audio (WAV / MP3 / etc.) the user
   * wants to sync against the MIDI visualization. The sync offset
   * and volume that pair with this asset live inside `settings`
   * (`userAudioOffsetSec`, `userAudioVolume`) so they ride the
   * normal settings persistence path.
   */
  userAudio?: AssetRef | null
  /**
   * User-provided overhead "hand video" composited over the scene. The
   * placement / look / timeline-offset knobs live inside `settings`
   * (`handVideo*`) so they ride the normal settings persistence path;
   * only the (H.264-normalised) media bytes need a binary asset slot.
   */
  handVideo?: AssetRef | null
}

/**
 * In-memory snapshot of a project at the I/O boundary. `pack()` consumes
 * this; `unpack()` produces it. During a session the project's contents
 * live in the zustand store (`settings`, `song`) — this struct exists only
 * to bracket the file I/O, not as a long-lived object.
 */
export type Project = {
  name: string
  createdAt: number
  updatedAt: number
  settings: Partial<Settings>
  songMidi: ArrayBuffer | null
  /** Bytes of the user's custom note-texture image. null when not in use. */
  customTexture: { bytes: ArrayBuffer; mime: string; fileName: string } | null
  /** Bytes of the user-provided accompaniment audio. null when not in use. */
  userAudio: { bytes: ArrayBuffer; mime: string; fileName: string } | null
  /** Bytes of the user-provided hand video (H.264). null when not in use. */
  handVideo: { bytes: ArrayBuffer; mime: string; fileName: string } | null
}

/**
 * Reference to a project file on disk + (when supported) the FSA handle
 * needed to overwrite it on `Save`. `handle` is null on browsers without
 * the File System Access API (Safari / Firefox), where `Save` falls back
 * to a download.
 */
export type FileRef = {
  name: string
  handle: FileSystemFileHandle | null
}

/**
 * Anonymous, opt-out usage analytics — event taxonomy.
 *
 * INVARIANT: only anonymous interaction signal leaves the browser.
 * Never the user's MIDI / recordings / project / audio content, never
 * file names or paths, never free text, never error message bodies.
 * Numeric magnitudes are bucketed (not raw) so a song can't be
 * fingerprinted by its note count or length. This mirrors the Help
 * menu's existing "never user content" rule.
 */

export type EventName =
  | 'app_loaded'
  | 'song_opened'
  | 'demo_loaded'
  | 'project_saved'
  | 'project_new'
  | 'custom_audio_imported'
  | 'hand_video_added'
  | 'playback_started'
  | 'playback_paused'
  | 'playback_stopped'
  | 'record_started'
  | 'record_finished'
  | 'note_edited'
  | 'undo'
  | 'redo'
  | 'settings_pin_added'
  | 'settings_reset'
  | 'live_play_session'
  | 'export_started'
  | 'export_finished'
  | 'error_surfaced'

export type EventProps = Record<string, string | number | boolean>

/** How a song entered the session — a closed enum, never a filename. */
export type SongSource =
  | 'midi_file'
  | 'project'
  | 'recent'
  | 'demo'
  | 'recording'
  | 'drop'

/** Live-input origin — a closed enum. */
export type LiveSource = 'touch' | 'mouse' | 'pc_keyboard' | 'midi'

/**
 * Bucket a note count so the raw size of a user's song never leaves
 * the device. Boundaries chosen to separate "empty / sketch / piece /
 * large piece / huge" without being reversible.
 */
export function noteBucket(n: number): string {
  if (n <= 0) return '0'
  if (n <= 50) return '1-50'
  if (n <= 200) return '51-200'
  if (n <= 1000) return '201-1000'
  return '1000+'
}

/** Bucket a duration in seconds (song length, export wall-clock). */
export function durationBucket(sec: number): string {
  if (sec < 30) return '<30s'
  if (sec < 120) return '30s-2m'
  if (sec < 300) return '2-5m'
  return '5m+'
}

/** Bucket a pin / keyframe count. */
export function pinCountBucket(n: number): string {
  if (n <= 0) return '0'
  if (n <= 2) return '1-2'
  if (n <= 5) return '3-5'
  if (n <= 15) return '6-15'
  return '15+'
}

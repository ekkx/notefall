import type { ParsedSong } from '../midi/types'
import type { Settings, VideoAspect } from '../store'
import {
  VIDEO_CODECS,
  isVideoExportSupported,
  renderSongVideo,
  type AudioTrackConfig,
  type VideoRenderOptions,
  type VideoRenderProgress,
} from './renderVideo'
import { VideoRenderAborted } from './errors'
import type { VideoCodec } from './codec/types'
import { defaultExportFileName, triggerDownload } from './download'
import type { UserAudioTrack } from './synth/types'

// ──────────────────────────────────────────────────────────────────────
// Composable export settings — the export-settings dialog picks a value
// from each axis (resolution, fps, quality) and the bitrate ladder
// looks up the right number. Splitting "preset" into independent axes
// instead of a flat `1080p · 60fps · High` list keeps the UI readable
// and lets each axis evolve independently.
// ──────────────────────────────────────────────────────────────────────

export type VideoResolutionId = '720p' | '1080p' | '4k'
export type VideoFps = 30 | 60
export type VideoQualityId = 'standard' | 'high'

export const VIDEO_RESOLUTIONS: Record<
  VideoResolutionId,
  { width: number; height: number; label: string }
> = {
  '720p': { width: 1280, height: 720, label: '720p' },
  '1080p': { width: 1920, height: 1080, label: '1080p' },
  '4k': { width: 3840, height: 2160, label: '4K' },
}

const ASPECT_RATIOS: Record<VideoAspect, number> = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1 }

export const VIDEO_ASPECTS = Object.keys(ASPECT_RATIOS) as VideoAspect[]

/** Width over height. */
export const aspectRatio = (aspect: VideoAspect): number => ASPECT_RATIOS[aspect] ?? ASPECT_RATIOS['16:9']

/** Pixel size of a video: the resolution's short side stays the short side whatever the shape. */
export function videoSize(resolution: VideoResolutionId, aspect: VideoAspect): { width: number; height: number } {
  const { width, height } = VIDEO_RESOLUTIONS[resolution]
  if (aspect === '9:16') return { width: height, height: width }
  if (aspect === '1:1') return { width: height, height }
  return { width, height }
}

export const VIDEO_QUALITIES: Record<
  VideoQualityId,
  { label: string; bitrateMul: number }
> = {
  // Numbers chosen so "High" is visibly cleaner than "Standard" without
  // doubling file size — bitrate scales ~1.5×, perceived quality scales
  // less than that for typical piano-viz content.
  standard: { label: 'Standard', bitrateMul: 1.0 },
  high: { label: 'High', bitrateMul: 1.5 },
}

/**
 * Base video bitrate (kbps) per resolution × fps combo. "Standard"
 * quality maps directly to these numbers; "High" applies the
 * `bitrateMul` from `VIDEO_QUALITIES`. Tuned for piano-visualization
 * content (dark backgrounds, sharp edges, occasional bright bloom);
 * a videographer-aimed app might pick higher numbers but these
 * produce clean files in the 30–200 MB range for typical song lengths.
 */
const BASE_VIDEO_BITRATES_KBPS: Record<`${VideoResolutionId}_${VideoFps}`, number> = {
  '720p_30': 4_000,
  '720p_60': 6_000,
  '1080p_30': 8_000,
  '1080p_60': 12_000,
  '4k_30': 25_000,
  '4k_60': 40_000,
}

export function computeVideoBitrateKbps(
  resolution: VideoResolutionId,
  fps: VideoFps,
  quality: VideoQualityId,
  aspect: VideoAspect,
): number {
  const base = BASE_VIDEO_BITRATES_KBPS[`${resolution}_${fps}`]
  const full = VIDEO_RESOLUTIONS[resolution]
  const { width, height } = videoSize(resolution, aspect)
  const pixels = (width * height) / (full.width * full.height)
  return Math.round(base * VIDEO_QUALITIES[quality].bitrateMul * pixels)
}

/**
 * Default AAC-LC audio config — keep aligned with `exportAudio.ts`'s
 * 44.1 kHz so the WAV path and the H.264 / AAC audio path produce equivalent
 * quality. 192 kbps is transparent for piano material.
 */
export const DEFAULT_AUDIO_CONFIG: AudioTrackConfig = {
  sampleRate: 44_100,
  bitrateKbps: 192,
}

/** Audio config matching a codec preset (Opus needs 48 kHz). */
export function audioConfigFor(codec: VideoCodec): AudioTrackConfig {
  return { sampleRate: VIDEO_CODECS[codec].config.audioSampleRate, bitrateKbps: 192 }
}

export type VideoExportResult =
  | { kind: 'ok' }
  | { kind: 'cancelled' }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string }

export type VideoExportOptions = {
  codec: VideoCodec
  width: number
  height: number
  fps: number
  videoBitrateKbps: number
  /** `null` to produce a silent video (no audio track). */
  audio: AudioTrackConfig
  /** Optional accompaniment buffer mixed into the audio track. */
  userAudio?: UserAudioTrack | null
  fileName?: string
  signal?: AbortSignal
  onProgress?: (p: VideoRenderProgress) => void
}

export async function exportSongToVideo(
  song: ParsedSong,
  settings: Settings,
  options: VideoExportOptions,
): Promise<VideoExportResult> {
  if (!isVideoExportSupported()) return { kind: 'unsupported' }

  const renderOptions: VideoRenderOptions = {
    codec: options.codec,
    width: options.width,
    height: options.height,
    fps: options.fps,
    videoBitrateKbps: options.videoBitrateKbps,
    audio: options.audio,
    userAudio: options.userAudio ?? null,
    signal: options.signal,
    onProgress: options.onProgress,
  }

  try {
    const blob = await renderSongVideo(song, settings, renderOptions)
    if (options.signal?.aborted) return { kind: 'cancelled' }
    const fileName = options.fileName ?? defaultExportFileName(song.name, VIDEO_CODECS[options.codec].config.ext)
    triggerDownload(blob, fileName)
    return { kind: 'ok' }
  } catch (e) {
    if (e instanceof VideoRenderAborted) return { kind: 'cancelled' }
    const message = e instanceof Error ? e.message : String(e)
    return { kind: 'error', message }
  }
}

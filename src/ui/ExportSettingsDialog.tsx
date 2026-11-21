import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, Disclosure, SegmentedControl, Switch } from './kit'
import {
  VIDEO_QUALITIES,
  VIDEO_RESOLUTIONS,
  audioConfigFor,
  computeVideoBitrateKbps,
  type VideoFps,
  type VideoQualityId,
  type VideoResolutionId,
} from '../export/exportVideo'
import { VIDEO_CODECS, probeVideoCodecs } from '../export/renderVideo'
import type { VideoCodec } from '../export/codec/types'
import { playExportCompleteChime } from '../audio/exportChime'

export type ExportFormat = 'video-audio' | 'video-only' | 'audio-only'

export type ExportSettingsValues = {
  format: ExportFormat
  codec: VideoCodec
  resolution: VideoResolutionId
  fps: VideoFps
  quality: VideoQualityId
  /** Play a chime when the export finishes successfully. */
  playSoundOnComplete: boolean
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettingsValues = {
  format: 'video-audio',
  codec: 'h264',
  resolution: '1080p',
  fps: 60,
  quality: 'high',
  playSoundOnComplete: true,
}

/**
 * Single export configuration dialog. Replaces the old
 * "Export Audio" / "Export Video ▸" menu pair — the user picks
 * format, resolution, fps, and quality here, then submits.
 *
 * Everyday choices (format, resolution, frame rate) sit on top; codec
 * and quality are folded under "Advanced", whose closed row summarises
 * them. Layout collapses to the format + Export button when "Audio
 * only" is selected, since none of the video knobs apply.
 *
 * Defaults come from the caller so the Toolbar can remember the
 * user's last choice across the session — picked once, the dialog
 * opens to those values next time.
 *
 * Non-dismissable while the user is configuring (Cancel button is
 * the way out). Dismissing on Escape / backdrop is allowed because
 * the dialog has no in-flight work to lose.
 */
export function ExportSettingsDialog({
  isOpen,
  onClose,
  onExport,
  songDuration,
  silentOnly = false,
  videoExportSupported,
  defaults,
}: {
  isOpen: boolean
  onClose: () => void
  onExport: (settings: ExportSettingsValues) => void
  /** Song length in seconds — used for the estimated-size readout. */
  songDuration: number
  /** No song, only a hand video: a silent video is the one thing to export. */
  silentOnly?: boolean
  /** Browser support gate. When false, video formats are disabled. */
  videoExportSupported: boolean
  defaults: ExportSettingsValues
}) {
  const { t } = useTranslation('dialogs')
  const [format, setFormat] = useState<ExportFormat>(defaults.format)
  const [codec, setCodec] = useState<VideoCodec>(defaults.codec)
  // null while the async encoder probe is running.
  const [codecSupport, setCodecSupport] = useState<Record<VideoCodec, boolean> | null>(null)
  const [resolution, setResolution] = useState<VideoResolutionId>(defaults.resolution)
  const [fps, setFps] = useState<VideoFps>(defaults.fps)
  const [quality, setQuality] = useState<VideoQualityId>(defaults.quality)
  const [playSoundOnComplete, setPlaySoundOnComplete] = useState<boolean>(
    defaults.playSoundOnComplete,
  )

  // Reset to defaults each time the dialog opens. Without this, the
  // form would show whatever the previous render left in state, even
  // if the user dismissed without exporting and the caller's
  // defaults updated.
  useEffect(() => {
    if (isOpen) {
      setFormat(defaults.format)
      setCodec(defaults.codec)
      setResolution(defaults.resolution)
      setFps(defaults.fps)
      setQuality(defaults.quality)
      setPlaySoundOnComplete(defaults.playSoundOnComplete)
    }
  }, [isOpen, defaults])

  // If video export is unsupported, force the form to audio-only so
  // submitting always produces a valid export.
  useEffect(() => {
    if (isOpen && silentOnly && format !== 'video-only') setFormat('video-only')
  }, [isOpen, silentOnly, format])
  useEffect(() => {
    if (isOpen && !silentOnly && !videoExportSupported && format !== 'audio-only') {
      setFormat('audio-only')
    }
  }, [isOpen, videoExportSupported, format])

  // Probe which codecs this browser can encode each time the dialog
  // opens, then move off an unavailable selection to the first usable one.
  useEffect(() => {
    if (!isOpen || !videoExportSupported) return
    // Drop the previous open's result so stale support never shows.
    setCodecSupport(null)
    let cancelled = false
    void probeVideoCodecs().then((support) => {
      if (cancelled) return
      setCodecSupport(support)
      setCodec((cur) =>
        support[cur] ? cur : ((['h264', 'vp9', 'av1'] as VideoCodec[]).find((c) => support[c]) ?? cur),
      )
    })
    return () => {
      cancelled = true
    }
  }, [isOpen, videoExportSupported])

  const showVideoOptions = format !== 'audio-only'

  // Estimated file size readout. Helps the user catch "I picked 4K
  // 60fps High and got a 2 GB file" surprises before committing.
  // Numbers are intentionally rough — the actual encoder hits a
  // variable bitrate and the muxer adds container overhead.
  const estimatedMb = useMemo(() => {
    let bitrateKbps = 0
    if (format === 'audio-only') {
      // 32-bit float stereo PCM wav = 4 bytes × 2 channels × sampleRate
      // = 352.8 kB/s at 44.1 kHz ≈ 2822 kbps
      bitrateKbps = 44_100 * 4 * 2 * 8 / 1000
    } else {
      bitrateKbps += computeVideoBitrateKbps(resolution, fps, quality)
      if (format === 'video-audio') {
        bitrateKbps += audioConfigFor(codec)?.bitrateKbps ?? 0
      }
    }
    const bytes = (bitrateKbps * songDuration * 1000) / 8
    return Math.max(1, Math.round(bytes / (1024 * 1024)))
  }, [format, codec, resolution, fps, quality, songDuration])

  const handleExport = () => {
    onExport({ format, codec, resolution, fps, quality, playSoundOnComplete })
  }

  const summary = [
    CODEC_SUMMARY[codec],
    VIDEO_QUALITIES[quality].label,
  ].join(' · ')
  const fileMeta = showVideoOptions
    ? t('export.fileFormat', {
        codec: VIDEO_CODECS[codec].config.ext.toUpperCase(),
        res: VIDEO_RESOLUTIONS[resolution].label,
        fps,
      })
    : t('export.wavMeta')

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={t('export.title')}
      width={460}
      actions={
        <>
          <Button onPress={onClose}>{t('export.cancel')}</Button>
          <Button variant="primary" onPress={handleExport}>
            {t('export.submit')}
          </Button>
        </>
      }
    >
      {!videoExportSupported && (
        <p className="m-0 text-ink-muted">{t('export.unsupported')}</p>
      )}

      <Field label={t('export.format.label')}>
        <SegmentedControl<ExportFormat>
          aria-label={t('export.format.label')}
          value={format}
          onChange={setFormat}
          options={[
            { value: 'video-audio', label: t('export.format.videoAudio'), isDisabled: !videoExportSupported || silentOnly },
            { value: 'video-only', label: t('export.format.videoOnly'), isDisabled: !videoExportSupported },
            { value: 'audio-only', label: t('export.format.audioOnly'), isDisabled: silentOnly },
          ]}
        />
      </Field>

      {showVideoOptions && (
        <>
          <Field label={t('export.resolution')}>
            <SegmentedControl<VideoResolutionId>
              aria-label={t('export.resolution')}
              value={resolution}
              onChange={setResolution}
              options={(Object.keys(VIDEO_RESOLUTIONS) as VideoResolutionId[]).map((id) => ({
                value: id,
                label: VIDEO_RESOLUTIONS[id].label,
              }))}
            />
          </Field>
          <Field label={t('export.fps')}>
            <SegmentedControl<'30' | '60'>
              aria-label={t('export.fps')}
              value={String(fps) as '30' | '60'}
              onChange={(v) => setFps(Number(v) as VideoFps)}
              options={[
                { value: '30', label: t('export.fps30') },
                { value: '60', label: t('export.fps60') },
              ]}
            />
          </Field>

          <Disclosure
            label={
              <span>
                {t('export.advanced')}
                <span className="text-ink-faint"> · {summary}</span>
              </span>
            }
          >
            <Field label={t('export.codec.label')}>
              <SegmentedControl<VideoCodec>
                aria-label={t('export.codec.label')}
                value={codec}
                onChange={setCodec}
                options={(Object.keys(VIDEO_CODECS) as VideoCodec[]).map((id) => ({
                  value: id,
                  label: id === 'h264' ? 'H.264' : id === 'vp9' ? 'VP9' : 'AV1',
                  isDisabled: !codecSupport?.[id],
                }))}
              />
              <p className="m-0 text-ink-muted">
                {codecSupport ? t(`export.codec.${codec}`) : t('export.codec.checking')}
              </p>
            </Field>
            <Field label={t('export.quality')}>
              <SegmentedControl<VideoQualityId>
                aria-label={t('export.quality')}
                value={quality}
                onChange={setQuality}
                options={(Object.keys(VIDEO_QUALITIES) as VideoQualityId[]).map((id) => ({
                  value: id,
                  label: VIDEO_QUALITIES[id].label,
                }))}
              />
              <p className="m-0 text-ink-muted">
                {t('export.qualityHint', {
                  mbps: (computeVideoBitrateKbps(resolution, fps, quality) / 1000).toFixed(1),
                })}
              </p>
            </Field>
          </Disclosure>
        </>
      )}

      <div className="flex items-center justify-between gap-3">
        <Switch isSelected={playSoundOnComplete} onChange={setPlaySoundOnComplete} className="gap-3">
          <span>{t('export.playSoundOnComplete')}</span>
        </Switch>
        {/* Audition the chime without committing to a full render.
            `excludeFromTabOrder` keeps Tab focus on the form's main controls. */}
        <Button size="sm" variant="field" excludeFromTabOrder onPress={() => playExportCompleteChime()}>
          {t('export.test')}
        </Button>
      </div>

      <div className="flex justify-between gap-3 border-t border-glass-edge pt-3.5 text-ink-muted">
        <span>{fileMeta}</span>
        <span>
          {t('export.estimatedSize')} {t('export.estimatedSizeValue', { mb: estimatedMb })}
        </span>
      </div>
    </Dialog>
  )
}

const CODEC_SUMMARY: Record<VideoCodec, string> = {
  h264: 'H.264 + AAC',
  vp9: 'VP9 + Opus',
  av1: 'AV1 + Opus',
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <span className="text-label text-ink-muted">{label}</span>
      {children}
    </div>
  )
}

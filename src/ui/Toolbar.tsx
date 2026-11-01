import { useTranslation } from 'react-i18next'
import { useStore, useSettingsSlice } from '../store'

const TOOLBAR_KEYS = [
  'userAudioOffsetSec',
  'userAudioTrimEndSec',
  'userAudioTrimStartSec',
  'userAudioVolume',
] as const
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { audioEngine } from '../audio/engine'
import { playSong } from '../audio/playback'
import { recorder } from '../audio/recorder'
import { addEmptyStopListener, toggleRecord as toggleRecordControl } from '../audio/recordControl'
import { ensureAudioReady } from '../audio/midiInput'
import { track } from '../usage'
import { durationBucket, type EventProps } from '../usage/events'
import { useMidiInput } from '../audio/useMidiInput'
import { useRecorder } from '../audio/useRecorder'
import { parseMidi } from '../midi/parse'
import { serializeMidi } from '../midi/serialize'
import {
  pickAndImportUserAudio,
  loadDemoProject,
  newProject,
  openProject,
  openRecent,
  saveProject,
  saveProjectAs,
} from '../projects/actions'
import { getRecent, subscribeRecent } from '../projects/recent'
import { useUserAudio } from '../audio/userAudio'
import { exportSongToWav } from '../export/exportAudio'
import { playExportCompleteChime } from '../audio/exportChime'
import {
  computeVideoBitrateKbps,
  audioConfigFor,
  exportSongToVideo,
  VIDEO_RESOLUTIONS,
} from '../export/exportVideo'
import { VIDEO_CODECS, isVideoExportSupported } from '../export/renderVideo'
import { showAlert } from './confirm'
import { FeedbackDialog } from './FeedbackDialog'
import type { ReportKind } from '../feedback/report'
import { ExportProgressModal, type ExportProgressState } from './ExportProgressModal'
import { CountIn } from './shell/CountIn'
import {
  DEFAULT_EXPORT_SETTINGS,
  ExportSettingsDialog,
  type ExportSettingsValues,
} from './ExportSettingsDialog'
import { showToast } from './kit'
import { InputIsland } from './shell/InputIsland'
import { SongIsland } from './shell/SongIsland'

export function Toolbar() {
  const { t } = useTranslation('toolbar')
  const song = useStore((s) => s.song)
  const settings = useSettingsSlice(TOOLBAR_KEYS)
  const setSong = useStore((s) => s.setSong)
  const setTransport = useStore((s) => s.setTransport)
  const setLoadStatus = useStore((s) => s.setLoadStatus)
  const midi = useMidiInput()
  const rec = useRecorder()
  const transport = useStore((s) => s.transport)
  const currentFile = useStore((s) => s.currentFile)
  const projectName = useStore((s) => s.projectName)
  const dirty = useStore((s) => s.dirty)
  const countInEnabled = useStore((s) => s.countInEnabled)
  const setCountInEnabled = useStore((s) => s.setCountInEnabled)
  // Mid-count-in beat number from the global record-control module so the
  // shortcut and the toolbar button stay in sync.
  const countInBeat = useStore((s) => s.countInBeat)
  // Tracks which recording (if any) is currently loaded as the active
  // song. Lets the per-row button toggle between play (load + play) and
  // pause (stop the running playback) instead of always restarting.
  const [activeRecordingId, setActiveRecordingId] = useState<string | null>(null)
  // Offline-export modal state. `null` when idle; the renderer feeds
  // title + phase + progress + ETA while a render is in flight.
  // Shared across the WAV / video-only / video+audio paths — they
  // all run the same UX pattern (modal, progress bar, cancel). The
  // AbortController ref ties Cancel to the active render. The menu
  // item reads `exportState !== null` to disable re-entry while a
  // render is running.
  const [exportState, setExportState] = useState<ExportProgressState>(null)
  const exportAbortRef = useRef<AbortController | null>(null)
  // Wall-clock baseline for ETA calculation. Set when the export
  // begins; the onProgress handler diffs against this to project
  // remaining time from the current progress fraction.
  const exportStartedAtRef = useRef<number>(0)
  // Rolling window of recent (elapsed, progress) samples — used to
  // compute a smoothed ETA from the current rate instead of the
  // global `elapsed × (1/p − 1)` formula. The global formula
  // assumes a linear progress curve, but our progress is not linear
  // in wall-clock (sample-loading vs render vs encoding all run at
  // different rates), so the global ETA grows during the slow-start
  // phase before falling — a confusing UX. A windowed rate adapts
  // to the *current* speed and shrinks monotonically.
  const exportRateWindowRef = useRef<{ elapsed: number; progress: number }[]>([])
  // Open / close + remembered defaults for the export-settings
  // dialog. Defaults persist across the session so reopening the
  // dialog shows the user's last choice.
  const [exportSettingsOpen, setExportSettingsOpen] = useState(false)
  const [feedbackKind, setFeedbackKind] = useState<ReportKind | null>(null)
  const [exportDefaults, setExportDefaults] =
    useState<ExportSettingsValues>(DEFAULT_EXPORT_SETTINGS)
  // Memoise once — `isVideoExportSupported` reads global typeof
  // checks that don't change at runtime, no point re-evaluating per
  // render.
  const videoExportSupported = isVideoExportSupported()
  const onLoadDemo = async (label: string, url: string) => {
    const result = await loadDemoProject(label, url)
    if (result.kind === 'ok') setActiveRecordingId(null)
    else if (result.kind === 'error') {
      void showAlert({
        title: t('error.couldNotLoadDemo'),
        message: result.message,
        tone: 'error',
      })
    }
  }

  // Click handler for the MIDI button — request access on the first open
  // (must be called from a user gesture for the browser permission prompt).
  const onOpenMidiPanel = async () => {
    if (!midi.hasAccess) await midi.requestAccess()
  }

  // Connect to a device. Ensures the AudioContext is running and the sampler
  // is loaded before the first MIDI message arrives so the user doesn't tap
  // a key into silence.
  const onConnect = async (deviceId: string) => {
    if (!audioEngine.isReady()) {
      setLoadStatus({ state: 'loading', loaded: 0, total: 1 })
      const ok = await ensureAudioReady((loaded, total) =>
        setLoadStatus({ state: 'loading', loaded, total }),
      )
      setLoadStatus(ok ? { state: 'ready' } : { state: 'idle' })
      if (!ok) return
    }
    midi.connect(deviceId)
  }

  // Recording requires the AudioContext + sampler so the first input
  // sound captured isn't silently dropped while the load races.
  // Whenever the loaded song clears (e.g. record press unloads the prior
  // MIDI), drop the "active recording" highlight so it doesn't outlive
  // the song it referenced.
  useEffect(() => {
    if (!song) setActiveRecordingId(null)
  }, [song])

  // Toast for an empty stop, plumbed via the recordControl module since the stop can also
  // originate from the global Shift+R shortcut.
  useEffect(() => {
    return addEmptyStopListener(() => showToast({ message: t('toast.emptyRecording') }))
  }, [t])

  // Auto-load a finalized recording as the current song. Record start
  // already cleared the previous song (recordControl.ts: setSong(null) +
  // unloadSong) so this just fills the empty slot — the user's project
  // song is not at risk of being silently overwritten by stop.
  useEffect(() => {
    return recorder.addFinalizedListener((r) => {
      void (async () => {
        const buf = recorder.toArrayBuffer(r.id)
        if (!buf) return
        const parsed = await parseMidi(buf, r.name)
        // A finalized recording is a new song → clear stale pins /
        // clip length / speed from the previous one; keep the look.
        setSong(parsed, { resetTimeline: true })
        track('song_opened', { source: 'recording' })
        // setSong now treats a song load as a fresh baseline (clean).
        // A recording is unsaved work though — flip dirty so the user
        // gets the beforeunload prompt if they try to close without
        // saving the take.
        useStore.getState().markDirty()
        audioEngine.loadSong(parsed)
        setTransport('stopped')
        setActiveRecordingId(r.id)
      })()
    })
  }, [setSong, setTransport])

  const onToggleRecord = () => {
    void toggleRecordControl()
  }

  // Project actions. Dirty-confirm for `newProject` and `openProject`
  // lives inside the action itself so the keyboard shortcut path
  // (Cmd+O in useGlobalShortcuts) stays in sync with the menu path.
  // Shared error surface for project actions. Wraps the in-app alert
  // modal so the loading-modal visual language is preserved (vs the
  // jarring native window.alert popup).
  const reportError = (title: string, message: string) =>
    void showAlert({ title, message, tone: 'error' })

  const onNewProject = async () => {
    const result = await newProject()
    if (result.kind === 'ok') setActiveRecordingId(null)
  }
  const onOpenProject = async () => {
    const result = await openProject()
    if (result.kind === 'error') reportError(result.title ?? t('error.couldNotOpenFile'), result.message)
    else if (result.kind === 'ok') setActiveRecordingId(null)
  }
  const onSaveProject = async () => {
    const result = await saveProject()
    if (result.kind === 'error') reportError(t('error.couldNotSaveProject'), result.message)
  }
  const onSaveProjectAs = async () => {
    const result = await saveProjectAs()
    if (result.kind === 'error') reportError(t('error.couldNotSaveProject'), result.message)
  }
  const onImportAudio = async () => {
    const result = await pickAndImportUserAudio()
    if (result.kind === 'error') {
      reportError(result.title ?? t('error.couldNotLoadAudio'), result.message)
    }
  }
  // Export the currently loaded song as a single-track Standard MIDI
  // File. `serializeMidi` collapses any multi-track structure from the
  // original source (e.g. right hand / left hand / pedal split tracks)
  // into one note track + the meta track that @tonejs/midi always
  // prepends — DAWs see a single instrument lane instead of having
  // to recombine three.
  const onSaveSongAsMidi = () => {
    if (!song) return
    const buf = serializeMidi(song)
    const blob = new Blob([buf], { type: 'audio/midi' })
    const url = URL.createObjectURL(blob)
    const base =
      (currentFile?.name.replace(/\.[^.]+$/, '')) ||
      projectName ||
      'song'
    const a = document.createElement('a')
    a.href = url
    a.download = `${base}.mid`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  // Open the unified export-settings dialog. The dialog itself
  // figures out whether this is a WAV / silent MP4 / A+V MP4 export
  // and calls back via `onSubmitExportSettings` with the chosen
  // values.
  const onOpenExportDialog = () => {
    if (!song || exportState !== null) return
    setExportSettingsOpen(true)
  }
  const onCloseExportDialog = () => setExportSettingsOpen(false)

  // Update the progress modal with a fresh phase + fraction, plus a
  // wall-clock-based ETA. ETA is computed from the *current* rate
  // over the last several seconds of progress samples (not from
  // total elapsed/progress), so it shrinks monotonically even when
  // the underlying work has heterogeneous rates (sample loading vs
  // offline render vs encoding).
  const ETA_WINDOW_SECONDS = 8
  const updateExportProgress = (
    title: string,
    phaseLabel: string,
    progress: number,
  ) => {
    // After Cancel (or the end), work that can't be stopped mid-flight (the offline audio render) still reports
    // progress; drop it, or it reopens the closed progress dialog for good.
    if (!exportAbortRef.current || exportAbortRef.current.signal.aborted) return
    const elapsedSec = (performance.now() - exportStartedAtRef.current) / 1000
    const window = exportRateWindowRef.current
    window.push({ elapsed: elapsedSec, progress })
    const cutoff = elapsedSec - ETA_WINDOW_SECONDS
    while (window.length > 0 && window[0].elapsed < cutoff) window.shift()

    let eta: number | null = null
    if (window.length >= 2) {
      const oldest = window[0]
      const dt = elapsedSec - oldest.elapsed
      const dp = progress - oldest.progress
      // Wait for at least 1 s of useful samples so the rate isn't
      // dominated by the initial setup burst. Skip negative or zero
      // dp (would imply progress went backwards or stalled).
      if (dt >= 1 && dp > 0) {
        const ratePerSec = dp / dt
        eta = Math.max(0, (1 - progress) / ratePerSec)
      }
    }
    setExportState({ title, phaseLabel, progress, etaSeconds: eta })
  }

  // Build the output filename. Includes resolution / fps / quality
  // tags so a user who exports the same song at multiple settings
  // can tell the files apart at a glance:
  //   song-1080p60-high.mp4
  //   song-1080p60-high-silent.mp4
  //   song-720p30-standard.webm
  //   song.wav
  const buildExportFileName = (values: ExportSettingsValues): string => {
    const songName = song?.name ?? ''
    const base = songName
      .trim()
      .replace(/\.(mid|midi)$/i, '')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    const fallback = `notefall-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`
    const stem = base || fallback
    if (values.format === 'audio-only') return `${stem}.wav`
    const resLabel = VIDEO_RESOLUTIONS[values.resolution].label.toLowerCase()
    const tag = `${resLabel}${values.fps}-${values.quality}`
    const silent = values.format === 'video-only' ? '-silent' : ''
    return `${stem}-${tag}${silent}.${VIDEO_CODECS[values.codec].config.ext}`
  }

  // Run the actual export with the dialog's chosen values. Closes
  // the settings dialog, opens the progress modal, dispatches to
  // the right pipeline (WAV / video), maps progress to the unified
  // shape, and surfaces errors.
  const onSubmitExportSettings = async (values: ExportSettingsValues) => {
    if (!song) return
    setExportDefaults(values)
    setExportSettingsOpen(false)

    const abort = new AbortController()
    exportAbortRef.current = abort
    exportStartedAtRef.current = performance.now()
    exportRateWindowRef.current = []

    const isAudioOnly = values.format === 'audio-only'
    const title = isAudioOnly ? t('export.titleAudio') : t('export.titleVideo')
    setExportState({ title, phaseLabel: t('export.phasePreparing'), progress: 0, etaSeconds: null })

    const exportFormat = isAudioOnly
      ? 'wav'
      : `${VIDEO_CODECS[values.codec].config.container}_${values.format === 'video-audio' ? 'av' : 'video'}`
    const exportProps: EventProps = isAudioOnly
      ? { format: exportFormat }
      : {
          format: exportFormat,
          codec: values.codec,
          resolution: values.resolution,
          fps: values.fps,
          quality: values.quality,
        }
    track('export_started', exportProps)
    const finishExport = (outcome: string) =>
      track('export_finished', {
        ...exportProps,
        outcome,
        duration: durationBucket(
          (performance.now() - exportStartedAtRef.current) / 1000,
        ),
      })

    try {
      const fileName = buildExportFileName(values)

      // Snapshot the user-provided accompaniment (if any) at export
      // start so the offline render mixes it alongside the piano.
      const ua = useUserAudio.getState()
      const userAudioForExport =
        ua.buffer
          ? {
              buffer: ua.buffer,
              offsetSec: settings.userAudioOffsetSec,
              volume: settings.userAudioVolume,
              trimStartSec: settings.userAudioTrimStartSec,
              trimEndSec: settings.userAudioTrimEndSec,
            }
          : null

      if (isAudioOnly) {
        const result = await exportSongToWav(song, useStore.getState().settings, {
          fileName,
          signal: abort.signal,
          userAudio: userAudioForExport,
          onProgress: (p) => {
            if (p.phase === 'loading') {
              const fraction = p.total > 0 ? p.loaded / p.total : 0
              updateExportProgress(title, t('export.phaseLoadingSamples'), fraction)
            } else if (p.phase === 'rendering') {
              updateExportProgress(title, t('export.phaseRenderingAudio'), p.progress)
            }
          },
        })
        if (result.kind === 'error') {
          finishExport(abort.signal.aborted ? 'cancelled' : 'error')
          reportError(t('error.couldNotExportAudio'), result.message)
        } else {
          finishExport(result.kind === 'cancelled' ? 'cancelled' : 'ok')
          if (result.kind === 'ok' && values.playSoundOnComplete) {
            playExportCompleteChime()
          }
        }
      } else {
        if (!videoExportSupported) {
          finishExport('unsupported')
          reportError(
            t('error.videoNotSupportedTitle'),
            t('error.videoNotSupportedMessage'),
          )
          return
        }
        const includeAudio = values.format === 'video-audio'
        const resInfo = VIDEO_RESOLUTIONS[values.resolution]
        const videoBitrateKbps = computeVideoBitrateKbps(
          values.resolution,
          values.fps,
          values.quality,
        )
        const result = await exportSongToVideo(song, useStore.getState().settings, {
          codec: values.codec,
          width: resInfo.width,
          height: resInfo.height,
          fps: values.fps,
          videoBitrateKbps,
          audio: includeAudio ? audioConfigFor(values.codec) : null,
          userAudio: includeAudio ? userAudioForExport : null,
          fileName,
          signal: abort.signal,
          onProgress: (p) => {
            if (p.phase === 'preparing') {
              updateExportProgress(title, t('export.phasePreparing'), 0)
            } else if (p.phase === 'rendering') {
              updateExportProgress(title, t('export.phaseRendering'), p.progress)
            } else if (p.phase === 'finalizing') {
              updateExportProgress(title, t('export.phaseFinalizing'), 1)
            }
          },
        })
        if (result.kind === 'error') {
          finishExport(abort.signal.aborted ? 'cancelled' : 'error')
          reportError(t('error.couldNotExportVideo'), result.message)
        } else if (result.kind === 'unsupported') {
          finishExport('unsupported')
          reportError(
            t('error.videoNotSupportedTitle'),
            t('error.videoNotSupportedShort'),
          )
        } else {
          finishExport(result.kind === 'cancelled' ? 'cancelled' : 'ok')
          if (result.kind === 'ok' && values.playSoundOnComplete) {
            playExportCompleteChime()
          }
        }
      }
    } finally {
      exportAbortRef.current = null
      setExportState(null)
    }
  }
  const onCancelExport = () => {
    exportAbortRef.current?.abort()
  }
  // Recents subscription — empty array on browsers without FSA since
  // `addRecent` no-ops there, so the submenu naturally hides itself
  // via the recents.length === 0 check below.
  const recents = useSyncExternalStore(subscribeRecent, getRecent, getRecent)
  const onOpenRecent = async (entry: (typeof recents)[number]) => {
    const result = await openRecent(entry)
    if (result.kind === 'error') reportError(t('error.couldNotOpenProject'), result.message)
    else if (result.kind === 'ok') setActiveRecordingId(null)
  }

  const onPickRecording = async (id: string, name: string) => {
    const buf = rec.toArrayBuffer(id)
    if (!buf) return
    const parsed = await parseMidi(buf, name)
    // Loading a saved recording as the song → reset song-tied
    // timeline content (pins / clip length / speed); keep the look.
    setSong(parsed, { resetTimeline: true })
    audioEngine.loadSong(parsed)
    setTransport('stopped')
    setActiveRecordingId(id)
  }

  const onLoadAndPlayRecording = async (id: string, name: string) => {
    await onPickRecording(id, name)
    // Start playback automatically — pressing the play-shaped button in
    // the list reads as "play this take", not just "load it and wait".
    await playSong()
  }

  const fallbackName = currentFile
    ? currentFile.name.replace(/\.nfz$/i, '')
    : song
      ? song.name.replace(/\.midi?$/i, '')
      : dirty
        ? t('projectName.untitled')
        : ''

  return (
    <>
    <SongIsland
      actions={{
        onNew: () => void onNewProject(),
        onOpen: () => void onOpenProject(),
        onSave: () => void onSaveProject(),
        onSaveAs: () => void onSaveProjectAs(),
        onImportAudio: () => void onImportAudio(),
        onSaveMidi: onSaveSongAsMidi,
        onExport: onOpenExportDialog,
        onLoadDemo: (label, url) => void onLoadDemo(label, url),
        onOpenRecent: (entry) => void onOpenRecent(entry),
      }}
      recents={recents}
      recording={rec.state === 'recording'}
      hasSong={!!song}
      exportBusy={exportState !== null}
      // Nothing to name until something is loaded or edited.
      fallbackName={song || currentFile || dirty || projectName ? fallbackName : null}
      onFeedback={setFeedbackKind}
    />
    <CountIn beat={countInBeat} onCancel={onToggleRecord} />
    <InputIsland
      midi={midi}
      rec={rec}
      countInBeat={countInBeat}
      onConnect={(id) => void onConnect(id)}
      onOpenMidiPanel={() => void onOpenMidiPanel()}
      onToggleRecord={onToggleRecord}
      canExport={!!song && exportState === null && rec.state !== 'recording'}
      onExport={onOpenExportDialog}
      takes={{
        transport,
        activeRecordingId,
        countInEnabled,
        onCountInChange: setCountInEnabled,
        onPickRecording: (id, name) => void onPickRecording(id, name),
        onLoadAndPlayRecording: (id, name) => void onLoadAndPlayRecording(id, name),
      }}
    />
    <ExportSettingsDialog
      isOpen={exportSettingsOpen}
      onClose={onCloseExportDialog}
      onExport={(values) => void onSubmitExportSettings(values)}
      songDuration={song?.duration ?? 0}
      videoExportSupported={videoExportSupported}
      defaults={exportDefaults}
    />
    <ExportProgressModal state={exportState} onCancel={onCancelExport} />
    <FeedbackDialog
      kind={feedbackKind ?? 'bug'}
      isOpen={feedbackKind !== null}
      onClose={() => setFeedbackKind(null)}
    />
    </>
  )
}

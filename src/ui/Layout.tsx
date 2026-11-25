import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { UNSAFE_PortalProvider } from 'react-aria'
import { DropZone } from 'react-aria-components'
import { Toolbar } from './Toolbar'
import { Inspector } from './Inspector'
import { Viewport } from './Viewport'
import { TimelineEditor } from './TimelineEditor'
import { ConfirmModal } from './ConfirmModal'
import { Icon, ToastHost, GEOMETRY, useReleaseFocusAfterPointer } from './kit'
import { ShortcutSheet } from './shell/ShortcutSheet'
import { TransportPill } from './shell/TransportPill'
import { HandVideoSetup } from './HandVideoSetup'
import { LoadingIsland } from './shell/LoadingIsland'
import { DriftIsland } from './shell/DriftIsland'
import { IdleDriver } from './shell/idle'
import { setFullscreenRoot, useIsFullscreen } from './shell/fullscreen'
import { useStore } from '../store'
import { audioEngine } from '../audio/engine'
import { midiInput } from '../audio/midiInput'
import { isAudioName, useUserAudio } from '../audio/userAudio'
import { parseMidi } from '../midi/parse'
import { loadFirstVisitDemo, importHandVideo, importUserAudio, isHandVideoFile, openProjectFromFile } from '../projects/actions'
import { isVideoName, useHandVideo } from '../video/handVideo'
import { handVideoEndOnTimeline } from '../video/time'
import { PROJECT_FILE_EXTENSION } from '../projects/types'
import { showAlert } from './confirm'
import { useGlobalShortcuts } from './useGlobalShortcuts'

// Accepted file types. Match case-insensitively so files renamed in
// uppercase (`.NFZ`, `.MID`) still load.
const PROJECT_EXT_RE = new RegExp(
  `${PROJECT_FILE_EXTENSION.replace('.', '\\.')}$`,
  'i',
)
const MIDI_EXT_RE = /\.midi?$/i
const isProjectName = (name: string) => PROJECT_EXT_RE.test(name)
const isMidiName = (name: string) => MIDI_EXT_RE.test(name)

/**
 * Drives the pin edit target off the PLAYHEAD: the nearest pin at or
 * before the head (`time <= currentSongTime`), or `null` before the
 * first pin / when there are none. Single app-wide rAF; writes
 * `editingKeyframeTime` only when it actually changes (a pin-boundary
 * crossing or a seek), so the Inspector / banner / lane re-render only
 * then — not every frame. This is what makes the Inspector follow the
 * timeline (and stops a clicked pin sticking once the head moves away).
 */
function PinTargetSync() {
  useEffect(() => {
    let raf = 0
    const loop = () => {
      const st = useStore.getState()
      const kfs = st.settings.settingsKeyframes
      let target: number | null = null
      if (kfs.length > 0) {
        const t = audioEngine.currentSongTime() + 1e-6
        let best = -Infinity
        for (let i = 0; i < kfs.length; i++) {
          const tm = kfs[i].time
          if (tm <= t && tm > best) best = tm
        }
        if (best > -Infinity) target = best
      }
      if (target !== st.editingKeyframeTime) {
        useStore.setState({ editingKeyframeTime: target })
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])
  return null
}

export function Layout() {
  const { t } = useTranslation('dialogs')
  const transport = useStore((s) => s.transport)
  useGlobalShortcuts()
  useReleaseFocusAfterPointer()
  // Fullscreen takes the whole app root so the floating chrome comes along. react-aria
  // portals into document.body by default, which sits outside the fullscreen element, so
  // redirect them to the root while fullscreen (and return body explicitly otherwise: once
  // a PortalProvider exists, a nullish container renders nothing).
  const rootRef = useRef<HTMLDivElement>(null)
  const isFullscreen = useIsFullscreen()
  useEffect(() => void loadFirstVisitDemo(), [])
  useEffect(() => {
    setFullscreenRoot(rootRef.current)
    return () => setFullscreenRoot(null)
  }, [])

  // ── Engine settings sync via imperative subscription ─────────────
  //
  // Previously Layout subscribed to `settings` (whole object) and had
  // ~25 `useEffect`s with per-key deps. That worked but forced Layout
  // to re-render on EVERY settings change — and since Layout is the
  // common ancestor of Toolbar / Viewport / Inspector / TimelineEditor,
  // every Inspector slider drag re-rendered the entire app tree
  // (visible in React Scan). The component bodies were cheap but the
  // cascading reconciliation through R3F / many BoundRows was not.
  //
  // The fix is to read settings only via `useStore.subscribe` inside
  // a mount-time effect: the diff happens in the subscription callback,
  // not in React's render cycle, so Layout never re-renders for these.
  useEffect(() => {
    // Initial sync from the live store state.
    let prev = useStore.getState().settings
    audioEngine.setVolume(prev.volume)
    audioEngine.setMidiVolume(prev.midiVolume)
    audioEngine.setMidiEnabled(prev.midiEnabled)
    audioEngine.setRate(prev.playbackRate)
    audioEngine.setPedalEnabled(prev.pedalEnabled)
    audioEngine.setReverbEnabled(prev.reverbEnabled)
    audioEngine.setReverbDry(prev.reverbDry)
    audioEngine.setReverbWet(prev.reverbWet)
    audioEngine.setReverbSize(prev.reverbSize)
    audioEngine.setReverbDecayTime(prev.reverbDecayTime)
    audioEngine.setReverbDecay(prev.reverbDecay)
    audioEngine.setReverbPreDelay(prev.reverbPreDelay)
    audioEngine.setReverbDamping(prev.reverbDamping)
    audioEngine.setReverbHiCut(prev.reverbHiCut)
    audioEngine.setReverbLowCut(prev.reverbLowCut)
    audioEngine.setReleaseTime(prev.releaseTime)
    audioEngine.setDetune(prev.samplerDetune)
    prev.eqBands.forEach((db, i) => audioEngine.setEqBand(i, db))
    audioEngine.setVelocityCurve(prev.velocityCurve)
    audioEngine.setVelocityCompensation(prev.velocityCompensation)
    audioEngine.setTranspose(prev.transpose)
    midiInput.setTranspose(prev.transpose)
    audioEngine.setUserAudioOffset(prev.userAudioOffsetSec)
    audioEngine.setUserAudioVolume(prev.userAudioVolume)
    audioEngine.setMidiOffset(prev.midiOffsetSec)
    audioEngine.setMidiTrim(prev.midiTrimStartSec, prev.midiTrimEndSec)
    audioEngine.setUserAudioTrim(prev.userAudioTrimStartSec, prev.userAudioTrimEndSec)
    audioEngine.setSpeedAutomation(prev.midiSpeedAutomation)
    return useStore.subscribe((state) => {
      const cur = state.settings
      if (cur === prev) return
      if (cur.volume !== prev.volume) audioEngine.setVolume(cur.volume)
      if (cur.midiVolume !== prev.midiVolume) audioEngine.setMidiVolume(cur.midiVolume)
      if (cur.midiEnabled !== prev.midiEnabled) audioEngine.setMidiEnabled(cur.midiEnabled)
      if (cur.playbackRate !== prev.playbackRate) audioEngine.setRate(cur.playbackRate)
      if (cur.pedalEnabled !== prev.pedalEnabled) audioEngine.setPedalEnabled(cur.pedalEnabled)
      if (cur.reverbEnabled !== prev.reverbEnabled) audioEngine.setReverbEnabled(cur.reverbEnabled)
      if (cur.reverbDry !== prev.reverbDry) audioEngine.setReverbDry(cur.reverbDry)
      if (cur.reverbWet !== prev.reverbWet) audioEngine.setReverbWet(cur.reverbWet)
      if (cur.reverbSize !== prev.reverbSize) audioEngine.setReverbSize(cur.reverbSize)
      if (cur.reverbDecayTime !== prev.reverbDecayTime) audioEngine.setReverbDecayTime(cur.reverbDecayTime)
      if (cur.reverbDecay !== prev.reverbDecay) audioEngine.setReverbDecay(cur.reverbDecay)
      if (cur.reverbPreDelay !== prev.reverbPreDelay) audioEngine.setReverbPreDelay(cur.reverbPreDelay)
      if (cur.reverbDamping !== prev.reverbDamping) audioEngine.setReverbDamping(cur.reverbDamping)
      if (cur.reverbHiCut !== prev.reverbHiCut) audioEngine.setReverbHiCut(cur.reverbHiCut)
      if (cur.reverbLowCut !== prev.reverbLowCut) audioEngine.setReverbLowCut(cur.reverbLowCut)
      if (cur.releaseTime !== prev.releaseTime) audioEngine.setReleaseTime(cur.releaseTime)
      if (cur.samplerDetune !== prev.samplerDetune) audioEngine.setDetune(cur.samplerDetune)
      if (cur.eqBands !== prev.eqBands) {
        cur.eqBands.forEach((db, i) => {
          if (db !== prev.eqBands[i]) audioEngine.setEqBand(i, db)
        })
      }
      if (cur.velocityCurve !== prev.velocityCurve) audioEngine.setVelocityCurve(cur.velocityCurve)
      if (cur.velocityCompensation !== prev.velocityCompensation)
        audioEngine.setVelocityCompensation(cur.velocityCompensation)
      if (cur.transpose !== prev.transpose) {
        audioEngine.setTranspose(cur.transpose)
        midiInput.setTranspose(cur.transpose)
      }
      if (cur.userAudioOffsetSec !== prev.userAudioOffsetSec)
        audioEngine.setUserAudioOffset(cur.userAudioOffsetSec)
      if (cur.userAudioVolume !== prev.userAudioVolume)
        audioEngine.setUserAudioVolume(cur.userAudioVolume)
      if (cur.midiOffsetSec !== prev.midiOffsetSec)
        audioEngine.setMidiOffset(cur.midiOffsetSec)
      if (
        cur.midiTrimStartSec !== prev.midiTrimStartSec ||
        cur.midiTrimEndSec !== prev.midiTrimEndSec
      ) {
        audioEngine.setMidiTrim(cur.midiTrimStartSec, cur.midiTrimEndSec)
      }
      if (
        cur.userAudioTrimStartSec !== prev.userAudioTrimStartSec ||
        cur.userAudioTrimEndSec !== prev.userAudioTrimEndSec
      ) {
        audioEngine.setUserAudioTrim(cur.userAudioTrimStartSec, cur.userAudioTrimEndSec)
      }
      if (cur.midiSpeedAutomation !== prev.midiSpeedAutomation)
        audioEngine.setSpeedAutomation(cur.midiSpeedAutomation)
      prev = cur
    })
  }, [])

  // Loop is a top-level store value (not nested under settings), kept
  // here as a stand-alone effect.
  const loop = useStore((s) => s.loop)
  useEffect(() => {
    audioEngine.setLoop(loop)
  }, [loop])

  // User audio buffer is kept outside the main store (heavy AudioBuffer);
  // subscribe to it directly so Layout doesn't re-render on settings.
  const userAudioBuffer = useUserAudio((s) => s.buffer)
  useEffect(() => {
    audioEngine.setUserAudio(userAudioBuffer)
  }, [userAudioBuffer])

  // The hand video is a third clip of the timeline: the engine plays / seeks / loops over its end too.
  useEffect(() => {
    const sync = () => {
      const st = useStore.getState().settings
      const v = useHandVideo.getState()
      audioEngine.setVideoEnd(handVideoEndOnTimeline(st, v.duration, v.element !== null))
    }
    sync()
    const offs = [useStore.subscribe(sync), useHandVideo.subscribe(sync)]
    return () => offs.forEach((off) => off())
  }, [])

  // sync transport state if engine auto-stopped at end-of-song
  useEffect(() => {
    if (transport !== 'playing') return
    let raf = 0
    const loop = () => {
      if (!audioEngine.isPlaying()) {
        useStore.getState().setTransport('stopped')
        return
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [transport])

  return (
    // App-wide DropZone. Wrapping the entire Layout means a drop
    // anywhere — Toolbar, Inspector, or canvas — routes the file. The
    // earlier Viewport-scoped DropZone left users dropping onto the
    // wrong surface with nothing happening.
    <UNSAFE_PortalProvider
      getContainer={() => (isFullscreen ? rootRef.current ?? document.body : document.body)}
    >
    <DropZone
      ref={rootRef}
      className="group/dropzone relative h-full w-full overflow-hidden bg-canvas outline-none"
      // Accept every file drop. react-aria's `DragTypes.has('Files')`
      // does NOT match native file drops the way HTML's
      // `dataTransfer.types.includes('Files')` does — it checks the
      // underlying MIME-type set, not the OS sentinel — so a `'Files'`
      // gate would always cancel and the DropZone would silently never
      // fire. We accept any drop here and filter by file extension in
      // `onDrop` below.
      getDropOperation={() => 'copy'}
      onDrop={async (e) => {
        const fileItem = e.items.find((item) => item.kind === 'file')
        if (!fileItem || fileItem.kind !== 'file') return
        if (isProjectName(fileItem.name)) {
          const file = await fileItem.getFile()
          const result = await openProjectFromFile(file)
          if (result.kind === 'error') {
            void showAlert({
              title: t('drop.couldNotOpenProjectTitle'),
              message: t('drop.couldNotOpenProjectMessage', {
                name: fileItem.name,
                detail: result.message,
              }),
              tone: 'error',
            })
          }
          return
        }
        if (isMidiName(fileItem.name)) {
          const file = await fileItem.getFile()
          try {
            const buf = await file.arrayBuffer()
            const parsed = await parseMidi(buf, file.name)
            const store = useStore.getState()
            // New MIDI dropped → reset song-tied timeline content
            // (pins / clip length / speed); keep the Inspector look.
            store.setSong(parsed, { resetTimeline: true })
            audioEngine.loadSong(parsed)
            store.setTransport('stopped')
          } catch (err) {
            void showAlert({
              title: t('drop.couldNotLoadMidiTitle'),
              message: t('drop.couldNotLoadMidiMessage', {
                name: fileItem.name,
                detail: err instanceof Error ? err.message : String(err),
              }),
              tone: 'error',
            })
          }
          return
        }
        if (isVideoName(fileItem.name)) {
          const file = await fileItem.getFile()
          if (await isHandVideoFile(file)) {
            const result = await importHandVideo(file)
            if (result.kind === 'error') {
              void showAlert({ title: result.title ?? t('drop.couldNotLoadAudioTitle'), message: result.message, tone: 'error' })
            }
            return
          }
        }
        if (isAudioName(fileItem.name)) {
          const file = await fileItem.getFile()
          const result = await importUserAudio(file)
          if (result.kind === 'error') {
            void showAlert({
              title: result.title ?? t('drop.couldNotLoadAudioTitle'),
              message: result.message,
              tone: 'error',
            })
          }
          return
        }
        // Unsupported extension — surface a clear message rather than
        // silently ignoring the drop. Users were left wondering whether
        // the drop registered at all.
        void showAlert({
          title: t('drop.unsupportedTitle'),
          message: t('drop.unsupportedMessage', { name: fileItem.name }),
          tone: 'error',
        })
      }}
    >
      <Viewport />
      <HandVideoSetup />
      <Toolbar />
      <Inspector />
      <TimelineEditor />
      <TransportPill />
      <LoadingIsland />
      <DriftIsland />
      <ToastHost bottom={GEOMETRY.PILL_BOTTOM + GEOMETRY.PILL + GEOMETRY.GAP} clearOf="[data-timeline-panel]" gap={GEOMETRY.GAP} />
      <ShortcutSheet />
      <PinTargetSync />
      <IdleDriver />
      <ConfirmModal />
      {/* Drop indicator. Toggled via CSS off the DropZone's
          `data-drop-target` attribute — using a render-prop here would
          re-execute the entire Layout subtree on every focus / hover /
          press change to the DropZone, not just when a file drag
          enters. `pointer-events-none` so the DropZone underneath
          still receives the drop event regardless of which UI surface
          the user releases on. */}
      <div
        aria-hidden
        className="nf-enter-fade pointer-events-none fixed inset-0 z-50 hidden flex-col items-center justify-center gap-1 bg-scrim text-center group-data-[drop-target]/dropzone:flex"
      >
        {/* the whole window is the drop target: a dashed frame just inside its edge */}
        <span className="absolute inset-2 rounded-panel border-[1.5px] border-dashed border-ink-muted" />
        <Icon.UploadIcon className="mb-1 h-7 w-7 text-ink" />
        <span className="text-title text-ink">{t('drop.title')}</span>
        <span className="text-ink-muted">{t('drop.hint')}</span>
      </div>
    </DropZone>
    </UNSAFE_PortalProvider>
  )
}

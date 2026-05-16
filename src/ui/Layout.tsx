import { useEffect } from 'react'
import { DropZone } from 'react-aria-components'
import { Toolbar } from './Toolbar'
import { Inspector } from './Inspector'
import { Viewport } from './Viewport'
import { TimelineEditor } from './TimelineEditor'
import { ConfirmModal } from './ConfirmModal'
import { HandVideoContextMenu } from './HandVideoContextMenu'
import { LoadingOverlay } from './LoadingOverlay'
import { useStore } from '../store'
import { audioEngine } from '../audio/engine'
import { midiInput } from '../audio/midiInput'
import { isAudioName, useUserAudio } from '../audio/userAudio'
import { useHandVideo } from '../notes/handVideo'
import { parseMidi } from '../midi/parse'
import { importUserAudio, openProjectFromFile } from '../projects/actions'
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

export function Layout() {
  const transport = useStore((s) => s.transport)
  useGlobalShortcuts()

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

  // Keep the engine's external-media extent in sync with the hand
  // video clip so the timeline can be scrubbed / played to the clip's
  // end even with no MIDI or accompaniment loaded. Depends on the
  // video store (duration) AND the placement settings (offset / tail
  // trim), so it can't ride the settings-only subscription above.
  const hvDuration = useHandVideo((s) => s.duration)
  const hvFileName = useHandVideo((s) => s.fileName)
  const hvOffsetSec = useStore((s) => s.settings.handVideoOffsetSec)
  const hvTrimEndSec = useStore((s) => s.settings.handVideoTrimEndSec)
  useEffect(() => {
    const end =
      hvFileName && hvDuration > 0
        ? hvOffsetSec + (hvTrimEndSec ?? hvDuration)
        : 0
    audioEngine.setExternalMediaEndSec(end)
  }, [hvFileName, hvDuration, hvOffsetSec, hvTrimEndSec])

  // User audio buffer is kept outside the main store (heavy AudioBuffer);
  // subscribe to it directly so Layout doesn't re-render on settings.
  const userAudioBuffer = useUserAudio((s) => s.buffer)
  useEffect(() => {
    audioEngine.setUserAudio(userAudioBuffer)
  }, [userAudioBuffer])

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
    <DropZone
      className="group/dropzone relative flex h-full w-full flex-col bg-neutral-950 outline-none"
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
              title: 'Could not open project',
              message: `"${fileItem.name}" could not be loaded.\n\n${result.message}`,
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
            store.setSong(parsed)
            audioEngine.loadSong(parsed)
            store.setTransport('stopped')
          } catch (err) {
            void showAlert({
              title: 'Could not load MIDI',
              message: `"${fileItem.name}" could not be parsed.\n\n${err instanceof Error ? err.message : String(err)}`,
              tone: 'error',
            })
          }
          return
        }
        if (isAudioName(fileItem.name)) {
          const file = await fileItem.getFile()
          const result = await importUserAudio(file)
          if (result.kind === 'error') {
            void showAlert({
              title: result.title ?? 'Could not load audio',
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
          title: 'Unsupported file type',
          message: `"${fileItem.name}" is not a supported format. Drop a .nfz project, .mid / .midi, or .mp3 / .wav audio file.`,
          tone: 'error',
        })
      }}
    >
      <Toolbar />
      {/* Viewport + TimelineEditor stack in a left column so the
          timeline editor sits under the canvas only. The Inspector
          remains a tall right column from Toolbar to bottom — the
          editor never extends under it. */}
      <div className="flex flex-1 overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <Viewport />
          <TimelineEditor />
        </div>
        <Inspector />
      </div>
      <LoadingOverlay />
      <ConfirmModal />
      <HandVideoContextMenu />
      {/* Drop indicator. Toggled via CSS off the DropZone's
          `data-drop-target` attribute — using a render-prop here would
          re-execute the entire Layout subtree on every focus / hover /
          press change to the DropZone, not just when a file drag
          enters. `pointer-events-none` so the DropZone underneath
          still receives the drop event regardless of which UI surface
          the user releases on. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-50 hidden items-center justify-center bg-sky-500/10 backdrop-blur-sm group-data-[drop-target]/dropzone:flex"
      >
        <div className="rounded-md border border-sky-500/40 bg-black/55 px-5 py-3 text-sm font-medium text-sky-100 shadow-lg backdrop-blur-md">
          Drop to load (.mid / .midi / .nfz / .mp3 / .wav)
        </div>
      </div>
    </DropZone>
  )
}

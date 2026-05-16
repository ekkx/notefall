import { useStore } from '../store'
import { audioEngine } from './engine'
import { useHandVideo } from '../notes/handVideo'

/**
 * True when a hand video is loaded and enabled — the timeline is then
 * playable / scrubbable even with no MIDI song so the user can align
 * the footage. Mirrors the engine's `externalMediaEndSec` gate.
 */
function hasHandVideoContent(): boolean {
  return !!useHandVideo.getState().fileName
}

/**
 * Shared play/pause/toggle helpers used by the bottom transport bar and the
 * click-to-toggle area in the falling-notes region. All store mutations and
 * sampler init flow through here so the two entry points stay in sync.
 */

/**
 * Drop the editor's selection + per-note context menu. Called on every
 * play/pause transition so a paused-then-resumed session doesn't leave a
 * note "selected" or its velocity menu floating in mid-air after some of
 * those notes have already scrolled past the hit line. Editing and
 * playback are conceptually separate modes — pressing a transport
 * control resets the editing-mode state.
 */
function resetEditorState(): void {
  const s = useStore.getState()
  if (s.contextMenu) s.setContextMenu(null)
  if (s.selection.size > 0) s.clearSelection()
}

export async function playSong(): Promise<void> {
  const { song, loadStatus, setLoadStatus, setTransport } = useStore.getState()
  if (!song && !hasHandVideoContent()) return
  resetEditorState()
  // No MIDI → nothing for the sampler to voice; skip the ~60 MB sample
  // load and just run the clock for the hand video.
  if (song && loadStatus.state !== 'ready') {
    setLoadStatus({ state: 'loading', loaded: 0, total: 1 })
    await audioEngine.init((p) =>
      setLoadStatus({ state: 'loading', loaded: p.loaded, total: p.total }),
    )
    setLoadStatus({ state: 'ready' })
  }
  await audioEngine.play()
  setTransport('playing')
}

export function pauseSong(): void {
  audioEngine.pause()
  resetEditorState()
  useStore.getState().setTransport('paused')
}

export async function togglePlayback(): Promise<void> {
  const { transport, song, loadStatus } = useStore.getState()
  if ((!song && !hasHandVideoContent()) || loadStatus.state === 'loading')
    return
  if (transport === 'playing') pauseSong()
  else await playSong()
}

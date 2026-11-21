import { useStore } from '../store'
import { audioEngine } from './engine'

/**
 * Shared play/pause/toggle helpers used by the bottom transport bar and the
 * click-to-toggle area in the falling-notes region. All store mutations and
 * sampler init flow through here so the two entry points stay in sync.
 */

/**
 * Drop the editor's selection. Called on every play/pause transition so a
 * paused-then-resumed session doesn't leave a note "selected" or its
 * selection card floating in mid-air after some of
 * those notes have already scrolled past the hit line. Editing and
 * playback are conceptually separate modes — pressing a transport
 * control resets the editing-mode state.
 */
function resetEditorState(): void {
  const s = useStore.getState()
  if (s.selection.size > 0) s.clearSelection()
}

export async function playSong(): Promise<void> {
  const { song, loadStatus, setLoadStatus, setTransport } = useStore.getState()
  if (!audioEngine.hasTimeline()) return
  resetEditorState()
  // A hand video alone has no sound to load the piano for.
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
  const { transport, loadStatus } = useStore.getState()
  if (!audioEngine.hasTimeline() || loadStatus.state === 'loading') return
  if (transport === 'playing') pauseSong()
  else await playSong()
}

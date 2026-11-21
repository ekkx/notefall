// Dev-only bootstrap (imported from main.tsx behind `import.meta.env.DEV`, so it never reaches a production bundle).
// Ctrl+Alt+D toggles dev tools; the panel itself is a lazily imported lil-gui instance (panel.ts).
import { audioEngine } from '../audio/engine'
import { useStore } from '../store'
import { selectionScreenRect } from '../scene/selectionBounds'
import { devToolsEnabled, setDevTools, subscribeDevMode, devNoAudio } from './mode'

type Panel = { destroy: () => void }
let panel: Panel | null = null
let opening = false
let lastNoAudio = devNoAudio()

async function sync(): Promise<void> {
  const on = devToolsEnabled()
  // Entering / leaving "No audio" must not leave loadStatus claiming a sampler that was never loaded (or vice versa).
  const na = devNoAudio()
  if (na !== lastNoAudio) {
    lastNoAudio = na
    const st = useStore.getState()
    if (!audioEngine.hasSampler() && st.loadStatus.state !== 'loading') st.setLoadStatus({ state: 'idle' })
  }
  if (on && !panel && !opening) {
    opening = true
    try {
      const m = await import('./panel')
      if (devToolsEnabled()) panel = m.openDevPanel()
    } finally {
      opening = false
    }
  } else if (!on && panel) {
    panel.destroy()
    panel = null
  }
}

export function bootDev(): void {
  // Console handle (same module instances as the app).
  ;(window as unknown as Record<string, unknown>).__nfDev = { store: useStore, engine: audioEngine, selectionScreenRect }
  subscribeDevMode(() => void sync())
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyD' && e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey && !e.repeat) {
      e.preventDefault()
      setDevTools(!devToolsEnabled())
    }
  })
  void sync()
}

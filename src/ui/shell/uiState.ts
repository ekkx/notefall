import { create } from 'zustand'

// View state of the floating shell that is not part of a project: which panels are open.
// (The Timeline's open state stays in `settings.timelineEditorOpen`.)

// Customize starts open on every page load, so people notice they can change the look. Closing it
// lasts for the session only (nothing is stored), and the pill toggles it back.

type ShellState = {
  lookOpen: boolean
  setLookOpen: (v: boolean) => void
  shortcutsOpen: boolean
  setShortcutsOpen: (v: boolean) => void
}

export const useShell = create<ShellState>((set) => ({
  lookOpen: true,
  setLookOpen: (v) => set({ lookOpen: v }),
  shortcutsOpen: false,
  setShortcutsOpen: (v) => set({ shortcutsOpen: v }),
}))

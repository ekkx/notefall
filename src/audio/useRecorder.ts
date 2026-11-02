import { useEffect, useRef, useState } from 'react'
import { audioEngine } from './engine'
import { recorder, type Recording } from './recorder'
import { midiToName } from '../midi/noteName'

/**
 * React hook around the recorder singleton. Exposes the current state, the
 * list of stopped recordings, a live elapsed counter (ticks only while
 * recording), and stable handles for every recorder action.
 */
export function useRecorder() {
  const [, setTick] = useState(0)
  useEffect(() => recorder.addListener(() => setTick((n) => n + 1)), [])

  // Smooth elapsed-second counter for the recording badge. Re-armed every
  // time the manager state changes so we don't burn a 250ms wakeup while
  // idle.
  const [elapsed, setElapsed] = useState(0)
  const intervalRef = useRef<number | null>(null)
  useEffect(() => {
    const arm = () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
      if (recorder.getState() === 'recording') {
        const update = () => setElapsed(recorder.getElapsedSec())
        update()
        intervalRef.current = window.setInterval(update, 250)
      } else {
        setElapsed(0)
      }
    }
    arm()
    return recorder.addListener(arm)
  }, [])

  // Per-keystroke feedback while recording. Resets on each new recording
  // start and freezes when stopped (the rest of the UI stops showing it).
  const [noteOnCount, setNoteOnCount] = useState(0)
  const [lastNote, setLastNote] = useState<string | null>(null)
  useEffect(() => {
    const reset = recorder.addListener(() => {
      if (recorder.getState() === 'recording') {
        setNoteOnCount(0)
        setLastNote(null)
      }
    })
    const off = audioEngine.addLiveListener((e) => {
      if (recorder.getState() !== 'recording') return
      if (e.type !== 'noteOn') return
      setNoteOnCount((n) => n + 1)
      setLastNote(midiToName(e.midi))
    })
    return () => {
      reset()
      off()
    }
  }, [])

  return {
    state: recorder.getState(),
    elapsed,
    noteOnCount,
    lastNote,
    recordings: recorder.getRecordings(),
    unreadCount: recorder.getUnreadCount(),
    start: () => recorder.start(),
    stop: () => recorder.stop(),
    cancel: () => recorder.cancel(),
    delete: (id: string) => recorder.delete(id),
    restore: (r: Recording) => recorder.restore(r),
    rename: (id: string, name: string) => recorder.rename(id, name),
    clearAll: () => recorder.clearAll(),
    markAllRead: () => recorder.markAllRead(),
    download: (id: string) => recorder.download(id),
    toArrayBuffer: (id: string) => recorder.toArrayBuffer(id),
  }
}

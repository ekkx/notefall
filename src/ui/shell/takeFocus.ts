import { useSyncExternalStore } from 'react'
import { recorder } from '../../audio/recorder'
import { useStore } from '../../store'

const subscribe = (cb: () => void) => recorder.addListener(cb)
const isRecording = () => recorder.getState() === 'recording'

/**
 * True from the count-in until a take stops. The screen then belongs to the take: everything but the
 * record island (and the canvas) steps aside.
 */
export function useTakeInProgress(): boolean {
  const recording = useSyncExternalStore(subscribe, isRecording)
  const countingIn = useStore((s) => s.countInBeat > 0)
  return recording || countingIn
}

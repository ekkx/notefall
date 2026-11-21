import { useSyncExternalStore } from 'react'
import { recorder } from '../../audio/recorder'
import { useStore } from '../../store'
import { useHandVideo } from '../../video/handVideo'

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

/**
 * True while the hand video setup (`ui/HandVideoSetup.tsx`) is open: it has the screen to
 * itself (its own bar over the scene), so every other surface steps aside.
 */
export function useHandVideoSetupOpen(): boolean {
  return useHandVideo((s) => s.editing !== null)
}

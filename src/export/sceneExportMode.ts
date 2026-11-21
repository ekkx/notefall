import * as THREE from 'three'
import type { RootState } from '@react-three/fiber'

/**
 * Put the live R3F scene into offline-export mode and return a function
 * that restores it. The restore is best-effort (never throws) so it is
 * safe to call from a `finally` block.
 *
 * - Resizes the drawing buffer to the export resolution (`false` keeps
 *   CSS unchanged so the visible canvas doesn't reflow), pins the pixel
 *   ratio to 1 and fixes the camera aspect.
 * - Switches to `frameloop="never"` so the exporter drives every frame
 *   via `advance()`.
 * - **Disarms `THREE.Clock`**: stop it + `autoStart=false` + zero
 *   `elapsedTime`/`oldTime`. Without this, R3F's `getDelta()` (called
 *   unconditionally before the `frameloop="never"` override) accumulates
 *   wall-clock seconds into `elapsedTime`. The override's
 *   `delta = timestamp - elapsedTime` then drifts with units mismatched
 *   against the virtual timeline and eventually goes negative — sending
 *   Keyboard's exp-decay glow into NaN/Infinity. With autoStart off,
 *   getDelta returns 0 and the override owns the timeline.
 * - Drops frames already queued by `invalidate()` (see the comment at the assignment).
 */
export function enterSceneExportMode(r3f: RootState, width: number, height: number): () => void {
  const { gl, camera, clock } = r3f

  const prevSize = new THREE.Vector2()
  gl.getSize(prevSize)
  const prevPixelRatio = gl.getPixelRatio()
  const prevFrameloop = r3f.frameloop
  const perspective = (camera as THREE.PerspectiveCamera).isPerspectiveCamera === true
    ? (camera as THREE.PerspectiveCamera)
    : null
  const prevAspect = perspective?.aspect ?? 1

  const prevClockAutoStart = clock.autoStart
  const prevClockRunning = clock.running
  const prevClockElapsed = clock.elapsedTime
  const prevClockOldTime = clock.oldTime

  const restore = () => {
    try {
      if (perspective) {
        perspective.aspect = prevAspect
        perspective.updateProjectionMatrix()
      }
      gl.setPixelRatio(prevPixelRatio)
      gl.setSize(prevSize.x, prevSize.y, false)
      clock.elapsedTime = prevClockElapsed
      clock.oldTime = prevClockOldTime
      clock.autoStart = prevClockAutoStart
      if (prevClockRunning) {
        clock.oldTime = performance.now()
        clock.running = true
      }
      r3f.set({ frameloop: prevFrameloop })
      r3f.invalidate()
    } catch {
      /* ignore */
    }
  }

  try {
    clock.stop()
    clock.autoStart = false
    clock.elapsedTime = 0
    clock.oldTime = 0

    gl.setSize(width, height, false)
    gl.setPixelRatio(1)
    if (perspective) {
      perspective.aspect = width / height
      perspective.updateProjectionMatrix()
    }
    r3f.set({ frameloop: 'never' })
    // A frame invalidated before this point (video texture, preview ticker) is still queued, and R3F's rAF loop
    // would run it in 'never' mode with the rAF timestamp as the clock: elapsedTime jumps to ~1e4 s, the next
    // advance(t) then gets a huge negative delta, and Keyboard's exp-decay glow turns NaN (keys black for the whole
    // render). It showed up as a load-dependent flake once the hand video added invalidations. Drop the queue.
    r3f.internal.frames = 0
  } catch (e) {
    restore()
    throw e
  }

  return restore
}

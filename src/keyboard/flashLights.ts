import { MAX_LIGHTS } from './whiteKeyShader'

/**
 * Read-only view of the keyboard's strongest flash lights (top MAX_LIGHTS keys by glow), written by `Keyboard`'s
 * useFrame from the same `now()`-driven state that lights the white keys, so anything else that wants to be lit by the
 * flashes (the hands) matches the keys and the offline exporter. Light position: x = `xy[2i]`, y = the hit line.
 * Colours are working-space (linear) RGB, lifted toward white like the keys' hit lights. `strength` is 0 with the hit lights off.
 */
export const flashLights = {
  xy: new Float32Array(MAX_LIGHTS * 2),
  intensities: new Float32Array(MAX_LIGHTS),
  /** Same slots, but without the same-pitch retrigger dip (the hands' light must not pulse on every repeated note). */
  handIntensities: new Float32Array(MAX_LIGHTS),
  colors: new Float32Array(MAX_LIGHTS * 3),
  strength: 0,
  boost: 0,
  falloffX: 1,
  falloffY: 1,
}

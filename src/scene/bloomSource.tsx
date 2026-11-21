import { useContext, useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { BlendFunction, BloomEffect, Pass } from 'postprocessing'
import { EffectComposerContext, wrapEffect } from '@react-three/postprocessing'

/**
 * Keeps the hand video out of the Bloom.
 *
 * Bloom normally thresholds the frame the scene pass drew, so the bright footage (white keys, skin) and the virtual
 * keys behind it glowed. While the hand video shows, `BloomSourcePass` draws the scene a second time into a small
 * target of its own with the video as plain black (its own alpha: the keys behind it are covered too) and the
 * notes / hit line / particles / flashes over it as usual; `MaskedBloomEffect` thresholds and blurs THAT picture and
 * adds the result to the normal frame. So the footage never blooms, everything drawn over it still does, and the glow
 * spills over the video like anywhere else. With no video the pass does nothing and Bloom reads the frame as before.
 *
 * It lives inside the composer, so the offline exporter (`advance()`) runs it exactly like the live view; both
 * draw into plain linear half-float targets, so `uLinearTarget` / `isLinearTarget` behave as for the composer's own.
 */
export const bloomSource = {
  /** Set each frame by `HandVideoLayer`: the footage is visible and would bloom. */
  active: false,
  /** The video layer's material (its `uBloomMask` uniform turns the footage black). */
  material: null as THREE.ShaderMaterial | null,
  /** The picture Bloom reads this frame (null = the composer's own frame). */
  target: null as THREE.WebGLRenderTarget | null,
}

/** The source is drawn at this share of the drawing buffer: Bloom itself starts from half the frame. */
const SCALE = 0.5

export class MaskedBloomEffect extends BloomEffect {
  update(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget, deltaTime: number): void {
    super.update(renderer, bloomSource.target ?? inputBuffer, deltaTime)
  }
}

export const MaskedBloom = wrapEffect(MaskedBloomEffect, { blendFunction: BlendFunction.ADD })

class BloomSourcePass extends Pass {
  private rt: THREE.WebGLRenderTarget | null = null
  private size = new THREE.Vector2()
  constructor(private bloomScene: THREE.Scene, private bloomCamera: THREE.Camera) {
    super('BloomSourcePass')
    this.needsSwap = false
  }
  render(renderer: THREE.WebGLRenderer) {
    const material = bloomSource.material
    if (!bloomSource.active || !material) {
      bloomSource.target = null
      // No footage to keep out of the bloom: give the target back.
      if (this.rt) {
        this.rt.dispose()
        this.rt = null
      }
      return
    }
    renderer.getDrawingBufferSize(this.size)
    const w = Math.max(1, Math.round(this.size.x * SCALE))
    const h = Math.max(1, Math.round(this.size.y * SCALE))
    if (!this.rt) {
      this.rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4 })
    } else if (this.rt.width !== w || this.rt.height !== h) {
      this.rt.setSize(w, h)
    }
    const prevTarget = renderer.getRenderTarget()
    const prevAutoClear = renderer.autoClear
    material.uniforms.uBloomMask.value = 1
    renderer.autoClear = true
    renderer.setRenderTarget(this.rt)
    renderer.render(this.bloomScene, this.bloomCamera)
    renderer.autoClear = prevAutoClear
    renderer.setRenderTarget(prevTarget)
    material.uniforms.uBloomMask.value = 0
    bloomSource.target = this.rt
  }
  dispose() {
    this.rt?.dispose()
    super.dispose()
  }
}

/** Child of `<EffectComposer>`, before the Bloom. */
export function BloomSourceComposerPass() {
  const ctx = useContext(EffectComposerContext)
  const pass = useMemo(() => (ctx ? new BloomSourcePass(ctx.scene, ctx.camera) : null), [ctx])
  useEffect(
    () => () => {
      bloomSource.target = null
      pass?.dispose()
    },
    [pass],
  )
  return pass ? <primitive object={pass} /> : null
}

import { create } from 'zustand'
import * as THREE from 'three'
import { useStore } from '../store'
import { prepareHandVideoBytes } from '../video/transcode'

/**
 * Holds the user-provided "hand video" — an overhead clip of the user's
 * hands on a real keyboard, composited into the scene (and the exported
 * MP4) so the falling notes line up with the actual finger movement.
 *
 * Kept separate from the main settings store because the decoded media
 * (`<video>` element + THREE.VideoTexture) is a GPU/DOM-bound object that
 * doesn't belong in the serialisable settings tree. The placement / look
 * knobs (position, scale, opacity, brightness, timeline offset / trim)
 * live in `Settings` instead.
 *
 * The original (post-normalisation) file bytes are retained alongside the
 * texture so the clip survives a project save/load cycle — `pack`/`unpack`
 * in `projects/io.ts` ferry these through the .nfz zip as a binary asset,
 * and `setFromBytes` rehydrates without requiring the user to re-pick.
 *
 * The realtime path uses a plain `<video>` element + THREE.VideoTexture;
 * the sync layer drives `video.currentTime` / play / pause from the
 * transport. The offline exporter swaps `texture` for a decoder-fed
 * canvas texture (see export pipeline) so frame-accurate stepping under
 * the virtual clock is possible.
 */

type HandVideoStore = {
  /** Bound by HandVideoOverlay. VideoTexture in realtime; swapped for a
   *  decoder-fed CanvasTexture during offline export. */
  texture: THREE.Texture | null
  /** Underlying media element, driven by the realtime sync layer. */
  videoEl: HTMLVideoElement | null
  fileName: string | null
  /** Normalised (H.264) file bytes — kept so the clip can be re-serialised. */
  fileBytes: ArrayBuffer | null
  /** MIME type of `fileBytes` (always a browser-decodable container). */
  fileMime: string | null
  /** Source duration in seconds (0 until metadata loads). */
  duration: number
  /** Native aspect ratio (width / height); 16/9 until metadata loads. */
  aspect: number
  /** True while an import-time transcode is running. */
  transcoding: boolean
  /** True while the offline exporter owns the texture (canvas-fed). The
   *  overlay skips its realtime `<video>` sync in this mode. */
  exporting: boolean
  /** Loading / decode failure surfaced to the Inspector; null when ok. */
  error: string | null
  /**
   * Offline-export hook. Swaps `texture` for a canvas the exporter
   * draws decoded frames into, so frame stepping under the virtual
   * clock is exact. Returns a draw fn (frame, or null to clear), or
   * null when there's no clip to export. Pairs with `endExport`.
   */
  beginExport: () => ((frame: VideoFrame | null) => void) | null
  /** Restores the realtime VideoTexture after an export pass. */
  endExport: () => void
  /** User-gesture entry point (Inspector's FileTrigger). Marks dirty. */
  setFromFile: (file: File | null) => Promise<void>
  /** Project-load entry point. Same loading logic, skips the dirty mark. */
  setFromBytes: (bytes: ArrayBuffer, mime: string, fileName: string) => Promise<void>
  /** Project-load clear (loaded project carries no hand video). No dirty mark. */
  clearFromLoad: () => void
}

export const useHandVideo = create<HandVideoStore>((set, get) => {
  // Module-instance-level handles for the live media so `clear` can fully
  // tear them down (revoke the blob URL, detach the element, free the GPU
  // texture) before a new clip loads.
  let objectUrl: string | null = null

  const teardownMedia = () => {
    const { texture, videoEl } = get()
    texture?.dispose()
    if (videoEl) {
      try {
        videoEl.pause()
      } catch {
        /* element may already be detached */
      }
      videoEl.removeAttribute('src')
      videoEl.load()
    }
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl)
      objectUrl = null
    }
  }

  const clear = () => {
    teardownMedia()
    set({
      texture: null,
      videoEl: null,
      fileName: null,
      fileBytes: null,
      fileMime: null,
      duration: 0,
      aspect: 16 / 9,
      error: null,
    })
  }

  const makeVideoTexture = (video: HTMLVideoElement): THREE.VideoTexture => {
    const tex = new THREE.VideoTexture(video)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.minFilter = THREE.LinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.generateMipmaps = false
    return tex
  }

  const loadFromBytes = async (bytes: ArrayBuffer, mime: string, fileName: string) => {
    teardownMedia()

    const blob = new Blob([bytes], { type: mime })
    objectUrl = URL.createObjectURL(blob)

    const video = document.createElement('video')
    video.src = objectUrl
    // No audio from the clip — the song / user-audio tracks own sound.
    video.muted = true
    video.defaultMuted = true
    video.playsInline = true
    video.loop = false
    video.preload = 'auto'
    // Decode without attaching to the DOM. crossOrigin is unnecessary for
    // a same-origin blob URL.
    video.crossOrigin = 'anonymous'

    await new Promise<void>((resolve, reject) => {
      const onMeta = () => {
        cleanup()
        resolve()
      }
      const onErr = () => {
        cleanup()
        reject(new Error('Could not play this video'))
      }
      const cleanup = () => {
        video.removeEventListener('loadedmetadata', onMeta)
        video.removeEventListener('error', onErr)
      }
      video.addEventListener('loadedmetadata', onMeta)
      video.addEventListener('error', onErr)
      video.load()
    })

    const aspect =
      video.videoWidth > 0 && video.videoHeight > 0
        ? video.videoWidth / video.videoHeight
        : 16 / 9
    const duration = Number.isFinite(video.duration) ? video.duration : 0

    const tex = makeVideoTexture(video)

    set({
      texture: tex,
      videoEl: video,
      fileName,
      fileBytes: bytes,
      fileMime: mime,
      duration,
      aspect,
      error: null,
    })
  }

  return {
    texture: null,
    videoEl: null,
    fileName: null,
    fileBytes: null,
    fileMime: null,
    duration: 0,
    aspect: 16 / 9,
    transcoding: false,
    exporting: false,
    error: null,
    beginExport: () => {
      const { videoEl, texture } = get()
      if (!videoEl) return null
      const w = videoEl.videoWidth || 1280
      const h = videoEl.videoHeight || 720
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      // The realtime VideoTexture is left attached to videoEl and
      // simply unreferenced for the duration of the export; endExport
      // rebuilds a fresh one. Dispose the old GPU handle now.
      texture?.dispose()
      const canvasTex = new THREE.CanvasTexture(canvas)
      canvasTex.colorSpace = THREE.SRGBColorSpace
      canvasTex.minFilter = THREE.LinearFilter
      canvasTex.magFilter = THREE.LinearFilter
      canvasTex.generateMipmaps = false
      set({ texture: canvasTex, exporting: true })
      return (frame: VideoFrame | null) => {
        if (frame) {
          ctx.drawImage(frame, 0, 0, canvas.width, canvas.height)
        } else {
          ctx.clearRect(0, 0, canvas.width, canvas.height)
        }
        canvasTex.needsUpdate = true
      }
    },
    endExport: () => {
      const { videoEl, texture } = get()
      texture?.dispose()
      if (videoEl) {
        set({ texture: makeVideoTexture(videoEl), exporting: false })
      } else {
        set({ texture: null, exporting: false })
      }
    },
    setFromFile: async (file) => {
      if (!file) {
        clear()
        useStore.getState().markDirty()
        return
      }
      set({ error: null, transcoding: true })
      try {
        // Normalise to a WebCodecs-decodable H.264 container so the
        // offline exporter can frame-step it. Already-H.264 input passes
        // through untouched (no re-encode, no wait).
        const prepared = await prepareHandVideoBytes(file)
        await loadFromBytes(prepared.bytes, prepared.mime, file.name)
        useStore.getState().markDirty()
      } catch (e) {
        clear()
        set({ error: e instanceof Error ? e.message : String(e) })
      } finally {
        set({ transcoding: false })
      }
    },
    setFromBytes: async (bytes, mime, fileName) => {
      set({ error: null })
      try {
        await loadFromBytes(bytes, mime, fileName)
      } catch (e) {
        clear()
        set({ error: e instanceof Error ? e.message : String(e) })
      }
    },
    clearFromLoad: () => {
      clear()
    },
  }
})

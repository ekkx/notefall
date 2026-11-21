import { create } from 'zustand'
import type { Input } from 'mediabunny'

/**
 * The hand video: the user's footage of their hands on a real keyboard,
 * shown in place of (or over) the virtual keyboard (`scene/HandVideoLayer`).
 *
 * The video is a picture-only clip with its own timeline lane
 * (`handVideoOffsetSec` / trim); its sound is never decoded or played.
 *
 * Heavy, non-serialisable state lives here (Blob, <video>), like
 * `userAudio.ts`; the look and the alignment are `handVideo*` settings.
 */

export const VIDEO_EXTENSIONS = ['.mp4', '.m4v', '.mov', '.webm']

export function isVideoName(name: string): boolean {
  return /\.(mp4|m4v|mov|webm)$/i.test(name)
}

/** `.webm` is also an audio extension: it is a hand video only when it holds a video track. */
export async function hasVideoTrack(file: Blob): Promise<boolean> {
  const input = await openInput(file)
  try {
    return (await input.getPrimaryVideoTrack()) !== null
  } catch {
    return false
  } finally {
    input.dispose()
  }
}

/** mediabunny is loaded on first use (like the export muxer), keeping it out of the initial bundle. */
export async function openInput(blob: Blob): Promise<Input> {
  const { ALL_FORMATS, BlobSource, Input } = await import('mediabunny')
  return new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
}

function guessVideoMime(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (ext === 'mov') return 'video/quicktime'
  if (ext === 'webm') return 'video/webm'
  return 'video/mp4'
}

export class HandVideoError extends Error {
  constructor(
    readonly reason: 'noVideoTrack' | 'cannotPlay',
    message: string,
  ) {
    super(message)
  }
}

/** A load that was overtaken (another load, `clear()`, a different project opened) before it finished: its result is dropped. */
export class HandVideoLoadSuperseded extends Error {
  constructor() {
    super('The hand video load was superseded')
  }
}

export type HandVideoSetupStep = 'confirm' | 'fix' | 'range'

/** Where the automatic placement stands. `failed` leaves the video keyboard-wide for the user to place. */
export type HandVideoDetect =
  | { state: 'idle' }
  | { state: 'finding' }
  | { state: 'found'; octaveKnown: boolean }
  | { state: 'failed'; reason: string }

/** The background check of the camera's drift (`video/autotrack.ts`): running with a 0..1 fraction, or not. */
export type HandVideoTrack = { state: 'idle' } | { state: 'running'; fraction: number }

type HandVideoStore = {
  /** The file itself (kept as a Blob so the browser can page it from disk). */
  blob: Blob | null
  fileName: string | null
  mime: string | null
  /** Display size (rotation metadata applied, as the <video> shows it). */
  width: number
  height: number
  duration: number
  /** Live playback source for the scene texture, synced by `sync.ts`. */
  element: HTMLVideoElement | null
  loading: boolean
  /** Timeline thumbnails, filled in the background after a load. */
  thumbs: HandVideoThumbs | null
  /** The keyboard detection (`video/autoplace.ts`); not saved. */
  detect: HandVideoDetect
  setDetect: (d: HandVideoDetect) => void
  /** Drift tracking over the whole video; not saved. */
  track: HandVideoTrack
  setTrack: (t: HandVideoTrack) => void
  /** The setup step that is open (slice 2's UI; `video/setup.ts`): confirm the automatic placement, or fix it by hand. */
  editing: HandVideoSetupStep | null
  setEditing: (step: HandVideoSetupStep | null) => void
  /** Load a file (user gesture or project load). Throws `HandVideoError`. */
  load: (blob: Blob, fileName: string, mime?: string) => Promise<void>
  /**
   * Keep the file of a project's video that this browser could not decode (no element), so Save writes it back
   * unchanged instead of dropping it. Only for the project-open path, after `load` failed.
   */
  keepUndecodable: (blob: Blob, fileName: string, mime: string) => void
  /** Drop the video. No dirty mark (callers decide). */
  clear: () => void
}

function waitForMetadata(el: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      el.removeEventListener('loadeddata', onOk)
      el.removeEventListener('error', onErr)
    }
    const onOk = () => {
      done()
      resolve()
    }
    const onErr = () => {
      done()
      reject(new Error(el.error?.message || 'The browser cannot play this video'))
    }
    // `loadeddata` (not just metadata) so the first frame is ready for
    // the texture and the alignment view.
    el.addEventListener('loadeddata', onOk)
    el.addEventListener('error', onErr)
  })
}

/** Small pictures for the timeline lane, one about every `THUMB_STEP_SEC` (fewer for long videos). */
export type HandVideoThumbs = { step: number; images: (ImageBitmap | null)[]; width: number; height: number }
const THUMB_STEP_SEC = 1
const THUMB_MAX = 240
const THUMB_HEIGHT = 72

async function makeThumbs(blob: Blob, duration: number, onUpdate: (t: HandVideoThumbs) => void, isCurrent: () => boolean): Promise<void> {
  const input = await openInput(blob)
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track || !(await track.canDecode())) return
    const { CanvasSink } = await import('mediabunny')
    // Display size: the file's rotation is already applied (CanvasSink applies it too).
    const w0 = await track.getDisplayWidth()
    const h0 = await track.getDisplayHeight()
    const height = THUMB_HEIGHT
    const width = Math.max(8, Math.round((height * w0) / Math.max(1, h0)))
    const count = Math.max(1, Math.min(THUMB_MAX, Math.ceil(duration / THUMB_STEP_SEC)))
    const step = duration / count
    const sink = new CanvasSink(track, { width, height, fit: 'fill', poolSize: 2 })
    const thumbs: HandVideoThumbs = { step, images: new Array(count).fill(null), width, height }
    const times = Array.from({ length: count }, (_, i) => Math.min(duration - 0.001, (i + 0.5) * step))
    let i = 0
    let lastPush = 0
    for await (const wrapped of sink.canvasesAtTimestamps(times)) {
      if (!isCurrent()) return
      if (wrapped) thumbs.images[i] = await createImageBitmap(wrapped.canvas)
      i++
      // Hand out progress now and then so the lane fills in while decoding.
      if (i - lastPush >= 12 || i === count) {
        lastPush = i
        onUpdate({ ...thumbs, images: thumbs.images.slice() })
      }
    }
  } finally {
    input.dispose()
  }
}

export const useHandVideo = create<HandVideoStore>((set, get) => {
  let objectUrl: string | null = null
  // Bumped by every load and every clear: a load that finds it changed has been overtaken.
  let generation = 0

  const release = () => {
    const el = get().element
    if (el) {
      el.pause()
      el.removeAttribute('src')
      el.load()
    }
    if (objectUrl) URL.revokeObjectURL(objectUrl)
    objectUrl = null
  }

  return {
    blob: null,
    fileName: null,
    mime: null,
    width: 0,
    height: 0,
    duration: 0,
    element: null,
    loading: false,
    thumbs: null,
    detect: { state: 'idle' },
    setDetect: (detect) => set({ detect }),
    track: { state: 'idle' },
    setTrack: (track) => set({ track }),
    editing: null,
    setEditing: (step) => set({ editing: step }),

    keepUndecodable: (blob, fileName, mime) => set({ blob, fileName, mime: mime || blob.type || guessVideoMime(fileName) }),

    load: async (blob, fileName, mime) => {
      const mine = ++generation
      set({ loading: true })
      let input: Input
      try {
        input = await openInput(blob)
      } catch (e) {
        if (mine === generation) set({ loading: false })
        throw e
      }
      try {
        if (mine !== generation) throw new HandVideoLoadSuperseded()
        let videoTrack = null
        try {
          videoTrack = await input.getPrimaryVideoTrack()
        } catch {
          videoTrack = null
        }
        if (!videoTrack) throw new HandVideoError('noVideoTrack', 'This file has no video')

        const el = document.createElement('video')
        el.muted = true // the video's sound is never used
        el.playsInline = true
        el.preload = 'auto'
        el.disablePictureInPicture = true
        const url = URL.createObjectURL(blob)
        el.src = url
        try {
          await waitForMetadata(el)
        } catch (e) {
          URL.revokeObjectURL(url)
          throw new HandVideoError('cannotPlay', e instanceof Error ? e.message : String(e))
        }
        if (mine !== generation) {
          URL.revokeObjectURL(url)
          throw new HandVideoLoadSuperseded()
        }

        const duration = Number.isFinite(el.duration) ? el.duration : 0
        release()
        objectUrl = url
        set({
          blob,
          fileName,
          mime: mime || blob.type || guessVideoMime(fileName),
          width: el.videoWidth,
          height: el.videoHeight,
          duration,
          element: el,
          loading: false,
          thumbs: null,
        })
        const current = () => get().element === el
        void makeThumbs(blob, duration, (thumbs) => {
          if (current()) set({ thumbs })
        }, current).catch(() => {
          /* no thumbnails: the lane shows a plain clip */
        })
      } catch (e) {
        if (mine === generation) set({ loading: false })
        throw e
      } finally {
        input.dispose()
      }
    },

    clear: () => {
      generation++
      release()
      set({
        blob: null,
        fileName: null,
        mime: null,
        width: 0,
        height: 0,
        duration: 0,
        element: null,
        loading: false,
        thumbs: null,
        detect: { state: 'idle' },
        track: { state: 'idle' },
        editing: null,
      })
    },
  }
})

/** The video is loaded and switched on: the scene shows it and the keyboard rules apply. */
export function handVideoShown(enabled: boolean): boolean {
  return enabled && useHandVideo.getState().element !== null
}

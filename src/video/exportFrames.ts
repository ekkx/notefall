import * as THREE from 'three'
import type { Input, VideoSample, VideoSampleSink } from 'mediabunny'
import type { Settings } from '../store'
import { openInput, useHandVideo } from './handVideo'
import { handVideoTimeAt } from './time'

/**
 * Frame-exact hand video for the offline export. A <video> element can't
 * be stepped reliably (seeks are async and land on "a" frame), so the
 * exporter decodes the file itself with mediabunny and, before each
 * `r3f.advance()`, puts the frame shown at that instant into a texture the
 * scene layer uses instead of the live one.
 *
 * Frames are pulled from one forward decode (`samples()`): the export
 * timeline only moves forward, and random access per frame would decode
 * from the previous keyframe every time. The decoded VideoFrame is
 * uploaded as is (no 2D canvas in between).
 * The <video> element applies the file's rotation itself; here the scene
 * layer applies it (`handVideoExportRotation`).
 */

type ExportState = {
  input: Input
  sink: VideoSampleSink
  iter: AsyncGenerator<VideoSample, void, unknown> | null
  cur: VideoSample | null
  next: VideoSample | null
  done: boolean
  frame: VideoFrame | null
  texture: THREE.Texture
  rotation: number
  duration: number
  /** Timestamp of the file's first frame. */
  firstTime: number
}

let state: ExportState | null = null

export function handVideoExportTexture(): THREE.Texture | null {
  return state?.frame ? state.texture : null
}

/** True from `beginHandVideoExport` to `endHandVideoExport`: the scene must draw export frames, never the live element. */
export function handVideoExportActive(): boolean {
  return state !== null
}

/** Clockwise quarter turns the scene must apply to the export frames (0..3). */
export function handVideoExportRotation(): number {
  return state ? Math.round(state.rotation / 90) % 4 : 0
}

/** Open the decoder. Throws a readable error when this browser can't decode the video. */
export async function beginHandVideoExport(): Promise<void> {
  await endHandVideoExport()
  const v = useHandVideo.getState()
  if (!v.blob || !v.element) return
  const input = await openInput(v.blob)
  const { VideoSampleSink } = await import('mediabunny')
  const track = await input.getPrimaryVideoTrack()
  if (!track || !(await track.canDecode())) {
    input.dispose()
    throw new Error(
      `This browser can't decode the hand video (${track?.codec ?? 'unknown codec'}) for export. Convert it to H.264 MP4 and add it again.`,
    )
  }
  const texture = new THREE.Texture()
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = false
  state = {
    input,
    sink: new VideoSampleSink(track),
    iter: null,
    cur: null,
    next: null,
    done: false,
    frame: null,
    texture,
    rotation: await track.getRotation(),
    duration: v.duration,
    firstTime: await track.getFirstTimestamp(),
  }
}

async function pull(s: ExportState): Promise<VideoSample | null> {
  if (!s.iter || s.done) return null
  const r = await s.iter.next()
  if (r.done) {
    s.done = true
    return null
  }
  return r.value
}

/** Put the frame for timeline time `t` into the export texture. */
export async function prepareHandVideoFrame(t: number, settings: Settings): Promise<void> {
  const s = state
  if (!s) return
  const eps = 1e-4
  let { time } = handVideoTimeAt(t, settings, s.duration)
  // A file whose first frame comes after 0 (B-frame delay, edit lists) would otherwise look "backwards" at every
  // frame that holds the start picture and restart the decode each time: hold the first frame's own time instead.
  if (time < s.firstTime) time = s.firstTime
  let changed = false
  // (Re)start the forward decode when nothing is open yet or time went back.
  if (!s.iter || (s.cur && time < s.cur.timestamp - eps)) {
    await s.iter?.return()
    s.cur?.close()
    s.next?.close()
    s.iter = s.sink.samples(time)
    s.done = false
    s.cur = await pull(s)
    s.next = await pull(s)
    changed = true
  }
  while (s.next && s.next.timestamp <= time + eps) {
    s.cur?.close()
    s.cur = s.next
    s.next = await pull(s)
    changed = true
  }
  if (changed && s.cur) {
    s.frame?.close()
    s.frame = s.cur.toVideoFrame()
    s.texture.image = s.frame
    s.texture.needsUpdate = true
  }
}

export async function endHandVideoExport(): Promise<void> {
  const s = state
  state = null
  if (!s) return
  try {
    await s.iter?.return()
  } catch {
    /* ignore */
  }
  s.cur?.close()
  s.next?.close()
  s.frame?.close()
  s.texture.dispose()
  s.input.dispose()
}

/** Throws when the export has no decoded frame to draw (the scene would otherwise leave the video out of the render). */
export function assertHandVideoFrame(): void {
  if (!handVideoExportTexture()) throw new Error('The hand video could not be decoded for the export. Convert it to H.264 MP4 and add it again.')
}

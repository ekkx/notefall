/**
 * Import-time normalisation for the hand video.
 *
 * The offline exporter frame-steps the clip through a WebCodecs
 * `VideoDecoder`, which can only handle codecs the browser exposes. To
 * keep "any clip the user drops in" exportable everywhere (notably
 * iPhone's default HEVC/.mov), a clip whose codec WebCodecs *cannot*
 * decode here is transcoded to an H.264 MP4 on import via a lazily
 * loaded ffmpeg.wasm.
 *
 * A clip WebCodecs *can* decode (any H.264, and HEVC on Safari / Mac
 * Chrome) passes through untouched — no re-encode, no wait, no quality
 * loss — so the common "Most Compatible" iPhone capture and any
 * web-friendly MP4 are zero-cost, and HEVC stays HEVC where supported.
 *
 * ffmpeg.wasm (~30 MB core) is dynamically imported only when a
 * transcode is actually needed, so it never weighs down app startup.
 */
import { probeFirstVideoTrack } from './demux'

export type PreparedVideo = {
  bytes: ArrayBuffer
  mime: string
}

export async function prepareHandVideoBytes(file: File): Promise<PreparedVideo> {
  const bytes = await file.arrayBuffer()
  const mime = file.type || guessMimeFromName(file.name) || 'video/mp4'

  if (await isWebCodecsDecodable(bytes)) {
    return { bytes, mime }
  }
  const transcoded = await transcodeToH264(bytes, file.name)
  return { bytes: transcoded, mime: 'video/mp4' }
}

/** True when the export path's `VideoDecoder` can handle this clip as-is
 *  in this browser. Non-ISO-BMFF containers (WebM/MKV/AVI) probe as null
 *  → not decodable by our mp4box-based demuxer → transcode. */
async function isWebCodecsDecodable(bytes: ArrayBuffer): Promise<boolean> {
  if (typeof VideoDecoder === 'undefined') {
    // No WebCodecs at all → video export is unsupported regardless;
    // skip the costly transcode and let realtime preview use <video>.
    return true
  }
  const probe = await probeFirstVideoTrack(bytes).catch(() => null)
  if (!probe) return false
  const support = await VideoDecoder.isConfigSupported({
    codec: probe.codec,
    codedWidth: probe.width,
    codedHeight: probe.height,
  }).catch(() => null)
  return !!support?.supported
}

async function transcodeToH264(
  bytes: ArrayBuffer,
  fileName: string,
): Promise<ArrayBuffer> {
  // Lazy: pulls the ffmpeg.wasm core (~30 MB) only on first non-H.264
  // import. Vite serves the core/wasm from node_modules as hashed
  // assets; `toBlobURL` sidesteps cross-origin worker restrictions.
  const [{ FFmpeg }, { toBlobURL }, coreURL, wasmURL] = await Promise.all([
    import('@ffmpeg/ffmpeg'),
    import('@ffmpeg/util'),
    import('@ffmpeg/core?url').then((m) => m.default),
    import('@ffmpeg/core/wasm?url').then((m) => m.default),
  ])

  const ff = new FFmpeg()
  await ff.load({
    coreURL: await toBlobURL(coreURL, 'text/javascript'),
    wasmURL: await toBlobURL(wasmURL, 'application/wasm'),
  })

  const ext = (fileName.toLowerCase().split('.').pop() || 'mov').replace(
    /[^a-z0-9]/g,
    '',
  )
  const inName = `in.${ext || 'mov'}`
  const outName = 'out.mp4'
  await ff.writeFile(inName, new Uint8Array(bytes))
  // Drop audio (`-an`) — the song / user-audio tracks own sound. The
  // hand video is an overlay, so CRF 23 / veryfast is a good
  // size/quality/time balance. yuv420p + faststart keep it broadly
  // decodable (incl. our own WebCodecs export path).
  const code = await ff.exec([
    '-i',
    inName,
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    outName,
  ])
  if (code !== 0) {
    ff.terminate()
    throw new Error('Video conversion failed')
  }
  const out = await ff.readFile(outName)
  ff.terminate()
  const data = typeof out === 'string' ? new TextEncoder().encode(out) : out
  // Detach into a standalone ArrayBuffer for the project-asset path.
  const buf = new ArrayBuffer(data.byteLength)
  new Uint8Array(buf).set(data)
  return buf
}

// Best-effort MIME guess when the OS omits file.type (some drag-and-drop
// sources do). Only the containers we realistically expect for hand cams.
function guessMimeFromName(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (ext === 'mp4' || ext === 'm4v') return 'video/mp4'
  if (ext === 'mov' || ext === 'qt') return 'video/quicktime'
  if (ext === 'webm') return 'video/webm'
  if (ext === 'mkv') return 'video/x-matroska'
  if (ext === 'avi') return 'video/x-msvideo'
  return ''
}

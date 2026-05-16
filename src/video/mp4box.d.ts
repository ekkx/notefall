/**
 * Minimal ambient typing for `mp4box` — the package ships no types and
 * no ESM build. We only use the demux surface needed to feed a
 * WebCodecs `VideoDecoder`: track info, sample extraction, and the
 * codec-specific config box (`avcC` / `hvcC`) for `decoderConfig`.
 *
 * Deep box traversal (`stsd.entries[].avcC`) is typed loosely on
 * purpose — fully modelling the ISO-BMFF box tree here would be far
 * more surface than the two fields we touch.
 */
declare module 'mp4box' {
  export interface MP4VideoTrackInfo {
    id: number
    codec: string
    track_width: number
    track_height: number
    nb_samples: number
    timescale: number
    duration: number
  }
  export interface MP4Info {
    duration: number
    timescale: number
    videoTracks: MP4VideoTrackInfo[]
    tracks: MP4VideoTrackInfo[]
  }
  export interface MP4Sample {
    number: number
    track_id: number
    is_sync: boolean
    timescale: number
    dts: number
    cts: number
    duration: number
    size: number
    data: Uint8Array
  }
  export type MP4ArrayBuffer = ArrayBuffer & { fileStart: number }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type BoxNode = any

  export interface MP4File {
    onReady?: (info: MP4Info) => void
    onError?: (e: string) => void
    onSamples?: (id: number, user: unknown, samples: MP4Sample[]) => void
    appendBuffer(data: MP4ArrayBuffer): number
    start(): void
    stop(): void
    flush(): void
    setExtractionOptions(
      id: number,
      user?: unknown,
      opts?: { nbSamples?: number },
    ): void
    getTrackById(id: number): BoxNode
  }

  export function createFile(keepMdatData?: boolean): MP4File

  export class DataStream {
    static BIG_ENDIAN: boolean
    constructor(arrayBuffer?: ArrayBuffer, byteOffset?: number, endianness?: boolean)
    buffer: ArrayBuffer
  }
}

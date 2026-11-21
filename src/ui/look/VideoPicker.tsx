import { useEffect, useRef, useState, type DragEvent } from 'react'
import { Button as AriaButton } from 'react-aria-components'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import { Button, Icon } from '../kit'
import { useHandVideo } from '../../video/handVideo'

/**
 * The hand video, in the same shape as `ImagePicker`: empty, a well to click
 * or drop a video on; set, a still of the video with its name, Remove, and
 * the button that lines it up with the keys again.
 */
export function VideoPicker({
  label,
  onPick,
  onDropFile,
  onClear,
  onLineUp,
  onRange,
}: {
  label: string
  onPick: () => void
  onDropFile: (file: File) => void
  onClear: () => void
  onLineUp: () => void
  onRange: () => void
}) {
  const { t } = useTranslation('video')
  const element = useHandVideo((s) => s.element)
  const fileName = useHandVideo((s) => s.fileName)
  const kept = useHandVideo((s) => s.blob !== null)
  const loading = useHandVideo((s) => s.loading)
  const [dragOver, setDragOver] = useState(false)

  // Same drop handling as ImagePicker: keep the drag from the app-wide drop zone.
  const dropProps = {
    onDragEnter: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      e.stopPropagation()
      setDragOver(true)
    },
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'copy'
      setDragOver(true)
    },
    onDragLeave: () => setDragOver(false),
    onDrop: (e: DragEvent) => {
      const file = e.dataTransfer.files[0]
      setDragOver(false)
      if (!file) return
      e.preventDefault()
      e.stopPropagation()
      onDropFile(file)
    },
  }

  // A project's video this browser can't decode: kept so Save still writes it, so it must be removable.
  if (!element && kept && fileName) {
    return (
      <div className="grid min-w-0 gap-1" {...dropProps}>
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-caption text-ink-muted" title={fileName}>
            {fileName}
          </span>
          <Button variant="quiet" size="sm" onPress={onClear} className="flex-none">
            {t('picker.remove')}
          </Button>
        </div>
        <p className="text-caption text-ink-faint">{t('picker.unplayable')}</p>
      </div>
    )
  }

  if (!element || !fileName) {
    return (
      <div {...dropProps}>
        <AriaButton
          aria-label={`${label}: ${t('picker.choose')}`}
          onPress={onPick}
          isDisabled={loading}
          className={clsx(
            'nf-focus nf-press flex h-24 w-full cursor-pointer flex-col items-center justify-center gap-1 rounded-field bg-fill-field px-3 outline-none data-[hovered]:bg-fill-selected data-[disabled]:cursor-wait',
            dragOver && 'shadow-[inset_0_0_0_1.5px_var(--ink)]',
          )}
        >
          <span className="inline-flex items-center gap-1.5 font-medium text-ink">
            <Icon.UploadIcon className="h-4 w-4" />
            {loading ? t('picker.loading') : t('picker.choose')}
          </span>
          <span className="text-caption text-ink-faint">{t('picker.dropHint')}</span>
        </AriaButton>
      </div>
    )
  }

  return (
    <div className="grid min-w-0 gap-2" {...dropProps}>
      <VideoStill element={element} highlighted={dragOver} />
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-caption text-ink-muted" title={fileName}>
          {fileName}
        </span>
        <Button variant="quiet" size="sm" onPress={onClear} className="flex-none">
          {t('picker.remove')}
        </Button>
      </div>
      <Button variant="field" onPress={onLineUp}>
        {t('picker.lineUp')}
      </Button>
      <Button variant="field" onPress={onRange}>
        {t('picker.range')}
      </Button>
    </div>
  )
}

/** A still of the current frame (redrawn when the element shows a new one while paused). */
function VideoStill({ element, highlighted }: { element: HTMLVideoElement; highlighted: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const draw = () => {
      const c = ref.current
      if (!c || element.videoWidth === 0) return
      const w = 320
      c.width = w
      c.height = Math.round((w * element.videoHeight) / element.videoWidth)
      c.getContext('2d')?.drawImage(element, 0, 0, c.width, c.height)
    }
    draw()
    element.addEventListener('seeked', draw)
    element.addEventListener('loadeddata', draw)
    return () => {
      element.removeEventListener('seeked', draw)
      element.removeEventListener('loadeddata', draw)
    }
  }, [element])
  return (
    <div
      className={clsx(
        'relative h-28 w-full overflow-hidden rounded-field bg-fill-well',
        highlighted && 'shadow-[inset_0_0_0_1.5px_var(--ink)]',
      )}
    >
      <canvas ref={ref} aria-hidden className="absolute inset-0 h-full w-full object-cover" />
    </div>
  )
}

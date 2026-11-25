import { useTranslation } from 'react-i18next'
import { VIDEO_ASPECTS } from '../export/exportVideo'
import { useStore, type VideoAspect } from '../store'

/**
 * Changes the picture's shape. A narrower picture can't show the whole keyboard at a readable size, so it comes with the
 * camera follow on; going back to 16:9 turns it off. The follow's own switch still decides afterwards.
 */
export function setVideoAspect(videoAspect: VideoAspect): void {
  const { settings, updateSettings, beginSettingsEdit, endSettingsEdit } = useStore.getState()
  if (settings.videoAspect === videoAspect) return
  beginSettingsEdit()
  updateSettings({ videoAspect, cameraFollowEnabled: videoAspect !== '16:9' })
  endSettingsEdit()
}

export function useVideoAspectOptions(): { value: VideoAspect; label: string }[] {
  const { t } = useTranslation('inspector')
  const label: Record<VideoAspect, string> = {
    '16:9': t('videoAspect.landscape'),
    '9:16': t('videoAspect.portrait'),
    '1:1': t('videoAspect.square'),
  }
  return VIDEO_ASPECTS.map((value) => ({ value, label: label[value] }))
}

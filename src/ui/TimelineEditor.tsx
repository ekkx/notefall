import { useEffect, useRef, useState } from 'react'
import {
  Button,
  FileTrigger,
  Menu,
  MenuItem,
  MenuTrigger,
  Popover,
} from 'react-aria-components'
import { useStore } from '../store'
import { useUserAudio } from '../audio/userAudio'
import { useHandVideo } from '../notes/handVideo'
import { DEMOS, loadDemoManifestNames } from '../demos'
import { toggleRecord as toggleRecordControl } from '../audio/recordControl'
import { loadDemoProject, openProject } from '../projects/actions'
import { showAlert } from './confirm'
import { Timeline } from './Timeline'
import {
  ChevronUpIcon,
  CrosshairIcon,
  PlaylistIcon,
  RecordIcon,
} from './icons'

/**
 * Toggle whether the timeline auto-pans to keep the playhead visible
 * during playback. Off by default — auto-follow interrupts manual
 * minimap edits, which is what users actually reach for during
 * playback. The opt-in button lives next to the chevron in the
 * section header.
 */
function FollowPlayheadToggle() {
  const follow = useStore((s) => s.settings.followPlayhead)
  const updateSettings = useStore((s) => s.updateSettings)
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        updateSettings({ followPlayhead: !follow })
      }}
      onPointerDown={(e) => e.stopPropagation()}
      aria-pressed={follow}
      title={
        follow
          ? 'Stop following playhead'
          : 'Follow playhead during playback'
      }
      className={`flex h-6 items-center gap-1 rounded px-2 text-[10px] font-medium outline-none transition-colors ${
        follow
          ? 'bg-sky-500/25 text-sky-200 hover:bg-sky-500/35'
          : 'bg-neutral-800/80 text-neutral-400 hover:bg-neutral-700 hover:text-neutral-200'
      }`}
    >
      <CrosshairIcon className="h-3 w-3" />
      <span>Follow</span>
    </button>
  )
}

/**
 * "There's nothing loaded" state for the expanded editor. Replaces
 * the empty timeline lanes with quick-action buttons that mirror the
 * Toolbar's File menu entries — opening a project / starting a
 * recording / loading a bundled demo. Same handlers as the Toolbar,
 * so behaviour (dirty confirms, audio init, etc.) stays consistent.
 */
function EmptyState() {
  const [demoNames, setDemoNames] = useState<Map<string, string>>(new Map())
  useEffect(() => {
    let cancelled = false
    if (DEMOS.length === 0) return
    void loadDemoManifestNames().then((names) => {
      if (!cancelled) setDemoNames(names)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const onOpen = async () => {
    const result = await openProject()
    if (result.kind === 'error') {
      void showAlert({
        title: 'Could not open project',
        message: result.message,
        tone: 'error',
      })
    }
  }
  const onRecord = () => {
    void toggleRecordControl()
  }
  const setHandVideoFile = useHandVideo((s) => s.setFromFile)
  const onPickDemo = async (label: string, url: string) => {
    const result = await loadDemoProject(label, url)
    if (result.kind === 'error') {
      void showAlert({
        title: 'Could not load demo',
        message: result.message,
        tone: 'error',
      })
    }
  }

  const buttonClass =
    'flex h-9 items-center gap-2 rounded border border-neutral-700 bg-neutral-900 px-3 text-xs text-neutral-200 outline-none hover:border-neutral-600 hover:bg-neutral-800 focus-visible:border-sky-500'

  return (
    <div
      className="flex flex-col items-center justify-center gap-3 pr-4"
      // Match the no-audio populated Timeline height exactly: minimap
      // (10) + gap (4) + ruler (18) + gap (4) + MIDI lane (56) = 92.
      // Loading a MIDI with no accompaniment therefore produces zero
      // vertical layout shift. Adding audio still grows by one lane
      // height, but that's inherent to introducing a new track.
      style={{ height: 92 }}
    >
      <span className="text-[11px] text-neutral-500">
        No song loaded — drop a .mid / .nfz file or pick a quick action
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void onOpen()}
          className={buttonClass}
        >
          Open file…
        </button>
        <button type="button" onClick={onRecord} className={buttonClass}>
          <RecordIcon className="h-3.5 w-3.5 text-rose-400" />
          Record
        </button>
        <FileTrigger
          acceptedFileTypes={['video/*']}
          onSelect={async (e) => {
            if (!e) return
            const file = Array.from(e)[0]
            if (file) await setHandVideoFile(file)
          }}
        >
          <Button className={buttonClass}>Hand video…</Button>
        </FileTrigger>
        {DEMOS.length > 0 && (
          <MenuTrigger>
            <Button className={buttonClass}>
              <PlaylistIcon className="h-3.5 w-3.5 text-neutral-400" />
              <span>Demo songs</span>
              <span className="text-neutral-500">▾</span>
            </Button>
            <Popover className="rounded-lg border border-neutral-700 bg-neutral-900 p-1 shadow-xl outline-none data-[entering]:animate-in data-[entering]:fade-in data-[entering]:duration-150">
              <Menu
                aria-label="Demo songs"
                className="flex w-64 flex-col gap-0.5 outline-none"
              >
                {DEMOS.map((demo) => {
                  const label = demoNames.get(demo.url) ?? demo.fallbackLabel
                  return (
                    <MenuItem
                      key={demo.url}
                      onAction={() => void onPickDemo(label, demo.url)}
                      textValue={label}
                      className="flex cursor-default items-center justify-between rounded px-2 py-1.5 text-xs text-neutral-200 outline-none data-[focused]:bg-neutral-800"
                    >
                      <span className="truncate">{label}</span>
                    </MenuItem>
                  )
                })}
              </Menu>
            </Popover>
          </MenuTrigger>
        )}
      </div>
    </div>
  )
}

/**
 * Bottom-of-app section housing the multi-row timeline (minimap +
 * ruler + MIDI lane + audio lane). Sits under the Viewport (left
 * column) and is intentionally OUTSIDE the falling-note canvas so it
 * stays available regardless of fullscreen / canvas state.
 *
 * Collapsible: a thin always-visible header strip with a chevron
 * lets the user toggle the section. State persists via
 * `settings.timelineEditorOpen`. When collapsed, only the header
 * remains so the Viewport reclaims most of the vertical space —
 * useful for "watching" sessions where the editor isn't needed.
 *
 * Transport controls (play / rewind / volume / speed / fullscreen +
 * full-song progress slider) remain in the canvas overlay
 * (`SeekBar`) since those are the "watching" controls; the timeline
 * lanes here are the "editing" surface and warrant a dedicated
 * section.
 */
/**
 * Resize handle pinned to the top edge of the editor. Drag UP to
 * grow the lane heights (`settings.timelineLaneScale`); the minimum
 * is the natural lane heights, so the user can't shrink past the
 * default. Dragging is anchored to the pointer's wall-clock Y
 * delta, divided by the combined natural height of the three lanes
 * — that way one pixel of drag translates to one pixel of total
 * editor growth, giving a "the handle follows my cursor" feel.
 */
function TimelineResizeHandle() {
  const laneScale = useStore((s) => s.settings.timelineLaneScale)
  const updateSettings = useStore((s) => s.updateSettings)
  const dragRef = useRef<{ startY: number; startScale: number } | null>(null)
  // Natural total height of all three lanes (MIDI + audio + speed)
  // at scale=1. Drag pixel ↔ scale change uses this so the cursor
  // tracks the visual growth 1:1.
  const BASE_LANE_TOTAL = 56 + 48 + 32
  const MAX_SCALE = 4
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.stopPropagation()
    dragRef.current = { startY: e.clientY, startScale: laneScale }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d) return
    e.stopPropagation()
    const dy = e.clientY - d.startY // +ve = downward = shrink
    const nextScale = Math.max(
      1,
      Math.min(MAX_SCALE, d.startScale - dy / BASE_LANE_TOTAL),
    )
    if (nextScale !== laneScale) {
      updateSettings({ timelineLaneScale: nextScale })
    }
  }
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    e.stopPropagation()
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* capture may already be released — ignore */
    }
    dragRef.current = null
  }
  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      title="Drag to resize lanes"
      aria-label="Resize timeline editor"
      style={{ touchAction: 'none' }}
      className="absolute inset-x-0 top-0 z-10 h-1 cursor-ns-resize bg-transparent transition-colors hover:bg-sky-500/40"
    />
  )
}

export function TimelineEditor() {
  const song = useStore((s) => s.song)
  const open = useStore((s) => s.settings.timelineEditorOpen)
  const updateSettings = useStore((s) => s.updateSettings)
  const audioBuffer = useUserAudio((s) => s.buffer)
  const audioLoaded = !!audioBuffer
  const handVideoFileName = useHandVideo((s) => s.fileName)
  const handVideoTranscoding = useHandVideo((s) => s.transcoding)
  // The editor is usable with *any* timeline content, not just a MIDI:
  // a hand video alone still needs the ruler / playhead so the user can
  // scrub it into alignment.
  const hasTimelineContent =
    !!song || !!handVideoFileName || handVideoTranscoding
  // Auto-open the editor when an accompaniment OR a hand video becomes
  // available — sync is the editor's headline feature and the user
  // just signalled intent. Fires on the none→present transition, so
  // manually collapsing afterwards stays sticky.
  useEffect(() => {
    if (audioLoaded || handVideoFileName) {
      useStore.getState().updateSettings({ timelineEditorOpen: true })
    }
  }, [audioLoaded, handVideoFileName])
  const toggle = () => updateSettings({ timelineEditorOpen: !open })
  return (
    <div className="relative flex-shrink-0 bg-neutral-950">
      {/* Resize handle — top edge, only meaningful while the editor
          is expanded AND a MIDI is loaded (no song = nothing to
          resize). Sits above the header strip via z-index so the
          drag works even when the cursor crosses the header. */}
      {open && song && <TimelineResizeHandle />}
      {/* Header strip — collapse/expand toggle spans the full row
          with its chevron + label centred so the open/close
          affordance reads at a glance, especially when the section
          is collapsed and there's nothing else competing for the
          eye. The Follow toggle floats on the right via absolute
          positioning so it stays a separate button (clicking it
          shouldn't accidentally collapse the section). */}
      <div className="relative bg-neutral-900/60">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-label={open ? 'Hide timeline editor' : 'Show timeline editor'}
          className="group flex w-full items-center justify-center gap-2 py-2 text-xs font-medium text-neutral-300 outline-none transition-colors hover:text-neutral-100 focus-visible:text-neutral-100"
        >
          <span
            aria-hidden
            className={`flex h-5 w-5 items-center justify-center rounded bg-neutral-800/80 text-neutral-400 ring-1 ring-white/10 transition-all group-hover:bg-neutral-700 group-hover:text-neutral-100 ${
              open ? 'rotate-180' : ''
            }`}
          >
            <ChevronUpIcon className="h-3.5 w-3.5" />
          </span>
          <span>Timeline editor</span>
        </button>
        {open && song && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2">
            <FollowPlayheadToggle />
          </div>
        )}
      </div>
      {open && (
        <div className="pb-3 pl-4 pt-2">
          {hasTimelineContent ? <Timeline /> : <EmptyState />}
        </div>
      )}
    </div>
  )
}

import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useThree, type ThreeEvent } from '@react-three/fiber'
import { useStore, useSettingsSlice } from '../store'
import { PICK_PLANES } from './pickPlanes'

const EDIT_TOOLS_KEYS = [
  'midiOffsetSec',
  'midiSpeedAutomation',
  'transpose',
] as const
import { audioEngine } from '../audio/engine'
import { ensureSamplerLoaded, previewNote } from '../audio/preview'
import { addNote, deleteNotes, moveNotes } from '../midi/edit'
import { buildSpeedMap } from '../midi/speedMap'
import type { ParsedSong } from '../midi/types'
import {
  clickXToMidi,
  clickYToTime,
  fallDistance,
  noteVisualBounds,
  parallaxX,
  NOTE_PLANE_Z,
  type TimeContext,
} from '../notes/positions'
import { noteDeathFx } from '../notes/noteDeathFx'
import {
  KEYBOARD_LAYOUT,
  KEY_COUNT,
  MIDI_MIN,
  NOTE_HIT_Y,
} from '../keyboard/layout'

/**
 * Edit-mode replacement for PlayToggleArea. Mounted only when the song is
 * paused (or stopped) — so the click semantics flip from "toggle play /
 * fast-forward" to "select / range-select / delete / add note".
 *
 * Plain left-pointerdown on empty area above the hit line → IMMEDIATELY
 *   create a new note at the cursor (snapped to nearest pitch, free in
 *   time) and arm a drag session for it. Releasing without moving leaves
 *   the note where it was created; dragging the cursor afterwards moves
 *   the note (just like dragging a selected note). One pointerdown =
 *   one undo entry, regardless of whether the gesture ended up dragging.
 *   Below the hit line the click is a no-op (placing a note in the
 *   audible past isn't useful).
 * Cmd/Ctrl+Left-drag on empty area → marquee range-select. Holding the
 *   modifier is the explicit gate: it makes the gesture deliberate and
 *   keeps it isolated from "add note" click. The marquee is ADDITIVE —
 *   it adds to the existing selection so users can build a multi-select
 *   across non-adjacent regions. As notes enter the marquee they're
 *   played as a brief preview so the user hears what they're selecting.
 * Cmd/Ctrl+Left-click on empty area, no drag → no-op. The Cmd modifier
 *   is reserved for the marquee drag gesture; an unmodified click is the
 *   way to clear / add at the click point.
 * Right-drag from empty → "eraser": notes whose visible rectangle the
 *   cursor sweeps over are deleted. The whole drag gesture collapses to
 *   one undo entry. Pure right-click without drag does nothing on empty
 *   space — right-click on a note (handled in FallingNotes) deletes that
 *   single note.
 *
 * Selection cleanup is also reachable via Escape (useGlobalShortcuts).
 */

// Fallback if for some reason store.lastNoteParams is unset; in practice
// the store seeds itself with these same values, so this branch is just
// a defensive default.
const FALLBACK_DURATION = 0.25
const FALLBACK_VELOCITY = 0.7

// Synthesised when the first note is added with no song loaded — gives
// us a valid ParsedSong baseline so the existing edit pipeline
// (setSongPreview / pushUndoSnapshot / addNote) works unchanged. Undo
// after the very first add restores this empty state, then a second
// undo is a no-op (history exhausted).
const EMPTY_SONG: ParsedSong = {
  name: 'Untitled',
  duration: 0,
  notes: [],
  pedals: [],
  tracks: [],
}

// CSS-standard "no/cancel" cursor — the OS-native circle-with-slash
// icon. Used while the right-click eraser drag is active so the cursor
// signals destructive intent without bringing in a custom asset.
const ERASER_CURSOR = 'not-allowed'
// CSS-standard "cell selection" cursor — the cross-hair-like icon used
// for spreadsheet range selections. Distinct from the plain `crosshair`
// we use for "click here to drop a new note", so the user can tell at a
// glance that Cmd+drag is doing something different.
const RANGE_SELECT_CURSOR = 'cell'

// Drag-vs-click threshold in client (CSS) pixels. Smaller than the
// note-drag threshold because here the gesture's intent is unambiguous
// from the very first move (range-select), whereas in note-drag we want
// a real margin to avoid accidental nudges on a select-click.
const DRAG_THRESHOLD_PX = 4

const PLANE = new THREE.Plane(new THREE.Vector3(0, 0, 1), -NOTE_PLANE_Z)

export function EditTools() {
  const s = useSettingsSlice(EDIT_TOOLS_KEYS)
  const { camera, gl } = useThree()
  // Time-context for the geometry helpers. Same shape FallingNotes
  // builds; mirroring it here keeps click→time conversions aligned
  // with what the user sees under speed automation.
  const timeCtx: TimeContext = useMemo(
    () => ({
      speedMap: buildSpeedMap(s.midiSpeedAutomation),
      midiOffset: s.midiOffsetSec,
    }),
    [s.midiSpeedAutomation, s.midiOffsetSec],
  )

  // EditTools is conditionally mounted (only in edit mode). When the
  // user starts playback we unmount and the canvas cursor would be
  // stuck on whatever we last set — clear on unmount so the cursor
  // returns to the browser default.
  useEffect(() => {
    return () => {
      gl.domElement.style.cursor = ''
    }
  }, [gl])

  const screenToWorld = (clientX: number, clientY: number): THREE.Vector3 | null => {
    const canvas = gl.domElement
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -(((clientY - rect.top) / rect.height) * 2 - 1),
    )
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(ndc, camera)
    const out = new THREE.Vector3()
    if (!raycaster.ray.intersectPlane(PLANE, out)) return null
    return out
  }

  // Try to delete the topmost note whose visible rectangle contains the
  // given world point. Returns true if something was deleted, so callers
  // can lazily push the undo snapshot only on the first hit of a drag.
  const tryDeleteAt = (world: THREE.Vector3): boolean => {
    const cur = useStore.getState()
    if (!cur.song) return false
    const tl = audioEngine.currentSongTime()
    for (const n of cur.song.notes) {
      const b = noteVisualBounds(n, tl, cur.settings, timeCtx)
      if (!b) continue
      if (
        world.x >= b.xMin &&
        world.x <= b.xMax &&
        world.y >= b.yMin &&
        world.y <= b.yMax
      ) {
        // Spawn the death-particle puff at the note's current
        // rectangle before removing it from the song — once deleted,
        // its bounds vanish and we'd have nothing to drive the visual.
        noteDeathFx.emit({
          midi: n.midi + cur.settings.transpose,
          velocity: n.velocity,
          x: (b.xMin + b.xMax) / 2,
          centerY: (b.yMin + b.yMax) / 2,
          width: b.xMax - b.xMin,
          length: b.yMax - b.yMin,
          track: n.track,
          id: n.id,
        })
        cur.setSongPreview(deleteNotes(cur.song, [n.id]))
        if (cur.selection.has(n.id)) {
          const trimmed = new Set(cur.selection)
          trimmed.delete(n.id)
          cur.replaceSelection(trimmed)
        }
        return true
      }
    }
    return false
  }

  // Right-click drag: erase notes the cursor sweeps over. The whole
  // gesture is one undo entry — pre-drag song is captured the moment the
  // first note is hit, not at pointerdown, so a drag that never crosses a
  // note doesn't pollute the history stack.
  const beginEraseDrag = () => {
    const initialSong = useStore.getState().song
    if (!initialSong) return
    let pushedHistory = false
    // Switch to the eraser cursor for the entire gesture so the user
    // gets immediate feedback that their right-click is in delete mode.
    gl.domElement.style.cursor = ERASER_CURSOR
    const commitFirstHit = () => {
      if (pushedHistory) return
      useStore.getState().pushUndoSnapshot(initialSong)
      pushedHistory = true
    }

    const eraseAt = (world: THREE.Vector3) => {
      // tryDeleteAt may delete one note per call; loop until a sweep
      // through the note list doesn't find anything more under this
      // exact point. Catches cases where two notes overlap visually
      // (long sustain + short re-attack at the same pitch) so the user
      // doesn't have to wiggle the cursor to peel them off one by one.
      let deleted = false
      while (true) {
        const hit = tryDeleteAt(world)
        if (!hit) break
        if (!deleted) {
          commitFirstHit()
          deleted = true
        }
      }
    }

    const onMove = (ev: PointerEvent) => {
      // R3F's pointer events fire before the window-level pointermove
      // (R3F is listening on the canvas itself). EditTools' empty-area
      // onPointerMove sets cursor='crosshair' on every event, which
      // would clobber our eraser cursor mid-drag. Re-assert it here so
      // the cursor stays consistent for the whole gesture.
      gl.domElement.style.cursor = ERASER_CURSOR
      const w = screenToWorld(ev.clientX, ev.clientY)
      if (!w) return
      eraseAt(w)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      // Drop the eraser cursor — the next pointermove decides what
      // cursor the canvas should show.
      gl.domElement.style.cursor = ''
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  // Cmd/Ctrl + drag: marquee range-select. Gated on the modifier so a
  // drift on a plain click can't accidentally start one. Always additive
  // — preserves the current selection so multi-region scoping is easy.
  // Each note's first entry into the marquee plays a brief preview cue.
  const beginRangeSelectDrag = (
    startWorld: THREE.Vector3,
    startClient: { x: number; y: number },
  ) => {
    const initialSelection = new Set(useStore.getState().selection)
    let lastAppliedSelection = new Set(initialSelection)
    let started = false

    const onMove = (ev: PointerEvent) => {
      if (!started) {
        const cdx = ev.clientX - startClient.x
        const cdy = ev.clientY - startClient.y
        if (cdx * cdx + cdy * cdy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return
        started = true
      }
      // Re-assert the marquee cursor on every move so EditTools'
      // empty-area onPointerMove (which sets crosshair) can't override
      // it during the drag. Same rationale as the eraser cursor.
      gl.domElement.style.cursor = RANGE_SELECT_CURSOR
      useStore.getState().setRangeSelectRect({
        x1: startClient.x,
        y1: startClient.y,
        x2: ev.clientX,
        y2: ev.clientY,
      })
      const w2 = screenToWorld(ev.clientX, ev.clientY)
      if (!w2) return
      const xMin = Math.min(startWorld.x, w2.x)
      const xMax = Math.max(startWorld.x, w2.x)
      const yMin = Math.min(startWorld.y, w2.y)
      const yMax = Math.max(startWorld.y, w2.y)

      const newSel = new Set<number>(initialSelection)
      const cur = useStore.getState()
      if (cur.song) {
        const tl = audioEngine.currentSongTime()
        for (const n of cur.song.notes) {
          const b = noteVisualBounds(n, tl, cur.settings, timeCtx)
          if (!b) continue
          if (b.xMax < xMin || b.xMin > xMax) continue
          if (b.yMax < yMin || b.yMin > yMax) continue
          newSel.add(n.id)
        }
        for (const id of newSel) {
          if (!lastAppliedSelection.has(id)) {
            const note = cur.song.notes.find((n) => n.id === id)
            if (note) {
              void previewNote(
                note.midi + cur.settings.transpose,
                note.velocity,
                150,
              )
            }
          }
        }
      }
      lastAppliedSelection = newSel
      useStore.getState().replaceSelection(newSel)
    }

    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      useStore.getState().setRangeSelectRect(null)
      // Drop the marquee cursor; the next pointermove decides what
      // cursor the canvas should show next.
      gl.domElement.style.cursor = ''
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  // Plain left-pointerdown on empty area: creates a new note immediately
  // and arms a drag session for it. Releasing without movement leaves
  // the note where it spawned; subsequent cursor movement repositions
  // it (Y → time, X → snapped semitone). One pointerdown collapses to
  // one undo entry regardless of whether the user dragged.
  const beginNewNoteDrag = (
    startWorld: THREE.Vector3,
    startClient: { x: number; y: number },
  ) => {
    const cur = useStore.getState()
    const settings = cur.settings
    const hitY = NOTE_HIT_Y
    if (startWorld.y <= hitY) return // below hit line: no-op

    // Bootstrap an empty song on first add when nothing is loaded so
    // the user can compose from scratch. setSong wipes editHistory, so
    // we capture the empty baseline as the very first undo snapshot
    // ourselves below.
    const baseSong: ParsedSong = cur.song ?? EMPTY_SONG
    if (!cur.song) {
      useStore.getState().setSong(baseSong)
    }

    const tl = audioEngine.currentSongTime()
    const time = clickYToTime(startWorld.y, tl, settings, timeCtx)
    const midi = clickXToMidi(startWorld.x, settings.transpose)

    // New notes inherit the duration & velocity AND track of the most
    // recently edited single note (resized, velocity-changed, or just
    // selected). Track inheritance lets the new note pick up the
    // per-track colour without manual book-keeping — keep tapping in
    // the "right hand" track and additions stay coloured for that hand.
    const newDuration = cur.lastNoteParams?.duration ?? FALLBACK_DURATION
    const newVelocity = cur.lastNoteParams?.velocity ?? FALLBACK_VELOCITY
    const newTrack = cur.lastNoteParams?.track ?? 0

    // Push the pre-add snapshot first so a single undo step fully
    // reverses the click + any subsequent drag motion.
    useStore.getState().pushUndoSnapshot(baseSong)

    const result = addNote(
      baseSong,
      midi,
      Math.max(0, time),
      newDuration,
      newVelocity,
      newTrack,
    )
    cur.setSongPreview(result.song)
    cur.replaceSelection([result.id])
    void previewNote(midi + settings.transpose, newVelocity, 200)

    // Drag-to-position. The post-add song is the snapshot we apply
    // moveNotes deltas against, so the new note keeps its identity
    // (id) across the gesture even as its time/midi shift.
    const noteId = result.id
    const snapshot = result.song
    const anchorDisplayedMidi = midi + settings.transpose
    const anchorIdx = anchorDisplayedMidi - MIDI_MIN
    if (anchorIdx < 0 || anchorIdx >= KEY_COUNT) return
    const anchorOriginalDisplayedX = parallaxX(KEYBOARD_LAYOUT.keys[anchorIdx].x)

    let lastDeltaSemis = 0
    let started = false

    const onMove = (ev: PointerEvent) => {
      // Tiny drift on a click-and-release shouldn't visibly nudge the
      // new note. Past the threshold, every subsequent move is applied.
      if (!started) {
        const cdx = ev.clientX - startClient.x
        const cdy = ev.clientY - startClient.y
        if (cdx * cdx + cdy * cdy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return
        started = true
      }
      const w = screenToWorld(ev.clientX, ev.clientY)
      if (!w) return

      const dx = w.x - startWorld.x
      const dy = w.y - startWorld.y

      const live = useStore.getState().settings
      const fd = fallDistance()
      const dirSign = live.fallDirection === 'down' ? 1 : -1
      const deltaTime = dirSign * (dy / fd) * live.fallDurationSec

      const newAnchorMidi = clickXToMidi(anchorOriginalDisplayedX + dx, 0)
      const deltaSemis = newAnchorMidi - anchorDisplayedMidi

      if (deltaSemis !== lastDeltaSemis) {
        lastDeltaSemis = deltaSemis
        // Audible feedback when the snapped pitch crosses to a new key.
        void previewNote(anchorDisplayedMidi + deltaSemis, newVelocity, 150)
      }

      const next = moveNotes(snapshot, [noteId], deltaTime, deltaSemis)
      useStore.getState().setSongPreview(next)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    const native = e.nativeEvent

    // Edit gestures require the sampler to be ready. Two reasons:
    //   1. Without it, `previewNote` silently drops to avoid the
    //      chord-burst that used to happen when queued previews all
    //      fired on sampler-ready (see `audio/preview.ts`).
    //   2. Starting a drag whose audio quietly disappears reads as
    //      broken — better to swallow this click and start the load,
    //      so the user's next click works as expected.
    if (!audioEngine.isReady()) {
      void ensureSamplerLoaded()
      return
    }

    // Right button → eraser drag.
    if (native.button === 2) {
      beginEraseDrag()
      return
    }

    // Middle button is reserved for camera orbit/pan
    // (see scene/CameraControls.tsx) — don't spawn a note.
    if (native.button === 1) return

    const additive = native.ctrlKey || native.metaKey
    const startWorld = e.point.clone()
    const startClient = { x: native.clientX, y: native.clientY }

    if (additive) {
      // Cmd/Ctrl + drag → marquee range-select. Cmd+click without drag
      // is implicitly a no-op since the marquee handler only acts on
      // movement and onUp does no fallback action.
      beginRangeSelectDrag(startWorld, startClient)
    } else {
      // Plain left → create note + reposition while held.
      beginNewNoteDrag(startWorld, startClient)
    }
  }

  // Empty-area cursor hints.
  // - Above the hit line → crosshair (= "click here drops a new note").
  // - Below the hit line → default cursor: clicks are no-ops there
  //   (a note placed in the audible past isn't useful) so a creation
  //   cursor would be misleading.
  // FallingNotes' onPointerMove takes over when the cursor sits on a
  // note — no contention here since the InstancedMesh is at a closer
  // z and intercepts the events first.
  const onUpperAreaMove = () => {
    gl.domElement.style.cursor = 'crosshair'
  }
  const onLowerAreaMove = () => {
    gl.domElement.style.cursor = ''
  }
  const onAreaPointerOut = () => {
    gl.domElement.style.cursor = ''
  }

  return (
    <>
      {PICK_PLANES.map((p) => (
        <mesh
          key={p.name}
          position={p.position}
          onPointerDown={onPointerDown}
          onPointerMove={p.name === 'above' ? onUpperAreaMove : onLowerAreaMove}
          onPointerOut={onAreaPointerOut}
        >
          <planeGeometry args={p.size} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      ))}
    </>
  )
}

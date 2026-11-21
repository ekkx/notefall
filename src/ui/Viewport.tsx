import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Scene } from "../scene/Scene";
import { SelectionCard } from "./SelectionCard";
import { Icon } from "./kit";
import { useIdle } from "./shell/idle";
import { useStore } from "../store";
import { audioEngine } from "../audio/engine";

const ASPECT = 16 / 9;
// Wheel-to-seek sensitivity. 0.005s per CSS pixel of deltaY → a typical
// mouse wheel notch (~100px) advances the song by ~0.5s, while trackpads
// scrub at finer increments naturally. Direction: deltaY > 0 (wheel down)
// scrubs forward in time, matching the "scrolling down a timeline" mental
// model.
const WHEEL_SECONDS_PER_PX = 0.005;
// Normalise WheelEvent.deltaMode (0=px, 1=line, 2=page) into pixels so the
// same sensitivity coefficient works regardless of input device.
const LINE_PX = 16;
const PAGE_PX = 800;

// How long the transport feedback badge stays at full opacity before it
// pops back out. Plus the ~250ms transition this gives roughly a second of
// total presence — long enough to read clearly without lingering.
const FEEDBACK_VISIBLE_MS = 800;
// Easing curves: a back-out cubic on appear gives the badge an overshoot
// that reads as a soft "pop", and a snappier ease-in on hide makes it
// shrink decisively rather than sliding away.
const FEEDBACK_EASE_IN = "cubic-bezier(0.175, 0.885, 0.32, 1.4)";
const FEEDBACK_EASE_OUT = "cubic-bezier(0.4, 0, 1, 1)";

/**
 * Transient centered play / pause badge fired on every transport toggle.
 * Like a video player, the icon flashes briefly to acknowledge the action
 * (play icon when starting, pause icon when stopping) and then fades out.
 * Does not gate on `transport !== 'playing'` — it's a transition cue, not
 * a persistent state indicator. `pointer-events-none` so the underlying
 * canvas still receives clicks for play/pause toggling.
 */
function TransportFeedback() {
  const transport = useStore((s) => s.transport);
  const song = useStore((s) => s.song);
  const loadStatus = useStore((s) => s.loadStatus);
  const [feedback, setFeedback] = useState<"play" | "pause" | null>(null);
  // Latched icon: kept around during the fade-out so the icon doesn't swap
  // mid-animation if the next transition arrives before this one finishes.
  const [displayIcon, setDisplayIcon] = useState<"play" | "pause">("play");
  const prevTransportRef = useRef(transport);
  // The very first play after sample loading isn't a user "toggle" — the
  // user already pressed play earlier and was just waiting on the load —
  // so the badge would feel redundant. We mark this state when loadStatus
  // resolves to 'ready' and consume it on the next 'playing' transition.
  const skipNextPlayRef = useRef(false);

  useEffect(() => {
    if (loadStatus.state === "ready") skipNextPlayRef.current = true;
  }, [loadStatus]);

  useEffect(() => {
    const prev = prevTransportRef.current;
    prevTransportRef.current = transport;
    // Only react to actual transitions, and only once a song is loaded so
    // initial mount ('stopped' → 'stopped' once a song lands) doesn't fire.
    if (prev === transport || !song) return;
    if (transport === "playing") {
      if (skipNextPlayRef.current) {
        skipNextPlayRef.current = false;
        return;
      }
      setDisplayIcon("play");
      setFeedback("play");
    } else if (prev === "playing") {
      setDisplayIcon("pause");
      setFeedback("pause");
    }
  }, [transport, song]);

  useEffect(() => {
    if (feedback === null) return;
    const t = window.setTimeout(() => setFeedback(null), FEEDBACK_VISIBLE_MS);
    return () => clearTimeout(t);
  }, [feedback]);

  const visible = feedback !== null;
  return (
    <div
      className="pointer-events-none absolute inset-0 flex items-center justify-center pb-[15%]"
      aria-hidden={!visible}
    >
      <div
        style={{
          transitionTimingFunction: visible
            ? FEEDBACK_EASE_IN
            : FEEDBACK_EASE_OUT,
        }}
        className={`nf-glass-strong grid h-20 w-20 place-items-center rounded-round text-ink transition-[opacity,transform] duration-200 ${
          visible ? "scale-100 opacity-100" : "scale-50 opacity-0"
        }`}
      >
        {displayIcon === "pause" ? (
          <Icon.PauseIcon className="h-9 w-9" />
        ) : (
          <Icon.PlayIcon className="ml-1 h-9 w-9" />
        )}
      </div>
    </div>
  );
}

/**
 * Marquee rectangle for range-select while in edit mode. The rect is
 * stored in client (CSS) coords by EditTools' window-level pointermove,
 * which means we have to subtract the wrapper element's bounding box to
 * place the div correctly relative to the letterboxed Canvas. `pointer-
 * events-none` so the underlying canvas / EditTools mesh keeps receiving
 * the in-flight pointer events that drive the rect.
 */
function RangeSelectRect({ wrapEl }: { wrapEl: HTMLElement | null }) {
  const rect = useStore((s) => s.rangeSelectRect);
  if (!rect || !wrapEl) return null;
  const r = wrapEl.getBoundingClientRect();
  const left = Math.min(rect.x1, rect.x2) - r.left;
  const top = Math.min(rect.y1, rect.y2) - r.top;
  const width = Math.abs(rect.x2 - rect.x1);
  const height = Math.abs(rect.y2 - rect.y1);
  return (
    <div
      className="pointer-events-none absolute border border-ink-muted bg-fill-hover"
      style={{ left, top, width, height }}
      aria-hidden
    />
  );
}

/**
 * Top-center pill shown while the user is holding the falling-notes area
 * to fast-forward. `pointer-events-none` so the underlying click-to-hold
 * region keeps receiving events for the entire hold duration.
 */
function FastForwardIndicator() {
  const { t } = useTranslation("dialogs");
  const fastForward = useStore((s) => s.fastForward);
  return (
    <div
      className={`pointer-events-none absolute left-1/2 top-[84px] -translate-x-1/2 transition-all duration-150 ${
        fastForward ? "scale-100 opacity-100" : "scale-90 opacity-0"
      }`}
      aria-hidden={!fastForward}
    >
      <div className="nf-glass-strong flex h-control items-center gap-2 rounded-round px-3.5 text-label text-ink">
        <Icon.FastForwardIcon className="h-[17px] w-[17px]" />
        <span>{t("fastForward.rate")}</span>
      </div>
    </div>
  );
}

export function Viewport() {
  const wrapRef = useRef<HTMLDivElement>(null);
  // Ref to the INNER letterboxed div. Range-select / future overlays
  // position absolutely inside this element, so their offsets need this
  // div's bounding rect — not the outer DropZone, which spans the full
  // available area and is offset from the canvas by the letterbox bars.
  const innerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  // Drives the click-eater overlay: while samples are being downloaded
  // we shouldn't let any canvas interaction (play toggle, eraser, new
  // note, range-select, hold-to-fast-forward) fire. The floating chrome
  // stays live since it sits outside the canvas.
  const isLoading =
    useStore((s) => s.loadStatus.state) === "loading";
  // The cursor hides with the chrome after a stretch of no movement while playing.
  const cursorHidden = useIdle((s) => s.hidden && s.holds.size === 0);

  // Suppress the browser's native context menu over the 3D canvas while a
  // song is loaded — right-click is repurposed as the per-note context
  // menu, and the browser default would either pop up alongside it or
  // (when right-clicking empty space) get in the way of the editing flow.
  // Outside the canvas (Inspector, Toolbar, Popovers) the browser menu
  // stays untouched so users can still inspect / view-source / paste etc.
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.tagName === "CANVAS") e.preventDefault();
    };
    window.addEventListener("contextmenu", onCtx);
    return () => window.removeEventListener("contextmenu", onCtx);
  }, []);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const containerAspect = r.width / r.height;
      let w: number, h: number;
      if (containerAspect > ASPECT) {
        h = r.height;
        w = h * ASPECT;
      } else {
        w = r.width;
        h = w / ASPECT;
      }
      setSize({ w, h });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Wheel-to-seek over the canvas while in edit mode. Reaching for the
  // seek bar every time interrupts the editing flow — scrolling lets the
  // user scrub time without leaving the cursor. Listener is on the inner
  // letterboxed div so it covers the canvas + SeekBar + indicators but
  // NOT the Inspector / Toolbar (those keep native scroll behaviour).
  // Gated on edit mode (song loaded, not playing, sampler not loading)
  // so the wheel doesn't fight the play surface or fire during the
  // sample download. `passive: false` is required to call preventDefault.
  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // Ctrl/Cmd + wheel is reserved for the camera dolly
      // (see scene/CameraControls.tsx) — let it through unhandled.
      if (e.ctrlKey || e.metaKey) return;
      const s = useStore.getState();
      if (!audioEngine.hasTimeline()) return;
      if (s.transport === "playing") return;
      if (s.loadStatus.state === "loading") return;
      const unit =
        e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? PAGE_PX : 1;
      const dt = e.deltaY * unit * WHEEL_SECONDS_PER_PX;
      if (dt === 0) return;
      e.preventDefault();
      // Source of truth is the engine's clock, not the store's
      // currentTime — the store only updates on SeekBar drags / skip
      // buttons and would lag the actual playhead in the paused
      // state. `currentSongTime` is TL_audio (the elapsed-time axis
      // that `seek` expects); the wheel delta is in wall-clock
      // seconds so adding directly is correct.
      const cur = audioEngine.currentSongTime();
      const duration = audioEngine.timelineEnd();
      const next = Math.max(0, Math.min(duration, cur + dt));
      if (next === cur) return;
      audioEngine.seek(next);
      s.setCurrentTime(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Drag-and-drop is now wired at the window level (`useFileDrop` in
  // `Layout.tsx`) so a drop anywhere over the app — Toolbar, Inspector,
  // canvas — routes the file. The earlier Viewport-scoped `DropZone` was
  // too narrow: users routinely dropped onto the Inspector or Toolbar
  // and saw nothing happen.
  return (
    <div
      ref={wrapRef}
      className="absolute inset-0 flex items-center justify-center overflow-hidden bg-canvas outline-none"
    >
      <div
        ref={innerRef}
        className={`relative ${cursorHidden ? "cursor-none" : ""}`}
        style={{ width: size.w, height: size.h, touchAction: "none" }}
      >
        <Scene />
        {/* Click-eater while the sampler is loading. Sits above the Scene
            canvas, so canvas interactions are blocked but the floating
            chrome stays live. cursor-wait gives the visual feedback that
            interaction is paused. */}
        {isLoading && (
          <div
            aria-hidden
            className="absolute inset-0 cursor-wait"
          />
        )}
        <TransportFeedback />
        <FastForwardIndicator />
        <RangeSelectRect wrapEl={innerRef.current} />
        <SelectionCard wrapEl={innerRef.current} />
      </div>
    </div>
  );
}

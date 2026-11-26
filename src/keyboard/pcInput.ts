import { useEffect } from "react";
import * as Tone from "tone";
import { audioEngine } from "../audio/engine";
import { markLivePlay } from "../usage";
import { useStore } from "../store";
import { useHandVideo } from "../video/handVideo";

// PC keyboard → MIDI mapping. ZXCV/ASDF rows = lower octave (white/sharps),
// QWERTY/digit rows = upper octave. Some pitches reachable from multiple
// keys (e.g. q/, both = C4); distinct keys trigger separate voices.
const PC_KEY_NOTES: Record<string, number> = {
  KeyZ: 48, KeyX: 50, KeyC: 52, KeyV: 53, KeyB: 55, KeyN: 57, KeyM: 59,
  Comma: 60, Period: 62, Slash: 64,
  KeyS: 49, KeyD: 51, KeyG: 54, KeyH: 56, KeyJ: 58, KeyL: 61, Semicolon: 63,
  KeyQ: 60, KeyW: 62, KeyE: 64, KeyR: 65, KeyT: 67, KeyY: 69, KeyU: 71,
  KeyI: 72, KeyO: 74, KeyP: 76, BracketLeft: 77, BracketRight: 79,
  Digit2: 61, Digit3: 63, Digit5: 66, Digit6: 68, Digit7: 70, Digit9: 73,
  Digit0: 75, Equal: 78,
};

const isEditable = (el: EventTarget | null): boolean => {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable
  );
};

/**
 * PC keyboard input — same lifecycle as touch. Skipped on editable focus
 * and modifiers (incl. Shift, reserved for Shift+R record). Window blur
 * releases everything. Global `transpose` applies.
 */
export function usePcKeyboardInput(ensureAudio: () => Promise<boolean>) {
  useEffect(() => {
    const pressed = new Map<string, () => void>();
    const pending = new Set<string>();

    const onDown = async (e: KeyboardEvent) => {
      // No piano while the hand video setup has the keyboard.
      if (useHandVideo.getState().editing) return;
      // Shift is reserved for global shortcuts (e.g. Shift+R for record).
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      // Check the focused element too: a field that keeps focus while it forwards keys to a list (react-aria's
      // Autocomplete re-dispatches them on the menu) would otherwise play the piano while typing.
      if (isEditable(e.target) || isEditable(document.activeElement)) return;
      const baseMidi = PC_KEY_NOTES[e.code];
      if (baseMidi === undefined) return;
      e.preventDefault();
      if (pressed.has(e.code) || pending.has(e.code)) return;

      const transpose = useStore.getState().settings.transpose;
      const midi = baseMidi + transpose;
      if (midi < 0 || midi > 127) return;
      markLivePlay("pc_keyboard");

      if (Tone.getContext().state !== "running") {
        try {
          await Tone.start();
        } catch {
          /* ignored */
        }
      }

      if (audioEngine.isReady()) {
        const handle = audioEngine.triggerKey(midi, 0.78);
        if (handle) pressed.set(e.code, handle.release);
        return;
      }

      pending.add(e.code);
      const ready = await ensureAudio();
      if (!pending.has(e.code)) return;
      pending.delete(e.code);
      if (!ready) return;
      const handle = audioEngine.triggerKey(midi, 0.78);
      if (handle) pressed.set(e.code, handle.release);
    };

    const onUp = (e: KeyboardEvent) => {
      const release = pressed.get(e.code);
      if (release) {
        release();
        pressed.delete(e.code);
      }
      pending.delete(e.code);
    };

    const releaseAll = () => {
      for (const r of pressed.values()) r();
      pressed.clear();
      pending.clear();
    };

    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    // Drop everything on tab switch so keys don't get stuck.
    window.addEventListener("blur", releaseAll);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", releaseAll);
      releaseAll();
    };
  }, [ensureAudio]);
}

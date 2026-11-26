import { useMemo, useRef, useEffect, useCallback } from "react";
import * as THREE from "three";
import * as Tone from "tone";
import { hitLineColoring, NoteColorResolver, writeGradientUniforms } from "../notes/noteColor";
import { markLivePlay } from "../usage";
import { useFrame, useThree } from "@react-three/fiber";
import type { ThreeEvent } from "@react-three/fiber";
import {
  BLACK_KEY_LENGTH,
  BLACK_KEY_THICKNESS,
  KEYBOARD_LAYOUT,
  KEYBOARD_Y,
  KEY_COUNT,
  MIDI_MAX,
  MIDI_MIN,
  NOTE_HIT_Y,
  WHITE_KEY_LENGTH,
  WHITE_KEY_WIDTH,
} from "./layout";
import {
  BLACK_KEY_GEOMETRY,
  WHITE_BODY_FRONT_MATERIAL,
  WHITE_BODY_MATERIALS,
  WHITE_BODY_WOOD_MATERIAL,
  WOOD_COLOR,
  WHITE_CAP_THICKNESS,
  whiteBodyGeometryFor,
  whiteKeyGeometryFor,
  WOOD_TOP_GAP,
} from "./geometry";
import { flashLights } from "./flashLights";
import {
  ACTIVE_SHADOW_GROW,
  BLACK_KEY_BOUNDS,
  BLACK_KEY_COUNT,
  BLACK_KEY_INDICES,
  LIGHT_BOOST_BASE,
  LIGHT_FALLOFF_X_BASE,
  LIGHT_FALLOFF_Y_BASE,
  LIGHT_Z,
  MAX_LIGHTS,
  SHADOW_HALO_BASE,
  patchWhiteKeyMaterial,
  patchBodyFrontShade,
  hitLightUniforms,
  frontShadeUniform,
  type SharedLightUniforms,
  type WhiteKeyUniforms,
} from "./whiteKeyShader";
import { usePcKeyboardInput } from "./pcInput";
import { retriggerDip } from "./retriggerDip";
import { useStore, useSettingsSlice, HIT_LINE_DEFAULT_BRIGHTNESS } from "../store";
import { MAX_LIVE_VISIBLE_ABOVE_HIT } from "../scene/visibleTop";
import { getResolvedSettings } from "../scene/automatedSettings";

// Key labels: glyph height (world units, size 1). Black-key labels sit on
// the flat top face (past the front slope, within the tapered width) so
// they lie on the key instead of hovering over the slope.
const KEY_LABEL_HEIGHT = 0.2;
const BLACK_TOP_FROM_FRONT = BLACK_TOP_FRONT_Y + BLACK_KEY_LENGTH / 2;
const BLACK_TOP_WIDTH = BLACK_TOP_HALF_W * 2 - 0.016;
const KEY_LABEL_COLOR = new THREE.Color();
const KEY_LABEL_LOCAL = new THREE.Matrix4();
const KEY_LABEL_MATRIX = new THREE.Matrix4();

const KEYBOARD_KEYS = [
  "blackKeyColor",
  "cameraFov",
  "cameraLookAt",
  "cameraPos",
  "hitLight",
  "hitLightEnabled",
  "hitLightFollowNote",
  "hitLightWidth",
  "hitLightReach",
  "hitLightWhiten",
  "hitLightColor",
  "keyboardBrightness",
  "whiteKeyFrontShade",
  "keyHitLineLight",
  "keyHitLineReach",
  "keyboardScreenY",
  "keyGlowColor",
  "keyGlowDecay",
  "keyGlowEnabled",
  "keyGlowFollowNote",
  "keyGlowIntensity",
  "keyLabelsEnabled",
  "keyLabelsMode",
  "keyLabelFormat",
  "keyLabelAccidental",
  "noteColor",
  "octaveLinesEnabled",
  "trackColors",
  "whiteKeyColor",
] as const;
import { audioEngine } from "../audio/engine";
import { clockEpoch, now } from "../audio/clock";
import { createLabelMesh, labelAtlas, LABEL_CELL_ASPECT, type LabelMesh } from "../notes/pitchLabels";
import { BLACK_TOP_FRONT_Y, BLACK_TOP_HALF_W } from "./geometry";

// Press animation: each key's group sits at the rear edge; press dips
// `position.z = -PIVOT_DIP × p` and tilts `rotation.x = ANGLE × p`.
// PIVOT_DIP gives the whole key a "settle" without which the rear reads
// as rigidly fixed. ANGLE is derived so total front-tip drop = PRESS_DEPTH.
const PRESS_TC = 0.022;
const WHITE_PRESS_DEPTH = 0.12;
const BLACK_PRESS_DEPTH = 0.08;
const WHITE_PIVOT_DIP = 0.035;
const BLACK_PIVOT_DIP = 0.05;
const WHITE_PRESS_ANGLE =
  (WHITE_PRESS_DEPTH - WHITE_PIVOT_DIP) / WHITE_KEY_LENGTH;
const BLACK_PRESS_ANGLE =
  (BLACK_PRESS_DEPTH - BLACK_PIVOT_DIP) / BLACK_KEY_LENGTH;

// Clip for the white keys (cap and wood body): the plane through the camera
// and the keyboard's top back edge (the hit line), keeping the side in
// front. The camera sits above the keyboard, so anything deeper at the back
// edge — the keys' rear walls, the wood walls of the gaps between keys —
// projects ABOVE the edge on screen. The hit line normally covers that; with
// it off it showed as wood-coloured slivers. With this plane nothing of the
// white keys draws above the edge line. The cut opens onto the background
// (inner walls are back-face culled). Re-aimed every frame since the camera
// can move; WHITE_REAR_CLIP keeps the edge itself off the plane.
const WHITE_REAR_CLIP = 0.001;
const WHITE_KEY_CLIP = new THREE.Plane();
const WHITE_KEY_CLIP_PLANES = [WHITE_KEY_CLIP];
// The wood walls are only seen through the thin gaps between white keys; darken them toward the near-black lines of a real keyboard.
const GAP_WOOD_DARKEN = 0.2;
for (const m of WHITE_BODY_MATERIALS) {
  m.clippingPlanes = WHITE_KEY_CLIP_PLANES;
  patchBodyFrontShade(m as THREE.MeshStandardMaterial, m === WHITE_BODY_WOOD_MATERIAL ? GAP_WOOD_DARKEN : 1);
}
const CLIP_EDGE_POINT = new THREE.Vector3(0, NOTE_HIT_Y - WHITE_REAR_CLIP, 0);
const CLIP_NORMAL_SCRATCH = new THREE.Vector3();

// Retrigger lift: a note-on that lands while the key is still (mostly)
// down — same-pitch notes with a tiny or zero gap, where the off and the
// next on can even arrive in the same frame — would leave the key looking
// held through both notes. Instead the key rises for RETRIGGER_LIFT_SECONDS
// before pressing again. Long enough for PRESS_TC to bring it nearly all
// the way up, and longer than one frame at 24 fps so exports show it too.
const RETRIGGER_LIFT_SECONDS = 0.05;
const RETRIGGER_PRESS_THRESHOLD = 0.35;
// The key light (glow here, the flash via `retriggerDip`) dims with the lift
// rather than blinking off: it eases toward
// RETRIGGER_GLOW_FLOOR of its level with time constant RETRIGGER_GLOW_TC,
// then eases back, so a fast run of repeats doesn't flicker.
const RETRIGGER_GLOW_FLOOR = 0.3;
const RETRIGGER_GLOW_TC = 0.03;

// Slope tint: per-frame, slope material's color = lerp(blackKeyColor, white,
// FACTOR). 0.12 is "若干明るい" — a perceptible but not dramatic step up.
const SLOPE_TINT_TARGET = new THREE.Color(1, 1, 1);
const SLOPE_TINT_FACTOR = 0.12;

// Front-fillet ("seam" between slope and top face) base color — a fixed
// gray, multiplied by keyboardBrightness in useFrame. Static, not derived
// from blackKeyColor, so the seam stays visible regardless of theme.
const FILLET_FRONT_COLOR = new THREE.Color("#808080");

// Black-key press tint: when held, lerp every surface (body / slope /
// fillet-front) toward the glow color by `glow × this`. Without this,
// only the emissive channel carried the press color, which read as
// "lit from inside" on the flat top but barely registered on the
// slope / sides because their dark base color dominated under shading.
// Tinting the actual base color makes the entire key visibly take on
// the press color, not just the most directly-lit face.
const BLACK_PRESS_TINT_STRENGTH = 0.85;
// Reusable scratch instance — lerping the press tint allocates nothing.
const PRESS_TINT_SCRATCH = new THREE.Color();

// Target the hit lights' colour is lerped toward (hitLightWhiten).
const WHITE_LIGHT_TARGET = new THREE.Color(1, 1, 1);

// The hit lights (the piano's own light at a hit) light the keys AND the hands, independent of the flash sprite's
// settings: `hitLight` (1 = default) scales the strength, `hitLightWidth` / `hitLightReach` (1 = default) the
// sideways / front falloff.
const KEY_LIGHT_STRENGTH_BASE = 0.5; // uLightStrength at hitLight = 1
// The hands' light is lifted this much further toward white than the keys' (hitLightWhiten default 0.3 + this =
// the 0.5 lift the hands had when they followed the flash's brightness).
const HANDS_WHITEN_OFFSET = 0.2;
// Per-slot colour of the key lights (the hands have their own, `flashLights.colors`).
const KEY_LIGHT_COLORS = new Float32Array(MAX_LIGHTS * 3);
// Scratch reused in the per-frame per-slot colour resolver so the lerp
// + hex parse don't allocate on every frame.
const LIGHT_COLOR_SCRATCH = new THREE.Color();

export function Keyboard() {
  const settings = useSettingsSlice(KEYBOARD_KEYS);
  const setLoadStatus = useStore((s) => s.setLoadStatus);
  const { gl } = useThree();

  // Hover counter + deferred reset: a horizontal cursor sweep across
  // adjacent key meshes fires OUT(prev) → OVER(next) pairs in either
  // order (R3F's order depends on raycast). Naively setting/clearing
  // the cursor flickers; counting+deferring keeps it stable.
  const hoverCountRef = useRef(0);
  const resetTimerRef = useRef<number | null>(null);
  const onKeyPointerOver = useCallback(() => {
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
    hoverCountRef.current++;
    gl.domElement.style.cursor = "pointer";
  }, [gl]);
  const onKeyPointerOut = useCallback(() => {
    hoverCountRef.current = Math.max(0, hoverCountRef.current - 1);
    if (hoverCountRef.current === 0) {
      if (resetTimerRef.current !== null)
        window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = window.setTimeout(() => {
        resetTimerRef.current = null;
        if (hoverCountRef.current === 0) gl.domElement.style.cursor = "";
      }, 0);
    }
  }, [gl]);

  const glow = useMemo(() => new Float32Array(KEY_COUNT), []);
  const held = useMemo(() => new Uint8Array(KEY_COUNT), []);
  const press = useMemo(() => new Float32Array(KEY_COUNT), []);
  // Absolute time until which a retriggered key is held up (see
  // RETRIGGER_LIFT_SECONDS). Reset on clock epoch like glow / press.
  const liftUntil = useMemo(() => new Float64Array(KEY_COUNT), []);
  // Glow as drawn this frame: `glow` scaled by `retriggerDip`, which dims
  // while a key lifts, so the emissive, black-key tint, and the light /
  // shadow on the white keys all dim with it. `glow` keeps integrating.
  const shownGlow = useMemo(() => new Float32Array(KEY_COUNT), []);
  const lastEpoch = useRef(clockEpoch());
  // World-space clip applied to the black-key materials: keep only
  // geometry at or in front of the keyboard's back edge (the hit line,
  // world Y = NOTE_HIT_Y). Black keys are modelled
  // 0.01 past that edge (to kill a white sliver at the shared seam) and
  // tilt rearward when pressed — without this clip that coloured rear
  // pokes up above the keyboard into the falling-note lane. Normal is
  // -Y so the kept half-space is y <= constant. Cutting through the geometry is
  // safe: black keys have an inner solid fill, so the cross-section
  // reads as the key colour rather than a hollow shell.
  const blackKeyClip = useMemo(
    () => new THREE.Plane(new THREE.Vector3(0, -1, 0), NOTE_HIT_Y),
    [],
  );
  // Stable array identity so r3f doesn't re-assign the prop every frame.
  const blackKeyClipPlanes = useMemo(() => [blackKeyClip], [blackKeyClip]);
  // Scratch buffer for top-K light selection; allocated once to keep
  // useFrame allocation-free.
  const claimed = useMemo(() => new Uint8Array(KEY_COUNT), []);

  const meshRefs = useRef<(THREE.Mesh | null)[]>([]);
  // Group wraps each key with its origin at the rear pivot; animating the
  // group's rotation+position tilts/dips the key during press.
  const keyGroupRefs = useRef<(THREE.Group | null)[]>([]);
  const matRefs = useRef<(THREE.MeshStandardMaterial | null)[]>([]);
  // Slope-only material per black key (material slot 1). Tinted slightly
  // brighter than the body so the slope reads as a distinct surface.
  const slopeMatRefs = useRef<(THREE.MeshStandardMaterial | null)[]>([]);
  // Front-fillet material per black key (material slot 2). Fixed gray;
  // emissive mirrors the body so the seam glows along with key presses.
  const filletMatRefs = useRef<(THREE.MeshStandardMaterial | null)[]>([]);

  const whiteKeyUniforms = useMemo(() => {
    const arr: (WhiteKeyUniforms | null)[] = new Array(KEY_COUNT).fill(null);
    for (let i = 0; i < KEY_COUNT; i++) {
      const k = KEYBOARD_LAYOUT.keys[i];
      if (k.isBlack) continue;
      arr[i] = {
        uMeshOriginXY: { value: new THREE.Vector2(k.x, k.yLocal) },
        uLightZ: { value: LIGHT_Z },
        uBlackKeyTop: { value: BLACK_KEY_THICKNESS },
      };
    }
    return arr;
  }, []);

  // Shared across every white-key material; in-place Float32Array updates
  // in useFrame propagate to all 52 materials via the {value} reference.
  const sharedLightUniforms = useMemo<SharedLightUniforms>(
    () => ({
      uBlackBounds: { value: BLACK_KEY_BOUNDS },
      // The arrays are shared with `flashLights` so the hands read the same slots.
      uLightXYs: { value: flashLights.xy },
      uLightIntensities: { value: flashLights.intensities },
      uLightStrength: { value: 0 },
      uBlackGlow: { value: new Float32Array(BLACK_KEY_COUNT) },
      uActiveShadowGrow: { value: ACTIVE_SHADOW_GROW },
      uLightBoost: { value: LIGHT_BOOST_BASE },
      uFalloffX: { value: LIGHT_FALLOFF_X_BASE },
      uFalloffY: { value: LIGHT_FALLOFF_Y_BASE },
      uShadowHalo: { value: SHADOW_HALO_BASE },
      // Per-slot tint, packed as [r,g,b] × MAX_LIGHTS. Each slot can
      // carry its own (per-track) colour so simultaneously-active keys
      // from different tracks light the keyboard in different hues.
      uLightColors: { value: KEY_LIGHT_COLORS },
    }),
    [],
  );

  const whiteKeyMaterials = useMemo(() => {
    const arr: (THREE.MeshStandardMaterial | null)[] = new Array(
      KEY_COUNT,
    ).fill(null);
    for (let i = 0; i < KEY_COUNT; i++) {
      const k = KEYBOARD_LAYOUT.keys[i];
      if (k.isBlack) continue;
      const u = whiteKeyUniforms[i];
      if (!u) continue;
      const mat = new THREE.MeshStandardMaterial({
        color: settings.whiteKeyColor,
        roughness: 0.55,
        metalness: 0.05,
      });
      mat.clippingPlanes = WHITE_KEY_CLIP_PLANES;
      patchWhiteKeyMaterial(mat, u, sharedLightUniforms);
      arr[i] = mat;
    }
    return arr;
    // Initial colour from settings; later updates flow through useFrame's
    // color.set(). settings excluded so changes don't recreate materials.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whiteKeyUniforms, sharedLightUniforms]);

  useEffect(
    () => () => {
      for (const m of whiteKeyMaterials) m?.dispose();
    },
    [whiteKeyMaterials],
  );

  // Mirror imperatively-created white-key materials into matRefs[] so the
  // per-frame color/emissive loop reaches them like declarative refs do.
  useEffect(() => {
    for (let i = 0; i < KEY_COUNT; i++) {
      const m = whiteKeyMaterials[i];
      if (m) matRefs.current[i] = m;
    }
  }, [whiteKeyMaterials]);

  const activePointers = useRef<
    Map<number, { midi: number; release: () => void }>
  >(new Map());
  // Pending midi during async audio init; cleared on pointerup so a release
  // during loading doesn't leak a stuck note.
  const pendingMidi = useRef<Map<number, number>>(new Map());

  // Per-key track index of the latest note-on. -1 = no track / live
  // input. The render loop reads this to look up the per-track tint
  // from settings.trackColors so the glow matches the colour of the
  // falling note that triggered it.
  const lastTrack = useMemo(() => {
    const a = new Int32Array(KEY_COUNT);
    a.fill(-1);
    return a;
  }, []);
  // Song note id of that note-on (-1 = live input), for per-note random colours.
  const lastNoteId = useMemo(() => {
    const a = new Int32Array(KEY_COUNT);
    a.fill(-1);
    return a;
  }, []);
  const colorResolver = useMemo(() => new NoteColorResolver(), []);
  useEffect(() => {
    // held[] is a refcount, not a flag — back-to-back retriggers may emit
    // on/off in either order within a frame; counting handles overlap.
    const off = audioEngine.addKeyListener((ev) => {
      const idx = ev.midi - MIDI_MIN;
      if (idx < 0 || idx >= KEY_COUNT) return;
      if (ev.type === "on") {
        const t = now();
        if (press[idx] > RETRIGGER_PRESS_THRESHOLD && t >= liftUntil[idx]) {
          liftUntil[idx] = t + RETRIGGER_LIFT_SECONDS;
        }
        glow[idx] = Math.max(glow[idx], 0.5 + ev.velocity * 0.6);
        held[idx]++;
        lastTrack[idx] = ev.track ?? -1;
        lastNoteId[idx] = ev.id ?? -1;
      } else {
        held[idx] = Math.max(0, held[idx] - 1);
      }
    });
    return off;
  }, [glow, held, press, liftUntil, lastTrack, lastNoteId]);

  // Window-level release so dragging off the canvas still stops the note.
  useEffect(() => {
    const onUp = (e: PointerEvent) => {
      const id = e.pointerId;
      const entry = activePointers.current.get(id);
      if (entry) {
        entry.release();
        activePointers.current.delete(id);
      }
      pendingMidi.current.delete(id);
    };
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, []);

  const ensureAudio = useCallback(async () => {
    if (audioEngine.isReady()) return true;
    const status = useStore.getState().loadStatus;
    if (status.state === "loading") {
      while (useStore.getState().loadStatus.state === "loading") {
        await new Promise((r) => setTimeout(r, 50));
      }
      return audioEngine.isReady();
    }
    setLoadStatus({ state: "loading", loaded: 0, total: 1 });
    try {
      await audioEngine.init((p) =>
        setLoadStatus({ state: "loading", loaded: p.loaded, total: p.total }),
      );
      setLoadStatus({ state: "ready" });
      return true;
    } catch {
      setLoadStatus({ state: "idle" });
      return false;
    }
  }, [setLoadStatus]);

  const triggerForPointer = useCallback((pointerId: number, midi: number) => {
    const prev = activePointers.current.get(pointerId);
    if (prev) {
      if (prev.midi === midi) return;
      prev.release();
      activePointers.current.delete(pointerId);
    }
    const handle = audioEngine.triggerKey(midi, 0.78);
    if (!handle) return;
    activePointers.current.set(pointerId, { midi, release: handle.release });
  }, []);

  const onPointerDown = useCallback(
    async (e: ThreeEvent<PointerEvent>, midi: number) => {
      // Middle button is reserved for camera orbit/pan
      // (see scene/CameraControls.tsx) — don't trigger the key.
      if (e.nativeEvent.button === 1) return;
      e.stopPropagation();
      const id = e.pointerId;
      markLivePlay(e.nativeEvent.pointerType === "touch" ? "touch" : "mouse");

      // Release implicit pointer capture (touch sets it automatically) so
      // pointerEnter on sibling keys fires while dragging.
      const target = e.nativeEvent.target as Element | null;
      if (
        target &&
        typeof target.hasPointerCapture === "function" &&
        target.hasPointerCapture(id)
      ) {
        try {
          target.releasePointerCapture(id);
        } catch {
          /* ignored */
        }
      }

      if (Tone.getContext().state !== "running") {
        try {
          await Tone.start();
        } catch {
          /* ignored */
        }
      }

      if (audioEngine.isReady()) {
        triggerForPointer(id, midi);
        return;
      }

      // Track intent through async load. pointerEnter may update the desired
      // midi; pointerup clears the entry so we trigger nothing on release.
      pendingMidi.current.set(id, midi);
      const ready = await ensureAudio();
      if (!pendingMidi.current.has(id)) return;
      const targetMidi = pendingMidi.current.get(id)!;
      pendingMidi.current.delete(id);
      if (!ready) return;
      triggerForPointer(id, targetMidi);
    },
    [ensureAudio, triggerForPointer],
  );

  const onPointerEnter = useCallback(
    (e: ThreeEvent<PointerEvent>, midi: number) => {
      const id = e.pointerId;
      if (pendingMidi.current.has(id)) {
        pendingMidi.current.set(id, midi);
        return;
      }
      if (activePointers.current.has(id)) {
        triggerForPointer(id, midi);
      }
    },
    [triggerForPointer],
  );

  usePcKeyboardInput(ensureAudio);

  // Pitch labels on the keys: one instanced mesh under the keyboard group,
  // each label placed in its key group's frame so it tilts with the press.
  const rootRef = useRef<THREE.Group>(null);
  const keyLabelsRef = useRef<LabelMesh | null>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const labels = createLabelMesh(KEY_COUNT);
    labels.mesh.visible = false;
    root.add(labels.mesh);
    keyLabelsRef.current = labels;
    return () => {
      root.remove(labels.mesh);
      labels.dispose();
      keyLabelsRef.current = null;
    };
  }, []);

  useFrame(({ camera }, delta) => {
    // Normal = X × (camera − edge point) = (0, −dz, dy): points toward the
    // front of the keyboard, the kept side.
    const cam = camera.position;
    CLIP_NORMAL_SCRATCH.set(
      0,
      -(cam.z - CLIP_EDGE_POINT.z),
      cam.y - CLIP_EDGE_POINT.y,
    ).normalize();
    WHITE_KEY_CLIP.setFromNormalAndCoplanarPoint(
      CLIP_NORMAL_SCRATCH,
      CLIP_EDGE_POINT,
    );

    // Pin-resolved settings for every animatable key in this pass.
    // Non-animatable toggles (keyGlowEnabled / keyGlowFollowNote /
    // flashEnabled / flashFollowNote) keep reading the React `settings`
    // slice. Zero pins ⇒ `rs` is the live settings object by reference,
    // so every value below is bit-identical to the pre-pin code.
    const rs = getResolvedSettings();
    colorResolver.update(rs);
    const noteHexAt = (i: number): string => {
      const t = lastTrack[i];
      const id = lastNoteId[i];
      return colorResolver.hex(i + MIDI_MIN, t < 0 ? undefined : t, id < 0 ? undefined : id);
    };
    // A clock swap (the exporter installing its virtual clock) starts a
    // new timeline. The engine already sent note-offs for everything
    // sounding, but glow / press only decay over `keyGlowDecay`, so keys
    // lit by playback right before Export stayed lit in the video's
    // opening frames. Drop them so the render starts from a dark keyboard.
    const epoch = clockEpoch();
    if (epoch !== lastEpoch.current) {
      lastEpoch.current = epoch;
      glow.fill(0);
      press.fill(0);
      liftUntil.fill(0);
      retriggerDip.fill(1);
    }
    const nowSec = now();
    const brightness = rs.keyboardBrightness;
    frontShadeUniform.value = rs.whiteKeyFrontShade;
    {
      // Hit-line light on the keys: the line's own colour.
      const { gradient, hex } = hitLineColoring(rs);
      writeGradientUniforms(hitLightUniforms as unknown as Parameters<typeof writeGradientUniforms>[0], gradient);
      hitLightUniforms.uHitColor.value.set(hex);
      hitLightUniforms.uHitReach.value = rs.keyHitLineReach;
      hitLightUniforms.uHitLight.value = rs.hitLineEnabled
        ? rs.keyHitLineLight * Math.min(rs.hitLineBrightness / HIT_LINE_DEFAULT_BRIGHTNESS, 2)
        : 0;
    }
    const pressK = 1 - Math.exp(-delta / Math.max(0.005, PRESS_TC));
    const dipK = 1 - Math.exp(-delta / RETRIGGER_GLOW_TC);
    for (let i = 0; i < KEY_COUNT; i++) {
      const decay = rs.keyGlowDecay;
      const target = held[i] ? Math.max(glow[i], 0.6) : 0;
      const k1 = 1 - Math.exp(-delta / Math.max(0.01, decay));
      glow[i] += (target - glow[i]) * k1;

      const lifting = nowSec < liftUntil[i];
      retriggerDip[i] += ((lifting ? RETRIGGER_GLOW_FLOOR : 1) - retriggerDip[i]) * dipK;
      shownGlow[i] = glow[i] * retriggerDip[i];

      const pressTarget = held[i] && !lifting ? 1 : 0;
      press[i] += (pressTarget - press[i]) * pressK;

      const mat = matRefs.current[i];
      const k = KEYBOARD_LAYOUT.keys[i];
      const group = keyGroupRefs.current[i];
      if (group) {
        const pivotDip = k.isBlack ? BLACK_PIVOT_DIP : WHITE_PIVOT_DIP;
        const angle = k.isBlack ? BLACK_PRESS_ANGLE : WHITE_PRESS_ANGLE;
        group.position.z = -pivotDip * press[i];
        group.rotation.x = angle * press[i];
      }
      if (!mat) continue;

      const baseColor = k.isBlack
        ? rs.blackKeyColor
        : rs.whiteKeyColor;
      mat.color.set(baseColor).multiplyScalar(brightness);
      const e = shownGlow[i];
      const glowOn = e > 0.001 && settings.keyGlowEnabled;
      // Resolve the glow tint per-key: in "follow note" mode, the colour
      // of the most recent note-on on this key (notes/noteColor.ts);
      // the explicit `keyGlowColor` mode stays global.
      const glowColorHex = settings.keyGlowFollowNote
        ? noteHexAt(i)
        : rs.keyGlowColor;
      // Black-key surface tint: bring the actual color toward the glow
      // color, scaled brightness. White keys keep their pristine surface
      // (the additive emissive already reads cleanly off light gray).
      if (glowOn && k.isBlack) {
        PRESS_TINT_SCRATCH.set(glowColorHex).multiplyScalar(brightness);
        mat.color.lerp(
          PRESS_TINT_SCRATCH,
          Math.min(1, e * BLACK_PRESS_TINT_STRENGTH),
        );
      }
      if (glowOn) {
        mat.emissive.set(glowColorHex);
        mat.emissiveIntensity = e * rs.keyGlowIntensity * brightness;
      } else {
        mat.emissiveIntensity = 0;
      }

      // Slope material: lerp the base color toward white so the slope reads
      // as a slightly brighter shade than the body. Mirror emissive so glow
      // remains coherent across the whole black key.
      const slopeMat = slopeMatRefs.current[i];
      if (slopeMat) {
        slopeMat.color
          .set(baseColor)
          .lerp(SLOPE_TINT_TARGET, SLOPE_TINT_FACTOR)
          .multiplyScalar(brightness);
        if (glowOn) {
          PRESS_TINT_SCRATCH.set(glowColorHex).multiplyScalar(brightness);
          slopeMat.color.lerp(
            PRESS_TINT_SCRATCH,
            Math.min(1, e * BLACK_PRESS_TINT_STRENGTH),
          );
        }
        slopeMat.emissive.copy(mat.emissive);
        slopeMat.emissiveIntensity = mat.emissiveIntensity;
      }
      // Front-fillet material: fixed gray (theme-independent), brightness
      // applied. Emissive follows the body so the seam glows on press.
      const filletMat = filletMatRefs.current[i];
      if (filletMat) {
        filletMat.color.copy(FILLET_FRONT_COLOR).multiplyScalar(brightness);
        if (glowOn) {
          PRESS_TINT_SCRATCH.set(glowColorHex).multiplyScalar(brightness);
          filletMat.color.lerp(
            PRESS_TINT_SCRATCH,
            Math.min(1, e * BLACK_PRESS_TINT_STRENGTH),
          );
        }
        filletMat.emissive.copy(mat.emissive);
        filletMat.emissiveIntensity = mat.emissiveIntensity;
      }
    }

    // Wood chassis tint — single shared material, single color.set per
    // frame. Brightness multiplied so it dims with the rest of the keys.
    WHITE_BODY_WOOD_MATERIAL.color.set(WOOD_COLOR).multiplyScalar(brightness);
    // White-coated front face follows whiteKeyColor. Front-face normals
    // are forced to +Z (see tagWhiteBodyFrontFace) so the surface gets
    // the same N·L diffuse contribution as the cap top. We dim by 0.85
    // so the front still reads slightly darker than the top.
    WHITE_BODY_FRONT_MATERIAL.color
      .set(rs.whiteKeyColor)
      .multiplyScalar(brightness * 0.85);

    const lightXYs = sharedLightUniforms.uLightXYs.value;
    const lightIntensities = sharedLightUniforms.uLightIntensities.value;
    const blackGlow = sharedLightUniforms.uBlackGlow.value;
    const keyLightOn = settings.hitLightEnabled;
    const widthS = Math.max(0.05, rs.hitLightWidth);
    const reachS = Math.max(0.05, rs.hitLightReach);
    sharedLightUniforms.uLightStrength.value = keyLightOn
      ? rs.hitLight * KEY_LIGHT_STRENGTH_BASE
      : 0;
    sharedLightUniforms.uLightBoost.value = LIGHT_BOOST_BASE;
    sharedLightUniforms.uFalloffX.value = LIGHT_FALLOFF_X_BASE / (widthS * widthS);
    sharedLightUniforms.uFalloffY.value = LIGHT_FALLOFF_Y_BASE / (reachS * reachS);
    sharedLightUniforms.uShadowHalo.value = SHADOW_HALO_BASE;
    // The hands are lit by the same hit lights as the keys (hitLight* settings): same strength, falloff and colour
    // source; the flash sprite's settings no longer reach them. Off with the hit lights.
    flashLights.strength = keyLightOn ? rs.hitLight * KEY_LIGHT_STRENGTH_BASE : 0;
    flashLights.boost = LIGHT_BOOST_BASE;
    flashLights.falloffX = LIGHT_FALLOFF_X_BASE / (widthS * widthS);
    flashLights.falloffY = LIGHT_FALLOFF_Y_BASE / (reachS * reachS);
    // Per-slot light colour: the colour of the key's most recent note-on when following the note, else the
    // explicit hitLightColor, lifted toward white (keys: hitLightWhiten; hands: HANDS_WHITEN_OFFSET more, which keeps
    // the hands' look from before the hands moved to these settings). Lerps run in scratch colours, no allocation.
    const lightColors = sharedLightUniforms.uLightColors.value;
    const followNote = settings.hitLightFollowNote;
    const handWhiten = Math.min(1, rs.hitLightWhiten + HANDS_WHITEN_OFFSET);
    const keyFollow = followNote;
    const keyWhiten = rs.hitLightWhiten;
    LIGHT_COLOR_SCRATCH.set(keyFollow ? rs.noteColor : rs.hitLightColor).lerp(WHITE_LIGHT_TARGET, keyWhiten);
    const keyFallbackR = LIGHT_COLOR_SCRATCH.r;
    const keyFallbackG = LIGHT_COLOR_SCRATCH.g;
    const keyFallbackB = LIGHT_COLOR_SCRATCH.b;
    LIGHT_COLOR_SCRATCH.set(keyFollow ? rs.noteColor : rs.hitLightColor).lerp(WHITE_LIGHT_TARGET, handWhiten);
    const fallbackR = LIGHT_COLOR_SCRATCH.r;
    const fallbackG = LIGHT_COLOR_SCRATCH.g;
    const fallbackB = LIGHT_COLOR_SCRATCH.b;
    for (let bk = 0; bk < BLACK_KEY_COUNT; bk++) {
      blackGlow[bk] = Math.min(1, shownGlow[BLACK_KEY_INDICES[bk]]);
    }
    if (keyLightOn) {
      claimed.fill(0);
      // Top-K selection sort: 6 × 88 = 528 comparisons per frame.
      for (let slot = 0; slot < MAX_LIGHTS; slot++) {
        let bestI = -1;
        let bestVal = 0.005;
        for (let i = 0; i < KEY_COUNT; i++) {
          if (claimed[i]) continue;
          const v = shownGlow[i];
          if (v > bestVal) {
            bestVal = v;
            bestI = i;
          }
        }
        if (bestI < 0) {
          for (let s = slot; s < MAX_LIGHTS; s++) lightIntensities[s] = flashLights.handIntensities[s] = 0;
          break;
        }
        claimed[bestI] = 1;
        lightIntensities[slot] = Math.min(1, bestVal);
        flashLights.handIntensities[slot] = Math.min(1, glow[bestI]);
        lightXYs[slot * 2] = KEYBOARD_LAYOUT.keys[bestI].x;
        lightXYs[slot * 2 + 1] = WHITE_KEY_LENGTH;
        // Per-slot colour: the colour of this key's most recent note-on
        // when following the note; else the lifted fallback (the hands a bit whiter, see HANDS_WHITEN_OFFSET).
        const c3 = slot * 3;
        const handOverride = followNote ? noteHexAt(bestI) : undefined;
        const handColors = flashLights.colors;
        if (handOverride) {
          LIGHT_COLOR_SCRATCH.set(handOverride).lerp(WHITE_LIGHT_TARGET, handWhiten);
          handColors[c3] = LIGHT_COLOR_SCRATCH.r;
          handColors[c3 + 1] = LIGHT_COLOR_SCRATCH.g;
          handColors[c3 + 2] = LIGHT_COLOR_SCRATCH.b;
        } else {
          handColors[c3] = fallbackR;
          handColors[c3 + 1] = fallbackG;
          handColors[c3 + 2] = fallbackB;
        }
        const keyOverride = keyFollow ? noteHexAt(bestI) : undefined;
        if (keyOverride) {
          LIGHT_COLOR_SCRATCH.set(keyOverride).lerp(WHITE_LIGHT_TARGET, keyWhiten);
          lightColors[c3] = LIGHT_COLOR_SCRATCH.r;
          lightColors[c3 + 1] = LIGHT_COLOR_SCRATCH.g;
          lightColors[c3 + 2] = LIGHT_COLOR_SCRATCH.b;
        } else {
          lightColors[c3] = keyFallbackR;
          lightColors[c3 + 1] = keyFallbackG;
          lightColors[c3 + 2] = keyFallbackB;
        }
      }
    } else {
      for (let slot = 0; slot < MAX_LIGHTS; slot++) {
        lightIntensities[slot] = flashLights.handIntensities[slot] = 0;
      }
    }


    const keyLabels = keyLabelsRef.current;
    if (keyLabels) {
      keyLabels.mesh.visible = settings.keyLabelsEnabled;
      if (settings.keyLabelsEnabled) writeKeyLabels(keyLabels, rs);
    }
  });

  function writeKeyLabels(labels: LabelMesh, rs: ReturnType<typeof getResolvedSettings>) {
    const atlas = labelAtlas(settings.keyLabelFormat, settings.keyLabelAccidental);
    const u = labels.material.uniforms;
    u.uAtlas.value = atlas.texture;
    u.uOutline.value = 0;
    const offset = Math.max(rs.keyLabelOffset, 0);
    const colors = labels.colors;
    KEY_LABEL_COLOR.set(rs.keyLabelWhiteColor).convertLinearToSRGB();
    const wr = KEY_LABEL_COLOR.r, wg = KEY_LABEL_COLOR.g, wb = KEY_LABEL_COLOR.b;
    KEY_LABEL_COLOR.set(rs.keyLabelBlackColor).convertLinearToSRGB();
    const opacity = Math.min(Math.max(rs.keyLabelOpacity, 0), 1);
    const size = Math.max(rs.keyLabelSize, 0.05);
    const mode = settings.keyLabelsMode;
    const out = labels.mesh.instanceMatrix.array as Float32Array;
    let n = 0;
    for (let i = 0; i < KEY_COUNT; i++) {
      const k = KEYBOARD_LAYOUT.keys[i];
      if (mode === "c" ? k.midi % 12 !== 0 : mode === "white" && k.isBlack) continue;
      const group = keyGroupRefs.current[i];
      if (!group) continue;
      group.updateMatrix();
      const faceW = k.isBlack ? BLACK_TOP_WIDTH : k.width * 0.8;
      const h = Math.min(KEY_LABEL_HEIGHT * size, faceW / atlas.textAspect[i]);
      // The group pivots at the key's rear edge; its front edge is at -length.
      const front = -k.length + (k.isBlack ? BLACK_TOP_FROM_FRONT : 0);
      KEY_LABEL_LOCAL.makeScale(h * LABEL_CELL_ASPECT, h, 1).setPosition(
        0,
        front + offset + h / 2,
        (k.isBlack ? BLACK_KEY_THICKNESS : 0) + 0.001,
      );
      KEY_LABEL_MATRIX.multiplyMatrices(group.matrix, KEY_LABEL_LOCAL).toArray(out, n * 16);
      labels.glyphs[n] = i;
      labels.alphas[n] = opacity;
      colors[n * 3] = k.isBlack ? KEY_LABEL_COLOR.r : wr;
      colors[n * 3 + 1] = k.isBlack ? KEY_LABEL_COLOR.g : wg;
      colors[n * 3 + 2] = k.isBlack ? KEY_LABEL_COLOR.b : wb;
      n++;
    }
    labels.commit(n);
  }

  // X positions of B→C octave boundaries.
  const octaveDividerXs = useMemo(() => {
    const xs: number[] = [];
    for (let midi = MIDI_MIN; midi <= MIDI_MAX; midi++) {
      if (((midi % 12) + 12) % 12 !== 11) continue;
      const k = KEYBOARD_LAYOUT.keys[midi - MIDI_MIN];
      xs.push(k.x + WHITE_KEY_WIDTH / 2);
    }
    return xs;
  }, []);

  // Octave dividers run from the keyboard's back edge past the top of any
  // view (the same cap the falling notes use).
  const dividerLength = MAX_LIVE_VISIBLE_ABOVE_HIT;

  return (
    <group ref={rootRef} position={[0, KEYBOARD_Y, 0]}>
      {KEYBOARD_LAYOUT.keys.map((k, i) => {
        const isBlack = k.isBlack;
        const customMat = whiteKeyMaterials[i];
        // Group is anchored at the rear pivot; press animation drives
        // group.position.z + rotation.x to tilt + settle the key.
        return (
          <group
            key={k.midi}
            ref={(g) => (keyGroupRefs.current[i] = g)}
            position={[k.x, k.yLocal + k.length / 2, 0]}
          >
            <mesh
              ref={(m) => (meshRefs.current[i] = m)}
              position={[0, -k.length / 2, 0]}
              onPointerDown={(e) => onPointerDown(e, k.midi)}
              onPointerEnter={(e) => onPointerEnter(e, k.midi)}
              onPointerOver={onKeyPointerOver}
              onPointerOut={onKeyPointerOut}
              // White: imperative material (shadow-projection patch).
              // Black: declarative material child below.
              material={isBlack ? undefined : (customMat ?? undefined)}
              geometry={
                isBlack ? BLACK_KEY_GEOMETRY : whiteKeyGeometryFor(k.midi)
              }
            >
              {isBlack && (
                <>
                  <meshStandardMaterial
                    attach="material-0"
                    ref={(mat) => (matRefs.current[i] = mat)}
                    color={settings.blackKeyColor}
                    roughness={0.4}
                    metalness={0.05}
                    clippingPlanes={blackKeyClipPlanes}
                  />
                  <meshStandardMaterial
                    attach="material-1"
                    ref={(mat) => (slopeMatRefs.current[i] = mat)}
                    color={settings.blackKeyColor}
                    roughness={0.4}
                    metalness={0.05}
                    clippingPlanes={blackKeyClipPlanes}
                  />
                  <meshStandardMaterial
                    attach="material-2"
                    ref={(mat) => (filletMatRefs.current[i] = mat)}
                    color={FILLET_FRONT_COLOR}
                    roughness={0.4}
                    metalness={0.05}
                    clippingPlanes={blackKeyClipPlanes}
                  />
                </>
              )}
            </mesh>
            {!isBlack && (
              <mesh
                // ExtrudeGeometry's top cap sits at mesh-local z=0 (after
                // translate); position the mesh so that lands at
                // -CAP-GAP, matching the cap's underside.
                position={[
                  0,
                  -k.length / 2,
                  -WHITE_CAP_THICKNESS - WOOD_TOP_GAP,
                ]}
                geometry={whiteBodyGeometryFor(k.midi)}
                material={WHITE_BODY_MATERIALS}
              />
            )}
          </group>
        );
      })}
      {settings.octaveLinesEnabled &&
        octaveDividerXs.map((x, i) => (
          <mesh
            key={`octave-divider-${i}`}
            position={[x, WHITE_KEY_LENGTH + dividerLength / 2, 0.02]}
          >
            <planeGeometry args={[0.008, dividerLength]} />
            <meshBasicMaterial
              color="#3a3a3a"
              transparent
              opacity={0.45}
              toneMapped={false}
              depthWrite={false}
            />
          </mesh>
        ))}
    </group>
  );
}

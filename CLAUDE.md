# notefall

Browser-based piano visualizer. Notes fall onto an 88-key keyboard while a MIDI plays; users can also play live (touch / mouse / PC keyboard / Web MIDI), record, and edit MIDI directly on the canvas. All content (MIDI / recordings / projects / audio) is processed client-side and never uploaded; the **only** outbound data is anonymous, opt-out usage analytics (see `src/usage/`) and reports the user writes and sends from the in-app feedback form (`src/feedback/`). PolyForm Shield 1.0.0.

## Stack

- Vite + React 18 + TypeScript
- `@react-three/fiber` + `drei` + `@react-three/postprocessing` (Bloom)
- `smplr` for sampled playback (Salamander Grand Piano V3 samples, served from R2)
- `@tonejs/midi` for parse/serialize; `tone` only for AudioContext lifecycle
- `react-aria-components` + Tailwind for UI; `zustand` for state
- IndexedDB for recordings; Web MIDI API for hardware input
- `mediabunny` (MP4 / WebM muxing) + WebCodecs (`VideoEncoder` / `AudioEncoder`) for offline MP4 / WebM export

## Layout

```
src/
├ App.tsx        Layout, fallbacks for no-WebGL or <1024px
├ store.ts       zustand: settings, song, transport, editor, project file
├ midi/          parse / serialize / edit (resolveOverlaps lives here)
├ projects/      .nfz zip format + FSA wrapper + recent files
├ audio/         engine, sampler, recorder, click metronome, MIDI input, preview,
│                clock (pluggable time source — real wall-clock or virtual export clock)
├ keyboard/      88-key layout + Keyboard.tsx (3D cap geometry, glow, input)
├ notes/         FallingNotes (SDF shader), HitLine, HitParticles, LandingFlashes,
│                noteDeathFx pub-sub, customTexture
├ scene/         Canvas + EditTools (paused) / PlayToggleArea (playing) +
│                exportBridge (R3F state getter for the offline video pass)
├ export/        renderAudio (OfflineAudioContext → AudioBuffer / WAV),
│                renderVideo (frame-stepped R3F → encoders → muxer),
│                exportAudio / exportVideo (download wrappers),
│                timeline (shared render window), async / errors / download helpers,
│                progress (weighted A/V bar), sceneExportMode (R3F export-mode enter/restore)
│  ├ synth/      offline piano: load + settings, pedal ranges, note / accompaniment scheduling
│  └ codec/      VIDEO_CODECS presets, encoder config + probe, audio encode loop,
│                muxer factory (MP4 / WebM), preflight
└ ui/            Layout, Toolbar, Inspector (Customize panel), Viewport, Timeline*,
   │             SelectionCard, ConfirmModal, Export* / Feedback dialogs
   ├ kit/        design tokens (tokens.css) + react-aria components; build UI from these
   └ shell/      islands, transport pill, loading island, start card, shortcut sheet,
                 view state (uiState: lookOpen / shortcutsOpen), idle fade, fullscreen
```

## Coordinates

- Camera at `[0, 0, 12]`, FOV 32°. Keyboard fixed at world `KEYBOARD_Y = -2.0` (`keyboard/layout.ts`).
- 1 mm = 0.01 wu. White: 0.235 × 1.475. Black: 0.137 × 0.95. 88 white keys × 0.235 = 12.22 wu = full 16:9 viewport width.
- White keys are 3D solid caps with rounded corners (`createRoundedWhiteGeometry`); black keys are custom chamfered geometry with an **inner solid fill** so chamfer/slope seams resolve to black instead of revealing the void behind.
- On-screen keyboard position is `keyboardScreenY` (Inspector "Keyboard Y"; 0 = keyboard front edge on the bottom of the view, 1 = back edge on the top). `keyboardViewShift` turns it into a **lens shift** for the current camera, applied by `CameraSync` via `camera.view.offsetY` (`applyViewShift`, `scene/visibleTop.ts`). The keyboard itself never moves — moving it in world Y (the old `keyboardY`) exposed its back/top structure through perspective. Anything that derives the visible Y range from FOV must scale the half-height by `viewTopScale` / `viewBottomScale` of that shift.
- Hit line at `NOTE_HIT_Y = KEYBOARD_Y + WHITE_KEY_LENGTH`. Note plane z = 0.05; clipping is **per-fragment SDF** (`vWorldY < uHitY`), NOT z-occlusion — putting notes at a different z would cause perspective parallax against the keys.

## AudioEngine (`src/audio/engine.ts`)

Singleton, decoupled from React. Self-clocked via `now()` from `audio/clock.ts` (default = `performance.now() / 1000`; the offline video exporter swaps in a `VirtualClock`). `Layout.tsx` syncs settings → engine via `useEffect`s.

- **Two tick drivers**: `useFrame` (visual sync, paused on hidden tab) + Web Worker `setInterval(25 ms)` (background-tab playback would otherwise stall and burst on return).
- **Unique `stopId` per note** is mandatory. smplr defaults `stopId` to midi number, so back-to-back same-pitch notes share an id and stopping one cancels another mid-release. We pass `s${noteId}` for song, `live${liveId}` for touch, `prev-${n}` for previews.
- **Lookahead 0.015 s + stop buffer 0.02 s** prevent attack clicks and cancel-before-start drops.
- **Pedal sustain (half-pedal aware)**: CC64 is kept as 0..1 everywhere (song, live input, recordings). When a note's `endTime` arrives with the dampers lifted, its stop fn is pushed onto `pedalHeld[]` per source ('song' / 'live'). `audio/pedalDepth.ts` maps the value to a damper lift (≤ 0.15 none, ≥ 0.85 full); a held voice fades exponentially with `dampTc(lift)` (full lift = hold, half ≈ 0.4 s time constant, no lift = the plain key release), re-targeted whenever the pedal moves, and is stopped once faded `SILENT_TCS` time constants. smplr can't reshape a stopping voice, so `smoothRelease.holdRelease` calls its stop fn while capturing the voice's envelope param + source (no ramp scheduled, source stop pushed out) and returns `decay` / `end` handles. Held voices are "stopping" to smplr, so `piano.stopAll()` skips them: every path that drops `pedalHeld` must release them (`flushPedalHeld` / `releaseHeld`). A 0/127 pedal behaves exactly like a threshold. The offline render walks the same model per note (`scheduleSongNotes`). Sostenuto / soft (CC66 / 67) are recorded and kept in `ParsedSong.controls` for the MIDI round-trip only — never sounded.
- **Init dedupe**: concurrent `init()` callers share `initPromise`, so the ~77 MB sample load isn't kicked off twice.
- **`updateSong(song)`**: editor-driven replacement. Selectively releases active notes whose id/midi/endTime changed; structurally-unchanged notes stay so the engine fires their note-off naturally. Without this, pause+edit+resume left phantom-held notes.
- **`addLiveListener` ≠ `addKeyListener`**: live channel only fires for user input (recorder uses it to capture only what the user played).
- **`triggerPreview`**: plays a sampler note WITHOUT firing key listeners — editor previews don't trigger glow/particles.
- **`pause()`** keeps visualizer state intact, only kills audio via `releaseAllSounding()`.
- **Silent / export mode** — `beginExportPlayback()` resets the song cursor and flips `silent = true` so `tick()` walks the timeline emitting only listener events (no `piano.start()`, no pedal-held queue mutation, no end-of-song auto-stop). The video exporter brackets the render with `begin/endExportPlayback` and drives the virtual clock externally.

## Sampler (`src/audio/sampler.ts`)

Loads **Salamander Grand Piano V3** (close mic, CC-BY 3.0; 30 sampled keys × 16 velocity layers, ~77 MB of OGG) through smplr's underlying `Smplr` class with a descriptor built in `salamanderDescriptor.ts` (which also offsets each layer's gain to cancel half of smplr's quadratic velocity curve). The samples come from `samples.notefall.app` (R2; `VITE_SAMPLES_BASE_URL` overrides, `npm run dev` goes through Vite's `/samples-cdn` proxy because the bucket's CORS allows only notefall.app) and are kept in Cache Storage (`sampleCache.ts`) after the first load. Preparing / uploading them: `scripts/fetch-salamander.sh`, `prepare-salamander.mjs`, `upload-r2.sh`. Using `Smplr` directly (not a wrapper like `SplendidGrandPiano`) also keeps the `scheduler` option, which the wrappers drop. The offline audio render passes a custom `Scheduler` with `lookaheadMs: Infinity` so every `piano.start()` dispatches synchronously inside `OfflineAudioContext.startRendering()` (smplr's default `setInterval`-driven scheduler never fires during offline render and would silently drop everything past the first 100 ms).

`createPiano(context, onProgress, options)` accepts any `BaseAudioContext` — the realtime engine passes Tone's `rawContext`, the offline exporter passes a fresh `OfflineAudioContext`. Same effect-chain wiring (master → 6-band EQ → split → dry / pre-delay → reverb → wet) is used in both paths so render parity is automatic.

**FadeInStorage** is critical — smplr's `Voice` sets `envelope.gain.value = 1` instantly (no attack), so any sample whose first frame isn't zero clicks on attack. We intercept the storage layer, decode, apply 1.5 ms linear fade-in, re-encode WAV, hand back to smplr.

## Falling notes (`src/notes/FallingNotes.tsx`)

Single `InstancedMesh` + custom ShaderMaterial (shaders in `noteShader.ts`). Per-instance data is packed into three vec4s (`iRect` = centre + size, `iSeedSel` = seed + selected + black, `iTintAlpha`), filled from per-field CPU arrays at the end of each frame; the vertex shader places the quad from `iRect`, not `instanceMatrix` (still written, for raycast picking). **Keep every shader within 8 attribute locations** (WebGL's guaranteed `MAX_VERTEX_ATTRIBS`; `instanceMatrix` costs 4): Firefox sometimes hands out a minimal-capability context with exactly 8, and a shader over it silently never draws (the old 12-location note layout made notes vanish while keys / particles worked). Fragment shader clips `vWorld.y < uHitY` per pixel, then SDF rounded-box, fill (note look), edge, selection outline.

**Note looks** (`looks/`). `noteMaterial` `flat` = tint × (1 + Emissive); `reflective` = SDF bevel + baked bump normal (`hammeredNormal.ts` / `crystalNormal.ts`, baked once on first use) lit by key/fill lights and reflecting an animated light pattern (`caustics.ts`, created on first use, ticked from the clamped `now()` delta), plus optional cloud / highlight / frost layers, an outline ring OUTSIDE the body (the vertex shader widens the quad by `uMargin`; raycast picking still hits the unwidened note box) and a rim band inside it. `noteBumpScatter` reads the note-carried maps in a song-space per-key frame (`uScroll`). `noteShape` (round / gem-cut octagon / hollow angled frame, `gemFacets.ts`) applies to every material; `notePattern` picks the generator (`caustics.ts` / `crystalLight.ts` / `lightsPattern.ts`); `noteMaterial` `realistic` shades baked albedo / metal-smoothness / normal / emissive map sets (`realistic.ts`, cached per set + bake params) under the pattern × an optional silk texture. **Liquid merge** (`merge.ts`, `noteMergeRadius` > 0, round shape): the shader is compiled with `MERGE`; each instance's quad is placed in world units from a data texture rebuilt every frame (rects + tints + K=8 neighbour lists, same order as the instances), and each pixel is drawn only by the instance that owns it (smallest SDF) — ownership is resolved BEFORE any other discard, so keep derivative-based terms valid after it. Picking still raycasts the instanceMatrix quads; the selection treatment uses the note's own box; dying ghosts are `solo`. Same-key overlaps are clipped before the build. `noteMaterial` `sprite` (Inspector "2D") is a separate analytic shading model in the same shader (`shadeSprite`: soft-lit rounded slab / ring, embossed silk, shimmer, outline band); its glow halo is a child InstancedMesh sharing the note mesh's geometry, instanceMatrix and uniforms (`GLOW_PASS` variant, never raycast). Presets in `noteLook.ts` (`NOTE_LOOK_PRESETS`, lengths written in white-key widths); the Inspector's Preset row is derived (the preset the look matches, else Custom). **Colour space**: the reflective formula runs on sRGB-encoded values; only the final colour is converted — linear for the bloom composer target, sRGB for the canvas (`uLinearTarget`, set in `onBeforeRender` like HitParticles), so notes look the same with Bloom on/off. Origin: re-implemented in `_local/particle-lab` (`own*.ts`); the remaining port phases and parked look issues are in `_local/particle-lab/NOTES_HANDOFF.md`.

**Note colouring** (`noteColor.ts`, `noteColorMode`): `hand` = the note's hand from the selection card (`noteHandColorL` / `R`, `noteColor` when unset; looked up by id via `midi/noteHands.ts` `handOfNote`, whose song source the store registers to avoid an import cycle); `solid` = `noteColor` + per-track `trackColors`; `gradient` = 2–5 sRGB stops (`noteGradientColor/Pos1..5`) across the keyboard width × one fall distance above the hit line at `noteGradientAngle` (clockwise from +x, 0° = first stop on the left), shaded per pixel in the note shader (`gradientAt`); `random` = seeded palette pick (`noteRandomColor1..5`, count, seed) per note id / pitch / pitch class (per-track colours are `solid`'s `trackColors`). Neighbouring stops blend over a `*GradientSoftness` share of their gap, centred on its midpoint (1 = linear across the gap, 0 = hard switch halfway). The hit line has its own `hitLineColorMode`: `solid` (`hitLineColor`), `gradient` (its own 2–5 stops along the line, `hitLineGradient*`), `note` (the notes' gradient along the line, `noteColor` for solid notes, its own `hitLineColor` for random notes); both line shaders share `NOTE_GRADIENT_GLSL`. Every other consumer (particles, flashes, key glow, the timeline clip) goes through `NoteColorResolver` (gradient = the hit-line colour at the key), using the note id carried on key 'on' events. Stop / palette colours, positions and the angle are pin-animatable.

**Pitch labels** (`pitchLabels.ts`): one atlas `CanvasTexture` per naming scheme (`letter` / `letterOctave` × sharp / flat, a cell per key plus five finger-number cells (`fingerGlyph`), drawn synchronously with a system font so export frame 0 has them; R = fill mask, G = outline mask) and an instanced quad material. Note labels (`noteLabelContent`: pitch / finger / both, finger nearest the keyboard) are a child InstancedMesh of the note mesh (renderOrder 2.05, filled from the instance rects each frame: fixed to the note at its keyboard end / middle / far end, so it sinks into the hit line with the note (per-fragment `uClipY`), fitted to the note width incl. outline, and with labels on every note is DRAWN at least `noteLabelMinLength` long (display only — `noteLabelMinLengthAt` is mirrored by `positions.ts` range-select bounds and HitParticles' min-emit window; audio untouched); the atlas G channel is a stepped distance ramp, so outline width is a uniform); key labels are one InstancedMesh under the keyboard group, placed in each key group's frame so they tilt with the press — black-key labels sit on the flat top face (`BLACK_TOP_FRONT_Y` / `BLACK_TOP_HALF_W`), not over the front slope.

Each `useFrame`: places song notes, appends live notes (always 'up'), appends `noteDeathFx.list()` ghosts (fading via `instanceAlpha`). Maintains `instanceToNoteId[]` for click→note resolution. **Pin `mesh.boundingSphere = Sphere(0, 1000)`** to defeat three.js's stale lazy BS — auto-computed once would silently fail raycast for later far-positioned notes.

**Texture animation phase is INTEGRATED, not `now() * speed`.** The custom image scrolls by a `uPhase` vec2 that the `useFrame` accumulates as `phase += clamp(Δnow, 0, 0.1) * noteAnimSpeed{X,Y}`. The earlier `uTime * uAnimSpeed` form made the apparent flow velocity `animSpeed + now()·dAnimSpeed/dt`; since `now()` is a large absolute timestamp, any `noteAnimSpeed` slope between two settings-pins (even a ramp *into* two pins that hold the **same** value) exploded the flow speed. Integrating the rate makes the visual velocity exactly `animSpeed` and the phase C⁰ across pin boundaries. Phase + last-`now()` live in refs that persist across the live→export handoff (same component instance); the Δ clamp absorbs backgrounded-tab gaps, seeks, and that handoff. Driven off `now()` so export parity stays automatic. **`uPhase` is wrapped `% PHASE_WRAP` (1024)** — the same precision guard HitLine applies to its `uTime` (`% TIME_WRAP_SECONDS`): an unbounded accumulator fed into fbm/hash eventually exceeds float32-precise range, the per-frame delta drops below the ULP, and the flow visibly **freezes even at speed 1** (a long-standing bug the old `now() * animSpeed` form shared, since raw `now()` here was never wrapped). The `%` pop is one frame, tens of minutes apart, hidden in the noise churn, and deterministic in the phase so live and export wrap identically.

`fallDirection`: `'down'` future falls onto keyboard; `'up'` past rises as history trail.

## Editor

Active when `transport !== 'playing' && song !== null` — `Scene.tsx` mounts `<EditTools />` instead of `<PlayToggleArea />`.

**Undo plumbing** — three setters keep "whole drag = 1 undo entry":
- `applySongEdit(next)` — push history, replace, clear future, sync engine
- `setSongPreview(s)` — replace without history (in-flight drags)
- `pushUndoSnapshot(snapshot)` — push without applying (call once at drag start)

**Gestures:**

| Target | Input | Action |
|---|---|---|
| Note body | LClick | Select + arm move-drag |
| Note body | Cmd+L / Alt+L / RClick / DblClick | Toggle selection / split / delete that note / select it + open the selection card |
| Note edge | LDrag | Edge-resize (head moves time+duration; tail duration only); on a selected note, the same edge of every selected note by one delta |
| Empty above hit | LClick | Create note + arm position-drag (1 undo entry) |
| Empty | Cmd+LDrag / RDrag | Marquee range-select (additive) / eraser sweep |
| (any) | Del / Esc / Arrows / Cmd+Z / Shift+Z\|Y | Delete selection / clear / nudge as on screen (↑↓ along the fall ±0.05 s, ←→ ±1 semitone) / undo / redo |

**Collision rules** ("notes are solid", same-pitch overlap forbidden):
- `moveNotes` clamps time delta uniformly across the moved set. Pitch-shift collision uses **time-overlap**, not pitch-only — strict pitch-only would freeze most drags since same-pitch notes are scattered across time. Touching boundaries allowed.
- Edge-resize clamps to nearest same-pitch obstacle; a multi-note resize clamps the delta uniformly (the most constrained note limits all).
- `addNote` uses `resolveOverlaps` with new id as priority; existing overlapping notes get clipped.

**Loading guard.** Transparent click-eater div mounts over the Canvas while `loadStatus.state === 'loading'`. The triggering click itself isn't covered (status was still `'idle'` at pointerdown), so editor handlers also early-return when `!audioEngine.isReady()` and kick off `ensureSamplerLoaded` — first cold-session click downloads but doesn't drag. Pairs with `previewNote`'s sync-drop so no audio queues during load.

**Selection card** (`ui/SelectionCard.tsx`) replaces the old velocity context menu (right-click deletes). It opens on a double-click on a note (`openSelectionCard` stores the current `selection` Set as `selectionCardFor`) and shows while paused as long as `selection` is still that very Set, so any selection change (click, new note, marquee, Esc) closes it, and so does any press outside the card (`closeSelectionCard`, the card's window `pointerdown`; the selection stays). A kit `Panel`, hidden while a pointer gesture / marquee is in flight; each rAF it is placed beside the selection's projected screen box (`scene/selectionBounds.ts`, via `exportBridge`'s R3F state), right side first, never covering the notes. Header = count (+ pitch for one note); Velocity = value field + slider (mixed: `lo–hi` and a band on the track; dragging shifts all by one delta keeping differences, clamped 1..127; typing sets all) with one `pushUndoSnapshot` per gesture + `setSongPreview` and a 500 ms preview ticker; footer Delete (⌫). Hand (L / R) and Finger (1–5) are segmented rows (`ChoiceRow`): all agree → that value selected; they differ → nothing selected, the values in use ringed, "Mixed"; choosing sets all (`setNotesHand` / `setNotesFinger`, one `applySongEdit`); pressing the selected value again clears it (`undefined`). Deletes show no toast (the owner dropped the undo toast); ⌘Z undoes them.

## Timeline pins (settings keyframes)

Snapshot keyframes that animate visual settings along the timeline — drop a pin, change settings, drop another pin, and the scene morphs between them. Closer pins → steeper slope → faster visible change (inherent in time-parametric lerp). Modelled on `midiSpeedAutomation`: a speed point carries one scalar, a pin carries a whole settings snapshot.

- **Data** (`midi/settingsKeyframes.ts`). `settingsKeyframes: SettingsKeyframe[]` is a key **inside `Settings`** — so it rides the existing persistence / dirty / undo / `.nfz` paths with zero new plumbing (no manifest schema bump). `SettingsKeyframe = { time /* timeline-time sec */, settings: Partial<Settings>, curvature? }`. `ANIMATABLE_KEYS` enumerates the snapshot-able continuous visual keys (camera, colours, opacity/emissive, bloom, background, …) — discrete enums/booleans, audio, timeline-layout and song-sync are excluded. **`noteAnimSpeedX/Y` are also deliberately excluded**: they are a texture-flow RATE, and keyframing a rate is ill-posed — a pin-interpolated rate makes the visible speed lurch (the resolver ramps the rate itself), which produced both the "flow explodes at the next pin" and "flow decays to a standstill over ~2 min" bugs. Excluded ⇒ `isAnimatableKey` false ⇒ the Inspector's Animation Speed always reads/writes the single base value (constant everywhere, pins irrelevant); existing pins' stale `noteAnimSpeed*` snapshot entries are simply ignored by the resolver (it only iterates `ANIMATABLE_*`). Texture POSITION still moves over time via FallingNotes' integrated phase; only its rate is global. `pickAnimatable(s)` extracts that subset.
- **Resolver** `resolveSettingsAt(base, kfs, t)` — pure. **0 pins → returns `base` by reference** (bit-for-bit identity; the whole feature is a no-op until a pin exists). `pickBlend` chooses the segment: **before the first pin → ramp from `base`** (the editable "default look", held separately from pins, acting as an implicit anchor at t=0) **into the first pin** over `[0, firstPin.time]` — this is what makes Inspector edits visible in the no-pin region (with no pin targeted, edits land on `base`); **after the last pin → hold the last pin** (that region still has a governing target pin); **between → per-type lerp** (number / `#rrggbb` via THREE.Color / vec3 / colour-map), eased by the left pin's `curvature` (same `applyCurvature` shape as `speedMap`). `resolveNoteTintAt` shares `pickBlend`, so the timeline gradient shows the same base→first-pin ramp at the head.
- **Time base.** `t = audioEngine.currentSongTime()` — the same clock-driven value `FallingNotes` uses to place song notes. Because it flows through `audio/clock.ts`, pin animation is identical in live preview and the offline exporter (`renderVideo` swaps a `VirtualClock` and steps `r3f.advance()`) — **export parity is automatic**.
- **Supply** (`scene/automatedSettings.ts`). `AutomatedSettingsDriver` (mounted in `Scene` before every consumer; same-priority R3F useFrames run in mount order) recomputes `getResolvedSettings()` each frame. Visual consumers (`FallingNotes`, `HitLine`, `HitParticles`, `LandingFlashes`, `Keyboard`, `CameraSync`) read **animatable** keys from the resolved snapshot in their per-frame code; non-animatable keys stay on `useSettingsSlice`. Background and Bloom are applied **imperatively** in `BackgroundSync` / `BloomSync` useFrames (writing `scene.background` and the `BloomEffect`'s intensity/threshold/smoothing/radius) — React-prop updates wouldn't reach the exporter, which never re-renders React. The timeline editor's MIDI clip (`Timeline.tsx` → `MidiPreviewCanvas`) tints **each note by `resolveNoteTintAt(...)` at that note's OWN time** (note TL_audio = `midiOffset + midiToTimeline(speedMap, n.time)`), so the whole colour automation reads as a static gradient along the clip even while paused — it must NOT be a single playhead colour (the pin-edit base drift would otherwise stick it on the last-written colour) and must NOT use `getResolvedSettings()` (the R3F driver only ticks while the Canvas renders; the editor is used paused). `resolveNoteTintAt` is the cheap colour-only sibling of `resolveSettingsAt` (no ~100-key spread). The per-note array is memoised on notes/pins/base-tint/speedMap/offset — NOT the playhead — so scrub/play never recomputes or repaints it; `null` with no pins → unchanged base-colour path.
- **Editing UX.** Pins live on a fixed 16 px strip under the ruler (`ui/SettingsPinLane.tsx`, wired in `Timeline.tsx`) — diamond markers, not a value graph. Shift+K adds at the playhead (plain letters are the PC-keyboard piano) and a left-click on empty lane space adds at the clicked time; clicking a pin selects + seeks, drag moves, right-drag sweeps to erase every pin under the cursor, Del removes — each gesture collapses to one undo entry (begin/endSettingsEdit refcount nests with `removeKeyframe`'s own). Cursors mirror the note editor: `crosshair` on empty lane, `move` over a pin, `not-allowed` while erasing. **Edit target follows the PLAYHEAD** — `editingKeyframeTime` is driven by `PinTargetSync` (single app-wide rAF in `Layout`): the nearest pin at/before the head, or `null` before the first pin / no pins. It writes the store only on a *change* (boundary crossing or seek), so the Inspector/banner/lane re-render only then, not every frame. Clicking a pin seeks to it (so it becomes the target); moving the timeline retargets — a clicked pin does NOT stick once the head moves off it. **`base` (the "default look") and each pin's snapshot are held strictly separately**: `selectKeyframe` only records the click (it must NEVER merge the snapshot into `base` — that overwrote the default, a bug), and `updateSettings` routes by `editingKeyframeTime` — a pin targeted → animatable keys edit ONLY that pin's snapshot (`base` untouched); none → edit `base` (the default look the pre-first-pin region ramps from). Non-animatable keys (`isAnimatableKey` false: audio, etc.) always go to `base`. The Inspector READ side mirrors this via `useEffectiveSetting(key)` (used by every `Bound*` row + the bespoke camera / trackColors reads): it shows the targeted pin's snapshot value (animatable) or `base` — so a control always displays exactly what it writes. User-facing, pins are **keyframes** (◆) — never "pin" in UI text. The lane ("Keyframes") draws ink diamonds (the targeted one filled) vs the speed lane's round dots; no accent hue. While a keyframe is targeted the Customize panel shows a Keyframes header ("Keyframe at m:ss", previous / next, a strip of all keyframes) and a ◆ before each animatable row (filled = set in this keyframe, hollow = carried in); with none targeted it shows nothing about keyframes (no "default look" line). Del removes the targeted pin when no notes are selected (with a selection it deletes the notes only). **Reset** (`resetSettings`) is split: a pin targeted → reset ONLY that pin's snapshot to `pickAnimatable(defaultSettings)` (base default + other pins + everything else untouched); none → reset the `base` default look confined to what the Inspector shows, carrying over `RESET_PRESERVED_KEYS` (transport `volume`/`playbackRate`, the timeline editor's clip sync+trim = "clip length", `midiSpeedAutomation*` = "speed pins", lane layout, `followPlayhead`/`previewHighFps`, and `settingsKeyframes` — pins never wiped). **Add any new timeline/clip/session key to `RESET_PRESERVED_KEYS`** or Reset will clobber it. **Opening a different MIDI/song** (`setSong(song, { resetTimeline: true })` — passed from the Open-MIDI action, `.mid` drop, recording auto-load / pick) clears `SONG_TIED_KEYS` (pins, MIDI/audio clip offset+trim = "clip length", `midiSpeedAutomation*`) back to defaults since they're keyed to the old timeline, while keeping the Inspector look + editor layout; recorder-restore / empty-song bootstrap call `setSong` WITHOUT the flag (same song context). **Dragging the MIDI clip** (`Timeline.tsx` `onMidiPointerMove` → `store.shiftKeyframes`) translates every pin's `time` by the exact applied `midiOffset` delta so the colour automation stays glued to the notes — `midiOffset` is a pure additive shift of every note's TL_audio time, so the same delta on each pin keeps them locked regardless of the speed map; trimming does NOT shift pins (trim only hides, it doesn't reposition notes). `shiftKeyframes` is a plain set (no internal history) — the clip drag's own begin/endSettingsEdit bracket collapses the whole move to one undo entry; it runs BEFORE the `updateSettings({ midiOffsetSec })` set so the latter reads (and preserves) the already-shifted `settingsKeyframes`.

## Note death FX (`noteDeathFx.ts`)

Right-click and eraser drag emit `DyingNote { midi, velocity, x, centerY, width, length }`. `HitParticles` spawns a 0.35 s phantom emitter; `FallingNotes` reads `list()` and renders a fading ghost (`instanceAlpha = 1 - age/0.12s`). Bulk delete (Delete key, programmatic) skips the channel — wholesale deletion shouldn't spawn dozens of puffs.

## Hit particles (`src/notes/HitParticles.tsx`)

Three layers: soft **dots**, a share of them drawn as thin tilted **rays** (same pool, same shader), and faint **fog** puffs drawn underneath. The CPU sim lives in `particleSim.ts` (React-free, structure-of-arrays pools, oldest-first so youngest draws on top); `HitParticles.tsx` only wires key / death events and settings into it and uploads two instanced quad batches per frame. The sim has its own units (keyboard = `SIM_KEYBOARD_WIDTH`, y = 0 at the hit line); `SIM_TO_WORLD` maps positions and sizes into the scene, so tune constants in sim units.

- **Motion** — rise is a *position* add (`y += rise·dt`); velocity follows the flow by a **first-order lag** `v += (1 − e^(−7dt))·(target − v)`, not force accumulation, so sideways speed is bounded by the field (steady plume width, no EMA / confinement hacks needed). Young particles get a stronger push (`ageBoost`).
- **Flow field** — `curlLattice.ts` bakes `curlNoise.ts`'s curl into a lazily filled, periodic 128³ int16 lattice read **nearest-cell**; the lag smooths the cell steps. Sampling the continuous noise directly reads as jitter.
- **Sprites** are generated in the shaders (no textures). Colour is computed in sRGB and alpha-blended; with bloom on (linear composer target) the fragment linearises colour and raises alpha to 1.5 so the plume matches the bloom-off brightness (`uLinearTarget`, set per draw in `onBeforeRender`). Destination alpha must stay opaque (`blendSrcAlpha = One`) or the composer target turns translucent under particles and the canvas darkens them. Both batches draw at `renderOrder` 2.5: over the falling notes (2) and the hit line (2.2), under the landing flashes (3).
- **Emission** — per held key per frame (count ≥ 1 rounds up, < 1 is a coin flip), ×8 on the first frame of a press, two half-steps below 45 fps. **Note death**: `noteDeathFx` → `DeathEmitter` runs the same emission over the deleted note's rectangle for `DEATH_EMIT_DURATION` (0.35 s).

## Landing flashes (`src/notes/LandingFlashes.tsx`)

One `InstancedMesh` instance per key. Bumps intensities **instantly** on note-on (no fade-in) and extends `heldUntil[idx] = now + 80 ms` so super-short notes still register a flash.

## Keyboard (`src/keyboard/Keyboard.tsx`)

Per-key glow uses **reference-counted `held[]`** (not a flag) — back-to-back retriggers may emit on/off in either order within a frame; counting handles overlap correctly.

**Pointer input** (mouse + multi-touch):
- `onPointerDown` releases the touch's implicit pointer capture so sibling keys' `onPointerEnter` fires during a slide.
- `pointerId → activePointers` map; `pendingMidi` tracks intent during async load.
- Window-level `pointerup` / `pointercancel` releases notes dragged off the canvas.
- Hover counter + deferred reset on Over/Out so the cursor stays `pointer` across black/white boundaries (R3F may fire Out after Over depending on raycast).

**PC keyboard** (`PC_KEY_NOTES`): ZXCV → C3..E4 whites, ASDF → sharps, QWERTY → C4..G5 whites, digit row → chromatic above. Skipped on editable focus and modifiers (incl. Shift, reserved for Shift+R record). Window blur releases everything. Global `transpose` applies.

## Confirm / alert modal (`src/ui/confirm.ts`)

`showConfirm(...)` returns `Promise<boolean>`; `showAlert({ tone: 'error' })` swaps to rose border for failure surfaces. Async-callable from non-React modules via module-level pending state; component subscribes via `useSyncExternalStore`. Overlapping calls settle the prior promise first.

**No `window.confirm` / `window.alert` calls remain in the app.**

## Recording (`src/audio/recorder.ts` + `recordControl.ts`)

`RecorderManager` singleton captures `addLiveListener` events. Hydrates from IndexedDB; mutations write through; errors silently degrade. `recordControl.toggleRecord()` is shared by Toolbar button + Shift+R shortcut. 4-beat metronome count-in (100 BPM, sine clicks via `click.ts`) when `countInEnabled`. Empty recordings discarded with toast.

**Pre-record snapshot.** Pressing Record clears any loaded song; `recordControl` stashes `{ song, wasClean }` and restores it if the take ends empty OR the user cancels the count-in. `wasClean` mirrors `!dirty` so saved-project dirty indicator stays accurate.

**Auto-load on stop**: `recorder.addFinalizedListener` fires once per non-empty stop; Toolbar loads the take immediately. Empty stops go through `addEmptyStopListener` (toast).

**Unread badge.** `markAllRead()` runs when the popover **closes** (not opens) so users see what was new while reading.

## Projects (`src/projects/`)

**File-based persistence**, not IndexedDB. Files are `.nfz` (zip via `fflate`), saved to user's filesystem. IndexedDB silently disappears on clear-site-data, private mode, Safari ITP — catastrophic for creative work.

**Format:**
```
my-project.nfz  (zip)
├ manifest.json   { appVersion, name, createdAt, updatedAt, settings,
│                   songRef, customTexture: { ref, mime, fileName } | null }
└ assets/
   ├ song.mid
   └ note-texture.<ext>
```
Zip wrapper present from day 1 even with only `manifest.json`, so audio-sync (future) won't fork the format.

**Hands / fingers** (`NoteEvent.hand` / `finger`, set in the selection card) have no place in the SMF, so they ride in `manifest.noteHands` as `[midi, timeMs, hand, finger]` entries (`midi/noteHands.ts`); on open each entry returns to the same-pitch note starting nearest that time (≤ 10 ms; same-pitch notes never overlap). Edits keep them because every edit helper spreads the note.

**Versioning (pre-1.0).** No version field, no migration table — settings load via lenient merge `{ ...defaultSettings, ...saved }`; missing fills, unknown drops, renames silently lose old value. Reintroduce versioned migration before 1.0.

**FSA vs fallback** (`io.ts`):
- **Chrome/Edge**: File System Access API; handle held in `currentFile.handle` so Save overwrites in place. `recent.ts` persists handles in IndexedDB (capped 8); stale handles drop on `openRecent` re-check.
- **Safari/Firefox**: programmatic `<input type="file">` for open, Blob-URL download for save. Save falls through to Save As since no handle.

**Save model.** Explicit only, no autosave. `Cmd+S` overwrites; `Cmd+Shift+S` always opens picker. `dirty` flips on `setSong` / `updateSettings` / `resetSettings` / `applySongEdit` / `setSongPreview` / `undo` / `redo`. Window `beforeunload` prompts whenever `dirty`. Edit history NOT persisted.

**Action layer** (`actions.ts`). All return `{ kind: 'ok' | 'cancelled' | 'error', message? }`. The dirty-confirm prompt lives **inside the action** so shortcuts and menu items share one gate. `applyOpenedProject(buf, ref)` is the shared unpack/sync/recent-update helper.

**Customizing settings (pre-1.0).** New key → add to `defaultSettings`. Removed key → delete. Renamed/type-changed → just rename; old saved values silently drop.

## UI shell

`App.tsx` mounts `<Layout />` only when (a) WebGL context available (`detectWebGLAvailable()` probes webgl2 then webgl) and (b) viewport ≥ 1024 px. WebGL takes precedence over viewport-size.

**Design system: `docs/design-system.md`** is the single source for how everything outside the canvas looks and behaves (layout, tokens by name, kit components, motion, focus, copy, what never to do). It is imported by `src/ui/CLAUDE.md`, so it loads whenever files under `src/ui/` are read. Values live only in code: `ui/kit/tokens.css` (+ the Tailwind names in `tailwind.config.js`) and `GEOMETRY` in `ui/kit/Surface.tsx`; don't restate them here or in the doc.

Implementation notes the doc doesn't cover: the canvas is `absolute inset-0` in `Layout` with every surface `fixed` over it; the chrome's idle fade and the over-Customize hide are one store (`shell/idle.ts`, `useChromeHidden`); fullscreen targets the app root (`shell/fullscreen.ts`) and `UNSAFE_PortalProvider` in `Layout` keeps react-aria overlays inside it; `timelineEditorOpen` defaults to false and `loadProject` keeps the window's current value (it's view state that happens to live in `Settings`).

**Inspector** = the Customize panel (`ui/Inspector.tsx`, parts in `ui/controls.tsx`; open state `useShell.lookOpen`, toggled from the pill): five tabs (Notes / Effects / Keyboard / Scene / Sound, remembered in localStorage); each tab is a stack of `Section` cards whose header carries the feature's on/off switch (`enabledKey`; off = body closed) and sticks while scrolling; everyday rows first, the rest behind a `Detail` disclosure. Search spans every tab (matches grouped under the tab name). Effects' colour is always the same select (`FollowColorRows`: follow notes | solid; the hit line adds its own gradient). While a keyframe is targeted, rows whose key a keyframe can't hold (`isAnimatableKey` false) carry the line "Can't change over time. Applies to the whole song." (`scopeKey` on the row; Bound rows pass their key). Switching Material alone also brings in that material family's lights (`lightsForMaterialSwitch`). Design notes: `_local/INSPECTOR_DESIGN.md`.

**File drag-and-drop.** Single `<DropZone>` wraps the whole Layout (drops on Toolbar/Inspector used to silently fail). `.nfz` → `openProjectFromFile`; `.mid`/`.midi` → direct parse + setSong. Failures surface via `showAlert({ tone: 'error' })`.

**Footgun**: react-aria's `DragTypes.has('Files')` does NOT mirror HTML's `dataTransfer.types.includes('Files')` — it holds MIME types, not the OS-level `'Files'` sentinel. Don't gate `getDropOperation` on `'Files'`; either return `'copy'` unconditionally and filter in `onDrop`, or check specific MIME types.

**Toolbar** (`ui/Toolbar.tsx`) owns the state and renders the two top islands (`shell/SongIsland.tsx`, `shell/InputIsland.tsx`). The wordmark opens the app menu (`shell/AppMenu.tsx`: shortcuts, language, report / request, GitHub, analytics switch); Record ▾ opens the takes popover (`shell/TakesPopover.tsx`, count-in switch on top). **File menu** consolidates New / Open / Open Recent ▸ / Save / Save As / Open MIDI / Demo Songs. Disables during recording. Open MIDI replaces just the song; Open Project replaces the whole session. Open Recent submenu hides when no recents OR FSA unavailable. **Open… also accepts audio**: an audio pick is added to the current song as its accompaniment (`importUserAudio`) instead of replacing the session, so the discard-changes prompt runs *after* the picker, once the file type is known. With a song loaded the timeline's audio lane is always shown; empty, it carries an "Add audio…" button (`pickAndImportUserAudio`).

**App menu** → "Report a bug" / "Request a feature" open `FeedbackDialog` (`ui/FeedbackDialog.tsx`, `feedback/report.ts`): the user's text + a device block they can see and untick (browser, screen, GPU, capability flags — never user content) is POSTed to the Cloudflare Pages Function `functions/api/report.ts`, which checks Origin, a honeypot and Cloudflare Turnstile, defuses @mentions and files a **public** GitHub issue (labels `bug`/`enhancement` + `from-app`), returning its URL for the "follow its status" link. Secrets on the Pages project: `GITHUB_TOKEN` (fine-grained, this repo, Issues read/write), `TURNSTILE_SECRET`; client `VITE_TURNSTILE_SITE_KEY` (unset → no widget, and the server skips the check only when its secret is unset too). No token / Vite dev server → the dialog offers GitHub's own issue form (`githubIssueUrl`, `environment` pre-filled). `functions/` has its own tsconfig (`npm run typecheck` covers it). Also hosts the analytics opt-out toggle (see Analytics).

**Global shortcuts** (`useGlobalShortcuts.ts`) for `Cmd+O` / `Cmd+S` / `Cmd+Shift+S` / Space wire on **capture phase** to beat browser native dialogs and any focused react-aria button.

`Viewport.tsx` adds a window-level `contextmenu` listener that `preventDefault()`s on canvas (right-click is delete); outside the canvas the browser menu stays.

## Build / dev

```
npm install
npm run dev        # Vite dev server on :5173
npm run build      # tsc -b && vite build → dist/
npm run typecheck
```

`index.html` lives at project root (Vite convention).

## Export (`src/export/`)

Offline render of the loaded song to either a WAV (audio only), a silent video (video only), or an A/V video. Video is MP4 (H.264 + AAC) or WebM (VP9 / AV1 + Opus), picked per export. Triggered from File → Export… → settings dialog (`ExportSettingsDialog`); progress + cancel surfaced via `ExportProgressModal` with wall-clock-derived ETA.

### `audio/clock.ts` — pluggable time source

Module-level `Clock` with `setActiveClock` / `resetActiveClock` / `now()`. Default is the real wall clock (`performance.now() / 1000`). Engine + visual effects (HitParticles, LandingFlashes, HitLine, FallingNotes' `uPhase` integrator, customTexture animator) all read `now()` instead of `performance.now()` so the exporter can swap in a `VirtualClock` and step them at non-realtime intervals.

Recorder + MIDI input intentionally still call `performance.now()` directly — they only run during live performance, never under a virtualised clock.

### Shared helpers

- **`timeline.ts`** — `computeExportTimeline(song, settings, userAudio)` is the single source of the rendered window (MIDI offset, trim, speed automation, accompaniment tail, `TAIL_SECONDS = 5`). Audio and video both call it, so the two tracks always span the same length. Change the window here, never inline in a renderer.
- **`async.ts`** — `raceWithAbort(p, signal, onAbort)` takes an error factory so each pipeline keeps its own abort type (`AudioRenderAborted` / `VideoRenderAborted` in `errors.ts`); also `yieldToEventLoop` and `MAX_ENCODE_QUEUE`.
- **`download.ts`** — `triggerDownload` + `defaultExportFileName(songName, ext)`.

### Audio render (`renderAudio.ts` + `synth/`)

`renderAudio.ts` is orchestration only. Builds a fresh `OfflineAudioContext` at the chosen sample rate, brings up the piano via `synth/piano.ts` (`loadOfflinePiano`: `createPiano(ctx)` with the **infinite-lookahead Scheduler**, then applies settings), schedules via `synth/schedule.ts` (`scheduleSongNotes` with the same lookahead / stop-buffer / pedal-sustain semantics as the realtime tick; `scheduleUserAudio` for the accompaniment), and `await ctx.startRendering()`. Returns an `AudioBuffer`. Shared constants (`LOOKAHEAD`, `STOP_BUFFER`, `DEFAULT_SAMPLE_RATE`) live in `synth/consts.ts`.

Pedal sustain is scheduled up front offline: from each note's natural off-time, `scheduleSongNotes` walks the CC64 curve and schedules the held voice's fade per pedal event via `holdRelease` (same half-pedal model as the realtime engine, see AudioEngine above).

`AbortSignal` plumbing: `raceWithAbort` wraps both the sample fetch (`await piano.load`) and `ctx.startRendering()` so Cancel is responsive even mid-load. The underlying work continues in the background and gets GC'd along with the abandoned `OfflineAudioContext`.

Default sample rate: 44.1 kHz (vs 48 kHz). Convolution reverb is the dominant cost; the audible difference for piano material is below human-hearing thresholds and the lower rate noticeably trims render time.

### Video render (`renderVideo.ts`)

Single function `renderSongVideo(song, settings, options)` produces a complete MP4 or WebM Blob (per `options.codec`) with both video + audio tracks (or video only when `options.audio === null`).

**Pipeline:**
0. **Preflight** (`codec/preflight.ts`, `assertEncodersSupported`): probe the exact video + audio encoder configs with `isConfigSupported` before any render work, and throw a specific message naming the other codecs. Browsers can ship WebCodecs yet lack a codec (Firefox-based browsers have no AAC encoder, so MP4 + audio fails there; their H.264 video depends on the OpenH264 plugin).
1. `enterSceneExportMode` (`sceneExportMode.ts`) snapshots R3F state (renderer size, pixel ratio, frameloop, camera aspect, `state.clock` flags), resizes the drawing buffer to the export resolution, switches to `frameloop="never"`, and returns the never-throwing `restore()` the `finally` block calls.
2. **Disarm `THREE.Clock`** (also inside `enterSceneExportMode`): stop it + set `autoStart=false` + zero `elapsedTime`/`oldTime`. Without this, R3F's `getDelta()` (called unconditionally before the `frameloop="never"` override) accumulates wall-clock seconds into `elapsedTime`. The override's `delta = timestamp - elapsedTime` then drifts with units mismatched against our virtual timeline and **eventually goes negative** — sending Keyboard's exp-decay glow into NaN/Infinity (~1 minute into a render the keyboard saturates and clips to black). With autoStart off, getDelta returns 0 and the override owns the timeline.
3. Install a `VirtualClock` and call `audioEngine.beginExportPlayback()`. The clock swap bumps `clockEpoch()`, which every effect holding absolute-time or decaying state checks to start the render clean (HitParticles' buffer, LandingFlashes' hold deadlines, Keyboard's glow / press) — otherwise whatever was lit by playback right before Export lingers in the video's opening frames.
4. Build one muxer via `createMuxer` (`codec/muxer.ts`): `mediabunny` `Output` + `Encoded*PacketSource`, with `Mp4OutputFormat` (`fastStart: 'in-memory'`) for H.264 and `WebMOutputFormat` for VP9 / AV1, behind a small `MuxerLike` interface. Params carry the selected `VIDEO_CODECS[codec].config` (`muxVideoCodec` / `muxAudioCodec` name the muxer-side track codecs); `muxer.ts` never imports `VIDEO_CODECS`. Interface (`addVideoChunk` / `addAudioChunk` / `finalize(): Promise<Blob>`). Mediabunny's `add` is async while encoder output callbacks are sync, so every `add` is serialised on one promise chain (after `output.start()`); the first error poisons the chain and rethrows from `finalize`.
5. **Audio render runs in parallel** with the video pass — `renderSongAudio(...)` returns a Promise that's not awaited until step 7. The OfflineAudioContext processes off the main thread; the video frame loop runs on the main thread; total wall-clock = max(audio, video) instead of sum.
6. Frame loop:
   - `clock.setTime(t)` — virtual time in seconds
   - `r3f.advance(t, true)` — fires all useFrames + renders. **Pass seconds, not milliseconds**: useFrame consumers (Keyboard's `1 - exp(-delta/decay)` glow) treat delta as seconds, and the `frameloop="never"` override sets `delta = timestamp - elapsedTime` directly.
   - `new VideoFrame(canvas, { timestamp })` → `videoEncoder.encode(...)`
   - **Yield to event loop every frame** via `MessageChannel.postMessage` (`yieldToEventLoop()`). Without this, the synchronous loop monopolises the main thread and Cancel-button clicks never fire. `setTimeout(0)` would compound the spec's nested-timeout 4 ms clamp into many seconds across an 18 000-frame render; MessageChannel has no clamp.
7. Await audio buffer → AudioEncoder (AAC or Opus) → `encodeAudioBuffer` (`codec/audio.ts`: 1024-sample `f32-planar` chunks with queue backpressure) → muxer.
8. Flush both encoders, `muxer.finalize()`, return Blob.

**Codec presets** (`codec/codecs.ts`): `VIDEO_CODECS` maps `h264` / `vp9` / `av1` to container, extension, MIME, audio codec and audio sample rate, plus a `pickCodecString(w, h, fps)` that steps the level by throughput so `VideoEncoder.configure()` doesn't reject mismatched levels (H.264 by macroblocks/s, VP9 / AV1 by luma samples/s). `videoEncoderConfig(...)` (`codec/video.ts`) builds the encoder config; only H.264 gets `avc: { format: 'avc' }`.

| Codec | Container | Audio | Audio rate |
|---|---|---|---|
| `h264` | MP4 | AAC-LC (`mp4a.40.2`) | 44.1 kHz |
| `vp9` / `av1` | WebM | Opus | 48 kHz (Opus rejects 44.1 kHz) |

`audioConfigFor(codec)` (`exportVideo.ts`) returns the matching audio track config — always use it instead of a fixed 44.1 kHz, or Opus export fails. To add a codec: extend `VideoCodec`, add a `VIDEO_CODECS` entry, map its container to a mediabunny output format in `createMuxer`, and add the `export.codec.<id>` i18n strings.

**Progress** is a single weighted-sum bar: `audioWeight × audioFraction + videoWeight × videoFraction`. Audio weight collapses to 0 when no audio track is wanted, so the bar becomes pure video progress. The audio fraction is itself a weighted sum of three sub-phases (loading 35% / offline render 55% / AAC encode 10%) so it's monotonic.

**Browser support:** WebCodecs (`VideoEncoder` + `AudioEncoder` + `VideoFrame` + `AudioData`) is the binding constraint. Available on Chrome / Edge / Safari 16.4+; Firefox is still rolling out (early 2026). `isVideoExportSupported()` gates the dialog's video options. Per-codec availability varies on top of that: `probeVideoCodecs()` checks each preset (1080p30 video + its paired audio codec) so the dialog can disable the ones the browser can't encode.

### Settings dialog + progress modal (`ui/Export*.tsx`)

`ExportSettingsDialog` — single configuration form with format radio (Video+audio / Video only / Audio only), codec / resolution / fps / quality (when video), and an estimated-size readout. Each open runs `probeVideoCodecs()`: unsupported codecs are disabled and an unavailable selection moves to the first usable one (order `h264` → `vp9` → `av1`). The file extension (`Toolbar`'s `buildExportFileName`) follows `VIDEO_CODECS[codec].config.ext`. Defaults persist across the session via `Toolbar`'s `exportDefaults` state. Dismissable; no in-flight work to lose.

`ExportProgressModal` — shared by all three export paths. Shows title, phase label, progress bar, percentage, and ETA (`elapsed × (1/progress - 1)`, suppressed below 5% progress so the readout doesn't snap from a wildly wrong huge number). Non-dismissable; Cancel button aborts the controller.

## Analytics (`src/usage/`)

Anonymous, opt-out usage analytics via **PostHog EU Cloud**. The only outbound data in the whole app; the "nothing is uploaded" promise is now scoped to *content* (MIDI / recordings / projects / audio), which is still never sent.

- **The directory is deliberately `src/usage/`, NOT `src/analytics/`.** Ad/privacy blockers (uBlock, Brave, EasyPrivacy) block any request whose path contains `analytics` / `tracking` / `telemetry` / `metrics` / `beacon` etc. with `ERR_BLOCKED_BY_CLIENT`. In Vite dev, modules are served by source path, so a `src/analytics/` file is blocked outright — and since it's statically imported into `store.ts` (the earliest critical path) that **white-screens the entire app** for anyone with a blocker. Do NOT rename this back to a blocked word. PostHog's own SDK/network (dynamic `import('posthog-js')` + `eu.i.posthog.com`) is still blockable, but that's caught (`ph = null`) and only loses data — it never breaks the app.

- **Hard invariant** (enforced in `index.ts` + documented in `events.ts`): only the closed event set in `events.ts` is sent; numeric magnitudes are **bucketed** (`noteBucket` / `durationBucket` / `pinCountBucket`) so a song can't be fingerprinted; never filenames/paths/free-text/error-message bodies. Mirrors the feedback form's "never user content" rule.
- **`analyticsEnabled()` is the single gate**: needs a `VITE_POSTHOG_KEY` AND `import.meta.env.PROD` AND not `navigator.doNotTrack` AND not the persisted opt-out. Dev / local clones / no-key builds never even `import('posthog-js')` — true no-op. Re-checked on every `track()` so flipping DNT / opt-out mid-session takes effect with no reload.
- **PostHog config**: EU host, `autocapture` + `capture_pageview` + session-recording all OFF, `person_profiles: 'identified_only'` (we never `identify()` → anonymous), `persistence: 'localStorage'` (no cookies → no consent banner, retention still works).
- **Wiring**: `initAnalytics()` + `app_loaded` in `App.tsx` (capability flags only). Events fired at chokepoints: `store.ts` (`playback_*`, `note_edited` — one per committed `applySongEdit`, no op label; `undo`/`redo`; `settings_pin_added`/`settings_reset`), `recordControl.ts`, `projects/actions.ts` (`song_opened` with a `SongSource` enum, `project_*`, `error_surfaced` with a context enum — no message text), Toolbar export handlers (`export_started`/`export_finished` with format — `wav` or `<container>_av` / `<container>_video`, so H.264 keeps the pre-WebM `mp4_av` / `mp4_video` values — plus codec/res/fps/quality + outcome), and `markLivePlay()` (deduped once per input type per session) from `Keyboard.tsx` / `pcInput.ts` / `midiInput.ts`.
- **Opt-out**: `nf:analytics-optout` in localStorage; App-menu switch (`shell/AppMenu.tsx`) mirrors it. `setAnalyticsOptOut` also calls PostHog `opt_in/out_capturing`.
- **Env**: `VITE_POSTHOG_KEY` / `VITE_POSTHOG_HOST` (default `https://eu.i.posthog.com`) in `.env.example` / `.env.production`. Blank key ⇒ analytics absent.

## Hands (beta, `src/hands/`)

Virtual piano hands that play the loaded song. Off by default (`handsEnabled`; Inspector Keyboard tab "Hands (beta)"; not pin-animatable). The motion comes from a **runtime of built files** in `src/hands/runtime/` (`hands.js` + `.d.ts`, `hands-worker.js`, `hands.wasm`; see its README): they are built in the private repo `_local/piano-hands` (`npm run wasm:dist`) and copied in as they are. **Never put that repo's source here**; to update, rebuild there and copy `dist/ship/` over (all but its README) (keep the README's hashes current). The app side is only integration and rendering.

- **Motion** (`motion.ts`): `songHandNotes` maps the song onto the **timeline clock** (clip offset + speed map, trim window, `transpose`) and passes each note's own `hand` / `finger` from the selection card, which the runtime keeps (the rest it fills in). `synthHandMotion` makes the motion in the runtime's Worker (cancelled by an `AbortSignal` when a newer request replaces it). The runtime is one per page: created on first use (`HandsRuntime.create` compiles `hands.wasm` once and hands it to the Worker), released `RELEASE_AFTER_MS` after the last `Hands` unmounts (the Worker holds ~300 MB once the data is loaded). **Motion data**: `motion.<hash>.bin` (~22 MB) on the sample CDN under `hands/` (`https://samples.notefall.app/hands/…`, dev through the `/samples-cdn` proxy, `VITE_HANDS_DB_URL` overrides); the Worker downloads it only when hands are on and keeps it in Cache Storage (`nf-motion-db`). Serve it as-is (no Content-Encoding). Progress / errors are a small store (`getHandsStatus` / `subscribeHandsStatus`): the loading island shows the data loading and a song's motion being made (the latter only after 400 ms, straight on from the loading row), a failure is a toast once and a line under the Inspector section. The runtime's `poseAt` slides each hand in from below the keys before its first note and away after its last (and in long rests without motion), so hands never pop in or out. `handsSettled()` resolves when no motion is being made and the meshes are loaded; `renderVideo` awaits it before entering export mode.
- **Render**: `Hands.tsx` (mounted in `SceneContents` when `handsEnabled`; nothing drawn without a song) remakes the motion debounced (150 ms) on song / mapping changes (an edit keeps the previous motion playing until the new one is ready; a different song shows no hands meanwhile) and, each `useFrame`, poses skinned `meshHand.ts` hands from the runtime's `poseAt(motion, audioEngine.currentSongTime())` (a pure function of t) — the clock FallingNotes uses, via `audio/clock.ts` — so the offline exporter's `advance()` loop draws the same hands. Hand meshes have `raycast` disabled (never block editor clicks / key presses); they are lit by the scene's own lights, no shadows. **Lighting matches the keys**: skin is a dark matte albedo (roughness 0.82, no sheen / env map, faint neutral rim) scaled by the resolved `keyboardBrightness` each frame (`setLighting`), so unlit hands read as near-silhouettes below the white keys' luminance. The landing flashes light them: `Keyboard`'s top-6 flash slots are mirrored into `keyboard/flashLights.ts` (same arrays the white-key shader uses) and the skin `onBeforeCompile` loops over them as **point lights**: wrap diffuse + a small specular per slot, Gaussian falloff (key-glow X/Y widths `falloffX/Y`, tight `5.0` in height), so only a subtle tint reaches the fingertips / edges nearest a lit key. Each slot also adds a **hit-line glow** term (light at the hit line, z 0.35, wide Gaussian falloff with wrap-lambert, slot note colour) so the back of the hand / knuckles pick up colour too. Lights sit at the true world position (flash y is keyboard-local, hands are world-space, so `+ KEYBOARD_Y`); an earlier offset-0 placement put them ~2 wu above the hit line and the hands got effectively no light. The slots' intensity for the hands is `flashLights.handIntensities` (glow WITHOUT the same-pitch retrigger dip, so repeated notes don't pulse the hands); all scaled by `handsFlashLight` (0..2). The hand mesh darkens to black toward the wrist end (world-Y smoothstep below the keyboard front edge) so the forearm cut vanishes into a dark foreground (darkening, not alpha, so it assumes a dark background). Standard-material path, so Bloom on/off colour space is handled by three; fixed slot count, no recompiles.
- **Assets**: `public/hand-models/godot/` (hand_l / hand_r.gltf, Godot XR Tools hand models by Miodrag Sejic, **CC0**; `LICENSE.md` kept next to them).
- **Motion blur** (`motionBlur.ts`, `handsMotionBlur` default off, `handsBlurSamples` = cap 8): the lab's hands-only temporal supersampling. `Hands.tsx` `useFrame` picks the sample count from the fastest joint's px travel over a trailing shutter (`BLUR_SHUTTER` 0.5 of ONE nominal frame of song time = `rate × (1/exportFps | 1/60 s)`; `exportBridge.setExportFps` is set by `renderVideo`; never the real frame delta; sample 0 = t) and publishes a `blurBridge.plan`; < `BLUR_MIN_PX` of travel ⇒ no plan ⇒ the untouched default render (identical to blur off). A blurred frame renders the scene ONCE (hands hidden) into an MSAA half-float target with a depth texture, then the hands N times against a depth copy (gl_FragDepth seed quad, scissored to per-hand rects), accumulates rgb+coverage and composites `accum + (1-a)·base`. Bloom ON: `HandsBlurComposerPass` (child of `<EffectComposer>` before Bloom) disables the composer's RenderPass for that frame and composites into the composer's input buffer (linear), so Bloom sees it like a normal frame. Bloom OFF: `HandsBlurPlainRender` (priority-1 useFrame, only mounted then) renders to the canvas. With Bloom OFF the targets hold sRGB-ENCODED colour (`nfEncoded`, texture colour space sRGB; the composite undoes it before three's output encode) and the layers' `uLinearTarget` goes through `scene/linearTarget.ts` `isLinearTarget`, so alpha-blended glows / particles / labels blend exactly as on the canvas: before this the blurred path blended them in linear space and the WHOLE frame (mean +14 / 255) jumped brighter whenever the adaptive blur toggled between plain and composite (the flicker). Bloom ON is linear in both paths. Tone mapping follows the destination's plain render: with Bloom OFF the base / hand targets are flagged `isXRRenderTarget` so three ACES-tone-maps `toneMapped` materials as on the canvas; with Bloom ON they are plain targets (no tone mapping), like the composer's own RenderPass — flagging them there tone-mapped the blurred hands twice and they went visibly darker whenever the blur kicked in. GOTCHAS: the composer's buffers keep the PREVIEW size during an export, so the plan computes hand rects per destination size (`rectsFor`) and everything runs at the destination's resolution; three reads `renderTarget.scissor` inside `setRenderTarget` (set scissor, then bind). Transparent layers (particles / flashes) are in the base pass, so a hand always covers them.
- **Known gaps**: no hand shadows on keys, no live-play hands, `meshHand.ts` calibrates the fingertip stretch (`tipExt`) over the first pressed frames (tiny render-time state, not in `poseAt`).

## Dev mode (`src/dev/`, dev builds only)

Not part of production: `main.tsx` loads `dev/boot` through `if (import.meta.env.DEV) import(...)`, and `dev/mode.ts` is constant-false when `DEV` is false, so the panel / lil-gui (devDependency) never reach `dist` (verify: grep dist for `notefall dev` / `lil-gui` / `nf:dev`).

- **Switch**: `Ctrl+Alt+D` or `?dev=1` / `?dev=0` (persisted in localStorage `nf:dev`). Off = identical to production (the panel is destroyed).
- **No audio** (`nf:dev:noaudio`, default ON with dev tools on): `devNoAudio()` makes `audioEngine.init()` resolve without loading the ~77 MB samples, `isReady()` true, `tick()` / `seek()` / `triggerKey()` run with no-op stops (key glow, flashes, particles, hands all work, no sound), and `ensureAudioReady` / `play()` skip Tone. `audioEngine.hasSampler()` is the real "samples loaded" check; `dev/boot.ts` resets `loadStatus` to idle when the mode flips without a sampler.
- **Panel** (`dev/panel.ts`, lil-gui): draggable by its title bar (position + collapsed state in `nf:dev:panel`, clamped to the viewport), No-audio toggle, readouts (fps, frame ms, the hands' status). `window.__nfDev` exposes store / engine for the console.

## License

PolyForm Shield 1.0.0 (source-available). Permits any use except providing a competing product or service. See `LICENSE.md`.

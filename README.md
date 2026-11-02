# notefall

A piano visualizer that runs in the browser. Load a MIDI file and the notes
fall onto a 3D keyboard as the song plays. Notes are rendered in 3D, with
realistic reflections and textures like metal, water, ice or glass. Keys light
up when a note lands, and particles drift up from it like smoke.

You can also record from a MIDI keyboard, fix the notes on screen, and save the
result as a MIDI file or a video.

notefall is free, with no account and no watermark on exported videos.

<p align="center">
  <img src=".github/screenshot.jpg" alt="A beautiful piano visualization: faceted, crystal-like notes in violet and cyan fall onto a 3D piano keyboard. Light glints off their cut edges, struck keys glow in the note's color, and particles drift up like smoke from a glowing hit line. The Customize panel is open on the right, showing note styles such as Jewel, Ice and Marble." width="800">
</p>

<p align="center">
  <strong><a href="https://notefall.app">▶ Try it live — notefall.app</a></strong>
</p>

## Look

- Notes rendered in 3D, with realistic reflections and textures such as metal,
  water, ice, glass and marble.
- Particles and soft haze rise from each note and drift like smoke.
  Note shape, color, glow and particles can all be changed. Colors can follow
  the track, the hand, a gradient across the keyboard, or a random palette.
- Keyframes change colors, camera, bloom and background during the song.

## Record and edit MIDI

- Record from a MIDI keyboard, PC keyboard, mouse or touch. Velocity and the
  sustain pedal are recorded, with an optional count-in.
- Edit notes directly on the falling notes: add, move, resize, split and
  delete, and set velocity, hand and finger. Undo and redo.
- Save the song, or any recorded take, as a MIDI file.

## Export

- Video up to 4K at 60 fps, as MP4 (H.264) or WebM (VP9, AV1), with or without
  audio. WAV for audio only.
- Frames are rendered one by one rather than recorded in real time, so the
  video stays smooth on a slow computer.

## More features

- Playback with a sampled grand piano.
- Timeline: MIDI offset and trim, speed changes, and an audio track that plays along.
- Virtual hands (alpha) that play the song.
- Projects saved as `.nfz` files on your own disk.

MIDI files, recordings, projects and audio are processed in the browser and are
not uploaded. The app sends anonymous usage statistics, which can be turned off
in the app menu, and bug reports or feature requests only when you submit them.

## Tech stack

- Vite + React 18 + TypeScript
- [`@react-three/fiber`](https://github.com/pmndrs/react-three-fiber) + drei +
  postprocessing (Bloom) for the 3D scene
- [`smplr`](https://github.com/danigb/smplr) for sample playback,
  [`tone`](https://tonejs.github.io) for the AudioContext lifecycle
- [`@tonejs/midi`](https://github.com/Tonejs/Midi) for MIDI parse/serialize
- `react-aria-components` + Tailwind for the UI, `zustand` for state
- `mediabunny` + WebCodecs for MP4 / WebM export

## Working on the UI

The interface follows a small design system: tokens, a react-aria component kit
and rules for layout, motion and copy. Read
[`docs/design-system.md`](docs/design-system.md) before adding or changing UI.

## Credits

- Piano samples: [Salamander Grand Piano V3](https://archive.org/details/SalamanderGrandPianoV3)
  by Alexander Holm, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)
- Hand models: [Hand Models for the Godot XR Tools](https://github.com/GodotVR/godot-xr-tools)
  by Miodrag Sejic, CC0

## License

[PolyForm Shield 1.0.0](LICENSE.md). The source is available, and any use is
permitted except offering a competing product or service.

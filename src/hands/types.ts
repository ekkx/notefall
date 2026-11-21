// The pose a renderer draws: the runtime's (runtime/hands.d.ts), re-exported for meshHand / motionBlur.
//
// World frame = notefall's (see ../keyboard/layout):
//   x  lateral; key centre = keyForMidi(m).x (88 keys span x ∈ [-6.11, 6.11])
//   y  along the keys: front (player) edge at KEYBOARD_Y = -2.0, back edge at NOTE_HIT_Y = -0.525.
//   z  up, toward the camera. White key top z = 0, black key top z = BLACK_KEY_THICKNESS (0.09).
//   Units: 1 mm = 0.01 world units (white key 23.5 mm wide).
// The player sits at -y: fingertips point toward +y, wrists / forearms extend to y < KEYBOARD_Y.
//
// HandPose: `elbow` (forearm start, y < wrist.y), `wrist`, `bases` (metacarpal bases, thumb first), `fingers[f]` (0 = thumb …
// 4 = little; thumb [CMC, MCP, IP, tip], others [MCP, PIP, DIP, tip]), `press` (per finger 1 while it holds a key),
// `thumbRef` (the thumb bones' twist references).
export type { Hand, HandPose, HandPoses, Vec3 } from './runtime/hands'

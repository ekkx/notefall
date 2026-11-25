import { KEYBOARD_Y, NOTE_HIT_Y } from '../keyboard/layout'

// Invisible click planes above and below the keyboard (play / pause while playing, the editor while paused), larger than
// any view. Behind the notes; the keys between them take their own clicks.
const WIDTH = 120
const HEIGHT = 60
const Z = 0.01

type PickPlane = { name: string; position: [number, number, number]; size: [number, number] }

export const PICK_PLANES: readonly PickPlane[] = [
  { name: 'above', position: [0, NOTE_HIT_Y + HEIGHT / 2, Z], size: [WIDTH, HEIGHT] },
  { name: 'below', position: [0, KEYBOARD_Y - HEIGHT / 2, Z], size: [WIDTH, HEIGHT] },
]

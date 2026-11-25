import { NOTE_HIT_Y } from '../keyboard/layout'
import { fallTravel, getLensWindow } from '../scene/framing'
import { FALL_REFERENCE_DISTANCE } from './positions'

/**
 * How far to move a song note's textures along the note (world units) so that a zoom changing the note's length does not
 * slide them. A note can only get longer or shorter by letting one end of its texture run out, so the texture is held at
 * the note's point nearest the keyboard: the near end while the note is away from the hit line, and at the line while it
 * crosses (there the texture has moved by exactly what has fallen through, zoom changes included).
 * 0 whenever the fall length is constant.
 */
export function textureShift(
  t: number,
  headFire: number,
  tailFire: number,
  centerY: number,
  length: number,
  isDown: boolean,
  fallSec: number,
  texUnit: number,
): number {
  const perSec = FALL_REFERENCE_DISTANCE / fallSec
  // World y of the note's head if the texture up to the held point were rigid.
  let head: number
  if (isDown) head = t <= headFire ? centerY - length / 2 : NOTE_HIT_Y - perSec * fallTravel(headFire, t)
  else if (t <= tailFire) head = NOTE_HIT_Y + perSec * fallTravel(headFire, t)
  else head = NOTE_HIT_Y + perSec * getLensWindow().fall * (t - tailFire) + perSec * fallTravel(headFire, tailFire)
  const halfRef = (length * texUnit) / 2
  return isDown ? centerY - head - halfRef : centerY - head + halfRef
}

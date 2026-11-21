// Rendered finger thickness (meshHand.ts).
// Index breadth at the PIP: FAA 2008 survey medians 21 mm (men) / 18 mm (women); DIP width ~15 mm (PMC5702813,
// snippet); thumb ~20 mm at the IP (girth 6.8 / 5.9 cm, PMC12309929). Middle ≈ index (DIP widths alike); ring /
// little scaled down (no measured breadths found — ESTIMATE). Round capsules, so the dorsal-palmar depth equals the
// breadth (real fingers are a little flatter).
/** Capsule radius at each finger's first joint (thumb first); tapers linearly to TIP_TAPER of it at the tip. */
export const FINGER_R = [0.115, 0.105, 0.105, 0.1, 0.09]
/** (the pad is nearly as wide as the DIP: index ~18 mm at the PIP, ~15.5 at the DIP, ~14 at the pad) */
export const TIP_TAPER = 0.68
export const PALM_R = 0.085
/** Radius at fraction `u` (0 = first joint, 1 = tip) along finger `f`. */
export const fingerRadius = (f: number, u: number, scale = 1) => FINGER_R[f] * (1 - (1 - TIP_TAPER) * u) * scale

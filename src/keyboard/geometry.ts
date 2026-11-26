import * as THREE from "three";
import {
  adjacentBlackKeys,
  BLACK_KEY_LENGTH,
  BLACK_KEY_THICKNESS,
  BLACK_KEY_WIDTH,
  WHITE_KEY_LENGTH,
  WHITE_KEY_WIDTH,
} from "./layout";

// Wood chassis below the white cap, sharing the cap's 4% inter-key
// inset so the visible gap between keys runs continuously top-to-bottom
// (and adjacent bodies' rounded front corners don't collide at the
// boundary). Wood is still visible at oblique viewing angles.
export const WHITE_BODY_HEIGHT = 0.5;
export const WOOD_COLOR = "#a87d38";
export const WOOD_TOP_GAP = 0;
export const WHITE_CAP_THICKNESS = 0.015;
const WHITE_CAP_CORNER_RADIUS = 0.025;
// Rim bevel applied uniformly to the cap perimeter — softens the
// front-top edge, the side edges of the front face, and the cap top's
// corner profile. ExtrudeGeometry extrudes (depth − 2·bevel) and adds
// bevel volumes on top + bottom; we offset the post-translate so the
// final top face still lands at mesh-local z = 0.
const WHITE_CAP_BEVEL = 0.005;

// Black-key slope angle from horizontal — real piano black keys have a
// flat (non-curved) ~50° front-facing bevel.
const BLACK_SLOPE_ANGLE_DEG = 55;
const BLACK_SLOPE_Y =
  BLACK_KEY_THICKNESS / Math.tan((BLACK_SLOPE_ANGLE_DEG * Math.PI) / 180);
const BLACK_KEY_PIERCE = 0.18;
// Top-face front/back recess and fillet z-rise (in cross-section). The
// slope ends at z = t - INSET; a fillet ring rounds the remaining INSET
// in z while inseting INSET in y at the front/back. In x the fillet does
// nothing — body sides have already tapered to the top half-width by
// z = skirtZ (see BLACK_BODY_TAPER), so the top face simply continues
// straight up from the body sides.
const BLACK_TOP_INSET = 0.01;
// Top-face corner radii (front and back). Small — face width is governed
// by the body taper, not by corner rounding.
const BLACK_TOP_CORNER_R = 0.012;
// Front corner radius — rounds the top face's front-left/right corners
// AND extrudes downward as a 3D chamfer along the slope/side diagonal,
// making both edges between slope+side and top+side smoothly curved.
const BLACK_FRONT_TOP_CORNER_R = 0.01;
// Fillet / chamfer curve smoothness — number of subdivisions per quarter
// turn. Higher = closer to a true CSS-style border-radius arc; lower =
// faceted bevel. Used by the top-edge fillet and the slope/side chamfer.
const BLACK_FILLET_SEGMENTS = 12;
const BLACK_INNER_FILL_INSET = 0.001;

// Derived dims, hoisted so JSX (gray marker line) can reuse them without
// re-deriving from BLACK_SLOPE_Y etc.
const BLACK_HALF_W = (BLACK_KEY_WIDTH * 0.96) / 2;
const BLACK_HALF_L = BLACK_KEY_LENGTH / 2;
const BLACK_SKIRT_Z = BLACK_KEY_THICKNESS - BLACK_TOP_INSET;
const BLACK_SLOPE_END_Y =
  -BLACK_HALF_L + BLACK_SLOPE_Y * (BLACK_SKIRT_Z / BLACK_KEY_THICKNESS);
export const BLACK_TOP_FRONT_Y = BLACK_SLOPE_END_Y + BLACK_TOP_INSET;
// Body tapers inward over its z range so the slope's top edge, the body
// sides at z = skirtZ, and the top face's max half-width all line up.
// Top half-width = 80% of bottom — visible inward taper that still
// leaves a substantial top face.
const BLACK_BODY_TAPER = BLACK_HALF_W * 0.28;
// Common half-width at z = skirtZ → t: shared by slope top edge, body
// sides at z = skirtZ, and top face. Body tapers from ±halfW (z = 0) to
// ±this (z = skirtZ); above z = skirtZ stays at this width.
export const BLACK_TOP_HALF_W = BLACK_HALF_W - BLACK_BODY_TAPER;
// Edge chamfer radius. The fillet ring above z=skirtZ rounds inward by
// this amount in BOTH x and y, so the top/side and top/front edges of
// the body get a visible quarter-circle bevel. 0 = sharp top edge, ≈INSET
// = strongly rounded, larger than INSET will collapse the top face.
const BLACK_EDGE_CHAMFER = 0.008;

/**
 * Black-key geometry — body up to z=skirtZ (slope at front, rectangular
 * back/sides), then a quarter-circle FILLET RING wraps the perimeter from
 * z=skirtZ to z=t. The top face at z=t is a rounded rectangle inset by
 * BLACK_TOP_INSET on all 4 sides with corner radius BLACK_TOP_CORNER_R.
 *
 * The slope ends at z=skirtZ instead of z=t (so it doesn't protrude past
 * the inset top). The fillet's outer outline at z=skirtZ matches the
 * body's outer outline; its inner outline at z=t matches the rectangular
 * portion of the top face's outline. Small flat corner-fans (in z=t plane)
 * fill the gap between the rectangular fillet end and the top face's
 * rounded corner arcs.
 *
 * An inner solid fill backs the body so every sub-pixel seam resolves to
 * black instead of revealing the white-key cap.
 *
 * Mesh-local: x ∈ ±halfW, y ∈ [-halfL, +halfL] (front → back),
 * z ∈ [-PIERCE, t]. PIERCE region hidden inside the white-key chassis.
 */
function createChamferedBlackGeometry(): THREE.BufferGeometry {
  const halfW = BLACK_HALF_W;
  const halfL = BLACK_HALF_L;
  const t = BLACK_KEY_THICKNESS;
  const sy = BLACK_SLOPE_Y;
  const p = BLACK_KEY_PIERCE;
  const b = BLACK_TOP_INSET;
  const Rb = BLACK_TOP_CORNER_R;
  const Rf = BLACK_FRONT_TOP_CORNER_R;
  const N = BLACK_FILLET_SEGMENTS;
  const skirtZ = BLACK_SKIRT_Z;
  const slopeEndY = BLACK_SLOPE_END_Y;
  const stHW = BLACK_TOP_HALF_W;

  const positions: number[] = [];
  const indices: number[] = [];
  let count = 0;
  const quad = (verts: Array<[number, number, number]>) => {
    const start = count;
    for (const v of verts) positions.push(v[0], v[1], v[2]);
    count += 4;
    indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
  };
  const tri = (verts: Array<[number, number, number]>) => {
    const start = count;
    for (const v of verts) positions.push(v[0], v[1], v[2]);
    count += 3;
    indices.push(start, start + 1, start + 2);
  };

  // ── Body below the fillet (z ∈ [-PIERCE, skirtZ]) ─────────────────────
  // Bottom + front-vertical (hidden behind the white-key chassis).
  quad([
    [-halfW, -halfL, -p],
    [-halfW, +halfL, -p],
    [+halfW, +halfL, -p],
    [+halfW, -halfL, -p],
  ]);
  quad([
    [-halfW, -halfL, -p],
    [+halfW, -halfL, -p],
    [+halfW, -halfL, 0],
    [-halfW, -halfL, 0],
  ]);
  // Slope — trapezoid: full key width at the bottom, narrowed to ±stHW at
  // the top so the slope's top edge matches the straight portion of the
  // top face's front edge. Only the slanted front face itself emits as
  // material group 1 (slightly brighter black); the side tris and the
  // small y=slopeEndY gap-fill tris stay in group 0.
  const slopeIdxStart = indices.length;
  quad([
    [-halfW + Rf, -halfL, 0],
    [+halfW - Rf, -halfL, 0],
    [+stHW - Rf, slopeEndY, skirtZ],
    [-stHW + Rf, slopeEndY, skirtZ],
  ]);
  const slopeIdxEnd = indices.length;
  // Step triangles at z=0 plane filling the corner gap between the
  // PIERCE region's full ±halfW outline and the slope's now-recessed
  // bottom edge / body's now-recessed front-bottom edge. Faces +Z; sits
  // at white-key cap level so largely occluded.
  tri([
    [-halfW, -halfL, 0],
    [-halfW + Rf, -halfL, 0],
    [-halfW, -halfL + Rf, 0],
  ]);
  tri([
    [+halfW, -halfL, 0],
    [+halfW, -halfL + Rf, 0],
    [+halfW - Rf, -halfL, 0],
  ]);
  // Back face — PIERCE rectangle (vertical, hidden) + above-z=0 trapezoid
  // that tapers inward to ±stHW at z=skirtZ.
  quad([
    [+halfW, +halfL, -p],
    [-halfW, +halfL, -p],
    [-halfW, +halfL, 0],
    [+halfW, +halfL, 0],
  ]);
  quad([
    [+halfW, +halfL, 0],
    [-halfW, +halfL, 0],
    [-stHW, +halfL, skirtZ],
    [+stHW, +halfL, skirtZ],
  ]);
  // Left side — PIERCE rectangle (vertical at x=-halfW) + a single slanted
  // quad above z=0 that subsumes both the body's old vertical side and
  // the slope's left side. The quad is planar in the plane
  // x = -halfW + (Δw/skirtZ)·z; its front-top corner is the slope's
  // top-left, its back-top corner sits directly above the back-bottom
  // edge after the taper.
  quad([
    [-halfW, +halfL, -p],
    [-halfW, -halfL, -p],
    [-halfW, -halfL, 0],
    [-halfW, +halfL, 0],
  ]);
  quad([
    [-halfW, -halfL + Rf, 0],
    [-stHW, slopeEndY + Rf, skirtZ],
    [-stHW, +halfL, skirtZ],
    [-halfW, +halfL, 0],
  ]);
  // Right side (mirror).
  quad([
    [+halfW, -halfL, -p],
    [+halfW, +halfL, -p],
    [+halfW, +halfL, 0],
    [+halfW, -halfL, 0],
  ]);
  quad([
    [+halfW, +halfL, 0],
    [+stHW, +halfL, skirtZ],
    [+stHW, slopeEndY + Rf, skirtZ],
    [+halfW, -halfL + Rf, 0],
  ]);

  // ── Slope/side chamfer (front-left + front-right diagonal edges) ──────
  // Continuous quarter-cylinder rounding the front-side dihedral. Phase 1
  // covers the body region (z=0 → skirtZ) with linear motion; phase 2
  // continues through the fillet region (z=skirtZ → t), tracking the same
  // y- and x-insets the side/front strips use so it merges seamlessly
  // into the top face's front-left/right corner arcs.
  const eC2 = BLACK_EDGE_CHAMFER;
  const M = N; // arc segments — match fillet for uniform smoothness
  const emitChamferQuad = (
    p00: [number, number, number],
    p01: [number, number, number],
    p11: [number, number, number],
    p10: [number, number, number],
  ) => quad([p00, p01, p11, p10]);

  // Left chamfer: ψ ∈ [π, 3π/2]. ψ=π → body offset (x=-halfW, y at +R from
  // -halfL); ψ=3π/2 → slope offset (x=-halfW+R, y=-halfL).
  // Phase 1 — z=0 to z=skirtZ.
  for (let k = 0; k < M; k++) {
    const psi0 = Math.PI + (k / M) * (Math.PI / 2);
    const psi1 = Math.PI + ((k + 1) / M) * (Math.PI / 2);
    const cBotX = -halfW + Rf;
    const cBotY = -halfL + Rf;
    const cMidX = -stHW + Rf;
    const cMidY = slopeEndY + Rf;
    emitChamferQuad(
      [cBotX + Rf * Math.cos(psi0), cBotY + Rf * Math.sin(psi0), 0],
      [cBotX + Rf * Math.cos(psi1), cBotY + Rf * Math.sin(psi1), 0],
      [cMidX + Rf * Math.cos(psi1), cMidY + Rf * Math.sin(psi1), skirtZ],
      [cMidX + Rf * Math.cos(psi0), cMidY + Rf * Math.sin(psi0), skirtZ],
    );
  }
  // Phase 2 — z=skirtZ to z=t (fillet region; corner center sweeps in y
  // by INSET and in x by eC2 as θ goes 0→π/2).
  for (let j = 0; j < N; j++) {
    const t0 = (j / N) * (Math.PI / 2);
    const t1 = ((j + 1) / N) * (Math.PI / 2);
    const iY0 = b * (1 - Math.cos(t0));
    const iY1 = b * (1 - Math.cos(t1));
    const iX0 = eC2 * (1 - Math.cos(t0));
    const iX1 = eC2 * (1 - Math.cos(t1));
    const z0 = skirtZ + b * Math.sin(t0);
    const z1 = skirtZ + b * Math.sin(t1);
    const c0X = -stHW + Rf + iX0;
    const c0Y = slopeEndY + Rf + iY0;
    const c1X = -stHW + Rf + iX1;
    const c1Y = slopeEndY + Rf + iY1;
    for (let k = 0; k < M; k++) {
      const psi0 = Math.PI + (k / M) * (Math.PI / 2);
      const psi1 = Math.PI + ((k + 1) / M) * (Math.PI / 2);
      emitChamferQuad(
        [c0X + Rf * Math.cos(psi0), c0Y + Rf * Math.sin(psi0), z0],
        [c0X + Rf * Math.cos(psi1), c0Y + Rf * Math.sin(psi1), z0],
        [c1X + Rf * Math.cos(psi1), c1Y + Rf * Math.sin(psi1), z1],
        [c1X + Rf * Math.cos(psi0), c1Y + Rf * Math.sin(psi0), z1],
      );
    }
  }

  // Right chamfer: ψ ∈ [3π/2, 2π]. ψ=3π/2 → slope offset (+halfW-R, -halfL);
  // ψ=2π → body offset (+halfW, -halfL+R).
  for (let k = 0; k < M; k++) {
    const psi0 = (3 * Math.PI) / 2 + (k / M) * (Math.PI / 2);
    const psi1 = (3 * Math.PI) / 2 + ((k + 1) / M) * (Math.PI / 2);
    const cBotX = +halfW - Rf;
    const cBotY = -halfL + Rf;
    const cMidX = +stHW - Rf;
    const cMidY = slopeEndY + Rf;
    emitChamferQuad(
      [cBotX + Rf * Math.cos(psi0), cBotY + Rf * Math.sin(psi0), 0],
      [cBotX + Rf * Math.cos(psi1), cBotY + Rf * Math.sin(psi1), 0],
      [cMidX + Rf * Math.cos(psi1), cMidY + Rf * Math.sin(psi1), skirtZ],
      [cMidX + Rf * Math.cos(psi0), cMidY + Rf * Math.sin(psi0), skirtZ],
    );
  }
  for (let j = 0; j < N; j++) {
    const t0 = (j / N) * (Math.PI / 2);
    const t1 = ((j + 1) / N) * (Math.PI / 2);
    const iY0 = b * (1 - Math.cos(t0));
    const iY1 = b * (1 - Math.cos(t1));
    const iX0 = eC2 * (1 - Math.cos(t0));
    const iX1 = eC2 * (1 - Math.cos(t1));
    const z0 = skirtZ + b * Math.sin(t0);
    const z1 = skirtZ + b * Math.sin(t1);
    const c0X = +stHW - Rf - iX0;
    const c0Y = slopeEndY + Rf + iY0;
    const c1X = +stHW - Rf - iX1;
    const c1Y = slopeEndY + Rf + iY1;
    for (let k = 0; k < M; k++) {
      const psi0 = (3 * Math.PI) / 2 + (k / M) * (Math.PI / 2);
      const psi1 = (3 * Math.PI) / 2 + ((k + 1) / M) * (Math.PI / 2);
      emitChamferQuad(
        [c0X + Rf * Math.cos(psi0), c0Y + Rf * Math.sin(psi0), z0],
        [c0X + Rf * Math.cos(psi1), c0Y + Rf * Math.sin(psi1), z0],
        [c1X + Rf * Math.cos(psi1), c1Y + Rf * Math.sin(psi1), z1],
        [c1X + Rf * Math.cos(psi0), c1Y + Rf * Math.sin(psi0), z1],
      );
    }
  }

  // ── Fillet ring (z ∈ [skirtZ, t]) ─────────────────────────────────────
  // 4 strips per θ-step: back / front / left / right. Outer outline at
  // θ=0 matches the body's outline at z=skirtZ (already at ±stHW thanks
  // to the body taper); inner outline at θ=π/2 is the rectangle ±stHW ×
  // [topFront, topBack]. Y-inset and z-rise share `b` (quarter-circle in
  // y-z); x is constant at ±stHW, so left/right strips are flat planes
  // that simply continue the slanted body wall up to the top face.
  // Back / left / right strips first (material group 0). The front strip
  // is emitted in a separate pass below so its indices stay contiguous
  // and can be assigned to material group 2 (gray seam between slope
  // and top face). With BLACK_EDGE_CHAMFER>0 the strips also round in
  // x: at z=skirtZ outer is ±stHW, at z=t inner is ±(stHW-eC), giving
  // the top/side and top/front a visible bevel.
  const eC = BLACK_EDGE_CHAMFER;
  for (let k = 0; k < N; k++) {
    const t0 = (k / N) * (Math.PI / 2);
    const t1 = ((k + 1) / N) * (Math.PI / 2);
    const iY0 = b * (1 - Math.cos(t0));
    const iY1 = b * (1 - Math.cos(t1));
    const iX0 = eC * (1 - Math.cos(t0));
    const iX1 = eC * (1 - Math.cos(t1));
    const z0 = skirtZ + b * Math.sin(t0);
    const z1 = skirtZ + b * Math.sin(t1);
    // Side strips are recessed at the front by Rf so the slope/side
    // chamfer corner gets a clean home; back strip is unaffected.
    const fs0 = slopeEndY + Rf + iY0;
    const fs1 = slopeEndY + Rf + iY1;
    const k0 = halfL - iY0;
    const k1 = halfL - iY1;
    const w0 = stHW - iX0;
    const w1 = stHW - iX1;
    // Back strip (y = halfL - inset; outward +Y).
    quad([
      [-w0, k0, z0],
      [-w1, k1, z1],
      [+w1, k1, z1],
      [+w0, k0, z0],
    ]);
    // Left strip (outward -X).
    quad([
      [-w0, fs0, z0],
      [-w1, fs1, z1],
      [-w1, k1, z1],
      [-w0, k0, z0],
    ]);
    // Right strip (outward +X).
    quad([
      [+w0, k0, z0],
      [+w1, k1, z1],
      [+w1, fs1, z1],
      [+w0, fs0, z0],
    ]);
  }
  // Front strip (material group 2 — visible as a gray transition from
  // slope to top face). x range is narrowed by Rf on each side so the
  // chamfer corners take over at the ends.
  const filletFrontStart = indices.length;
  for (let k = 0; k < N; k++) {
    const t0 = (k / N) * (Math.PI / 2);
    const t1 = ((k + 1) / N) * (Math.PI / 2);
    const iY0 = b * (1 - Math.cos(t0));
    const iY1 = b * (1 - Math.cos(t1));
    const iX0 = eC * (1 - Math.cos(t0));
    const iX1 = eC * (1 - Math.cos(t1));
    const z0 = skirtZ + b * Math.sin(t0);
    const z1 = skirtZ + b * Math.sin(t1);
    const f0 = slopeEndY + iY0;
    const f1 = slopeEndY + iY1;
    const w0 = stHW - Rf - iX0;
    const w1 = stHW - Rf - iX1;
    quad([
      [+w0, f0, z0],
      [+w1, f1, z1],
      [-w1, f1, z1],
      [-w0, f0, z0],
    ]);
  }
  const filletFrontEnd = indices.length;

  // ── Top face: rounded rectangle at z=t, fan-triangulated ──────────────
  // Outline parameters (after inset b in y on front/back and eC in x on
  // sides — the latter producing the rounded top/side bevel).
  const topFront = BLACK_TOP_FRONT_Y;
  const topBack = halfL - b;
  const topHalfW = BLACK_TOP_HALF_W - eC;
  const cFR: [number, number] = [topHalfW - Rf, topFront + Rf];
  const cBR: [number, number] = [topHalfW - Rb, topBack - Rb];
  const cBL: [number, number] = [-topHalfW + Rb, topBack - Rb];
  const cFL: [number, number] = [-topHalfW + Rf, topFront + Rf];

  // Generate outline points CCW (viewed from +Z): right edge → BR arc →
  // back edge → BL arc → left edge → FL arc → front edge → FR arc → close.
  const outline: [number, number][] = [];
  outline.push([+topHalfW, topFront + Rf]);
  outline.push([+topHalfW, topBack - Rb]);
  for (let j = 1; j <= N; j++) {
    const phi = (j / N) * (Math.PI / 2);
    outline.push([cBR[0] + Rb * Math.cos(phi), cBR[1] + Rb * Math.sin(phi)]);
  }
  outline.push([-topHalfW + Rb, topBack]);
  for (let j = 1; j <= N; j++) {
    const phi = Math.PI / 2 + (j / N) * (Math.PI / 2);
    outline.push([cBL[0] + Rb * Math.cos(phi), cBL[1] + Rb * Math.sin(phi)]);
  }
  outline.push([-topHalfW, topFront + Rf]);
  for (let j = 1; j <= N; j++) {
    const phi = Math.PI + (j / N) * (Math.PI / 2);
    outline.push([cFL[0] + Rf * Math.cos(phi), cFL[1] + Rf * Math.sin(phi)]);
  }
  outline.push([+topHalfW - Rf, topFront]);
  for (let j = 1; j <= N; j++) {
    const phi = (3 * Math.PI) / 2 + (j / N) * (Math.PI / 2);
    outline.push([cFR[0] + Rf * Math.cos(phi), cFR[1] + Rf * Math.sin(phi)]);
  }
  // Fan from center; polygon is convex so the fan tessellation is valid.
  const cTop: [number, number] = [0, (topFront + topBack) / 2];
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const c = outline[(i + 1) % outline.length];
    tri([
      [cTop[0], cTop[1], t],
      [a[0], a[1], t],
      [c[0], c[1], t],
    ]);
  }

  // ── Corner gap-fill triangles (z=t plane) ─────────────────────────────
  // The fillet ring's inner outline at z=t is a rectangle (sharp corners
  // at ±topHalfW × {topFront, topBack}); the top face's outline has
  // rounded arcs there. The small region between the sharp corner and
  // the rounded arc is a flat triangle fan in the z=t plane.
  const cornerFan = (
    apex: [number, number],
    center: [number, number],
    phi0: number,
    radius: number,
  ) => {
    for (let j = 0; j < N; j++) {
      const a = phi0 + (j / N) * (Math.PI / 2);
      const c = phi0 + ((j + 1) / N) * (Math.PI / 2);
      tri([
        [apex[0], apex[1], t],
        [center[0] + radius * Math.cos(c), center[1] + radius * Math.sin(c), t],
        [center[0] + radius * Math.cos(a), center[1] + radius * Math.sin(a), t],
      ]);
    }
  };
  cornerFan([+topHalfW, topBack], cBR, 0, Rb);
  cornerFan([-topHalfW, topBack], cBL, Math.PI / 2, Rb);
  // Front-left and front-right corners are filled by the slope/side
  // chamfer's top end (its arc lands exactly on the top face's FL/FR
  // arcs at z=t), so no separate cornerFan is needed there.

  // ── Inner solid fill ──────────────────────────────────────────────────
  // Backs the body's interior so any sub-pixel seam in the outer shell
  // resolves to black. Inset from outer faces by BLACK_INNER_FILL_INSET;
  // slanted front face parallel to the outer slope.
  // Width matches the narrowed slope top so the fill stays inside the
  // tapered slope-side tris everywhere. The body's vertical side walls
  // are single quads with no seams to back, so the fill not reaching all
  // the way to ±halfW is fine.
  const ifW = stHW - BLACK_INNER_FILL_INSET;
  const ifBack = halfL - BLACK_INNER_FILL_INSET;
  const ifBottom = -p + BLACK_INNER_FILL_INSET;
  const ifTop = skirtZ - BLACK_INNER_FILL_INSET;
  const ifFV = -halfL + BLACK_INNER_FILL_INSET;
  const ifST = ifFV + (sy / t) * ifTop;

  quad([
    [-ifW, ifST, ifTop],
    [+ifW, ifST, ifTop],
    [+ifW, ifBack, ifTop],
    [-ifW, ifBack, ifTop],
  ]);
  quad([
    [-ifW, ifBack, ifBottom],
    [+ifW, ifBack, ifBottom],
    [+ifW, ifFV, ifBottom],
    [-ifW, ifFV, ifBottom],
  ]);
  quad([
    [+ifW, ifBack, ifBottom],
    [-ifW, ifBack, ifBottom],
    [-ifW, ifBack, ifTop],
    [+ifW, ifBack, ifTop],
  ]);
  quad([
    [-ifW, ifFV, ifBottom],
    [+ifW, ifFV, ifBottom],
    [+ifW, ifFV, 0],
    [-ifW, ifFV, 0],
  ]);
  quad([
    [-ifW, ifFV, 0],
    [+ifW, ifFV, 0],
    [+ifW, ifST, ifTop],
    [-ifW, ifST, ifTop],
  ]);
  // Pentagon side fans.
  tri([
    [-ifW, ifFV, ifBottom],
    [-ifW, ifFV, 0],
    [-ifW, ifST, ifTop],
  ]);
  tri([
    [-ifW, ifFV, ifBottom],
    [-ifW, ifST, ifTop],
    [-ifW, ifBack, ifTop],
  ]);
  tri([
    [-ifW, ifFV, ifBottom],
    [-ifW, ifBack, ifTop],
    [-ifW, ifBack, ifBottom],
  ]);
  tri([
    [+ifW, ifFV, ifBottom],
    [+ifW, ifST, ifTop],
    [+ifW, ifFV, 0],
  ]);
  tri([
    [+ifW, ifFV, ifBottom],
    [+ifW, ifBack, ifTop],
    [+ifW, ifST, ifTop],
  ]);
  tri([
    [+ifW, ifFV, ifBottom],
    [+ifW, ifBack, ifBottom],
    [+ifW, ifBack, ifTop],
  ]);

  const geom = new THREE.BufferGeometry();
  geom.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geom.setIndex(indices);
  // Material groups: 0 = body, 1 = slope (slightly brighter), 2 = front
  // fillet strip (gray seam). Slope and fillet-front index ranges are
  // each contiguous, sandwiched between body ranges.
  const totalIdx = indices.length;
  geom.addGroup(0, slopeIdxStart, 0);
  geom.addGroup(slopeIdxStart, slopeIdxEnd - slopeIdxStart, 1);
  geom.addGroup(slopeIdxEnd, filletFrontStart - slopeIdxEnd, 0);
  geom.addGroup(filletFrontStart, filletFrontEnd - filletFrontStart, 2);
  geom.addGroup(filletFrontEnd, totalIdx - filletFrontEnd, 0);
  geom.computeVertexNormals();
  // Each quad()/tri() emits its own duplicated positions, so by default
  // every shared edge renders flat (no normal averaging across faces).
  // Average normals across vertices at the same world position to round
  // edges visually — slope/side and top/side dihedrals get a smooth
  // shading transition. Silhouette is unchanged; this is a lighting-only
  // softening of the sharp edges.
  averageSharedNormals(geom);
  // After averaging, vertices at the top face plane (z=t) inherit a
  // tilted normal (mix of +Z from the flat top, radial from the chamfer
  // top, and a slight tilt from the fillet's back/side strips). That
  // tilt makes the top face's fan triangles visibly shaded — they look
  // like triangular facets instead of one flat face. Force every vertex
  // at z=t to a pure +Z normal: the top face renders as one flat plane,
  // and the chamfer's last segment naturally interpolates from its
  // radial mid-z normal up to +Z at z=t (still smooth visually).
  flattenTopFaceNormals(geom, BLACK_KEY_THICKNESS);
  return geom;
}

function flattenTopFaceNormals(geom: THREE.BufferGeometry, topZ: number) {
  const pos = geom.getAttribute("position") as THREE.BufferAttribute;
  const nrm = geom.getAttribute("normal") as THREE.BufferAttribute;
  const positions = pos.array as Float32Array;
  const normals = nrm.array as Float32Array;
  const vCount = positions.length / 3;
  for (let i = 0; i < vCount; i++) {
    if (Math.abs(positions[3 * i + 2] - topZ) < 1e-6) {
      normals[3 * i] = 0;
      normals[3 * i + 1] = 0;
      normals[3 * i + 2] = 1;
    }
  }
  nrm.needsUpdate = true;
}

function averageSharedNormals(geom: THREE.BufferGeometry) {
  const pos = geom.getAttribute("position") as THREE.BufferAttribute;
  const nrm = geom.getAttribute("normal") as THREE.BufferAttribute;
  const positions = pos.array as Float32Array;
  const normals = nrm.array as Float32Array;
  const groups = new Map<string, number[]>();
  const vCount = positions.length / 3;
  for (let i = 0; i < vCount; i++) {
    const key = `${Math.round(positions[3 * i] * 1e5)},${Math.round(
      positions[3 * i + 1] * 1e5,
    )},${Math.round(positions[3 * i + 2] * 1e5)}`;
    let arr = groups.get(key);
    if (!arr) {
      arr = [];
      groups.set(key, arr);
    }
    arr.push(i);
  }
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (const i of idxs) {
      nx += normals[3 * i];
      ny += normals[3 * i + 1];
      nz += normals[3 * i + 2];
    }
    const len = Math.hypot(nx, ny, nz);
    if (len === 0) continue;
    nx /= len;
    ny /= len;
    nz /= len;
    for (const i of idxs) {
      normals[3 * i] = nx;
      normals[3 * i + 1] = ny;
      normals[3 * i + 2] = nz;
    }
  }
  nrm.needsUpdate = true;
}

// Padding between the white-key notch outline and the adjacent black-key
// footprint. Matches the visible 4% inter-key gap so the black key sits in
// its socket with a thin black seam around it instead of touching white.
const WHITE_NOTCH_PAD = 0.006;

// Black-key extent inside an adjacent white key's mesh-local frame. The
// black key center sits at world x = whiteX ± WHITE_KEY_WIDTH/2 (boundary
// between the two whites), and extends ± BLACK_KEY_WIDTH·0.96/2 around
// that. The overlapping x-range with the white begins this far inside the
// boundary.
const BLACK_HALF_W_RENDERED = (BLACK_KEY_WIDTH * 0.96) / 2;
// Distance from the white-key boundary inward to the black-key edge.
const NOTCH_INSET_FROM_BOUNDARY =
  WHITE_KEY_WIDTH / 2 - BLACK_HALF_W_RENDERED - WHITE_NOTCH_PAD;
// Black-key front-edge y in white's mesh-local frame, padded toward the
// white-key front so the notch corner has breathing room.
const NOTCH_FRONT_Y =
  WHITE_KEY_LENGTH / 2 - BLACK_KEY_LENGTH + 0.01 - WHITE_NOTCH_PAD;

// White cap — rounded-corner extruded solid. Visible top at mesh-local
// z=0; cap extends to z=-WHITE_CAP_THICKNESS where the wood chassis
// takes over.
//
// `leftBlack`/`rightBlack` notch out the back-left/back-right corner so
// adjacent black keys sit in actual sockets — when a black key dips on
// press it stays visible from above instead of being clipped by the
// white-cap top plane it would otherwise be sliding below.
function createRoundedWhiteGeometry(
  leftBlack: boolean,
  rightBlack: boolean,
): THREE.BufferGeometry {
  const halfW = (WHITE_KEY_WIDTH * 0.96) / 2;
  const halfL = WHITE_KEY_LENGTH / 2;
  const r = WHITE_CAP_CORNER_RADIUS;
  const nRX = NOTCH_INSET_FROM_BOUNDARY; // right-notch inner x (>0)
  const nLX = -NOTCH_INSET_FROM_BOUNDARY; // left-notch inner x (<0)
  const nY = NOTCH_FRONT_Y; // notch front edge y (negative-ish)

  const shape = new THREE.Shape();
  // CCW from front-left rounded corner.
  shape.moveTo(-halfW + r, -halfL);
  shape.lineTo(+halfW - r, -halfL);
  shape.quadraticCurveTo(+halfW, -halfL, +halfW, -halfL + r);
  if (rightBlack) {
    // Right side runs straight up to the notch front, then jogs in along
    // the black key's footprint and continues to the back edge at the
    // notch's inner x.
    shape.lineTo(+halfW, nY);
    shape.lineTo(+nRX, nY);
    shape.lineTo(+nRX, +halfL);
  } else {
    // Back-right corner intentionally sharp — the back of the keyboard
    // sits behind the black-key row and the user reads its outline as
    // crisp; only the front face needs softening.
    shape.lineTo(+halfW, +halfL);
  }
  if (leftBlack) {
    // Mirror of the right notch, traversed in CCW direction.
    shape.lineTo(nLX, +halfL);
    shape.lineTo(nLX, nY);
    shape.lineTo(-halfW, nY);
  } else {
    // Back-left corner intentionally sharp — see comment above.
    shape.lineTo(-halfW, +halfL);
  }
  shape.lineTo(-halfW, -halfL + r);
  shape.quadraticCurveTo(-halfW, -halfL, -halfW + r, -halfL);

  // Inward bevel — rounds the cap's outer edges by REMOVING material
  // (a chamfer), so the cap stays within the original shape outline and
  // doesn't grow into adjacent keys. With ExtrudeGeometry's bevel
  // formula `bs = bevelSize·cos(t·π/2) + bevelOffset` (t in 0→1):
  //   t=0 (side wall) → bs = bevelSize + bevelOffset = 0 → matches outline
  //   t=1 (top face)  → bs = bevelOffset = −BEVEL  → top face inset
  // Net result: side wall stays at the original outline, top + bottom
  // faces shrink by BEVEL, with a smooth quarter-circle in between.
  const geom = new THREE.ExtrudeGeometry(shape, {
    depth: WHITE_CAP_THICKNESS - 2 * WHITE_CAP_BEVEL,
    bevelEnabled: true,
    bevelThickness: WHITE_CAP_BEVEL,
    bevelSize: WHITE_CAP_BEVEL,
    bevelOffset: -WHITE_CAP_BEVEL,
    bevelSegments: 3,
    curveSegments: 6,
  });
  // Shift so the +Z (visible top) face lands at z=0 in mesh-local.
  geom.translate(0, 0, -WHITE_CAP_THICKNESS + WHITE_CAP_BEVEL);
  // The cap's front side wall + top/bottom bevel curves naturally face
  // toward -Y (and tangents toward ±Z) — the only directional light is
  // at +Y +Z, so those surfaces render almost ambient-only and read as a
  // dark band between the bright top face and the body's white front.
  // Override front-section vertex normals to +Z so the front section
  // catches the same diffuse contribution as the top face.
  flattenCapFrontNormals(geom, -WHITE_KEY_LENGTH / 2);
  return geom;
}

// Override every vertex on the cap's front-section (front side wall +
// top/bottom bevel curves + rounded front-left/right corner curves) to
// a +Z normal so the surface receives the same diffuse light as the cap
// top. The earlier version excluded the bottom-bevel outer rim (where
// `z` rounded down to the bottom face plane), which left a thin dark
// band right under the top edge.
function flattenCapFrontNormals(
  geom: THREE.BufferGeometry,
  frontY: number,
): void {
  const positions = (geom.getAttribute("position") as THREE.BufferAttribute)
    .array as Float32Array;
  const normalAttr = geom.getAttribute("normal") as THREE.BufferAttribute;
  const normals = normalAttr.array as Float32Array;
  const vertexCount = positions.length / 3;
  const yBound = frontY + WHITE_CAP_CORNER_RADIUS + 1e-5;
  for (let v = 0; v < vertexCount; v++) {
    const y = positions[v * 3 + 1];
    if (y >= frontY - 1e-5 && y < yBound) {
      normals[v * 3 + 0] = 0;
      normals[v * 3 + 1] = 0;
      normals[v * 3 + 2] = 1;
    }
  }
  normalAttr.needsUpdate = true;
}

// Cache by neighbor configuration — only 4 unique cap shapes across all
// 52 white keys.
const WHITE_GEOM_CACHE = new Map<string, THREE.BufferGeometry>();
export function whiteKeyGeometryFor(midi: number): THREE.BufferGeometry {
  const { left, right } = adjacentBlackKeys(midi);
  const key = `${left ? "L" : "_"}${right ? "R" : "_"}`;
  let g = WHITE_GEOM_CACHE.get(key);
  if (!g) {
    g = createRoundedWhiteGeometry(!!left, !!right);
    WHITE_GEOM_CACHE.set(key, g);
  }
  return g;
}

export const BLACK_KEY_GEOMETRY = createChamferedBlackGeometry();

// Wood body — extruded with the SAME notch shape as the white cap, but at
// the full key width (no 4% inset; sides fill the inter-key gap so it
// reads as the body of the keyboard chassis). Carving the notch through
// the body removes the dark-top fill that would otherwise show through
// the cap notch when the black key dips, leaving a real cavity for the
// black key to sink into.
function buildWhiteBodyShape(
  leftBlack: boolean,
  rightBlack: boolean,
): THREE.Shape {
  // Body is inset slightly from the full key width — without an inset
  // adjacent bodies' rounded front corners meet at the boundary point,
  // producing a sharp V-notch at every inter-key seam at the front of
  // the keyboard. The cap's 4% inset already creates the visible
  // inter-key gap from the top, so matching it here keeps the gap
  // continuous all the way down the front face.
  const halfW = (WHITE_KEY_WIDTH * 0.96) / 2;
  const halfL = WHITE_KEY_LENGTH / 2;
  // Body front recessed so the cap (which still extends to -halfL)
  // overhangs by WHITE_BODY_FRONT_OVERHANG.
  const frontY = -halfL + WHITE_BODY_FRONT_OVERHANG;
  const fr = WHITE_BODY_FRONT_CORNER_R;
  const nRX = NOTCH_INSET_FROM_BOUNDARY;
  const nLX = -NOTCH_INSET_FROM_BOUNDARY;
  const nY = NOTCH_FRONT_Y;

  const shape = new THREE.Shape();
  // Start partway in from the front-left corner; quadraticCurveTo at the
  // end of the loop closes the shape with a rounded corner back to here.
  shape.moveTo(-halfW + fr, frontY);
  shape.lineTo(+halfW - fr, frontY);
  shape.quadraticCurveTo(+halfW, frontY, +halfW, frontY + fr);
  if (rightBlack) {
    shape.lineTo(+halfW, nY);
    shape.lineTo(+nRX, nY);
    shape.lineTo(+nRX, +halfL);
  } else {
    shape.lineTo(+halfW, +halfL);
  }
  if (leftBlack) {
    shape.lineTo(nLX, +halfL);
    shape.lineTo(nLX, nY);
    shape.lineTo(-halfW, nY);
  } else {
    shape.lineTo(-halfW, +halfL);
  }
  shape.lineTo(-halfW, frontY + fr);
  shape.quadraticCurveTo(-halfW, frontY, -halfW + fr, frontY);
  return shape;
}

// Real-piano detail: the cap protrudes slightly forward of the wood body,
// and the resulting recessed front-vertical face is painted/coated white
// instead of showing wood grain. We achieve both by recessing the body's
// front edge by this much (in y, mesh-local). The cap is unchanged so it
// sticks out by exactly this amount at the front.
export const WHITE_BODY_FRONT_OVERHANG = 0.015;
// Radius applied to the body's front-left and front-right corners. The
// front face transitions into the wood side faces along a quarter-circle
// arc instead of a hard 90° edge, so the white-coated front reads as
// "wraps around" rather than abruptly stopping.
const WHITE_BODY_FRONT_CORNER_R = 0.015;

// Reassign side-wall triangles whose 3 vertices all sit on the body's
// front edge to material index 2 (white front), and the walls of the
// black-key notch (inner x = ±NOTCH_INSET_FROM_BOUNDARY, front y =
// NOTCH_FRONT_Y) to index 0 (the dark top), like the felt-lined cavity a
// black key sits in. In wood they showed as a brown strip behind each black
// key at the keyboard's back edge, past the black key's rounded rear top. ExtrudeGeometry walks
// the contour in REVERSE order (`while (--i >= 0)`), so the front edge
// segment isn't at the start of the side group — it's near the end.
// We classify every side triangle by its vertex y, then split the side
// range into runs (alternating wood / front).
function tagWhiteBodyFrontFace(
  geom: THREE.BufferGeometry,
  frontY: number,
): void {
  const positions = (geom.getAttribute("position") as THREE.BufferAttribute)
    .array as Float32Array;
  const sideGroup = geom.groups.find((g) => g.materialIndex === 1);
  if (!sideGroup) return;
  const sideStart = sideGroup.start;
  const sideCount = sideGroup.count;
  const triCount = sideCount / 3;
  // Front face = the rectangular front strip plus the rounded
  // front-left/right corners. Test each triangle's vertex y against
  // [frontY, frontY + corner-radius]: triangles on the straight strip
  // all have y == frontY; triangles on the quarter-circle corners have
  // y in (frontY, frontY + WHITE_BODY_FRONT_CORNER_R).
  const yBound = frontY + WHITE_BODY_FRONT_CORNER_R + 1e-5;
  const isFront = new Uint8Array(triCount);
  const matOf = new Uint8Array(triCount);
  for (let t = 0; t < triCount; t++) {
    const v0 = sideStart + 3 * t;
    let allFront: 0 | 1 = 1;
    let allNotchX = true;
    let allNotchY = true;
    for (let k = 0; k < 3; k++) {
      const x = positions[(v0 + k) * 3];
      const y = positions[(v0 + k) * 3 + 1];
      if (y > yBound || y < frontY - 1e-5) allFront = 0;
      if (Math.abs(Math.abs(x) - NOTCH_INSET_FROM_BOUNDARY) > 1e-5)
        allNotchX = false;
      if (Math.abs(y - NOTCH_FRONT_Y) > 1e-5) allNotchY = false;
    }
    isFront[t] = allFront;
    matOf[t] = allFront ? 2 : allNotchX || allNotchY ? 0 : 1;
  }
  geom.clearGroups();
  geom.addGroup(0, sideStart, 0); // caps
  // Emit runs of equal material (wood 1 / white front 2 / notch 0) over
  // the side range.
  let runStart = 0;
  let runMat: number = matOf[0];
  const flushRun = (end: number, mat: number) => {
    const vStart = sideStart + 3 * runStart;
    const vCount = (end - runStart) * 3;
    if (vCount > 0) geom.addGroup(vStart, vCount, mat);
  };
  for (let t = 1; t < triCount; t++) {
    if (matOf[t] !== runMat) {
      flushRun(t, runMat);
      runStart = t;
      runMat = matOf[t];
    }
  }
  flushRun(triCount, runMat);

  // Override front-face vertex normals so the surface receives the same
  // diffuse light as the cap top (whose normal is +Z). Without this the
  // front face faces -Y and the only directional light (at +Y +Z) misses
  // it entirely, leaving the front lit by ambient alone.
  const normalAttr = geom.getAttribute("normal") as THREE.BufferAttribute;
  const normals = normalAttr.array as Float32Array;
  for (let t = 0; t < triCount; t++) {
    if (!isFront[t]) continue;
    const v0 = sideStart + 3 * t;
    for (let k = 0; k < 3; k++) {
      const v = v0 + k;
      normals[v * 3 + 0] = 0;
      normals[v * 3 + 1] = 0;
      normals[v * 3 + 2] = 1;
    }
  }
  normalAttr.needsUpdate = true;
}

const WHITE_BODY_GEOM_CACHE = new Map<string, THREE.BufferGeometry>();
export function whiteBodyGeometryFor(midi: number): THREE.BufferGeometry {
  const { left, right } = adjacentBlackKeys(midi);
  const key = `${left ? "L" : "_"}${right ? "R" : "_"}`;
  let g = WHITE_BODY_GEOM_CACHE.get(key);
  if (!g) {
    const shape = buildWhiteBodyShape(!!left, !!right);
    g = new THREE.ExtrudeGeometry(shape, {
      depth: WHITE_BODY_HEIGHT,
      bevelEnabled: false,
      curveSegments: 8,
    });
    // Top face at mesh-local z=0, bottom at z=-WHITE_BODY_HEIGHT.
    g.translate(0, 0, -WHITE_BODY_HEIGHT);
    const frontY = -WHITE_KEY_LENGTH / 2 + WHITE_BODY_FRONT_OVERHANG;
    tagWhiteBodyFrontFace(g, frontY);
    WHITE_BODY_GEOM_CACHE.set(key, g);
  }
  return g;
}

// ExtrudeGeometry assigns material index 0 to the front+back caps. We
// post-process the side group: front-face quads → index 2 (white-coated
// front), all other side quads → index 1 (wood). Top cap is what's
// visible through the cap's 4% inter-key gap.
const WHITE_BODY_TOP_COLOR = "#0a0a0a";
// Exported so Keyboard.tsx can scale `color` by the keyboard brightness
// per frame without needing per-key materials.
export const WHITE_BODY_WOOD_MATERIAL = new THREE.MeshStandardMaterial({
  color: WOOD_COLOR,
  roughness: 0.85,
  metalness: 0,
});
const WHITE_BODY_TOP_MATERIAL = new THREE.MeshStandardMaterial({
  color: WHITE_BODY_TOP_COLOR,
  roughness: 0.7,
  metalness: 0,
});
// White-coated front face — same MeshStandardMaterial profile as the
// cap. We override the front-face vertex normals to (0,0,1) so the
// front receives the same N·L diffuse contribution from the directional
// light as the cap top, instead of being lit by ambient only (the
// directional light at +Y +Z doesn't reach a -Y-facing surface).
export const WHITE_BODY_FRONT_MATERIAL = new THREE.MeshStandardMaterial({
  color: "#f5f5f5",
  roughness: 0.55,
  metalness: 0.05,
});
export const WHITE_BODY_MATERIALS: THREE.Material[] = [
  WHITE_BODY_TOP_MATERIAL, // group 0: caps (top + bottom; top visible) + black-key notch walls
  WHITE_BODY_WOOD_MATERIAL, // group 1: side walls (left/right/back)
  WHITE_BODY_FRONT_MATERIAL, // group 2: white-coated front-vertical face
];

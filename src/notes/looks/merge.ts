// Liquid note merging — notes that touch or overlap fuse with a surface-tension fillet (smooth union of their
// rounded-box SDFs); bevel / rim / outline / colour flow around the fillet without seams.
//
// Used by FallingNotes when `noteMergeRadius` > 0 (round shape): the note shader is compiled with MERGE, the vertex
// shader places each instance's quad from the data texture (`mergeQuadCorner`), and the fragment shader resolves
// pixel ownership + the merged field (`mergeSample`) BEFORE any other discard. Raycast picking still hits the
// instanceMatrix quads (the note's own box). Dying-note ghosts are `solo` (no neighbours).
//
// Method: per-instance neighbour lists + per-pixel OWNERSHIP.
//   The pixel's world position comes from gl_FragCoord (bit-identical in every instance). Each instance evaluates its
//   own and its (≤ K) neighbours' SDFs from the data texture; the smallest SDF (ties → lower index) owns the pixel and
//   every other instance discards it → the merged blob is drawn exactly once, and the owner hand-over is invisible
//   because every owner evaluates the same field from the same data.
//   Field = windowed log-sum-exp over key GROUPS (sameKey off: one key's notes are hard-unioned first):
//       D  = −kₑ · ln Σ_g c(d_g) · exp(−d_g / kₑ),  c(d) = 1 − smoothstep(τ1, τ2, d)   (window on ABSOLUTE distance)
//       ∇D = Σ_g (c_g − kₑ c'_g) e_g ∇d_g / Σ_g c_g e_g
//     symmetric and smooth (no crease where the nearest note changes); a lone note keeps its exact shape (τ1 ≥ all
//     that is drawn). Then D /= clamp(|∇D|, 0.25, 1): contact seams (∇D → 0) read as interior, and the outline / AA
//     keep a uniform width.
//   Bridge fade (no thin pinched necks): kₑ = k · F, F = Σ_{i<j} m_i m_j f(gap_ij) / Σ m_i m_j (m = window·softmax
//     member weights, gap = rect gap, f = 1 − smoothstep(0.6, 1.0, gap / (2 ln2 · k))). Pairs approaching the
//     bridging limit (gap = 2 ln2 · k) merge ever more weakly, so the neck retracts instead of stretching thin, and
//     what is left of it (bridge material: outside every note, sunk by the merge) fades out in alpha
//     (s.alpha = smoothstep(0.72, 0.95, F)) before it would pinch off.
//   Same-key legato (sameKey off) — DEFAULT (legatoClose = 0): notes on one key are hard-unioned per key and stay
//     separate rounded capsules; a neighbouring key's note fuses with them through the natural smooth-union
//     meniscus (the teardrop-shaped fillet into the joint is the intended liquid look).
//   Opt-in column closure (legatoClose > 0, scales the closure amount): consecutive same-key notes with gap <
//     legatoGap and another key's note within bridging reach are closed into one column (CPU: square, overlapping
//     ends, rows 0 / 2 / 3) with a surface-tension waist (seamWaist ≈ 0.25k, half-width seamBlend/2, added to both
//     notes' distances with its analytic gradient) and colours flowing over a seamBlend-wide band (≈ 4k).
//     Hard-crease look: legatoClose 1, creaseDepth > 0, seamWaist 0, small seamBlend.
//   Colour: softmax weights c_g·exp(−d_g / kc), kc = k·colorSpread·F (50/50 on the fillet mid-line).
//
// Colour: the tint is blended as given (FallingNotes passes sRGB-encoded tints; the shader decodes them, so the blend
// happens in display space).
import * as THREE from 'three'

export const MERGE_K = 8 // neighbours per note (two vec4 attributes)
export const MERGE_MAX_NOTES = 4096
const ROWS = 6
// The data texture holds MERGE_MAX_NOTES columns wrapped into blocks of TEX_W (WebGL2 only guarantees 2048-wide
// textures): note i, row r lives at (i % TEX_W, r + ROWS · floor(i / TEX_W)).
const TEX_W = 1024
const BLOCKS = MERGE_MAX_NOTES / TEX_W
const LN2X2 = 2 * Math.LN2 // bridging limit gap / k

export type MergeNote = {
  x: number // centre (world)
  y: number
  w: number // full width / height (world)
  h: number
  color: [number, number, number] // rgb tint
  key: number // pitch / key index (same-key rule)
  seed?: [number, number] // note-carried seeds (pattern, bump), returned by mergeNoteCarry().xy
  texShift?: number // moves the note-carried textures along the note, returned by mergeTexShift()
  solo?: boolean // takes no part in merging (no neighbours), e.g. a fading ghost
}

export type MergeShape = {
  mergeRadius: number // merge smoothness k (white keys): contact fillet ≈ k, gaps < 2ln2·k ≈ 1.39k can bridge; 0 = off
  colorSpread: number // colour / note-carried blend width relative to k
  sameKey: boolean // true: same-key notes fuse like any other; false: legato joints keep a groove
  cornerRadius: number
  bevelWidth: number
  outlineWidth: number
  creaseDepth: number // hard-crease look: legato groove depth (× bevelDepth in the shader); 0 = liquid joint (default)
  seamWaist?: number // liquid joint: depth of the surface-tension waist at a closed legato seam (world; 0 = straight; default 0.25·k)
  seamBlend?: number // liquid joint: colour blend band across a closed seam (10–90 % width, world; default 4·k)
  legatoClose?: number // OPT-IN 0..1 (default 0): close touching same-key joints into one column (scales the closure);
  //                       0 = v1 behaviour — separate capsules fused by the natural smooth-union meniscus
  legatoGap: number // same-key gaps < this are closed into one grooved column (full ≤ ½, faded to 0 at legatoGap) — only where a cross-key note is within bridging reach of the joint
}

export const MERGE_SHAPE_DEFAULTS: MergeShape = {
  mergeRadius: 0.12,
  colorSpread: 1,
  sameKey: false,
  cornerRadius: 0.3,
  bevelWidth: 0.16,
  outlineWidth: 0.06,
  creaseDepth: 0,
  seamWaist: 0.03, // = 0.25 · mergeRadius
  seamBlend: 0.48, // = 4 · mergeRadius
  legatoClose: 0,
  legatoGap: 0.25,
}

// data texture rows (x = note index):
//   0: render rect centre.xy, half.xy (legato ends extended)      1: tint rgb, key
//   2: corner radius top, bottom, seam y (top end), closure amount (top)
//   3: seam y (bottom end), gap (top end), ORIGINAL half h, closure amount (bottom)
//   4: pattern seed, bump seed, ORIGINAL centre.xy           5: texture shift
export const MERGE_VERT_GLSL = /* glsl */ `
uniform sampler2D uMergeData;
uniform float uMergeMargin;
attribute vec4 iMergeNbrA, iMergeNbrB;
flat varying vec4 vMergeNbrA, vMergeNbrB;
flat varying float vMergeSelf;
ivec2 mergeTexel(int id, int row) { return ivec2(id % ${TEX_W}, row + ${ROWS} * (id / ${TEX_W})); }
vec4 mergeNoteCarry(int id) { return texelFetch(uMergeData, mergeTexel(id, 4), 0); }
float mergeTexShift(int id) { return texelFetch(uMergeData, mergeTexel(id, 5), 0).x; }
// world xy of this quad corner (corner = position.xy in [-0.5, 0.5]); also sets the merge varyings
vec2 mergeQuadCorner(vec2 corner) {
  vec4 R = texelFetch(uMergeData, mergeTexel(gl_InstanceID, 0), 0);
  vMergeSelf = float(gl_InstanceID); vMergeNbrA = iMergeNbrA; vMergeNbrB = iMergeNbrB;
  return R.xy + corner * 2.0 * (R.zw + uMergeMargin);
}`

export const MERGE_FRAG_GLSL = /* glsl */ `
uniform sampler2D uMergeData;
uniform mat4 uMergeInvViewProj;
uniform vec2 uMergeRes;
uniform float uMergePlaneZ, uMergeK, uMergeKc, uMergeT1, uMergeT2, uMergeSameKey, uMergeBevelW, uMergeCrease, uMergeRadius;
uniform float uMergeWaist, uMergeSeamBlend;
flat varying vec4 vMergeNbrA, vMergeNbrB;
flat varying float vMergeSelf;
#define MERGE_N ${MERGE_K + 1}

struct MergeSample {
  float D;        // merged signed distance estimate (world; < 0 inside)
  vec2 dir;       // outward unit direction of the merged surface
  vec2 crease;    // extra slope of the legato groove (multiply by the bevel depth)
  float alpha;    // bridge fade (multiply body + ring alpha)
  vec3 tint;      // blended note colour
  int id0, id1;   // two strongest contributors (owner-independent), weights w0 + w1 = 1
  float w0, w1;
  float dOwn;     // the owner's own SDF
};

vec4 mergeRow(int id, int row) { return texelFetch(uMergeData, ivec2(id % ${TEX_W}, row + ${ROWS} * (id / ${TEX_W})), 0); }
vec4 mergeNoteCarry(int id) { return mergeRow(id, 4); }
float mergeTexShift(int id) { return mergeRow(id, 5).x; }
vec2 mergeWorldPos() {
  vec2 ndc = gl_FragCoord.xy / uMergeRes * 2.0 - 1.0;
  vec4 a = uMergeInvViewProj * vec4(ndc, -1.0, 1.0), b = uMergeInvViewProj * vec4(ndc, 1.0, 1.0);
  a /= a.w; b /= b.w;
  return mix(a.xyz, b.xyz, (uMergePlaneZ - a.z) / (b.z - a.z)).xy;
}
float mergeAA(vec2 p) { return max(length(fwidth(p)) * 0.7071, 1e-5); }
// rounded box with separate top / bottom corner radius: x = SDF, yz = outward unit gradient
vec3 mergeBoxG(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  vec2 s = vec2(p.x < 0.0 ? -1.0 : 1.0, p.y < 0.0 ? -1.0 : 1.0);
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  vec2 g;
  if (max(q.x, q.y) > 0.0) {
    vec2 m = max(q, 0.0);
    float l = length(m);
    g = l > 1e-6 ? s * m / l : (q.x > q.y ? vec2(s.x, 0.0) : vec2(0.0, s.y));
  } else g = q.x > q.y ? vec2(s.x, 0.0) : vec2(0.0, s.y);
  return vec3(d, g);
}
vec3 mergeNoteSdf(vec2 p, vec4 R, vec4 Q) {
  float r = clamp(p.y > R.y ? Q.x : Q.y, 0.0, min(R.z, R.w) - 1e-4);
  return mergeBoxG(p - R.xy, R.zw, r);
}
float mergeNbr(int s) { vec4 v = s < 4 ? vMergeNbrA : vMergeNbrB; return v[s & 3]; }
float mergeWin(float d) { return 1.0 - smoothstep(uMergeT1, uMergeT2, d); }
float mergeWinD(float d) {   // d/dd of mergeWin
  if (d <= uMergeT1 || d >= uMergeT2) return 0.0;
  float w = uMergeT2 - uMergeT1;
  return -6.0 * (d - uMergeT1) * (uMergeT2 - d) / (w * w * w);
}

bool mergeSample(vec2 p, out MergeSample s) {
  int self = int(vMergeSelf + 0.5);
  int ids[MERGE_N]; vec3 dg[MERGE_N]; vec4 R[MERGE_N]; float key[MERGE_N], dc0[MERGE_N], prox[MERGE_N];
  float ww = max(0.5 * uMergeSeamBlend, 1e-3);
  int n = 0;
  for (int k = 0; k < MERGE_N; k++) {
    int id = self;
    if (k > 0) { float f = mergeNbr(k - 1); if (f < 0.0) break; id = int(f + 0.5); }
    R[n] = mergeRow(id, 0);
    vec4 Q2 = mergeRow(id, 2);
    vec4 Q3 = mergeRow(id, 3);
    dg[n] = mergeNoteSdf(p, R[n], Q2);
    // closed legato joints (top: Q2.zw, bottom: Q3.xw) — both notes of a joint add the SAME terms, so the column
    // stays consistent: a gentle surface-tension waist (Gaussian dent of depth seamWaist on the joint's distance,
    // with its analytic gradient) and the seam proximity that widens the colour blend
    float dyT = p.y - Q2.z, dyB = p.y - Q3.x;
    float fT = Q2.w * exp(-dyT * dyT / (ww * ww)), fB = Q3.w * exp(-dyB * dyB / (ww * ww));
    dg[n].x += uMergeWaist * (fT + fB);
    dg[n].z += uMergeWaist * (fT * (-2.0 * dyT) + fB * (-2.0 * dyB)) / (ww * ww);
    prox[n] = max(Q2.w * (1.0 - smoothstep(0.5 * uMergeSeamBlend, 1.5 * uMergeSeamBlend, abs(dyT))),
                  Q3.w * (1.0 - smoothstep(0.5 * uMergeSeamBlend, 1.5 * uMergeSeamBlend, abs(dyB))));
    // ORIGINAL (un-extended) box: decides which note of a closed legato column a pixel belongs to (colour / carry)
    vec4 C4 = mergeRow(id, 4);
    dc0[n] = mergeNoteSdf(p, vec4(C4.zw, R[n].z, Q3.z), Q2).x;
    key[n] = uMergeSameKey > 0.5 ? float(id) : mergeRow(id, 1).w;
    ids[n] = id; n++;
  }
  int o = 0;
  for (int i = 1; i < n; i++) if (dg[i].x < dg[o].x || (dg[i].x == dg[o].x && ids[i] < ids[o])) o = i;
  if (ids[o] != self) return false;

  float d0 = dg[o].x;
  s.dOwn = d0; s.crease = vec2(0.0); s.alpha = 1.0;
  s.tint = mergeRow(ids[o], 1).rgb;
  s.id0 = s.id1 = ids[o]; s.w0 = 1.0; s.w1 = 0.0;
  float D = d0;
  vec2 G = dg[o].yz;
  if (uMergeK > 0.0 && n > 1) {
    float k = uMergeK;
    // ---- member window weights → pair-gap bridge fade F; legato groove ----
    float m[MERGE_N];
    for (int i = 0; i < n; i++) m[i] = mergeWin(dg[i].x) * exp(-(dg[i].x - d0) / k);
    float gm = ${LN2X2.toFixed(6)} * k, num = 1e-6, den = 1e-6;
    for (int i = 0; i < n; i++) for (int j = i + 1; j < n; j++) {
      if (key[i] == key[j]) continue;
      float mm = m[i] * m[j];
      if (mm <= 0.0) continue;
      float gap = length(max(abs(R[i].xy - R[j].xy) - (R[i].zw + R[j].zw), 0.0));
      num += mm * (1.0 - smoothstep(0.6 * gm, gm, gap)); den += mm;
    }
    float F = num / den;
    float cw = max(uMergeBevelW, 1e-4);
    for (int i = 0; i < n; i++) {
      if (m[i] <= 0.0) continue;
      vec4 Q2 = mergeRow(ids[i], 2);
      float dy = p.y - Q2.z, ady = abs(dy);
      if (Q2.w > 0.0) {   // closed legato joint at this note's top end → flat-bottomed groove
        // flat bottom (|dy| < fb), then the bevel's own rounded-over profile across one bevel width
        float fb = 0.25 * cw;
        float t = clamp((ady - fb) / cw, 0.0, 1.0);
        float prof = smoothstep(0.0, fb, ady) * (1.0 - t) * (1.0 - t);
        float inside = 1.0 - smoothstep(-0.005, 0.5 * cw, dg[i].x);
        s.crease += vec2(0.0, dy < 0.0 ? 1.0 : -1.0) * prof * inside * Q2.w * uMergeCrease;
      }
    }
    float ke = k * max(F, 0.02), kc = uMergeKc * max(F, 0.02);
    // ---- windowed log-sum-exp over key-group representatives at temperature kₑ ----
    float S = 0.0, ws = 0.0, wa = 0.0, wb = 0.0, wc3 = 0.0;
    vec2 gsum = vec2(0.0);
    vec3 cs = vec3(0.0);
    int ia = ids[o], ib = ids[o];
    for (int i = 0; i < n; i++) {
      // group distance = nearest EXTENDED box of the group (silhouette, ties → lower index); the group's colour is
      // shared among its notes by their ORIGINAL boxes (softmax over 0.25 bevel → a soft switch at the legato seam).
      bool rep = true;
      // this note's share of its group's colour: softmax over the ORIGINAL boxes; near a closed joint the temperature
      // widens so the colours flow into each other over ≈ seamBlend (10–90 %), elsewhere a ≈ AA-wide switch
      float gp = 0.0;
      for (int j = 0; j < n; j++) if (key[j] == key[i]) gp = max(gp, prox[j]);
      float tau = mix(0.25 * cw, uMergeSeamBlend / 2.2, gp);
      float share = 0.0;
      for (int j = 0; j < n; j++) {
        if (key[j] != key[i]) continue;
        if (j != i && (dg[j].x < dg[i].x || (dg[j].x == dg[i].x && ids[j] < ids[i]))) rep = false;
        share += exp(-(dc0[j] - dc0[i]) / tau);
      }
      share = 1.0 / share;
      float dgr = dg[i].x;   // this group's distance (from its silhouette representative)
      for (int j = 0; j < n; j++) if (key[j] == key[i]) dgr = min(dgr, dg[j].x);
      float c = mergeWin(dgr);
      if (c <= 0.0) continue;
      if (rep) {
        float E = exp(-(dgr - d0) / ke);
        S += c * E;
        gsum += (c - ke * mergeWinD(dgr)) * E * dg[i].yz;
      }
      if (share > 1e-3) {
        float wc = c * exp(-(dgr - d0) / kc) * share;
        cs += wc * mergeRow(ids[i], 1).rgb;
        ws += wc;
        if (wc > wa || (wc == wa && ids[i] < ia)) { wc3 = wb; wb = wa; ib = ia; wa = wc; ia = ids[i]; }
        else if (wc > wb || (wc == wb && ids[i] < ib)) { wc3 = wb; wb = wc; ib = ids[i]; }
        else wc3 = max(wc3, wc);
      }
    }
    if (S < 1e-6) return false;   // outside every note's window (quad corners) — the caller discards
    D = d0 - ke * log(S);
    G = gsum / S;
    s.tint = cs / ws;
    // top-2 weights minus the third: continuous where a third contributor overtakes the second
    s.id0 = ia; s.id1 = ib; s.w1 = (wb - wc3) / max(wa + wb - 2.0 * wc3, 1e-6); s.w0 = 1.0 - s.w1;
    // bridge material (outside every note, sunk by the merge) fades with F before the neck could pinch
    float bridge = smoothstep(0.0, 0.4 * k, d0) * smoothstep(0.0, 0.3 * k, d0 - D);
    s.alpha = mix(1.0, smoothstep(0.72, 0.95, F), bridge);
  }
  float gl = length(G);
  s.dir = gl > 1e-5 ? G / gl : vec2(0.0);
  s.D = D / clamp(gl, 0.25, 1.0);
  return true;
}`

const smoothstep = (a: number, b: number, x: number) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t) }

/** Stable merge sort of the indices 0..n-1 into `out` (ties keep index order, like Array.prototype.sort on [0..n-1]). */
function sortIdx(out: Int32Array, tmp: Int32Array, n: number, cmp: (a: number, b: number) => number) {
  let src = out, dst = tmp
  for (let i = 0; i < n; i++) src[i] = i
  for (let w = 1; w < n; w *= 2) {
    for (let lo = 0; lo < n; lo += 2 * w) {
      const mid = Math.min(lo + w, n), hi = Math.min(lo + 2 * w, n)
      let a = lo, b = mid, o = lo
      while (a < mid && b < hi) dst[o++] = cmp(src[a], src[b]) <= 0 ? src[a++] : src[b++]
      while (a < mid) dst[o++] = src[a++]
      while (b < hi) dst[o++] = src[b++]
    }
    const t = src; src = dst; dst = t
  }
  if (src !== out) for (let i = 0; i < n; i++) out[i] = src[i]
}

/** Grown copy of a scratch array (≥ 2× or `need`), keeping its first `keep` entries. */
function grow<T extends Int32Array | Float64Array>(a: T, keep: number, need = a.length + 1): T {
  const b = new (a.constructor as { new (n: number): T })(Math.max(2 * a.length, need))
  for (let i = 0; i < keep; i++) b[i] = a[i]
  return b
}

/** CPU side of the merge: data texture, neighbour attributes, uniforms. */
export class MergeData {
  readonly uniforms: Record<string, THREE.IUniform>
  readonly nbrA = new THREE.InstancedBufferAttribute(new Float32Array(MERGE_MAX_NOTES * 4), 4)
  readonly nbrB = new THREE.InstancedBufferAttribute(new Float32Array(MERGE_MAX_NOTES * 4), 4)
  /** quad enlargement (world) applied by mergeQuadCorner — also the picking slack */
  margin = 0
  stats = { notes: 0, pairs: 0, overflow: 0, maxNbrs: 0, legato: 0 }
  private data = new Float32Array(TEX_W * ROWS * BLOCKS * 4)
  private tex: THREE.DataTexture
  private tmpM = new THREE.Matrix4()
  // ---- build scratch, reused every frame (allocation-free in steady state): per-note arrays are sized for
  //      MERGE_MAX_NOTES; only the pair pool, the cell table and the candidate buffer grow (doubling) ----
  private y0 = new Float32Array(MERGE_MAX_NOTES) // rect bottom / top (legato ends extended after the joint pass)
  private y1 = new Float32Array(MERGE_MAX_NOTES)
  private rT = new Float32Array(MERGE_MAX_NOTES) // corner radius top / bottom
  private rB = new Float32Array(MERGE_MAX_NOTES)
  private seam = new Float32Array(MERGE_MAX_NOTES)
  private amt = new Float32Array(MERGE_MAX_NOTES)
  private gapT = new Float32Array(MERGE_MAX_NOTES)
  private seamB = new Float32Array(MERGE_MAX_NOTES) // same joint, seen from the upper note
  private amtB = new Float32Array(MERGE_MAX_NOTES)
  private extT = new Float64Array(MERGE_MAX_NOTES) // legato end extension of the joint at this note's top / bottom
  private extB = new Float64Array(MERGE_MAX_NOTES)
  private order = new Int32Array(MERGE_MAX_NOTES) // note indices sorted (stable) by y0
  private keyOrder = new Int32Array(MERGE_MAX_NOTES) // legato: note indices sorted (stable) by key, then y
  private sortTmp = new Int32Array(MERGE_MAX_NOTES)
  private pos = new Int32Array(MERGE_MAX_NOTES) // rank of each note in `order`
  // x buckets (columns `cellW` wide from `cellX0`, non-solo notes only); each cell lists its notes in `order`
  private cellOf = new Int32Array(MERGE_MAX_NOTES)
  private cellMem = new Int32Array(MERGE_MAX_NOTES)
  private cellMaxY1 = new Float32Array(MERGE_MAX_NOTES) // running max of y1 along each cell (legato reach query)
  private cellStart = new Int32Array(65)
  private cellPtr = new Int32Array(64)
  private cells = 0
  private cellX0 = 0
  private cellW = 1
  private cand = new Int32Array(64) // one note's later-in-order neighbours (+ gaps), before sorting by rank
  private candG = new Float64Array(64)
  private runHead = new Int32Array(64) // per visited column: its run [head, end) in cand
  private runEnd = new Int32Array(64)
  private pairI = new Int32Array(1024) // neighbour pairs in sweep order
  private pairJ = new Int32Array(1024)
  private pairG = new Float64Array(1024)
  private nbrStart = new Int32Array(MERGE_MAX_NOTES + 1) // per-note neighbour lists (CSR over nbrJ / nbrG)
  private nbrFill = new Int32Array(MERGE_MAX_NOTES)
  private nbrJ = new Int32Array(2048)
  private nbrG = new Float64Array(2048)
  private topJ = new Int32Array(MERGE_K) // K nearest of an overflowing list
  private topG = new Float64Array(MERGE_K)
  private sortNotes: MergeNote[] = []
  private byY0 = (a: number, b: number) => this.y0[a] - this.y0[b]
  private byKeyY = (a: number, b: number) => {
    const A = this.sortNotes[a], B = this.sortNotes[b]
    return A.key !== B.key ? A.key - B.key : A.y - B.y
  }

  constructor() {
    this.tex = new THREE.DataTexture(this.data, TEX_W, ROWS * BLOCKS, THREE.RGBAFormat, THREE.FloatType)
    this.tex.minFilter = this.tex.magFilter = THREE.NearestFilter
    this.tex.needsUpdate = true
    this.uniforms = {
      uMergeData: { value: this.tex }, uMergeMargin: { value: 0 }, uMergeInvViewProj: { value: new THREE.Matrix4() },
      uMergeRes: { value: new THREE.Vector2(1, 1) }, uMergePlaneZ: { value: 0 }, uMergeK: { value: 0 },
      uMergeKc: { value: 1 }, uMergeT1: { value: 1 }, uMergeT2: { value: 2 }, uMergeSameKey: { value: 0 },
      uMergeBevelW: { value: 0.1 }, uMergeCrease: { value: 0 }, uMergeRadius: { value: 0 },
      uMergeWaist: { value: 0 }, uMergeSeamBlend: { value: 0.5 },
    }
  }

  attach(geo: THREE.InstancedBufferGeometry) {
    geo.setAttribute('iMergeNbrA', this.nbrA)
    geo.setAttribute('iMergeNbrB', this.nbrB)
  }

  build(notes: MergeNote[], P: MergeShape) {
    const n = Math.min(notes.length, MERGE_MAX_NOTES)
    const k = Math.max(P.mergeRadius, 0), on = k > 0
    const r = P.cornerRadius, bw = P.bevelWidth
    const W = P.outlineWidth + 0.02 // outline + AA allowance (world)
    const gm = LN2X2 * k
    // window: a note takes part where its own SDF < τ1 (fully) … τ2 (faded out). τ1 covers every pixel that can be
    // drawn (D ≥ d_min − k·ln(K+1)); the owner draws only where d_o < τ1, and every note with d_j < τ2 there has a
    // rect gap < τ1 + τ2 → reach.
    const t1 = W + k * Math.log(MERGE_K + 1) + 0.02
    const t2 = t1 + 2 * k
    const reach = on ? t1 + t2 + 0.01 : -1
    // ---- legato (same key, sameKey off): closure amount / seam per joint; extended rects ----
    const { y0, y1, rT, rB, seam, amt, gapT, seamB, amtB, extT, extB, order, keyOrder } = this
    for (let i = 0; i < n; i++) { y0[i] = notes[i].y - notes[i].h / 2; y1[i] = notes[i].y + notes[i].h / 2; seam[i] = y1[i] }
    rT.fill(r, 0, n); rB.fill(r, 0, n)
    amt.fill(0, 0, n); gapT.fill(0, 0, n); seamB.fill(0, 0, n); amtB.fill(0, 0, n)
    let legato = 0
    const close = Math.min(Math.max(P.legatoClose ?? 0, 0), 1)
    const legatoPass = on && !P.sameKey && close > 0
    // spatial index: x columns ≥ reach wide (a pair / joint query only visits the columns within its x reach)
    if (on) this.layoutCells(notes, n, reach)
    let sorted = false
    if (legatoPass) {
      this.sortNotes = notes
      sortIdx(order, this.sortTmp, n, this.byY0)
      this.bucket(notes, n, true)
      sorted = true
      const G = Math.max(P.legatoGap, 1e-4)
      const lim = 1.5 * gm
      // key groups: indices sorted by key, then y (stable → input order on ties)
      sortIdx(keyOrder, this.sortTmp, n, this.byKeyY)
      for (let g0 = 0, g1 = 0; g0 < n; g0 = g1) {
        const key = notes[keyOrder[g0]].key
        let first = keyOrder[g0]
        for (g1 = g0 + 1; g1 < n && notes[keyOrder[g1]].key === key; g1++) first = Math.min(first, keyOrder[g1])
        if (notes[first].solo) continue // the key's first note (input order) decides, as before
        for (let s = g0; s + 1 < g1; s++) {
          const a = keyOrder[s], b = keyOrder[s + 1]
          const g = Math.max(y0[b] - y1[a], 0)
          if (g >= G) continue
          // a joint only needs closing where another key's note could bridge into it (otherwise it stays two plain
          // capsules = the separate look): nearest cross-key rect to the joint box, faded over [gm, 1.5 gm]
          const jx = notes[a].x, jhw = notes[a].w / 2, jy0 = y1[a] - r, jy1 = y0[b] + r
          const dn = this.nearestCrossKey(notes, notes[a].key, jx, jhw, jy0, jy1, lim)
          const c = close * (1 - smoothstep(0.5 * G, G, g)) * (1 - smoothstep(gm, 1.5 * gm, dn))
          if (c <= 0) continue
          legato++
          seam[a] = y1[a] + g / 2
          gapT[a] = g
          amt[a] = c
          seamB[b] = seam[a]; amtB[b] = c
          rT[a] = r * (1 - c); rB[b] = r * (1 - c)
          const e = c * (g / 2 + Math.min(1.5 * bw, 0.4 * Math.min(notes[a].h, notes[b].h)))
          extT[a] = e; extB[b] = -e
        }
      }
      // closed joints extend both ends (applied after the pass: the joint tests above read the original rects)
      for (let i = 0; i < n; i++) {
        if (amtB[i] > 0) { const e = extB[i]; if (e > 0) y1[i] += e; else y0[i] += e }
        if (amt[i] > 0) { const e = extT[i]; if (e > 0) y1[i] += e; else y0[i] += e }
      }
      if (legato > 0) sorted = false // rects moved → re-sort / re-bucket for the neighbour sweep
    }
    // ---- data texture ----
    const d = this.data, row = TEX_W * 4
    for (let i = 0; i < n; i++) {
      const N = notes[i], o = (i % TEX_W) * 4 + Math.floor(i / TEX_W) * ROWS * row
      d[o] = N.x; d[o + 1] = (y0[i] + y1[i]) / 2; d[o + 2] = N.w / 2; d[o + 3] = (y1[i] - y0[i]) / 2
      d[row + o] = N.color[0]; d[row + o + 1] = N.color[1]; d[row + o + 2] = N.color[2]; d[row + o + 3] = N.key
      d[2 * row + o] = rT[i]; d[2 * row + o + 1] = rB[i]; d[2 * row + o + 2] = seam[i]; d[2 * row + o + 3] = amt[i]
      d[3 * row + o] = seamB[i]; d[3 * row + o + 1] = gapT[i]; d[3 * row + o + 2] = N.h / 2; d[3 * row + o + 3] = amtB[i]
      d[4 * row + o] = N.seed?.[0] ?? (i * 0.618034) % 1 * 37; d[4 * row + o + 1] = N.seed?.[1] ?? 0
      d[4 * row + o + 2] = N.x; d[4 * row + o + 3] = N.y
      d[5 * row + o] = N.texShift ?? 0
    }
    this.tex.needsUpdate = true
    // ---- neighbours: extended-rect gap < reach, K nearest ----
    // Sweep over the notes sorted by bottom edge; each note pairs with the LATER notes of the columns in its x reach
    // until their bottom passes its top + reach. Pairs are emitted in (rank i, rank j) order, so every note's list
    // comes out in rank order (as the full sweep produced it); overflowing lists keep the K nearest (ties → rank).
    const A = this.nbrA.array as Float32Array, B = this.nbrB.array as Float32Array
    A.fill(-1, 0, n * 4); B.fill(-1, 0, n * 4)
    let pairs = 0, overflow = 0, maxNbrs = 0
    if (on) {
      if (!sorted) { sortIdx(order, this.sortTmp, n, this.byY0); this.bucket(notes, n, false) }
      const { pos, cellMem, cellStart, cellPtr } = this
      for (let ai = 0; ai < n; ai++) pos[order[ai]] = ai
      for (let c = 0; c < this.cells; c++) cellPtr[c] = cellStart[c]
      for (let ai = 0; ai < n; ai++) {
        const i = order[ai], Ni = notes[i]
        if (Ni.solo) continue
        const ext = (Ni.w / 2 + this.cellHalfW + reach) * 1.01 // padded: columns only pre-filter, the tests below decide
        const c1 = this.cellAt(Ni.x + ext)
        let nc = 0, runs = 0
        for (let c = this.cellAt(Ni.x - ext); c <= c1; c++) {
          let t = cellPtr[c]
          const end = cellStart[c + 1]
          while (t < end && pos[cellMem[t]] <= ai) t++
          cellPtr[c] = t
          const r0 = nc
          for (; t < end; t++) {
            const j = cellMem[t]
            if (y0[j] - y1[i] >= reach) break
            const Nj = notes[j]
            const gx = Math.max(Math.abs(Ni.x - Nj.x) - (Ni.w + Nj.w) / 2, 0)
            if (gx >= reach) continue // hypot ≥ either leg
            const gy = Math.max(Math.abs((y0[i] + y1[i]) - (y0[j] + y1[j])) / 2 - (y1[i] - y0[i] + y1[j] - y0[j]) / 2, 0)
            if (gy >= reach) continue
            const g = Math.hypot(gx, gy)
            if (g < reach) {
              if (nc === this.cand.length) { this.cand = grow(this.cand, nc); this.candG = grow(this.candG, nc) }
              this.cand[nc] = j; this.candG[nc] = g; nc++
            }
          }
          if (nc > r0) { this.runHead[runs] = r0; this.runEnd[runs++] = nc }
        }
        if (pairs + nc > this.pairI.length) {
          const need = pairs + nc
          this.pairI = grow(this.pairI, pairs, need); this.pairJ = grow(this.pairJ, pairs, need); this.pairG = grow(this.pairG, pairs, need)
        }
        // each column's run is in rank order → merge the runs (a handful) into the pair pool in rank order
        const { cand, candG, runHead, runEnd, pairI, pairJ, pairG } = this
        for (let s = 0; s < nc; s++) {
          let best = -1, bp = 0
          for (let q = 0; q < runs; q++) {
            if (runHead[q] === runEnd[q]) continue
            const p = pos[cand[runHead[q]]]
            if (best < 0 || p < bp) { best = q; bp = p }
          }
          const t = runHead[best]++
          pairI[pairs] = i; pairJ[pairs] = cand[t]; pairG[pairs] = candG[t]; pairs++
        }
      }
      // per-note lists (CSR), filled in pair order
      const { nbrStart, nbrFill, pairI, pairJ, pairG } = this
      nbrStart.fill(0, 0, n + 1)
      for (let p = 0; p < pairs; p++) { nbrStart[pairI[p] + 1]++; nbrStart[pairJ[p] + 1]++ }
      for (let i = 0; i < n; i++) nbrStart[i + 1] += nbrStart[i]
      if (2 * pairs > this.nbrJ.length) { this.nbrJ = grow(this.nbrJ, 0, 2 * pairs); this.nbrG = grow(this.nbrG, 0, 2 * pairs) }
      const { nbrJ, nbrG, topJ, topG } = this
      for (let i = 0; i < n; i++) nbrFill[i] = nbrStart[i]
      for (let p = 0; p < pairs; p++) {
        const i = pairI[p], j = pairJ[p], g = pairG[p]
        nbrJ[nbrFill[i]] = j; nbrG[nbrFill[i]++] = g
        nbrJ[nbrFill[j]] = i; nbrG[nbrFill[j]++] = g
      }
      for (let i = 0; i < n; i++) {
        const s0 = nbrStart[i], len = nbrStart[i + 1] - s0
        maxNbrs = Math.max(maxNbrs, len)
        if (len > MERGE_K) {
          // K smallest gaps, ties → earlier in the list (= a stable sort by gap, then the first K)
          overflow++
          let m = 0
          for (let s = s0; s < s0 + len; s++) {
            const g = nbrG[s]
            if (m === MERGE_K) { if (g >= topG[MERGE_K - 1]) continue; m-- } // drops the current K-th
            let t = m - 1
            for (; t >= 0 && topG[t] > g; t--) { topG[t + 1] = topG[t]; topJ[t + 1] = topJ[t] }
            topG[t + 1] = g; topJ[t + 1] = nbrJ[s]; m++
          }
          for (let s = 0; s < MERGE_K; s++) (s < 4 ? A : B)[i * 4 + (s & 3)] = topJ[s]
        } else for (let s = 0; s < len; s++) (s < 4 ? A : B)[i * 4 + (s & 3)] = nbrJ[s0 + s]
      }
    }
    this.nbrA.needsUpdate = this.nbrB.needsUpdate = true
    const st = this.stats
    st.notes = n; st.pairs = pairs; st.overflow = overflow; st.maxNbrs = maxNbrs; st.legato = legato
    this.margin = on ? t1 : W + 0.02
    const u = this.uniforms
    u.uMergeMargin.value = this.margin
    u.uMergeK.value = k
    u.uMergeKc.value = Math.max(k * P.colorSpread, 1e-4)
    u.uMergeT1.value = t1
    u.uMergeT2.value = t2
    u.uMergeSameKey.value = P.sameKey ? 1 : 0
    u.uMergeBevelW.value = bw
    u.uMergeCrease.value = P.creaseDepth
    u.uMergeWaist.value = P.seamWaist ?? 0.25 * k
    u.uMergeSeamBlend.value = Math.max(P.seamBlend ?? 4 * k, 1e-3)
    u.uMergeRadius.value = r
  }

  private cellHalfW = 0 // widest non-solo half width (pads every column query)
  /** Column layout over the non-solo notes: columns ≥ `minW` wide (fewer if the spread is huge — any monotone x →
   *  column map keeps the queries exact, the width only sets how much each one scans). */
  private layoutCells(notes: MergeNote[], n: number, minW: number) {
    let x0 = Infinity, x1 = -Infinity, hw = 0
    for (let i = 0; i < n; i++) {
      const N = notes[i]
      if (N.solo) continue
      x0 = Math.min(x0, N.x); x1 = Math.max(x1, N.x); hw = Math.max(hw, N.w / 2)
    }
    if (!(x1 >= x0)) { this.cells = 0; return }
    const cells = Math.max(1, Math.min(Math.floor((x1 - x0) / minW) + 1, 1024))
    this.cellX0 = x0; this.cellW = Math.max(minW, (x1 - x0) / cells); this.cellHalfW = hw; this.cells = cells
    if (cells + 1 > this.cellStart.length) {
      this.cellStart = new Int32Array(2 * cells + 1); this.cellPtr = new Int32Array(2 * cells)
      this.runHead = new Int32Array(2 * cells); this.runEnd = new Int32Array(2 * cells)
    }
    for (let i = 0; i < n; i++) if (!notes[i].solo) this.cellOf[i] = this.cellAt(notes[i].x)
  }
  /** column of world x (clamped: the queries pad their range, so clamping only merges far columns) */
  private cellAt(x: number) {
    return Math.min(Math.max(Math.floor((x - this.cellX0) / this.cellW), 0), this.cells - 1)
  }
  /** Fill the columns with the non-solo notes in `order`; `maxY1` also records each column's running max of y1. */
  private bucket(notes: MergeNote[], n: number, maxY1: boolean) {
    const { order, cellOf, cellMem, cellStart, cellPtr, y1, cellMaxY1 } = this
    const cells = this.cells
    if (cells === 0) return
    cellStart.fill(0, 0, cells + 1)
    for (let i = 0; i < n; i++) if (!notes[i].solo) cellStart[cellOf[i] + 1]++
    for (let c = 0; c < cells; c++) cellStart[c + 1] += cellStart[c]
    for (let c = 0; c < cells; c++) cellPtr[c] = cellStart[c]
    for (let t = 0; t < n; t++) {
      const i = order[t]
      if (!notes[i].solo) cellMem[cellPtr[cellOf[i]]++] = i
    }
    if (maxY1) for (let c = 0; c < cells; c++) {
      let m = -Infinity
      for (let t = cellStart[c]; t < cellStart[c + 1]; t++) cellMaxY1[t] = m = Math.max(m, y1[cellMem[t]])
    }
  }
  /** Rect distance from the joint box [jx ± jhw] × [jy0, jy1] to the nearest other-key note; anything ≥ lim reads as
   *  Infinity (the caller's fade is 0 there either way). Columns hold the notes sorted by y0 (bucket(…, true)). */
  private nearestCrossKey(notes: MergeNote[], key: number, jx: number, jhw: number, jy0: number, jy1: number, lim: number) {
    const { y0, y1, cellMem, cellStart, cellMaxY1 } = this
    let dn = Infinity
    if (this.cells === 0) return dn
    const ext = (jhw + this.cellHalfW + lim) * 1.01 // padded (see the neighbour sweep)
    const c1 = this.cellAt(jx + ext)
    for (let c = this.cellAt(jx - ext); c <= c1; c++) {
      // first note whose bottom is ≥ lim above the joint → scan down from there while some y1 can still reach
      let lo = cellStart[c], hi = cellStart[c + 1]
      while (lo < hi) { const m = (lo + hi) >> 1; if (y0[cellMem[m]] - jy1 >= lim) hi = m; else lo = m + 1 }
      for (let t = lo - 1; t >= cellStart[c]; t--) {
        if (cellMaxY1[t] <= jy0 - lim) break
        const j = cellMem[t]
        if (notes[j].key === key || y1[j] <= jy0 - lim) continue
        const gx = Math.max(Math.abs(notes[j].x - jx) - (notes[j].w / 2 + jhw), 0)
        const gy = Math.max(y0[j] - jy1, jy0 - y1[j], 0)
        dn = Math.min(dn, Math.hypot(gx, gy))
      }
    }
    return dn
  }

  /** Per draw: camera (gl_FragCoord → world on the note plane z = planeZ) + the size of the target drawn into
   *  (`target` null = the canvas' drawing buffer). */
  updateCamera(camera: THREE.Camera, target: THREE.WebGLRenderTarget | null, renderer: THREE.WebGLRenderer, planeZ = 0) {
    this.tmpM.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).invert()
    this.uniforms.uMergeInvViewProj.value.copy(this.tmpM)
    if (target) this.uniforms.uMergeRes.value.set(target.width, target.height)
    else renderer.getDrawingBufferSize(this.uniforms.uMergeRes.value)
    this.uniforms.uMergePlaneZ.value = planeZ
  }

  dispose() { this.tex.dispose() }
}

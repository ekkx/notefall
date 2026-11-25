import { GEM_FACETS_GLSL, ANGLED_FACETS_GLSL } from './looks/gemFacets'
import { REALISTIC_SHADING_GLSL } from './looks/realistic'
import { NOTE_GRADIENT_GLSL } from './noteColor'
import { MERGE_VERT_GLSL, MERGE_FRAG_GLSL } from './looks/merge'

// Falling-note shaders (FallingNotes' single InstancedMesh). The fragment shader clips at the hit line, cuts the
// rounded-box SDF, shades the fill (flat or reflective look), then composites the edge and the selection treatment.
//
// Colour space: the reflective look is computed on sRGB-encoded values (tint, light pattern and constants all in
// display space, so its tuning numbers mean what they show), and only the FINAL colour is converted for the target:
// linear for the bloom composer's buffer, sRGB-encoded for the canvas (`uLinearTarget`, set per draw — a
// ShaderMaterial gets no automatic output conversion). The flat fill, edge and selection treatment are linear-light
// terms as before; on the canvas they are now encoded too, so a note looks the same with Bloom on or off.

// Texture mode IDs. Keep in sync with TEXTURE_MODE in FallingNotes and the NoteTexture union in store.ts.
export const TEXTURE_SOLID = 0
export const TEXTURE_CUSTOM = 1

// sRGB transfer of one linear channel (CPU side of the shader's linearToSrgb, including its pass-through above white).
// The merge data carries sRGB-encoded tints so the fillet blends colours in display space, like the look maths.
export function linearToSrgbChannel(c: number): number {
  if (c >= 1) return c
  if (c <= 0) return 0
  return c < 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055
}

// Material IDs (NoteMaterial in looks/noteLook.ts).
export const MATERIAL_FLAT = 0
export const MATERIAL_REFLECTIVE = 1
export const MATERIAL_REALISTIC = 2
export const MATERIAL_SPRITE = 3

// Shape IDs (NoteShape in looks/noteLook.ts).
export const SHAPE_ROUND = 0
export const SHAPE_GEM = 1
export const SHAPE_ANGLED = 2

export const NOTE_VERTEX_SHADER = /* glsl */ `
  // Per-instance data packed into three vec4s, and the quad placed from
  // iRect instead of instanceMatrix, so the shader needs only 4 attribute
  // locations (6 with MERGE). WebGL guarantees just 8 (MAX_VERTEX_ATTRIBS),
  // and some contexts really give 8 (Firefox sometimes hands out a
  // minimal-capability context); the old layout (instanceMatrix = 4 + uv +
  // six loose attributes) needed 12, so the notes silently never drew there.
  // instanceMatrix still carries the same transform for raycast picking.
  // Note quad, instance space (before modelMatrix): centre.xy, size (width, length).
  attribute vec4 iRect;
  // Noise seed.xy, selection flag (0 / 1), black-key flag (the 2D look's
  // key split).
  attribute vec4 iSeedSel;
  // Linear RGB tint (track colour / noteColor / palette pick, resolved on
  // the CPU each frame) + opacity multiplier (1 for normal notes, ramped
  // 1 → 0 for the dying-note ghosts).
  attribute vec4 iTintAlpha;
  // Note plane z (NOTE_PLANE_Z), instance space.
  uniform float uNoteZ;
  // Extra quad margin (world units) around the note: AA edge + outline ring.
  uniform float uMargin;
  varying vec2 vLocal;
  varying vec2 vSize;
  varying vec2 vSeed;
  varying float vSelected;
  varying float vAlpha;
  varying vec2 vWorld;
  varying vec2 vCenter;
  varying vec3 vTint;
  varying float vBlack;
  #ifdef MERGE
  ${MERGE_VERT_GLSL}
  #endif
  void main() {
    vec2 size = iRect.zw;
    vSeed = iSeedSel.xy;
    vSelected = iSeedSel.z;
    vBlack = iSeedSel.w;
    vTint = iTintAlpha.rgb;
    vAlpha = iTintAlpha.a;
    vec4 center = modelMatrix * vec4(iRect.xy, uNoteZ, 1.0);
  #ifdef MERGE
    // liquid merge (looks/merge.ts): the quad is placed / enlarged from the
    // merge data in WORLD units; centre = the note's ORIGINAL centre
    vec2 w = mergeQuadCorner(position.xy);
    vWorld = w;
    vCenter = mergeNoteCarry(gl_InstanceID).zw;
    vLocal = w - vCenter;
    // world size: the mesh's parallax x-scale only
    vSize = size * vec2(length(modelMatrix[0].xyz), 1.0);
    gl_Position = projectionMatrix * viewMatrix * vec4(w, center.z, 1.0);
    return;
  #endif
    vSize = size;
    // The unit quad (position.xy in [-0.5, 0.5]) is scaled to the note and
    // widened by uMargin so the fragment shader can draw past the body.
    // Picking raycasts the unwidened instanceMatrix quad, so it still
    // resolves to the note's own box.
    vLocal = position.xy * (size + 2.0 * uMargin);
    vec4 worldPos = modelMatrix * vec4(iRect.xy + vLocal, uNoteZ, 1.0);
    vWorld = worldPos.xy;
    vCenter = center.xy;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`

export const NOTE_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  varying float vBlack;
  varying vec2 vLocal;
  varying vec2 vSize;
  varying vec2 vSeed;
  varying float vSelected;
  varying float vAlpha;
  varying vec2 vWorld;
  varying vec2 vCenter;
  varying vec3 vTint;
  uniform float uEmissive;
  // gradient colouring (notes/noteColor.ts)
  ${NOTE_GRADIENT_GLSL}
  uniform float uOpacity;
  uniform float uRadius;
  uniform float uHitY;
  // 1 while drawing into a linear (bloom composer) target, 0 for the canvas.
  uniform float uLinearTarget;
  uniform float uMargin;
  // Accumulated per-axis texture phase = integral of animSpeed dt,
  // integrated CPU-side. Integrating the RATE rather than multiplying
  // absolute clock time by the current speed (the old uTime*uAnimSpeed)
  // keeps the visual velocity exactly animSpeed even while a pin
  // animates it: with the old form the velocity picked up a
  // now()*dSpeed/dt term, and now() is a large absolute timestamp, so
  // any speed slope between pins exploded the flow speed. X / Y = custom
  // image UV scroll.
  uniform vec2 uPhase;
  // Texture preset selector — branched in main(). See TEXTURE_* constants
  // (CPU side) for the value mapping.
  uniform int uTextureMode;
  uniform float uTextureScale;
  // Static positional shift on the texture sample point. Subtracted from
  // the UV so positive offset visually moves the image in the positive
  // direction (right / up) on the note.
  uniform vec2 uTextureOffset;
  // LOD bias applied to the custom-image sampler. Each unit doubles the
  // effective blur radius — the GPU's trilinear mipmap filter handles the
  // smoothing in hardware, so even large values stay artifact-free
  // (compared to a multi-tap blur, which ghosts at wide radii).
  uniform float uTextureBlur;
  // Custom-preset per-note offset weight in [0, 1]. Multiplies the vSeed
  // component so 0 = every note identical, 1 = full random offset per note.
  uniform float uTextureVariation;
  uniform float uTextureContrast;
  uniform vec3 uEdgeColor;
  uniform float uEdgeWidth;
  uniform float uEdgeIntensity;
  // 'custom' preset — user image. uHasCustomTexture is 1 when a real texture
  // is bound, 0 otherwise (so the shader can fall back to the tint colour
  // and not display the placeholder 1x1 default).
  uniform sampler2D uCustomTexture;
  uniform float uHasCustomTexture;

  // ---- note look (looks/noteLook.ts) ----
  uniform int uMaterial;
  uniform int uShape;
  uniform float uUnit;           // white-key width (world units)
  uniform float uBevelW, uBevelD, uBevelProfile, uBevelSoft, uBevelReflect, uRimShade, uRimFade;
  uniform vec3 uKey, uFill;      // light directions (towards the light), +z = towards the viewer
  uniform float uKeyI, uFillI, uAmbient, uReflect, uTransparency, uSaturation, uSheen;
  uniform sampler2D uPattern;
  uniform float uPatternTile, uContrast, uBrightness, uLock, uDistort, uPatternAmount;
  uniform float uDriftX;         // sideways pattern scroll (world units, wrapped)
  uniform sampler2D uNoteTex;    // silk note texture, multiplied into the pattern
  uniform float uNoteTexAmount, uNoteTexTile;
  uniform sampler2D uAlbedoMap, uGlossMap, uEmissiveMap;   // realistic map set
  uniform float uAlbedoGain, uSpecular, uEmission, uSurfaceContrast;
  uniform float uBumpZEnc;       // 1: the bump map encodes z as n·0.5 + 0.5 (realistic sets)
  uniform float uKnee, uKneeSoft, uRibbon;
  uniform sampler2D uBump;
  uniform float uBumpTile, uBumpDepth, uDetail, uBumpSoft, uMelt, uScatter, uFacetEdges;
  uniform float uFacetMap;       // 1: the bump map's alpha carries baked facet edges (1 − edge; looks/crystalNormal.ts)
  uniform float uScroll;         // scale-1 units fallen so far: fall height ± uScroll is fixed on every song note
  uniform float uFallUnit;       // scale-1 units per world unit of fall (1 unless the lens is zoomed, see framing.ts)
  uniform float uTime;           // look animation clock (wrapped)
  uniform float uCloud, uCloudTile, uCloudSoft, uCloudClear;
  uniform float uHighlight, uHighlightThr, uHighlightSoft;
  uniform float uFrost, uFrostGrain, uFrostTile, uFrostVeil;
  uniform float uOutlineW, uOutlineBright, uOutlineBlend, uOutlineReflect;
  uniform vec3 uOutlineColor;    // sRGB-encoded
  uniform float uBandW, uBandBright, uBandBlend, uGapW, uGapDark;
  uniform vec3 uBandColor;       // sRGB-encoded
  // ---- 2D (sprite) look ----
  uniform float u2dRimW, u2dRimTilt, u2dHollow, u2dGloss, u2dGlossPow, u2dExposure, u2dWhiten, u2dWhitenStart, u2dKeySplit;
  uniform vec3 u2dFill;          // fill light direction (its intensity is uFillI)
  uniform float u2dShimmer, u2dShimmerGain, u2dShimmerCell, u2dShimmerSpeed, u2dShimmerLock;
  uniform float u2dTex, u2dTexCell, u2dTexStretch, u2dTexContrast, u2dTexGain, u2dTexRelief, u2dTexSpeed, u2dTexLock;
  uniform int u2dOutline;        // 0 off, 1 whole, 2 half
  uniform float u2dOutW, u2dOutTint, u2dOutShade, u2dOutGrey, u2dOutBright, u2dOutRelief;
  uniform float u2dGlow, u2dGlowR, u2dGlowTail, u2dGlowWhiten, u2dGlowBoost;

  float sdRoundedBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + vec2(r);
    return min(max(q.x, q.y), 0.0) + length(max(q, vec2(0.0))) - r;
  }
  // Outward unit gradient of sdRoundedBox.
  vec2 sdRoundedBoxDir(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    vec2 s = sign(p + 1e-6);
    if (max(q.x, q.y) > 0.0) {
      vec2 m = max(q, 0.0);
      float l = length(m);
      return l > 1e-6 ? s * m / l : (q.x > q.y ? vec2(s.x, 0.0) : vec2(0.0, s.y));
    }
    return q.x > q.y ? vec2(s.x, 0.0) : vec2(0.0, s.y);
  }

  // sRGB transfer on [0, 1]; values ABOVE white (the looks' overdriven
  // highlights for Bloom) pass through unchanged, so "1.7× white" stays a
  // 1.7× intensity instead of being raised to the 2.4th power.
  vec3 linearToSrgb(vec3 c) {
    c = max(c, 0.0);
    vec3 s = mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
    return mix(s, c, step(1.0, c));
  }
  vec3 srgbToLinear(vec3 c) {
    c = max(c, 0.0);
    vec3 l = mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
    return mix(l, c, step(1.0, c));
  }

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float vnoise2(vec2 x) {
    vec2 i = floor(x), f = fract(x), u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
  }
  // Smooth value-noise fbm (3 octaves) for the cloudy volume: low-frequency,
  // soft, slowly evolving.
  float cloudField(vec2 x, float t) {
    float s = 0.0, a = 0.5, n = 0.0;
    for (int o = 0; o < 3; o++) {
      s += a * vnoise2(x + vec2(0.37, -0.61) * t * (1.0 + float(o) * 0.5));
      n += a;
      x = mat2(1.6, 1.2, -1.2, 1.6) * x;
      a *= 0.45;
    }
    return s / n;
  }
  // Analytic gradient of 2-octave value noise: small crisp ridges, used as
  // a micro-grain slope on the cast bump.
  vec2 grainSlope(vec2 x) {
    vec2 g = vec2(0.0);
    float amp = 1.0;
    for (int o = 0; o < 2; o++) {
      vec2 i = floor(x), f = fract(x);
      vec2 u = f * f * (3.0 - 2.0 * f), du = 6.0 * f * (1.0 - f);
      float a = hash12(i), b = hash12(i + vec2(1, 0)), c = hash12(i + vec2(0, 1)), d = hash12(i + vec2(1, 1));
      g += amp * du * vec2(b - a + (a - b - c + d) * u.y, c - a + (a - b - c + d) * u.x);
      x = mat2(1.6, 1.2, -1.2, 1.6) * x;
      amp *= 0.5;
    }
    return g * 0.5;
  }

  ${GEM_FACETS_GLSL}
  ${ANGLED_FACETS_GLSL}
  ${REALISTIC_SHADING_GLSL}
  #ifdef MERGE
  ${MERGE_FRAG_GLSL}
  #endif

  // Note-carried inputs (pattern lock centre, seeds): the note's own, or —
  // merged — the two strongest contributors', whose RESULTS are blended
  // (gW1 = weight of the second one; blending the inputs instead would sweep
  // the pattern across many cells over the fillet).
  vec2 gC, gC1, gS, gS1;
  float gW1 = 0.0;

  // 'custom': user-uploaded image.
  // - UV is per-note local: vLocal + vSize / 2 gives a coordinate in world units
  //   from the note's bottom-left corner. Multiplied by uTextureScale, the
  //   image tiles within the note. Every note starts the image at the
  //   same origin → identical appearance across notes.
  // - uTextureScale = "tiles per world unit". Higher = smaller tiles
  //   (image repeats more times within the note). Both axes scale
  //   uniformly so the source aspect ratio is preserved.
  // - uPhase (X, Y) scrolls the UV per axis. Same world-unit
  //   semantics as the position term, so motion looks consistent
  //   regardless of scale.
  // - uTextureOffset shifts the image inside each note (positive = right
  //   / up).
  // - Per-note vSeed offset is gated by uTextureVariation: 0 = all notes
  //   show the image identically, 1 = each note starts at its own random
  //   spot.
  // - Contrast pushes pixel values away from mid gray (1 = identity).
  // - Tinted by the note colour (set Color = white for pass-through).
  // Texture wrap is RepeatWrapping in customTexture.ts so values outside
  // [0,1] tile naturally.
  vec3 textureCustom(vec3 tint) {
    vec2 uv = (vLocal + 0.5 * vSize + uPhase) * uTextureScale + vSeed * 100.0 * uTextureVariation - uTextureOffset;
    // Single tap with LOD bias — the texture is configured with mipmaps
    // and trilinear filtering, so the bias selects a progressively-blurred
    // mip level. This is what GPU hardware is built to do, and produces a
    // smooth gaussian-like blur with no ghosting at any radius.
    vec3 sampled = texture2D(uCustomTexture, uv, uTextureBlur).rgb;
    sampled = clamp((sampled - 0.5) * uTextureContrast + 0.5, 0.0, 1.0);
    // When no image is bound yet, fall back to the tint color so the user
    // doesn't see a black rectangle while picking a file.
    return mix(tint, sampled * tint, uHasCustomTexture);
  }

  // Frame of the note-carried maps (bump, and with scatter also cloud +
  // frost grain).
  //   scatter off: note-local frame + the note's y seed.
  //   scatter on: SONG-SPACE frame (x − key centre, fall height + scroll): every
  //     song note falls at the same speed, so this frame is attached to all
  //     of them at once and continuous across consecutive notes of one key;
  //     each key gets its own random offset + 90°-step rotation + mirror, so
  //     neighbouring keys / chords never show the same interior.
  // R maps frame → map space; slopes read from the map go back with transpose(R).
  // c = the note's centre, seedY = its bump seed.
  vec2 songFrame(vec2 c) { return vec2(vWorld.x - c.x, vWorld.y - c.y + uHitY + (c.y - uHitY) * uFallUnit + uScroll); }
  float keyHash(vec2 c) { return hash12(vec2(floor(c.x * 97.0 + 0.5) * 0.731, 4.17)); }
  vec2 noteMapUv(vec2 c, float seedY, float tile, out mat2 R) {
    R = mat2(1.0);
    vec2 local = vWorld - c;
    vec2 off = vec2(0.0, seedY * 64.0);
    if (uScatter > 0.0) {
      local = songFrame(c);
      float h = keyHash(c);
      float k = floor(fract(h * 3.71) * 4.0);
      vec2 cs = k < 0.5 ? vec2(1, 0) : k < 1.5 ? vec2(0, 1) : k < 2.5 ? vec2(-1, 0) : vec2(0, -1);
      float fl = fract(h * 11.3) > 0.5 ? -1.0 : 1.0;
      R = mat2(cs.x * fl, cs.y * fl, -cs.y, cs.x);   // rotation · mirror(x)
      off = vec2(fract(h * 7.13), fract(h * 5.17)) * 64.0 * tile;
    }
    return (R * local + off) / tile;
  }

  float patternTap(vec2 puv) { return dot(texture2D(uPattern, fract(puv)).rgb, vec3(0.3333)); }
  // Light pattern (grey level, ~[0, 1]) at a lookup point bent by 'bend'
  // (a surface slope). Anchored in world space, carried with the note by
  // uLock; the per-note seed shifts where a carried note samples it.
  float patternAt1(vec2 bend) {
    vec2 q = vWorld - uLock * (gC - gS.x * uPatternTile * vec2(1.0, 0.61));
    q.x -= uDriftX;
    vec2 b = uDistort * uPatternTile * bend;
    vec2 puv = (q + b) / uPatternTile;
    float pat = patternTap(puv);
    // frost: the light seen through the note is diffused — an 8-tap
    // golden-angle disc (radius up to 0.06 tile) averaged with the centre
    // tap. The satin grain jitters the disc per pixel (like etched glass)
    // instead of tilting the normal, so it never sparkles in highlights.
    if (uFrost > 0.0) {
      float acc = pat, rad = 0.06 * uFrost;
      vec2 gq = uScatter > 0.0 ? songFrame(gC) / uFrostTile + keyHash(gC) * 71.0 : (vWorld - gC) / uFrostTile + gS.x * 7.0;
      vec2 jit = (vec2(vnoise2(gq), vnoise2(gq + 17.3)) - 0.5) * uFrostGrain * rad * 2.0;
      for (int i = 0; i < 8; i++) {
        float a = float(i) * 2.39996, rr = rad * sqrt((float(i) + 0.5) / 8.0);
        acc += patternTap(puv + jit + rr * vec2(cos(a), sin(a)));
      }
      pat = mix(pat, acc / 9.0, min(uFrost, 1.0));
    }
    // translucent ribbons: the pattern's local gradient (2 extra taps)
    // marks fold EDGES; flat bright plateaus are dimmed toward a
    // grey-translucent level and their edges brightened
    if (uRibbon > 0.0) {
      float e = 2.0 / 1024.0;
      float g = clamp(length(vec2(patternTap(puv + vec2(e, 0.0)) - pat, patternTap(puv + vec2(0.0, e)) - pat)) * 6.0, 0.0, 1.0);
      float plateau = smoothstep(0.45, 0.9, pat) * (1.0 - g);
      pat = mix(pat, pat * (1.0 - 0.55 * plateau) + 0.35 * g, uRibbon);
    }
    // patternAmount < 1 flattens the pattern toward its typical mean level
    // (0.35) so the surface stays evenly lit at about the same brightness.
    pat = mix(0.35, pat, uPatternAmount);
    // silk note texture: carried like the pattern, bent proportionally
    if (uNoteTexAmount > 0.0) {
      vec2 qt = vWorld - uLock * gC + b * (uNoteTexTile / uPatternTile);
      pat *= mix(1.0, 2.2 * texture2D(uNoteTex, qt / uNoteTexTile).r, uNoteTexAmount);
    }
    return pat;
  }
  float patternAt(vec2 bend) {
    if (gW1 <= 0.0) return patternAt1(bend);
    vec2 c = gC, sd = gS;
    float a = patternAt1(bend);
    gC = gC1; gS = gS1;
    float b = patternAt1(bend);
    gC = c; gS = sd;
    return mix(a, b, gW1);
  }
  // ---- 2D (sprite) look: analytic soft-lit slab on the same quad ----
  float s2dFbm(vec2 x) {
    float s = 0.0, a = 0.5;
    for (int o = 0; o < 4; o++) { s += a * vnoise2(x); x = mat2(1.7, 1.1, -1.1, 1.7) * x + 3.1; a *= 0.5; }
    return s / 0.9375;
  }
  // flowing filaments: ridges of a warped fbm, elongated along y (the travel axis)
  float s2dSilk(vec2 p, float t) {
    vec2 q = p * vec2(1.0, 1.0 / u2dTexStretch);
    vec2 w = vec2(s2dFbm(q * 0.7 + vec2(0.0, t)), s2dFbm(q * 0.7 + vec2(5.2, 1.3 - t)));
    float f = s2dFbm(q * 1.3 + 1.6 * w + vec2(t * 0.3, 0.0));
    float r = 1.0 - abs(2.0 * f - 1.0);
    return r * r * r;
  }
  // moving light pattern: soft broad swell + thin bright lines of a warped fbm (mean ≈ 0.5)
  float s2dShimmerAt(vec2 p, float t) {
    vec2 q = p / u2dShimmerCell;
    float swell = s2dFbm(q * 0.35 + vec2(0.11 * t, -0.07 * t));
    vec2 w = vec2(s2dFbm(q * 0.6 + vec2(0.0, 0.2 * t)), s2dFbm(q * 0.6 + vec2(4.7, -0.17 * t)));
    float f = s2dFbm(q + 1.2 * w + vec2(0.13 * t, 0.0));
    float line = pow(1.0 - abs(2.0 * f - 1.0), 6.0);
    return 0.4 + 0.6 * (swell - 0.5) + 0.9 * line;
  }
  float s2dLight(vec3 N, vec3 L, float I) {
    if (I <= 0.0) return 0.0;
    vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
    return I * (0.8 * max(dot(N, L), 0.0) + u2dGloss * pow(max(dot(N, H), 0.0), u2dGlossPow));
  }
  float s2dShade(vec3 N) { return max(s2dLight(N, uKey, uKeyI) + s2dLight(N, u2dFill, uFillI), uAmbient); }
  // shade → colour: linear ramp up to the tint, beyond it only whitening
  vec3 s2dTone(vec3 tint, float s) {
    vec3 c = tint * min(s * u2dExposure, 1.0);
    return c + (1.0 - c) * u2dWhiten * max(s - u2dWhitenStart, 0.0);
  }
  // distance to the body shape (solid box or ring) and its outward gradient
  float s2dBody(vec2 p, vec2 halfSize, float r, out vec2 g) {
    float d = sdRoundedBox(p, halfSize, r);
    g = sdRoundedBoxDir(p, halfSize, r);
    if (u2dHollow > 0.0) {
      float h = min(u2dHollow, min(halfSize.x, halfSize.y));
      float k = d + h * 0.5;
      if (k < 0.0) g = -g;
      d = abs(k) - h * 0.5;
    }
    return d;
  }
  // body + outline, sRGB-encoded colour and coverage (non-premultiplied)
  vec4 shadeSprite(vec2 p, vec2 halfSize, float r, vec3 tint) {
    vec2 g;
    float d = s2dBody(p, halfSize, r, g);
    float cover = clamp(0.5 - d / max(fwidth(d), 1e-5), 0.0, 1.0);
    // outline band (relative to the solid outer edge, not the ring hole)
    float dOuter = sdRoundedBox(p, halfSize, r);
    vec2 go = sdRoundedBoxDir(p, halfSize, r);
    float oA = 0.0;
    vec3 oCol = vec3(0.0);
    if (u2dOutline > 0) {
      float lo = u2dOutline == 1 ? -0.5 * u2dOutW : 0.0;
      float mid = lo + 0.5 * u2dOutW, hw = 0.5 * u2dOutW;
      float db = abs(dOuter - mid) - hw;
      oA = clamp(0.5 - db / max(fwidth(db), 1e-5), 0.0, 1.0);
      vec3 base = mix(vec3(u2dOutGrey), tint * u2dOutShade, u2dOutTint) * u2dOutBright;
      // optional tube relief: the normal tips across the band
      float u = clamp((dOuter - mid) / max(hw, 1e-5), -1.0, 1.0);
      vec3 Nt = normalize(vec3(go * u, sqrt(max(1.0 - u * u, 0.02))));
      oCol = base * mix(1.0, s2dShade(Nt) * 1.6, u2dOutRelief);
    }
    vec3 col = vec3(0.0);
    float A = 0.0;
    if (cover > 0.0) {
      // rounded-over rim: the normal tips outward toward the edge
      float band = min(u2dRimW, u2dHollow > 0.0 ? 0.5 * min(u2dHollow, min(halfSize.x, halfSize.y)) : min(halfSize.x, halfSize.y));
      float t = clamp(-d / max(band, 1e-5), 0.0, 1.0);
      float tilt = u2dRimTilt * pow(1.0 - t, 1.4);
      vec3 N = vec3(g * sin(tilt), cos(tilt));
      vec3 alb = tint;
      float gain = 1.0;
      if (u2dTex > 0.0) {
        vec2 q = (vWorld - u2dTexLock * (gC - gS * 40.0)) / u2dTexCell;
        float tt = uTime * u2dTexSpeed;
        float h0 = s2dSilk(q, tt);
        float hx = s2dSilk(q + vec2(0.04, 0.0), tt), hy = s2dSilk(q + vec2(0.0, 0.04), tt);
        vec2 dh = vec2(hx - h0, hy - h0) / 0.04;
        N = normalize(N + vec3(-dh * u2dTexRelief * 0.12, 0.0));
        alb *= (1.0 - u2dTexContrast) + u2dTexContrast * 1.8 * h0;
        gain = u2dTexGain;
      }
      if (u2dShimmer > 0.0) {
        vec2 q = vWorld - u2dShimmerLock * (gC - gS * 40.0);
        gain *= u2dShimmerGain * (1.0 - 0.5 * u2dShimmer + u2dShimmer * s2dShimmerAt(q, uTime * u2dShimmerSpeed));
      }
      if (u2dGlow > 0.0) gain *= u2dGlowBoost;
      col = s2dTone(alb * gain, s2dShade(N)) + (vBlack > 0.5 ? -u2dKeySplit : u2dKeySplit);
      A = cover;
    }
    // composite (premultiplied): 'whole' sits over the rim, 'half' lies under / outside the body
    vec3 C = col * A;
    if (u2dOutline == 1) { C = oCol * oA + C * (1.0 - oA); A = oA + A * (1.0 - oA); }
    else if (u2dOutline == 2) { C += oCol * oA * (1.0 - A); A += oA * (1.0 - A); }
    return vec4(clamp(C / max(A, 1e-4), 0.0, 4.0), A);
  }
  // glow halo: Gaussian core + exponential tail of the distance OUTSIDE the body shape (so a ring glows inwards
  // too), faded out before the quad edge
  vec4 shadeSpriteGlow(vec2 p, vec2 halfSize, float r, vec3 tint) {
    vec2 g;
    float o = max(s2dBody(p, halfSize, r, g), 0.0);
    float halo = u2dGlow * ((1.0 - u2dGlowTail) * exp(-(o * o) / (u2dGlowR * u2dGlowR)) + u2dGlowTail * exp(-o / (u2dGlowR * 1.8)));
    halo *= 1.0 - smoothstep(uMargin * 0.6, uMargin, o);
    return vec4(mix(tint, vec3(1.0), u2dGlowWhiten), clamp(halo, 0.0, 1.0));
  }

  // cloud field at the note-carried frame of centre c / seed sx
  float cloudAt(vec2 c, float sx, float w) {
    vec2 cq = uScatter > 0.0
      ? songFrame(c) / uCloudTile + keyHash(c) * 170.0
      : (vWorld - uLock * c) / uCloudTile + sx * 17.0;
    return smoothstep(0.5 - w, 0.5 + w, cloudField(cq, uTime * 0.08));
  }
  // bump slope (note frame) of the map at centre c / bump seed sy, mip bias lod
  vec2 bumpAt(vec2 c, float sy, float lod) {
    mat2 R;
    vec3 bt = texture2D(uBump, noteMapUv(c, sy, uBumpTile, R), lod).rgb;
    if (uBumpZEnc > 0.5) bt.z = bt.z * 2.0 - 1.0;
    return transpose(R) * ((bt.xy * 2.0 - 1.0) / max(bt.z, 0.3));
  }
  // Soft knee on the reflected light: above uKnee it rolls off smoothly
  // toward uKnee + uKneeSoft instead of into a flat clipped plateau.
  float knee(float v) {
    if (uKnee <= 0.0 || v <= uKnee) return v;
    float x = v - uKnee, s = max(uKneeSoft, 1e-3);
    return uKnee + s * x / (s + x);
  }
  float envOf(float pat) { return knee((pat - 0.5) * uContrast + 0.5 + uBrightness); }

  // Lit body colour for one surface normal (sRGB-encoded in and out; called
  // twice across gem creases). N lights the surface; Np (the same surface
  // with the shape slope scaled by bevelReflect) bends the pattern lookup.
  // buv = map-space position of the note-carried maps (realistic set).
  vec3 shadeBody(vec3 N, vec3 Np, vec3 tint, vec2 buv, out float alpha) {
    float key = max(dot(N, uKey), 0.0) * uKeyI;
    float fill = max(dot(N, uFill), 0.0) * uFillI;
    if (uMaterial == ${MATERIAL_REALISTIC}) {
      float pat = patternAt(realisticEnvBend(Np, 1.0));
      alpha = 1.0 - uTransparency * (1.0 - clamp(pat, 0.0, 1.0));
      RealisticLights L = RealisticLights(uKey, uKeyI, uFill, uFillI, uAmbient);
      RealisticParams P = RealisticParams(uAlbedoGain, uReflect, uSpecular, uEmission, uSheen, uContrast);
      // surfaceContrast < 1 pulls the albedo toward its mean (top mip) → less mottling
      vec3 alb = max(mix(texture2D(uAlbedoMap, buv, 16.0).rgb, texture2D(uAlbedoMap, buv).rgb, uSurfaceContrast), 0.0);
      return realisticShade(tint, alb, texture2D(uGlossMap, buv), N, texture2D(uEmissiveMap, buv).rgb,
                            vec3(knee(pat + uBrightness)), L, P);
    }
    float pat = patternAt(Np.xy / max(Np.z, 0.25));
    float env = envOf(pat);
    // transparency: the body thins out where the pattern is dark
    alpha = 1.0 - uTransparency * (1.0 - clamp(pat, 0.0, 1.0));
    vec3 col = tint * (uReflect * env + key + fill + uAmbient);
    // hot spots of the pattern push toward white instead of being tinted
    float hot = smoothstep(0.6, 1.25, env);
    col += (1.0 - col) * hot * uSheen;
    col *= mix(0.72, 1.0, smoothstep(0.0, 0.45, env));
    return col;
  }

  void main() {
  #ifdef MERGE
    // ownership + merged field first (derivatives before any discard)
    vec2 mp = mergeWorldPos();
    float maa = mergeAA(mp);
    MergeSample ms;
    if (!mergeSample(mp, ms)) discard;   // another instance owns this pixel
    vec4 mc0 = mergeNoteCarry(ms.id0), mc1 = mergeNoteCarry(ms.id1);
    gC = mc0.zw; gS = mc0.xy; gC1 = mc1.zw; gS1 = mc1.xy; gW1 = ms.w1;
  #else
    gC = vCenter; gS = vSeed;
  #endif
    if (vWorld.y < uHitY) discard;
    if (vSize.x < 0.0001 || vSize.y < 0.0001) discard;
    vec2 halfSize = vSize * 0.5;
    vec2 p = vLocal;
    float r = min(uRadius, min(halfSize.x, halfSize.y) - 0.0001);
    r = max(r, 0.0);
    // the note's own box: the selection treatment stays on it when merged
    float dOwn = sdRoundedBox(p, halfSize, r);
  #ifdef MERGE
    float d = ms.D;
    float aa = maa;
    vec2 sdfDir = ms.dir;
  #else
    float d = uShape == ${SHAPE_GEM} ? gemOutlineSdf(p, halfSize, uRadius)
            : uShape == ${SHAPE_ANGLED} ? angledFrameSdf(p, halfSize, uBevelW, uRadius)
            : dOwn;
    float aa = max(fwidth(d), 0.0001);
    vec2 sdfDir = sdRoundedBoxDir(p, halfSize, r);
  #endif
    float alpha = clamp(-d / aa + 0.5, 0.0, 1.0);
    bool sprite = uMaterial == ${MATERIAL_SPRITE};
    bool lit = uMaterial == ${MATERIAL_REFLECTIVE} || uMaterial == ${MATERIAL_REALISTIC};

    // Albedo (linear): the note tint, times the user image for 'custom'.
  #ifdef MERGE
    // the merge data carries sRGB-encoded tints (blended in display space)
    vec3 tint0 = srgbToLinear(ms.tint);
  #else
    vec3 tint0 = vTint;
  #endif
    if (uGradient > 0.5) tint0 = gradientAt(vWorld);
    vec3 base = uTextureMode == ${TEXTURE_CUSTOM} ? textureCustom(tint0) : tint0;

    // ---- outline ring OUTSIDE the body (0 < d < uOutlineW), sRGB-encoded,
    // with a rounded profile: the outer half slopes outward, the inner in ----
    vec4 ring = vec4(0.0);
    if (lit && uShape == ${SHAPE_ROUND} && uOutlineW > 0.0 && alpha < 1.0) {
      float ringCover = clamp(0.5 - (d - uOutlineW) / aa, 0.0, 1.0) * clamp(d / aa + 1.0, 0.0, 1.0);
      if (ringCover > 0.0) {
        float s = clamp(d / uOutlineW, 0.0, 1.0) * 2.0 - 1.0;   // −1 at the body edge … +1 at the outer edge
        vec3 Nr = normalize(vec3(sdfDir * s * 1.6, 1.0));
        float light = max(dot(Nr, uKey), 0.0) * uKeyI + max(dot(Nr, uFill), 0.0) * uFillI;
        float env = envOf(patternAt(Nr.xy / max(Nr.z, 0.25)));
        vec3 alb = mix(uOutlineColor, linearToSrgb(base), uOutlineBlend);
        ring = vec4(alb * (uOutlineBright * (0.55 + light) + uOutlineReflect * max(env, 0.0)), ringCover);
  #ifdef MERGE
        ring.a *= ms.alpha;
  #endif
      }
    }
  #ifdef GLOW_PASS
    // the 2D look's halo, drawn by a second mesh under the notes
    vec4 glow = shadeSpriteGlow(p, halfSize, r, linearToSrgb(base));
    if (glow.a < 0.003) discard;
    vec3 glowLin = srgbToLinear(glow.rgb);
    gl_FragColor = vec4(uLinearTarget > 0.5 ? glowLin : glow.rgb, glow.a * uOpacity * vAlpha);
    return;
  #endif
    // (the 2D look's outline band may lie outside the body: it discards on its own coverage below)
    if (!sprite && alpha <= 0.0 && ring.a <= 0.0) discard;

    // Fill, linear light. Texture/material functions return JUST the fill —
    // edge is composited below so the user's Edge Color / Intensity are not
    // magnified by the note's Emissive setting.
    vec3 fill;
    float bodyAlpha = 1.0;
    if (sprite) {
      vec4 sp = shadeSprite(p, halfSize, r, linearToSrgb(base));
      if (sp.a < 0.003) discard;
      fill = srgbToLinear(sp.rgb);
      alpha = sp.a;
    } else if (lit) {
      vec3 tint = linearToSrgb(base);
      // cloud field (volume layer); computed up front because it also melts the facets
      float cloudC = 0.0;
      if (uCloud > 0.0 || uCloudClear > 0.0 || uMelt > 0.0) {
        float w = mix(0.04, 0.45, uCloudSoft);   // softness = width of the blob falloff
        cloudC = cloudAt(gC, gS.x, w);
        if (gW1 > 0.0) cloudC = mix(cloudC, cloudAt(gC1, gS1.x, w), gW1);
      }
      // ---- bump (carried by the note): normal map slope, + micro grain for cast metal ----
      // buv = contributor 0's map frame (the realistic maps use it too)
      mat2 bR;
      vec2 buv = noteMapUv(gC, gS.y, uBumpTile, bR);
      // melt: where the cloud is strong (everywhere when there is no cloud)
      // the map is read from a much blurrier mip, so creases dissolve
      float melt = uMelt * ((uCloud > 0.0 || uCloudClear > 0.0) ? cloudC : 1.0);
      vec2 bump = bumpAt(gC, gS.y, uBumpSoft + melt * 4.0);
      // merged: the second contributor's slope, sampled in ITS frame (slopes
      // mix linearly → no seam on the fillet)
      if (gW1 > 0.0) bump = mix(bump, bumpAt(gC1, gS1.y, uBumpSoft + melt * 4.0), gW1);
      // facet edges: faint lines where the UNMELTED map changes facet —
      // baked with the map when it has them (smooth, anti-aliased), else
      // the screen-space derivative of its slope (steps per 2×2 quad)
      float facetEdge = 0.0;
      if (uFacetEdges > 0.0) {
        vec4 bs = texture2D(uBump, buv, uBumpSoft);
        if (uFacetMap > 0.5) {
          // explicit gradients (the map frame's own scale, + the softness
          // bias): merged, buv jumps where contributor 0 changes, and the
          // implicit derivative there would pick the top mip → a grey seam
          float gs = exp2(uBumpSoft) / uBumpTile;
          facetEdge = 1.0 - textureGrad(uBump, buv, bR * dFdx(vWorld) * gs, bR * dFdy(vWorld) * gs).a;
        } else {
          if (uBumpZEnc > 0.5) bs.z = bs.z * 2.0 - 1.0;
          facetEdge = smoothstep(0.03, 0.25, length(fwidth((bs.xy * 2.0 - 1.0) / max(bs.z, 0.3))));
        }
      }
      if (uDetail > 0.0) bump += grainSlope(p / (uUnit * 0.09) + vSeed.y * 64.0) * uDetail;
      bump *= uBumpDepth;
      // ---- surface slope per shape. The shape slope (geo) and the bump
      // slope (bmp) stay apart so bevelReflect scales how much the SHAPE
      // bends the pattern without changing how it catches the lights ----
      vec2 geo, geoB = vec2(0.0), bmp = bump;
      float wB = 0.0;
      if (uShape == ${SHAPE_GEM}) {
        float id, edge, idB; vec3 nB;
        vec3 n = gemFacets(p, halfSize, uBevelW, uBevelD, uRadius, aa, id, edge, nB, idB, wB);
        geo = n.xy / n.z;
        geoB = nB.xy / nB.z;
      } else if (uShape == ${SHAPE_ANGLED}) {
        vec3 n = angledNormal(p, halfSize, uBevelW, uRadius, uBevelD);
        geo = n.xy / n.z;
        bmp = bump * 0.35;
      } else {
        // bevel: slope from the SDF across a band at the edge
        float bw = min(uBevelW, min(halfSize.x, halfSize.y));
        // slope direction from a box rounded by at least the bevel width, so
        // a wide bevel has no mitre seams; the profile follows the silhouette
        float rb = clamp(max(r, bw), 0.0, min(halfSize.x, halfSize.y) - 1e-4);
        float t = clamp(-d / max(bw, 1e-5), 0.0, 1.0);   // 0 at the edge, 1 where the flat top starts
        // profile, 1 at the edge: round = rounded-over (1−t)², steepest at
        // the edge and fading over the band; chamfer = constant slope that
        // rolls into the flat top over the last bevelSoftness of the band
        float roundP = (1.0 - t) * (1.0 - t);
        float chamfer = 1.0 - smoothstep(1.0 - max(uBevelSoft, 1e-3), 1.0, t);
        float rim = mix(roundP, chamfer, uBevelProfile);
  #ifdef MERGE
        geo = (sdfDir * rim + ms.crease) * uBevelD;   // + the legato groove of closed same-key joints
  #else
        geo = sdRoundedBoxDir(p, halfSize, rb) * rim * uBevelD;
  #endif
        bmp = bump * mix(1.0, 0.35, rim);   // the rim keeps its shape under the bump
      }
      vec2 slope = geo + bmp;
      // Pattern anti-aliasing: where the SHAPE slope sweeps the bent lookup
      // across many pattern cells per pixel (a steep narrow rim) the pattern
      // aliases into a bright / dark piping line around the note. There the
      // shape's share of the bend is faded out (the rim reflects what the
      // adjacent body reflects and only catches the lights).
      vec2 bendGeo = uDistort * geo * uBevelReflect;
      float patAA = 1.0 - uRimFade * smoothstep(0.01, 0.05, length(fwidth(bendGeo)));
      vec2 slopeP = slope - geo * (1.0 - uBevelReflect * patAA);
      vec3 col = shadeBody(normalize(vec3(slope, 1.0)), normalize(vec3(slopeP, 1.0)), tint, buv, bodyAlpha);
      if (wB > 0.0) {   // gem crease AA: shade the facet across the crease too and mix the colours
        float alphaB;
        vec3 colB = shadeBody(normalize(vec3(geoB + bmp, 1.0)), normalize(vec3(geoB * uBevelReflect + bmp, 1.0)), tint, buv, alphaB);
        col = mix(col, colB, wB);
        bodyAlpha = mix(bodyAlpha, alphaB, wB);
      }
      // rimShade darkens (> 0) or brightens (< 0) the bevel band along its profile (round shape)
      if (uShape == ${SHAPE_ROUND} && uRimShade != 0.0) col *= 1.0 - uRimShade * clamp(length(geo) / max(uBevelD, 1e-3), 0.0, 1.0);
      // cloudy volume: large soft light blobs inside the glass; between them
      // the body turns see-through by cloudClear
      if (uCloud > 0.0 || uCloudClear > 0.0) {
        col += mix(tint, vec3(1.0), 0.3) * cloudC * uCloud;
        bodyAlpha *= mix(1.0, 0.25 + 0.75 * cloudC, uCloudClear);
      }
      col = max(mix(vec3(dot(col, vec3(0.299, 0.587, 0.114))), col, uSaturation), 0.0);
      // frost veil: a milky layer that lifts the darks and lowers contrast;
      // the satin grain textures it, attenuated where the surface is already
      // bright so it never sparkles
      if (uFrostVeil > 0.0) {
        float gn = uFrostGrain > 0.0 ? vnoise2(p / uFrostTile + 3.7) - 0.5 : 0.0;
        float hot = smoothstep(0.5, 1.0, dot(col, vec3(0.299, 0.587, 0.114)));
        float v = uFrostVeil * 0.35 * (1.0 + uFrostGrain * 1.6 * gn * (1.0 - hot));
        col = mix(col, mix(tint, vec3(1.0), 0.5) * 0.55, clamp(v, 0.0, 1.0));
      }
      // white-hot highlight cores: luminance above the threshold rolls into
      // white (> 1, so Bloom picks it up); a hot core is never see-through
      if (uHighlight > 0.0) {
        float l = dot(col, vec3(0.299, 0.587, 0.114));
        float h = smoothstep(uHighlightThr, uHighlightThr + uHighlightSoft, l);
        col = mix(col, vec3(1.0 + 0.6 * uHighlight), h * h * min(uHighlight, 1.0));
        bodyAlpha = max(bodyAlpha, h * min(uHighlight, 1.0));
      }
      // faint glass edge lines, after the highlight roll so they can never be
      // pushed into white; they fade out on hot areas
      if (facetEdge > 0.0) {
        float lum = dot(col, vec3(0.299, 0.587, 0.114));
        col += mix(tint, vec3(1.0), 0.3) * facetEdge * uFacetEdges * 0.3 * (1.0 - smoothstep(0.35, 0.8, lum));
      }
      // thick glass rim: a bright band at the very edge, then a darker gap
      // just inside it (refraction through a thick edge)
      if (uBandW > 0.0) {
        float e = -d;
        float band = 1.0 - smoothstep(uBandW - aa, uBandW + aa, e);
        float gap = smoothstep(uBandW - aa, uBandW + aa, e) * (1.0 - smoothstep(uBandW + uGapW - aa, uBandW + uGapW + aa, e));
        vec3 bandCol = mix(uBandColor, mix(tint, vec3(1.0), 0.45), uBandBlend);
        col = mix(col, bandCol * uBandBright, band);
        col *= 1.0 - uGapDark * gap;
        bodyAlpha = mix(bodyAlpha, 1.0, band);
      }
      fill = srgbToLinear(clamp(col, 0.0, 4.0));
    } else {
      // Emissive boost feeds Bloom — applies only to the flat fill so edge
      // stays strictly user-controlled via its own Color + Intensity.
      fill = base * (1.0 + uEmissive);
    }

    float edge = smoothstep(uEdgeWidth, 0.0, abs(d));
    vec3 edgeCol = uEdgeColor * edge * uEdgeIntensity;

    vec3 finalColor = fill + edgeCol;

    // Selection treatment. Has to remain perceptible against every
    // possible fill colour AND luminance — a single-colour treatment
    // (white halo, black halo, even adaptive luminance shift) all
    // collapse on certain colours: white halo vanishes on white fills,
    // dark halo on black fills, luminance shift on mid-greys (~#A1A1A1)
    // where neither "brighten" nor "darken" produces meaningful
    // contrast. Three composited layers cover the whole spectrum:
    //   1. Adaptive luminance shift — brighten dark fills, dim bright
    //      fills. Carries most of the cue for high-contrast colours.
    //   2. Soft inner halo with HDR-adaptive accent — feeds Bloom into
    //      a glow when Bloom is on, contributes a subtle tint when off.
    //   3. Dual-edge stroke (bright stripe + dark stripe placed a few
    //      antialiased pixels apart) — guarantees that AT LEAST one
    //      stripe contrasts strongly with the underlying fill no matter
    //      what its luminance is. This is the "always works" layer
    //      that catches grey/mid-tone fills the other layers miss.
    //      Same principle as macOS / Windows focus rings.
    if (vSelected > 0.5) {
  #ifdef MERGE
      float dSel = dOwn;   // the selected note's own box, not the merged blob
  #else
      float dSel = d;
  #endif
      bodyAlpha = 1.0;
      float fillLum = dot(fill, vec3(0.299, 0.587, 0.114));
      float brightT = smoothstep(0.5, 0.7, fillLum);   // 0 dark → 1 bright
      float edgeDepth = min(halfSize.x, halfSize.y) * 0.18;
      float edgeT = smoothstep(-edgeDepth, 0.0, dSel);    // 0 inside → 1 at edge

      // 1. Uniform luminance shift.
      finalColor += fill * (1.0 - brightT);   // up to +1× for very dark fills
      finalColor *= mix(1.0, 0.5, brightT);   // down to ×0.5 for very bright fills

      // 2. Soft inner halo with adaptive accent.
      vec3 accent = mix(vec3(2.0), vec3(0.0), brightT);
      finalColor = mix(finalColor, accent, edgeT * 0.5);

      // 3. Dual-edge stroke. Two parallel ~1px stripes inset from the
      // edge: a bright HDR stripe near the outside, a dark stripe just
      // inside it. Pixel-scale offsets via fwidth keep both stripes a
      // consistent screen width at any zoom.
      float aaW = aa;
      float brightStrokeMid = -aaW * 2.0;
      float darkStrokeMid = -aaW * 5.0;
      float brightMask = 1.0 - smoothstep(aaW * 0.5, aaW * 1.5, abs(dSel - brightStrokeMid));
      float darkMask = 1.0 - smoothstep(aaW * 0.5, aaW * 1.5, abs(dSel - darkStrokeMid));
      finalColor = mix(finalColor, vec3(2.5), brightMask * 0.9);
      finalColor = mix(finalColor, vec3(0.0), darkMask * 0.9);
    }

    // body over the outline ring (the ring shows through the transparent
    // parts and the AA edge), composited in display space like the look
    // maths. The merge's bridge fade is applied once to each layer (the
    // ring's above): fading the composite again would fade the ring twice,
    // but only on the body's AA edge, where the two overlap.
    float bodyA = alpha * bodyAlpha;
  #ifdef MERGE
    bodyA *= ms.alpha;   // bridges about to pinch off fade out
  #endif
    float outA = bodyA + ring.a * (1.0 - bodyA);
    vec3 outColor;
    if (ring.a > 0.0) {
      vec3 disp = (linearToSrgb(finalColor) * bodyA + clamp(ring.rgb, 0.0, 4.0) * ring.a * (1.0 - bodyA)) / max(outA, 1e-5);
      outColor = uLinearTarget > 0.5 ? srgbToLinear(disp) : disp;
    } else {
      outColor = uLinearTarget > 0.5 ? finalColor : linearToSrgb(finalColor);
    }
    gl_FragColor = vec4(outColor, outA * uOpacity * vAlpha);
  }
`

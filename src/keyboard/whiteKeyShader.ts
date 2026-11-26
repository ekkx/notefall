import * as THREE from "three";
import { createGradientUniforms, NOTE_GRADIENT_GLSL } from "../notes/noteColor";
import { KEYBOARD_LAYOUT, KEYBOARD_Y, NOTE_HIT_Y, WHITE_KEY_LENGTH, WHITE_KEY_WIDTH } from "./layout";

// The flash reflection adds `albedo * KEY_FLASH_GAIN * light` (calibrated so the lit back
// half of a key is about as bright as the former raw additive light).
const KEY_FLASH_GAIN = 2.2;

// Static white-key shading (see the color_fragment patch below).
// On-screen (sRGB) brightness of a white key from the back (index 0) to the
// front (last), relative to the back: a steady falloff to ~0.36 over the whole
// length, taken from a reference. The scene light is a little brighter toward
// the front, so this is applied as albedo and compensated by the exponent.
const KEY_PROFILE = [1.0, 0.92, 0.84, 0.77, 0.69, 0.61, 0.51, 0.41, 0.36];
const KEY_PROFILE_GAMMA = 1.3; // sRGB ratio -> albedo ratio (empirical, tone mapping included)
const KEY_SIDE_AO = 0.05; // side darkening over the front part of the key
const KEY_SIDE_AO_BACK = 0.09; // ... and next to the black keys

// Front-shade amount (0 = none, 1 = the full profile): shared by the white-key
// caps and the wood / body materials seen through the gaps, so a gap keeps its
// ratio to the key at every point along it.
export const frontShadeUniform = { value: 1 };
const FRONT_SHADE_GLSL = /* glsl */ `
  uniform float uFrontShade;
  const float KEY_PROFILE[${KEY_PROFILE.length}] = float[](${KEY_PROFILE.map((v) => v.toFixed(3)).join(", ")});
  // ky: 0 at the key's front edge, 1 at its back.
  float frontShadeAt(float ky) {
    float pu = clamp(1.0 - ky, 0.0, 1.0) * ${(KEY_PROFILE.length - 1).toFixed(1)};
    float shade = 1.0;
    for (int pi = 0; pi < ${KEY_PROFILE.length - 1}; pi++) {
      shade += clamp(pu - float(pi), 0.0, 1.0) * (KEY_PROFILE[pi + 1] - KEY_PROFILE[pi]);
    }
    return mix(1.0, pow(shade, ${KEY_PROFILE_GAMMA.toFixed(2)}), uFrontShade);
  }
`;

// Same front darkening for the materials under the caps (wood walls seen
// through the gaps, the dark top, the white front face): by world position
// along the keyboard, no per-key data.
// `darken` < 1 also darkens the material's own colour: used on the wood walls,
// which are only ever seen through the thin gaps between white keys, so they
// read as near-black lines.
export function patchBodyFrontShade(material: THREE.MeshStandardMaterial, darken = 1) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uFrontShade = frontShadeUniform;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying float vKeyY;",
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>\nvKeyY = (modelMatrix * vec4(transformed, 1.0)).y - ${KEYBOARD_Y.toFixed(4)};`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>\nvarying float vKeyY;\n${FRONT_SHADE_GLSL}`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>\ndiffuseColor.rgb *= frontShadeAt(vKeyY / ${WHITE_KEY_LENGTH.toFixed(4)}) * ${darken.toFixed(3)};`,
      );
  };
  material.customProgramCacheKey = () => `white-body-front-shade-${darken}`;
}

// Light of the hit line on the back end of the keys: an additive, steady
// glow in the line's own colour at that x (uses the line shaders' gradient
// GLSL and the uniforms Keyboard.tsx fills from the same resolved settings).
// uHitLight = overall strength (0 = off); the colour is `uHitColor`, or the
// gradient when `uGradient` is on.
// The light acts on the surface: it adds `albedo * tint * strength * GAIN`, so white keys
// brighten toward white and the (near-black) black keys stay black.
const HIT_LIGHT_GAIN = 2.2;
// Share of the line's hue in the light's tint (0 = pure white light, 1 = the raw line colour).
const HIT_LIGHT_HUE = 0.35;
export const hitLightUniforms = {
  uHitLight: { value: 0 },
  uHitReach: { value: 1 }, // distance from the back edge, in white-key lengths
  uHitColor: { value: new THREE.Color() },
  ...createGradientUniforms(NOTE_HIT_Y),
};
const HIT_LIGHT_GLSL = /* glsl */ `
  uniform float uHitLight;
  uniform float uHitReach;
  uniform vec3 uHitColor;
  ${NOTE_GRADIENT_GLSL}
  vec3 hitLightAt(float x, float ky, vec3 albedo) {
    // Smooth fall from the back edge to 0 at the reach.
    float d = clamp((1.0 - ky) / uHitReach, 0.0, 1.0);
    float f = 1.0 - d * d * (3.0 - 2.0 * d);
    f *= f;
    vec3 c = uGradient < 0.5 ? uHitColor : gradientAt(vec2(x, uGradArea.y));
    vec3 tint = mix(vec3(1.0), c / max(max(max(c.r, c.g), c.b), 1e-3), ${HIT_LIGHT_HUE.toFixed(2)});
    return albedo * tint * (uHitLight * ${HIT_LIGHT_GAIN.toFixed(3)} * f);
  }
`;

// Flash → keyboard illumination. The shader treats each active flash as a
// point light at (key.x, WHITE_KEY_LENGTH, LIGHT_Z) projecting every black
// key's 3D box as a shadow on the white-key surface — past each key's front
// tip the silhouette leans and fans out away from the light (more slant the
// further the key is from it).
export const LIGHT_Z = 0.4;
// `exp(-(dx²·X + dy²·Y))`. X dominates so a fragment off to the side dims
// visibly even though the back-edge light is always ≥1 wu in front of it.
// These are the base values the hit lights' settings scale (`hitLightWidth` / `hitLightReach` divide the falloffs by
// their square, `hitLight` scales the strength).
export const LIGHT_FALLOFF_X_BASE = 1.5;
export const LIGHT_FALLOFF_Y_BASE = 1.0;
export const LIGHT_BOOST_BASE = 2.0;
export const SHADOW_HALO_BASE = 0.01;
const SHADOW_FEATHER = 0.005;
// Stretch applied on top of the physical magnification (equivalent to
// lowering the light): at default LIGHT_Z the cast shadow reaches
// ~y=0.1 instead of the physical ~0.26, leaning proportionally more.
const SHADOW_STRETCH = 1.9;
// Penumbra growth along the cast shadow (0=tip, 1=end): added to
// uShadowHalo at the far end so the tail blurs out progressively.
const SHADOW_TAIL_BLUR = 0.01;
// Where along the cast shadow the fade-out toward zero begins.
const SHADOW_FADE_START = 0.8;
// How much the shadow's darkness decays with distance from the light:
// exponent on the light falloff inside the shadow term. 1 = decay at
// the light's own rate (previous behaviour), 0 = no decay (a shadow
// stays fully dark however far the light is), >1 = decay faster.
const SHADOW_DISTANCE_FADE = 0.5;
// Uniform blur added to EVERY shadow boundary (the user-facing halo
// slider's uShadowHalo still adds on top).
const SHADOW_BASE_BLUR = 0.02;
// Lateral blur of the cone's side edges, used in place of
// SHADOW_BASE_BLUR for the x direction only (vertical edges and the
// wall feather keep the base width). Split per edge: NEAR is the
// light-side edge — the crisp silhouette line bordering the bright
// direct-light streak — FAR is the edge away from the light, where
// the penumbra bleeds out.
const SHADOW_NEAR_EDGE_BLUR = 0;
const SHADOW_FAR_EDGE_BLUR = 0.06;
// Width of the straight-down self shadow when the light sits on the
// key itself (pressed black key), as a fraction of the key's width —
// slightly narrower than the key reads more natural than the
// magnified cone the other keys get.
const SHADOW_SELF_WIDTH = 0;
// Curve of the darkness decay across the cone's edges: gamma applied
// to the feathered coverage. 1 = plain smoothstep; >1 = the shadow
// eases in more gradually (longer, softer bleed into the lit area);
// <1 = snappier, harder edge.
const SHADOW_EDGE_GAMMA = 0.3;
// y-feather at a wall's tip line, where the side confinement hands
// over to the cast cone below the key tips.
const SHADOW_WALL_FEATHER_Y = 0.08;
// Fraction of the light absorbed by EACH black-key wall standing
// between the light and the fragment: transmission = (1-a)^walls.
// 0 = walls never dim, 1 = the first counted wall blocks fully.
const SHADOW_WALL_ABSORB = 0.5;
// Walls the light passes for free before SHADOW_WALL_ABSORB starts
// counting. The previous behaviour was FREE=1 with ABSORB=1 (one
// free wall, then a hard block).
const SHADOW_WALL_FREE = 0.0;
// >1.0 pushes the lit-area formula negative inside the silhouette so the
// surface is actively darkened, not just stripped of the additive boost.
const SHADOW_OPACITY = 0.8;
// Per-fragment cost is MAX_LIGHTS × BLACK_KEY_COUNT (= 6 × 36 = 216 ops).
export const MAX_LIGHTS = 6;
// World-unit silhouette growth per unit of per-key glow. Active keys cast
// a thicker shadow than idle ones.
export const ACTIVE_SHADOW_GROW = -0.03;

// Black-key bounds packed flat as (xMin, xMax, yMin, yMax, ...) for a
// single vec4[BLACK_KEY_COUNT] shader uniform. BLACK_KEY_INDICES parallels
// it, mapping each entry back to KEYBOARD_LAYOUT.keys[].
const { BLACK_KEY_BOUNDS, BLACK_KEY_INDICES } = (() => {
  const flat: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < KEYBOARD_LAYOUT.keys.length; i++) {
    const k = KEYBOARD_LAYOUT.keys[i];
    if (!k.isBlack) continue;
    idx.push(i);
    flat.push(
      k.x - k.width / 2,
      k.x + k.width / 2,
      k.yLocal - k.length / 2,
      k.yLocal + k.length / 2,
    );
  }
  return {
    BLACK_KEY_BOUNDS: new Float32Array(flat),
    BLACK_KEY_INDICES: idx,
  };
})();
const BLACK_KEY_COUNT = BLACK_KEY_BOUNDS.length / 4;

export { BLACK_KEY_BOUNDS, BLACK_KEY_INDICES, BLACK_KEY_COUNT };

export type WhiteKeyUniforms = {
  uMeshOriginXY: { value: THREE.Vector2 };
  uLightZ: { value: number };
  uBlackKeyTop: { value: number };
};

export type SharedLightUniforms = {
  uBlackBounds: { value: Float32Array };
  uLightXYs: { value: Float32Array };
  uLightIntensities: { value: Float32Array };
  uLightStrength: { value: number };
  uBlackGlow: { value: Float32Array };
  uActiveShadowGrow: { value: number };
  uLightBoost: { value: number };
  uFalloffX: { value: number };
  uFalloffY: { value: number };
  uShadowHalo: { value: number };
  // Per-slot RGB packed as `[r0, g0, b0, r1, g1, b1, ...]`. Each entry
  // is already the brightness-lerped colour for that slot, so the
  // shader just multiplies it in.
  uLightColors: { value: Float32Array };
};

// Patch MeshStandardMaterial: ADD per-flash light + black-key shadow
// contribution after gl_FragColor has been computed. Standard PBR + the
// emissive glow channel still flow through unchanged.
export function patchWhiteKeyMaterial(
  material: THREE.MeshStandardMaterial,
  perMesh: WhiteKeyUniforms,
  shared: SharedLightUniforms,
) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, perMesh, shared);
    shader.uniforms.uFrontShade = frontShadeUniform;
    Object.assign(shader.uniforms, hitLightUniforms);
    Object.assign(shader.uniforms, hitLightUniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        /* glsl */ `
        #include <common>
        uniform vec2 uMeshOriginXY;
        varying vec2 vGroupXY;
        varying float vLocalX;
        `,
      )
      .replace(
        "#include <begin_vertex>",
        /* glsl */ `
        #include <begin_vertex>
        vGroupXY = uMeshOriginXY + position.xy;
        vLocalX = position.x;
        `,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        /* glsl */ `
        #include <common>
        ${FRONT_SHADE_GLSL}
        ${HIT_LIGHT_GLSL}
        #define BLACK_KEY_COUNT ${BLACK_KEY_COUNT}
        #define MAX_LIGHTS ${MAX_LIGHTS}
        uniform vec4 uBlackBounds[BLACK_KEY_COUNT];
        uniform float uBlackGlow[BLACK_KEY_COUNT];
        uniform vec2 uLightXYs[MAX_LIGHTS];
        uniform float uLightIntensities[MAX_LIGHTS];
        uniform float uLightZ;
        uniform float uBlackKeyTop;
        uniform float uLightStrength;
        uniform float uActiveShadowGrow;
        uniform float uLightBoost;
        uniform float uFalloffX;
        uniform float uFalloffY;
        uniform float uShadowHalo;
        uniform vec3 uLightColors[MAX_LIGHTS];
        varying vec2 vGroupXY;
        varying float vLocalX;

        // Per-key shadow as horizontal slices of the occlusion cone.
        // The light's y coincides with the key ROOTS, so the
        // physically exact umbra has full-width side wings along the
        // whole flank (it read as a wide ghost key); instead each
        // x-edge gets its own magnification ramp toward
        // mTop = lz/(lz - uBlackKeyTop):
        //  - the FAR-from-light edge ramps from the ROOT down to the
        //    shadow's end — a straight slant filling the side wedge
        //    where the key's flank blocks the light;
        //  - the NEAR edge hugs the key down to the TIP, then ramps —
        //    the visible bend starts exactly at the tip and leans
        //    away from the light, more so the further the key is
        //    from it.
        // Both edges meet at the projected tip edge, so the shape
        // stays closed. Returns 1 deep inside, smoothstep-feathered
        // out across HALO.
        float keyShadowAmount(vec4 bounds, vec2 L) {
          float lz = uLightZ;
          if (lz <= uBlackKeyTop) return 0.0;
          float mTop = 1.0
            + (lz / (lz - uBlackKeyTop) - 1.0) * ${SHADOW_STRETCH.toFixed(3)};
          // Bottom of the cast shadow: the tip edge projected at mTop.
          float yBot = L.y + (bounds.z - L.y) * mTop;
          float y = vGroupXY.y;
          // Progress along the cast shadow (0 at the tip, 1 at the
          // end) — drives the near-edge ramp, the tail blur and the
          // fade-out. Zero along the flank, so those stay crisp.
          float p = clamp(
            (bounds.z - y) / max(bounds.z - yBot, 1e-4),
            0.0, 1.0
          );
          // Per-edge magnification ramps, clamped linear in y.
          float mRoot = 1.0 + (mTop - 1.0)
            * clamp((bounds.w - y) / max(bounds.w - yBot, 1e-4), 0.0, 1.0);
          float mTip = 1.0 + (mTop - 1.0) * p;
          bool leftIsNear = abs(bounds.x - L.x) < abs(bounds.y - L.x);
          // A light on the key itself (pressed black key) casts its
          // shadow straight down: no magnification ramps, fixed
          // slightly-narrower-than-the-key width.
          bool selfLit = L.x >= bounds.x && L.x <= bounds.y;
          float xl = L.x + (bounds.x - L.x)
            * (selfLit ? ${SHADOW_SELF_WIDTH.toFixed(3)} : (leftIsNear ? mTip : mRoot));
          float xr = L.x + (bounds.y - L.x)
            * (selfLit ? ${SHADOW_SELF_WIDTH.toFixed(3)} : (leftIsNear ? mRoot : mTip));
          // Anisotropic feather: each x distance is pre-scaled by its
          // own edge's blur width relative to the base width, so the
          // near (light-side) edge stays crisp while the far edge
          // bleeds out; the vertical edges keep the base width.
          float wBase = uShadowHalo + ${SHADOW_BASE_BLUR.toFixed(3)}
            + ${SHADOW_TAIL_BLUR.toFixed(3)} * p;
          float wNear = uShadowHalo + ${SHADOW_NEAR_EDGE_BLUR.toFixed(3)}
            + ${SHADOW_TAIL_BLUR.toFixed(3)} * p;
          float wFar = uShadowHalo + ${SHADOW_FAR_EDGE_BLUR.toFixed(3)}
            + ${SHADOW_TAIL_BLUR.toFixed(3)} * p;
          // The self shadow has no crisp silhouette side — blur BOTH
          // edges with the far width.
          float dxl = (xl - vGroupXY.x) * wBase
            / ((leftIsNear && !selfLit) ? wNear : wFar);
          float dxr = (vGroupXY.x - xr) * wBase
            / ((leftIsNear || selfLit) ? wFar : wNear);
          vec2 q = vec2(
            max(dxl, dxr),
            max(yBot - y, y - bounds.w)
          );
          float sdf = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0);
          float amount = 1.0 - smoothstep(
            -${SHADOW_FEATHER.toFixed(4)},
            wBase,
            sdf
          );
          amount = pow(amount, ${SHADOW_EDGE_GAMMA.toFixed(3)});
          return amount * (1.0 - smoothstep(
            ${SHADOW_FADE_START.toFixed(3)}, 1.0, p
          ));
        }

        // Wall confinement: a black key standing between the light and
        // the fragment blocks the light entirely while the fragment is
        // alongside the key's span (the back "alleys" between black
        // keys stay dark); below the key tips the floor is open and
        // the cast cone above takes over (feathered hand-over across
        // SHADOW_WALL_FEATHER_Y). The light's own key (L.x inside the
        // bounds, i.e. a pressed black key) never walls itself.
        float wallAmount(vec4 b, vec2 L) {
          if (L.x >= b.x && L.x <= b.y) return 0.0;
          float w = uShadowHalo + ${SHADOW_BASE_BLUR.toFixed(3)};
          float past = (L.x > b.y)
            ? 1.0 - smoothstep(b.x - w, b.x + w, vGroupXY.x)
            : smoothstep(b.y - w, b.y + w, vGroupXY.x);
          float along = smoothstep(
            b.z - ${SHADOW_WALL_FEATHER_Y.toFixed(3)},
            b.z + ${SHADOW_WALL_FEATHER_Y.toFixed(3)},
            vGroupXY.y
          );
          return past * along;
        }

        // (Strongest cone shadow, wall count) across all black keys;
        // per-key glow inflates bounds so active keys cast thicker
        // shadows. Walls are SUMMED into a soft count of black keys
        // standing between the light and the fragment; the caller
        // turns it into a per-wall transmission.
        vec2 shadowTerms(vec2 L) {
          vec2 s = vec2(0.0);
          for (int i = 0; i < BLACK_KEY_COUNT; i++) {
            vec4 b = uBlackBounds[i];
            float grow = uActiveShadowGrow * uBlackGlow[i];
            b = vec4(b.x - grow, b.y + grow, b.z - grow, b.w + grow);
            s.x = max(s.x, keyShadowAmount(b, L));
            s.y += wallAmount(b, L);
          }
          return s;
        }
        `,
      )
      .replace(
        // Static key shading, applied to the albedo so the emissive press
        // glow and the additive flash light below stay untouched.
        "#include <color_fragment>",
        /* glsl */ `
        #include <color_fragment>
        {
          float ky = clamp(vGroupXY.y / ${WHITE_KEY_LENGTH.toFixed(4)}, 0.0, 1.0);
          float shade = frontShadeAt(ky);
          // Broad ambient-occlusion-like falloff toward the key sides, a
          // touch stronger in the span the black keys overhang.
          float ex = abs(vLocalX) / ${(WHITE_KEY_WIDTH * 0.49).toFixed(4)};
          float side = smoothstep(0.3, 1.0, ex);
          float aoAmt = uFrontShade * mix(${KEY_SIDE_AO.toFixed(3)}, ${KEY_SIDE_AO_BACK.toFixed(3)}, smoothstep(0.3, 0.45, ky));
          shade *= 1.0 - aoAmt * side * side;
          diffuseColor.rgb *= shade;
        }
        `,
      )
      .replace(
        // r157 renamed <output_fragment> → <opaque_fragment>; using the
        // wrong name silently no-ops the patch (compiles but never runs).
        "#include <opaque_fragment>",
        /* glsl */ `
        #include <opaque_fragment>
        gl_FragColor.rgb += hitLightAt(vGroupXY.x, vGroupXY.y / ${WHITE_KEY_LENGTH.toFixed(4)}, diffuseColor.rgb);
        if (uLightStrength > 0.001) {
          vec3 totalContribution = vec3(0.0);
          for (int li = 0; li < MAX_LIGHTS; li++) {
            float intensity = uLightIntensities[li];
            if (intensity < 0.005) continue;
            vec2 L = uLightXYs[li];
            float dx = vGroupXY.x - L.x;
            float dy = vGroupXY.y - L.y;
            float falloff = exp(
              -dx * dx * uFalloffX
              -dy * dy * uFalloffY
            );
            vec2 sw = shadowTerms(L);
            float shadowFalloff = pow(falloff, ${SHADOW_DISTANCE_FADE.toFixed(3)});
            // Per-wall transmission: each counted wall keeps
            // (1 - ABSORB) of the light. max() guards pow(0, 0)
            // when ABSORB is 1 and no wall is in the way.
            float wallT = pow(
              max(1.0 - ${SHADOW_WALL_ABSORB.toFixed(3)}, 1e-4),
              max(sw.y - ${SHADOW_WALL_FREE.toFixed(3)}, 0.0)
            );
            float effective = intensity * falloff * (
              1.0 - sw.x * shadowFalloff * ${SHADOW_OPACITY.toFixed(3)}
            ) * wallT;
            totalContribution += uLightColors[li] * uLightBoost * uLightStrength * effective;
          }
          // Clamp: protects against stacked shadows crushing to black /
          // dense chords saturating to white.
          // Like the hit-line light, the reflection lights the surface: proportional to the (front-shaded) albedo.
          gl_FragColor.rgb += clamp(totalContribution, vec3(-0.6), vec3(2.5)) * diffuseColor.rgb * ${KEY_FLASH_GAIN.toFixed(2)};
        }
        `,
      );
  };
  // Share one compiled program across all white-key materials.
  material.customProgramCacheKey = () => "white-key-shadow-multi";
}

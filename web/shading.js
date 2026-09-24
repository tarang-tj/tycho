// Shader injection shared by every lit surface in the scene. Adds, on top of
// three.js MeshStandardMaterial:
//   T_SUNMASK  baked terrain self-shadowing (peak shadows), sampled by world xz
//   T_TERRAIN  world-space regolith detail normals + DEM hillshade albedo blend
//   T_CURVE    planetary curvature (surface drops d^2 / 2R from the camera)
//   T_HOLE     discard inside the near-field patch footprint (the patch draws there)
import * as THREE from "three";

export function createSurfaceUniforms() {
  return {
    uSunMask: { value: null },
    uHasSunMask: { value: 0 },
    uDemOrigin: { value: new THREE.Vector2() },
    uDemSize: { value: new THREE.Vector2(1, 1) },
    uDetailA: { value: null },
    uDetailB: { value: null },
    uDetailC: { value: null },
    uTileC: { value: 160 },
    uTileA: { value: 3 },
    uTileB: { value: 24 },
    uDetailStrength: { value: 1 },
    uDetailAlbedo: { value: 0.6 },
    uDemAlbedo: { value: null },
    uHasDemAlbedo: { value: 0 },
    uHsMean: { value: 0.45 },
    uHsStrength: { value: 0.3 },
    uFillMask: { value: null },
    uCurvR: { value: 1737400 },
    uPatchCenter: { value: new THREE.Vector2(1e9, 1e9) },
    uPatchHalf: { value: 0 },
    uDemNormal: { value: null },
  };
}

const VERT_HEAD = /* glsl */ `
varying vec3 vTWorld;
varying vec3 vTNormalW;
#ifdef T_CURVE
uniform float uCurvR;
#endif
`;

const VERT_BODY = /* glsl */ `
vec4 tW = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
tW = instanceMatrix * tW;
#endif
tW = modelMatrix * tW;
vTWorld = tW.xyz;
vTNormalW = normalize((vec4(transformedNormal, 0.0) * viewMatrix).xyz);
#ifdef T_CURVE
vec2 tDc = tW.xz - cameraPosition.xz;
transformed.y -= dot(tDc, tDc) / (2.0 * uCurvR);
#endif
`;

const FRAG_HEAD = /* glsl */ `
varying vec3 vTWorld;
varying vec3 vTNormalW;
uniform vec2 uDemOrigin;
uniform vec2 uDemSize;
#ifdef T_SUNMASK
uniform sampler2D uSunMask;
uniform float uHasSunMask;
#endif
#ifdef T_TERRAIN
uniform sampler2D uDetailA;
uniform sampler2D uDetailB;
uniform sampler2D uDetailC;
uniform float uTileC;
uniform float uTileA;
uniform float uTileB;
uniform float uDetailStrength;
uniform float uDetailAlbedo;
uniform sampler2D uDemAlbedo;
uniform sampler2D uFillMask;
uniform float uHasDemAlbedo;
uniform float uHsMean;
uniform float uHsStrength;
#endif
#ifdef T_DEMNORMAL
uniform sampler2D uDemNormal;
#endif
#ifdef T_HOLE
uniform vec2 uPatchCenter;
uniform float uPatchHalf;
#endif
vec2 tDemUv() { return (vTWorld.xz - uDemOrigin) / uDemSize; }
bool tInDem(vec2 uv) { return uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0; }
#ifdef T_TERRAIN
vec2 tRotB(vec2 p) { return mat2(0.8, -0.6, 0.6, 0.8) * p; }
vec2 tRotC(vec2 p) { return mat2(0.6, -0.8, 0.8, 0.6) * p; }
// Top-down projected detail stretches on steep faces; steep lunar slopes also
// shed small craters, so crater layers fade out above ~25 deg.
float tFlatWeight() {
  float ny = normalize(vTNormalW).y;
  #ifdef T_DEMNORMAL
  vec2 fuv = tDemUv();
  if (tInDem(fuv)) { vec2 nn = texture2D(uDemNormal, fuv).rg; ny = sqrt(max(0.0, 1.0 - dot(nn, nn))); }
  #endif
  return mix(0.35, 1.0, smoothstep(0.62, 0.9, ny));
}
float tMidWeight(float d) { return 1.4 * smoothstep(20.0, 70.0, d) * (1.0 - smoothstep(2500.0, 6000.0, d)); }
#endif
`;

const FRAG_HOLE = /* glsl */ `
#ifdef T_HOLE
vec2 tDp = abs(vTWorld.xz - uPatchCenter);
if (max(tDp.x, tDp.y) < uPatchHalf) discard;
#endif
`;

const FRAG_ALBEDO = /* glsl */ `
#ifdef T_TERRAIN
{
  vec4 dA = texture2D(uDetailA, vTWorld.xz / uTileA);
  vec4 dB = texture2D(uDetailB, tRotB(vTWorld.xz) / uTileB);
  float tFar = smoothstep(120.0, 700.0, distance(vTWorld, cameraPosition));
  vec4 dC = texture2D(uDetailC, tRotC(vTWorld.xz) / uTileC);
  float tFlat = tFlatWeight();
  float alb = 1.0 + ((dA.a - 0.5) * 0.9 + ((dB.a - 0.5) * 1.1 * (1.0 - tFar)
    + (dC.a - 0.5) * 1.2 * tMidWeight(distance(vTWorld, cameraPosition))) * tFlat) * uDetailAlbedo;
  vec2 duv = tDemUv();
  if (uHasDemAlbedo > 0.5 && tInDem(duv)) {
    float hs = texture2D(uDemAlbedo, vec2(duv.x, 1.0 - duv.y)).g;
    float fill = texture2D(uFillMask, duv).r;
    alb *= mix(1.0, clamp(hs / uHsMean, 0.55, 1.6), uHsStrength * (1.0 - fill));
  }
  diffuseColor.rgb *= alb;
}
#endif
`;

const FRAG_NORMAL = /* glsl */ `
#ifdef T_TERRAIN
{
  vec3 nW = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
  #ifdef T_DEMNORMAL
  {
    // Full-resolution DEM shading on the subsampled far mesh.
    vec2 nuv = tDemUv();
    if (tInDem(nuv)) {
      vec2 nn = texture2D(uDemNormal, nuv).rg;
      vec3 dn = vec3(nn.x, sqrt(max(0.0, 1.0 - dot(nn, nn))), nn.y);
      nW = normalize(mix(nW, dn, 1.0 - smoothstep(400.0, 1500.0, distance(vTWorld, cameraPosition))));
    }
  }
  #endif
  vec3 tT = normalize(cross(nW, vec3(0.0, 0.0, 1.0)));
  vec3 tB = cross(tT, nW);
  vec3 dA = texture2D(uDetailA, vTWorld.xz / uTileA).xyz * 2.0 - 1.0;
  vec3 dB = texture2D(uDetailB, tRotB(vTWorld.xz) / uTileB).xyz * 2.0 - 1.0;
  // rotate the B sample's tangent components back into world axes
  dB.xy = mat2(0.8, 0.6, -0.6, 0.8) * dB.xy;
  float tDist = distance(vTWorld, cameraPosition);
  vec3 dC = texture2D(uDetailC, tRotC(vTWorld.xz) / uTileC).xyz * 2.0 - 1.0;
  dC.xy = mat2(0.6, 0.8, -0.8, 0.6) * dC.xy;
  float tFlatN = tFlatWeight();
  vec2 dxy = (dA.xy * (1.0 - smoothstep(20.0, 90.0, tDist))
    + (dB.xy * (1.0 - smoothstep(90.0, 500.0, tDist)) + dC.xy * tMidWeight(tDist)) * tFlatN) * uDetailStrength;
  nW = normalize(tT * dxy.x + tB * dxy.y + nW);
  normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
}
#endif
`;

const FRAG_SUNMASK = /* glsl */ `
#ifdef T_SUNMASK
if (uHasSunMask > 0.5) {
  vec2 muv = tDemUv();
  if (tInDem(muv)) {
    float sunVis = texture2D(uSunMask, muv).r;
    reflectedLight.directDiffuse *= sunVis;
    reflectedLight.directSpecular *= sunVis;
  }
}
#endif
`;

/**
 * Patch a MeshStandardMaterial (or Physical) in place.
 * flags: { sunMask, terrain, curve, hole }
 */
export function injectSurface(material, uniforms, flags = {}) {
  material.defines = { ...(material.defines || {}) };
  if (flags.sunMask !== false) material.defines.T_SUNMASK = "";
  if (flags.terrain) material.defines.T_TERRAIN = "";
  if (flags.curve) material.defines.T_CURVE = "";
  if (flags.hole) material.defines.T_HOLE = "";
  if (flags.demNormal) material.defines.T_DEMNORMAL = "";
  material.onBeforeCompile = (shader) => {
    for (const [key, value] of Object.entries(uniforms)) shader.uniforms[key] = value;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${VERT_HEAD}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${VERT_BODY}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FRAG_HEAD}`)
      .replace("#include <clipping_planes_fragment>", `#include <clipping_planes_fragment>\n${FRAG_HOLE}`)
      .replace("#include <map_fragment>", `#include <map_fragment>\n${FRAG_ALBEDO}`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>\n${FRAG_NORMAL}`)
      .replace("#include <lights_fragment_end>", `#include <lights_fragment_end>\n${FRAG_SUNMASK}`);
  };
  material.customProgramCacheKey = () => `tycho-${Object.keys(material.defines).sort().join(",")}`;
  return material;
}

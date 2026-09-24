// Sky for each body. Moon: black sky, a dense but faint starfield, the Earth
// as a small lit disc (~1.9 deg across, the real apparent size from the
// Moon) roughly 45 deg up toward the north, and the sun's glare. Mars: a
// butterscotch dust sky with the blue halo Mars shows around the sun.
// Everything is parented to a group that follows the camera.
import * as THREE from "three";
import { rng } from "./noise.js";
import { makeEarthTexture, makeSoftSprite } from "./textures.js";

const SKY_R = 90000;

function dirFromAzEl(azDeg, elDeg) {
  // Azimuth measured from north (-z) toward east (+x).
  const az = THREE.MathUtils.degToRad(azDeg);
  const el = THREE.MathUtils.degToRad(elDeg);
  return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
}

function buildStars(count) {
  const r = rng(99);
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const v = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    v.set(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1);
    if (v.lengthSq() > 1 || v.lengthSq() < 1e-4) { i--; continue; }
    v.normalize().multiplyScalar(SKY_R * 0.9);
    pos.set([v.x, v.y, v.z], i * 3);
    const mag = r() ** 6; // most stars faint, a few bright
    const temp = r();
    const c = temp < 0.15 ? [1, 0.82, 0.66] : temp > 0.85 ? [0.72, 0.82, 1] : [1, 0.97, 0.92];
    const b = 0.12 + mag * 0.9;
    col.set([c[0] * b, c[1] * b, c[2] * b], i * 3);
    size[i] = 1.0 + mag * 2.2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setAttribute("size", new THREE.BufferAttribute(size, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uPixelRatio: { value: 1 } },
    vertexShader: `attribute float size; varying vec3 vColor; uniform float uPixelRatio;
      void main() { vColor = color; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_PointSize = size * uPixelRatio; }`,
    fragmentShader: `varying vec3 vColor;
      void main() { vec2 d = gl_PointCoord - 0.5; float a = smoothstep(0.5, 0.0, length(d)); gl_FragColor = vec4(vColor * a, 1.0); }`,
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return points;
}

function glowSprite(texture, color, scale, opacity) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false,
  }));
  s.scale.setScalar(scale);
  return s;
}

const MARS_SKY_FRAG = /* glsl */ `
uniform vec3 uSunDir;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float el = d.y;
  vec3 horizon = vec3(0.80, 0.60, 0.42);
  vec3 zenith = vec3(0.42, 0.30, 0.22);
  vec3 ground = vec3(0.55, 0.40, 0.29);
  vec3 col = el > 0.0 ? mix(horizon, zenith, pow(clamp(el, 0.0, 1.0), 0.55)) : mix(horizon, ground, clamp(-el * 6.0, 0.0, 1.0));
  float cosA = dot(d, normalize(uSunDir));
  float halo = pow(max(cosA, 0.0), 24.0);
  col = mix(col, vec3(0.62, 0.72, 0.86), halo * 0.75);
  col += vec3(1.0, 0.98, 0.95) * pow(max(cosA, 0.0), 900.0) * 3.0;
  col += vec3(0.75, 0.82, 0.95) * pow(max(cosA, 0.0), 120.0) * 0.35;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * Create the sky. Returns { group, sunDir, earthDir, fogColor, update(camera) }.
 * sunDir / earthDir are unit vectors pointing from the ground toward them.
 */
export function createSky(body) {
  const group = new THREE.Group();
  group.renderOrder = -10;
  const sprite = makeSoftSprite();

  if (body === "mars") {
    const sunDir = dirFromAzEl(240, 28);
    const earthDir = dirFromAzEl(95, 30);
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(SKY_R, 48, 24),
      new THREE.ShaderMaterial({
        uniforms: { uSunDir: { value: sunDir } },
        vertexShader: "varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
        fragmentShader: MARS_SKY_FRAG,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
      }),
    );
    dome.renderOrder = -10;
    group.add(dome);
    const sunGlow = glowSprite(sprite, 0xdfe8ff, SKY_R * 0.06, 0.55);
    sunGlow.position.copy(sunDir).multiplyScalar(SKY_R * 0.85);
    group.add(sunGlow);
    return {
      group, sunDir, earthDir,
      fogColor: new THREE.Color(0.74, 0.55, 0.39),
      update(camera) { group.position.copy(camera.position); },
      setPixelRatio() {},
      dispose() { dome.geometry.dispose(); dome.material.dispose(); sprite.dispose(); },
    };
  }

  // Moon. Tycho sits near 43 S, 11 W: the Earth hangs roughly 45 deg up,
  // slightly east of north. The sun is low in the west-northwest.
  const sunDir = dirFromAzEl(284, 12);
  const earthDir = dirFromAzEl(14, 45);
  const stars = buildStars(9000);
  group.add(stars);

  const earthDist = SKY_R * 0.7;
  const earthRadius = earthDist * Math.tan(THREE.MathUtils.degToRad(0.95));
  const earthTex = makeEarthTexture();
  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(earthRadius, 48, 32),
    new THREE.MeshStandardMaterial({ map: earthTex, roughness: 0.85, metalness: 0, color: 0xffffff, fog: false }),
  );
  earth.position.copy(earthDir).multiplyScalar(earthDist);
  earth.rotation.set(0.41, 2.2, 0.1);
  group.add(earth);
  const atmo = glowSprite(sprite, 0x6fa8ff, earthRadius * 3.1, 0.22);
  atmo.position.copy(earth.position);
  group.add(atmo);

  const sunGlow = glowSprite(sprite, 0xfff6e8, SKY_R * 0.05, 0.9);
  sunGlow.position.copy(sunDir).multiplyScalar(SKY_R * 0.85);
  const sunDisc = glowSprite(sprite, 0xffffff, SKY_R * 0.012, 1);
  sunDisc.position.copy(sunGlow.position);
  group.add(sunGlow, sunDisc);

  return {
    group, sunDir, earthDir, fogColor: null,
    earthWorldPos: (camera) => earth.position.clone().add(camera.position),
    update(camera) { group.position.copy(camera.position); },
    setPixelRatio(pr) { stars.material.uniforms.uPixelRatio.value = pr; },
    dispose() {
      stars.geometry.dispose(); stars.material.dispose(); earth.geometry.dispose(); earth.material.dispose();
      earthTex.dispose(); sprite.dispose();
    },
  };
}

const ENV_FRAG = /* glsl */ `
uniform vec3 uSunDir; uniform vec3 uUp; uniform vec3 uHorizon; uniform vec3 uGround; uniform float uSun;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  vec3 col = d.y > 0.0 ? mix(uHorizon, uUp, clamp(d.y * 2.5, 0.0, 1.0)) : mix(uHorizon, uGround, clamp(-d.y * 4.0, 0.0, 1.0));
  col += vec3(1.0, 0.97, 0.9) * pow(max(dot(d, normalize(uSunDir)), 0.0), 600.0) * uSun;
  gl_FragColor = vec4(col, 1.0);
}`;

/** Prefiltered environment for image-based light: sky above, sunlit ground below, a sun glint. */
export function makeEnvironment(renderer, body, sunDir) {
  const mars = body === "mars";
  const scene = new THREE.Scene();
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uSunDir: { value: sunDir },
      uUp: { value: mars ? new THREE.Color(0.3, 0.2, 0.14) : new THREE.Color(0, 0, 0) },
      uHorizon: { value: mars ? new THREE.Color(0.62, 0.42, 0.27) : new THREE.Color(0.05, 0.05, 0.05) },
      uGround: { value: mars ? new THREE.Color(0.3, 0.17, 0.1) : new THREE.Color(0.19, 0.19, 0.185) },
      uSun: { value: mars ? 12 : 30 },
    },
    vertexShader: "varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: ENV_FRAG,
    side: THREE.BackSide,
  });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 64, 32), mat));
  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(scene, 0.01);
  pmrem.dispose();
  mat.dispose();
  return target;
}

// Things the rover leaves on the ground: wheel tracks (grouser imprints that
// stay where you drove) and dust kicked up by the wheels (ballistic on the
// airless Moon, drifting and lingering on Mars).
import * as THREE from "three";
import { injectSurface } from "./shading.js";
import { makeTrackTexture } from "./textures.js";

const MAX_POINTS = 1600;
const TRACK_W = 0.15;

function createTrack(material) {
  const positions = new Float32Array(MAX_POINTS * 2 * 3);
  const uvs = new Float32Array(MAX_POINTS * 2 * 2);
  const normals = new Float32Array(MAX_POINTS * 2 * 3);
  const index = new Uint32Array((MAX_POINTS - 1) * 6);
  for (let i = 0; i < MAX_POINTS - 1; i++) {
    const a = i * 2;
    index.set([a, a + 2, a + 1, a + 2, a + 3, a + 1], i * 6);
  }
  for (let i = 0; i < MAX_POINTS * 2; i++) normals[i * 3 + 1] = 1;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.setDrawRange(0, 0);
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.renderOrder = 1;
  return { mesh, geo, pts: [], dist: 0 };
}

export function createTracks({ uniforms, color }) {
  const material = injectSurface(new THREE.MeshStandardMaterial({
    color, map: makeTrackTexture(), transparent: true, opacity: 0.8, roughness: 1,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  }), uniforms, {});
  const tracks = [createTrack(material), createTrack(material)];
  const group = new THREE.Group();
  for (const t of tracks) group.add(t.mesh);

  function write(t, groundAt, from = 0) {
    const pos = t.geo.attributes.position.array;
    const uv = t.geo.attributes.uv.array;
    const n = t.pts.length;
    for (let i = Math.max(0, from); i < n; i++) {
      const p = t.pts[i];
      const prev = t.pts[Math.max(0, i - 1)];
      const next = t.pts[Math.min(n - 1, i + 1)];
      let dx = next.x - prev.x, dz = next.z - prev.z;
      const len = Math.hypot(dx, dz) || 1;
      dx /= len; dz /= len;
      const ox = -dz * TRACK_W / 2, oz = dx * TRACK_W / 2;
      const yl = groundAt(p.x + ox, p.z + oz) + 0.012;
      const yr = groundAt(p.x - ox, p.z - oz) + 0.012;
      pos.set([p.x + ox, yl, p.z + oz, p.x - ox, yr, p.z - oz], i * 6);
      uv.set([0, p.d / 0.5, 1, p.d / 0.5], i * 4);
    }
    t.geo.attributes.position.needsUpdate = true;
    t.geo.attributes.uv.needsUpdate = true;
    t.geo.setDrawRange(0, Math.max(0, (n - 1) * 6));
  }

  return {
    group,
    /** contacts: [{x, z}, {x, z}] wheel contact points (left, right). */
    add(contacts, groundAt) {
      contacts.forEach((c, i) => {
        const t = tracks[i];
        const last = t.pts[t.pts.length - 1];
        if (last && Math.hypot(c.x - last.x, c.z - last.z) > 4) { t.pts.length = 0; t.dist = 0; }
        if (last && t.pts.length && Math.hypot(c.x - last.x, c.z - last.z) < 0.18) return;
        if (last) t.dist += Math.hypot(c.x - last.x, c.z - last.z);
        t.pts.push({ x: c.x, z: c.z, d: t.dist });
        if (t.pts.length >= MAX_POINTS) { t.pts.splice(0, 300); write(t, groundAt); return; }
        if (t.pts.length > 1) write(t, groundAt, t.pts.length - 2);
      });
    },
    redrape(groundAt) { for (const t of tracks) if (t.pts.length > 1) write(t, groundAt); },
    clear() { for (const t of tracks) { t.pts.length = 0; t.geo.setDrawRange(0, 0); } },
    dispose() { for (const t of tracks) t.geo.dispose(); material.map.dispose(); material.dispose(); },
  };
}

const DUST_MAX = 500;

export function createDust({ body, sprite, color }) {
  const mars = body === "mars";
  const gravity = mars ? 3.71 : 1.62;
  const pos = new Float32Array(DUST_MAX * 3);
  const alpha = new Float32Array(DUST_MAX);
  const size = new Float32Array(DUST_MAX);
  const vel = new Float32Array(DUST_MAX * 3);
  const life = new Float32Array(DUST_MAX);
  const maxLife = new Float32Array(DUST_MAX);
  let cursor = 0;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute("aAlpha", new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute("aSize", new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uMap: { value: sprite }, uColor: { value: new THREE.Color(color) }, uScale: { value: 600 } },
    vertexShader: `attribute float aAlpha; attribute float aSize; varying float vA; uniform float uScale;
      void main() { vA = aAlpha; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; gl_PointSize = aSize * uScale / -mv.z; }`,
    fragmentShader: `uniform sampler2D uMap; uniform vec3 uColor; varying float vA;
      void main() { float a = texture2D(uMap, gl_PointCoord).r * vA; if (a < 0.01) discard; gl_FragColor = vec4(uColor, a);
      #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;

  return {
    points,
    setViewportHeight(px) { mat.uniforms.uScale.value = px * 0.9; },
    emit(x, y, z, heading, speed, dt) {
      const rate = Math.min(1, Math.abs(speed) / 2) * (mars ? 90 : 55);
      let n = rate * dt;
      while (n > 0) {
        if (n < 1 && Math.random() > n) break;
        n -= 1;
        const i = cursor;
        cursor = (cursor + 1) % DUST_MAX;
        const back = -Math.sign(speed || 1);
        const spread = (Math.random() - 0.5) * 0.8;
        pos.set([x + (Math.random() - 0.5) * 0.1, y + 0.02, z + (Math.random() - 0.5) * 0.1], i * 3);
        const vx = Math.sin(heading + spread) * back * (0.4 + Math.random() * 0.8) * Math.abs(speed) * 0.5;
        const vz = Math.cos(heading + spread) * back * (0.4 + Math.random() * 0.8) * Math.abs(speed) * 0.5;
        vel.set([vx, 0.5 + Math.random() * 1.1, vz], i * 3);
        maxLife[i] = mars ? 1.8 + Math.random() * 2.2 : 0.7 + Math.random() * 0.5;
        life[i] = maxLife[i];
        size[i] = mars ? 0.06 : 0.035;
      }
    },
    update(dt, groundAt) {
      for (let i = 0; i < DUST_MAX; i++) {
        if (life[i] <= 0) { alpha[i] = 0; continue; }
        life[i] -= dt;
        const k = i * 3;
        vel[k + 1] -= gravity * dt;
        if (mars) {
          vel[k] = vel[k] * (1 - 1.6 * dt) + 0.35 * dt;
          vel[k + 1] *= 1 - 1.2 * dt;
          vel[k + 2] *= 1 - 1.6 * dt;
          size[i] += dt * 0.12;
        }
        pos[k] += vel[k] * dt; pos[k + 1] += vel[k + 1] * dt; pos[k + 2] += vel[k + 2] * dt;
        const g = groundAt(pos[k], pos[k + 2]);
        if (pos[k + 1] < g) { pos[k + 1] = g; vel[k] *= 0.3; vel[k + 1] = 0; vel[k + 2] *= 0.3; if (!mars) life[i] = Math.min(life[i], 0.08); }
        const t = life[i] / maxLife[i];
        alpha[i] = (mars ? 0.35 : 0.5) * Math.min(1, t * 2.5) * Math.min(1, (1 - t) * 8 + 0.2);
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.aAlpha.needsUpdate = true;
      geo.attributes.aSize.needsUpdate = true;
    },
    dispose() { geo.dispose(); mat.dispose(); },
  };
}

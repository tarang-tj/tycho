// Near-field ground around the rover: a fine (0.6 m) patch that carries the
// DEM plus world-anchored micro-relief (small craters, undulation), and
// instanced boulders. Re-centres as the rover drives; the far DEM mesh
// discards fragments under it. groundAt() is the single source of truth for
// "where is the visible ground", used by the rover's wheels, tracks, markers.
import * as THREE from "three";
import { hash2, rng, valueNoise } from "./noise.js";
import { microRelief } from "./terrain-field.js";
import { makeRockTexture } from "./textures.js";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { injectSurface } from "./shading.js";

const SIZE = 150;
const N = 251; // 0.6 m spacing
const SPACING = SIZE / (N - 1);

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function makeRockGeometry(seed, detail, boulder) {
  let geo = new THREE.IcosahedronGeometry(1, detail);
  if (boulder) {
    // Shared vertices so the cut faces meet in slightly weathered edges
    // instead of a faceted gem; uv regenerated below for the rock texture.
    geo.deleteAttribute("normal");
    geo.deleteAttribute("uv");
    geo = mergeVertices(geo);
  }
  const pos = geo.attributes.position;
  const r = rng(seed);
  const planes = Array.from({ length: boulder ? 15 : 7 }, () => {
    const n = new THREE.Vector3(r() - 0.5, (r() - 0.3) * 1.1, r() - 0.5).normalize();
    return { n, off: boulder ? 0.48 + r() * 0.38 : 0.55 + r() * 0.35 };
  });
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    let s = 1;
    for (const p of planes) {
      const d = v.dot(p.n);
      if (d > 0.05) s = Math.min(s, p.off / d);
    }
    s *= 1 + 0.07 * valueNoise(v.x * 3 + v.z * 2 + seed, v.y * 3 + seed, seed)
      + (boulder ? 0.035 * valueNoise(v.x * 9 + v.z * 7, v.y * 9 - v.x * 3, seed + 1) : 0);
    v.multiplyScalar(s);
    if (v.y < -0.3) v.y = -0.3 + (v.y + 0.3) * 0.25;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  if (boulder) {
    const uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) { uv[i * 2] = pos.getX(i) + pos.getZ(i) * 0.7; uv[i * 2 + 1] = pos.getY(i) - pos.getZ(i) * 0.3; }
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  }
  return geo;
}

export function createNearField({ field, body, uniforms, groundColor, rockColor }) {
  const micro = microRelief(body);
  let cx = 1e9, cz = 1e9;
  const exclusions = [];

  const fadeAt = (x, z) => 1 - smoothstep(SIZE * 0.3, SIZE * 0.46, Math.max(Math.abs(x - cx), Math.abs(z - cz)));
  // Inside the fade band the ground eases from the full-resolution DEM (plus
  // micro-relief) onto the far mesh's own triangles, so the patch edge meets
  // the far mesh exactly even when the far mesh is subsampled.
  const groundAt = (x, z) => {
    const f = fadeAt(x, z);
    if (!field.inDem(x, z)) return field.outerAt(x, z) + micro(x, z) * f;
    const fine = f > 0 ? field.demAt(x, z) + micro(x, z) : 0;
    if (f >= 1) return fine;
    return field.meshAt(x, z) * (1 - f) + fine * f;
  };

  const positions = new Float32Array(N * N * 3);
  const normals = new Float32Array(N * N * 3);
  const indices = new Uint32Array((N - 1) * (N - 1) * 6);
  let k = 0;
  for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
    const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
    indices[k++] = a; indices[k++] = c; indices[k++] = b;
    indices[k++] = b; indices[k++] = c; indices[k++] = d;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  const mat = injectSurface(new THREE.MeshStandardMaterial({ color: groundColor, roughness: 0.97, metalness: 0 }), uniforms, { terrain: true });
  const patch = new THREE.Mesh(geo, mat);
  patch.receiveShadow = true;
  patch.castShadow = true;
  patch.frustumCulled = false;

  const rockMat = injectSurface(new THREE.MeshStandardMaterial({ color: rockColor, roughness: 0.92, flatShading: true }), uniforms, {});
  const rockTex = makeRockTexture(body);
  const boulderMat = injectSurface(new THREE.MeshStandardMaterial({ color: rockColor, map: rockTex, roughness: 0.9 }), uniforms, {});
  rockMat.map = rockTex;
  const makeInstanced = (geo, material, max) => {
    const m = new THREE.InstancedMesh(geo, material, max);
    m.castShadow = true;
    m.receiveShadow = true;
    m.frustumCulled = false;
    m.count = 0;
    m.userData.max = max;
    return m;
  };
  const smallRocks = [11, 23, 37].map((seed) => makeInstanced(makeRockGeometry(seed, 1, false), rockMat, 700));
  const boulders = [5, 17].map((seed) => makeInstanced(makeRockGeometry(seed, 3, true), boulderMat, 80));
  const rockMeshes = [...smallRocks, ...boulders];

  const group = new THREE.Group();
  group.add(patch, ...rockMeshes);

  function rebuildPatch() {
    const heights = new Float32Array(N * N);
    const ox = cx - SIZE / 2, oz = cz - SIZE / 2;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = ox + i * SPACING, z = oz + j * SPACING;
      const y = groundAt(x, z);
      heights[j * N + i] = y;
      positions.set([x, y, z], (j * N + i) * 3);
    }
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const il = Math.max(0, i - 1), ir = Math.min(N - 1, i + 1);
      const jd = Math.max(0, j - 1), ju = Math.min(N - 1, j + 1);
      const dx = (heights[j * N + ir] - heights[j * N + il]) / ((ir - il) * SPACING);
      const dz = (heights[ju * N + i] - heights[jd * N + i]) / ((ju - jd) * SPACING);
      const len = Math.hypot(dx, 1, dz);
      normals.set([-dx / len, 1 / len, -dz / len], (j * N + i) * 3);
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.normal.needsUpdate = true;
    geo.computeBoundingSphere();
    uniforms.uPatchCenter.value.set(cx, cz);
    uniforms.uPatchHalf.value = SIZE / 2 - 0.8;
  }

  const dummy = new THREE.Object3D();
  function placeRock(x, z, size, seed) {
    if (Math.max(Math.abs(x - cx), Math.abs(z - cz)) > SIZE * 0.4) return;
    for (const e of exclusions) if (size > 0.25 && Math.hypot(x - e.x, z - e.z) < e.r) return;
    const pool = size > 0.45 ? boulders : smallRocks;
    const mesh = pool[Math.floor(hash2(seed, 3, 91) * pool.length)];
    if (mesh.count >= mesh.userData.max) return;
    const sy = size * (0.5 + hash2(seed, 4, 91) * 0.45);
    dummy.position.set(x, groundAt(x, z) - sy * 0.22, z);
    dummy.rotation.set((hash2(seed, 5, 91) - 0.5) * 0.4, hash2(seed, 6, 91) * Math.PI * 2, (hash2(seed, 7, 91) - 0.5) * 0.4);
    dummy.scale.set(size * (0.8 + hash2(seed, 8, 91) * 0.5), sy, size * (0.8 + hash2(seed, 9, 91) * 0.5));
    dummy.updateMatrix();
    mesh.setMatrixAt(mesh.count++, dummy.matrix);
  }

  function rebuildRocks() {
    for (const m of rockMeshes) m.count = 0;
    const reach = SIZE * 0.4;
    const pSmall = body === "mars" ? 0.42 : 0.3;
    const small = 2.2;
    for (let iz = Math.floor((cz - reach) / small); iz <= Math.floor((cz + reach) / small); iz++) {
      for (let ix = Math.floor((cx - reach) / small); ix <= Math.floor((cx + reach) / small); ix++) {
        if (hash2(ix, iz, 71) > pSmall) continue;
        const size = 0.05 + 0.42 * hash2(ix, iz, 72) ** 3;
        placeRock((ix + hash2(ix, iz, 73)) * small, (iz + hash2(ix, iz, 74)) * small, size, ix * 7919 + iz);
      }
    }
    const big = 13;
    for (let iz = Math.floor((cz - reach) / big); iz <= Math.floor((cz + reach) / big); iz++) {
      for (let ix = Math.floor((cx - reach) / big); ix <= Math.floor((cx + reach) / big); ix++) {
        if (hash2(ix, iz, 81) > 0.16) continue;
        const size = 0.5 + 1.1 * hash2(ix, iz, 82) ** 2.5;
        placeRock((ix + hash2(ix, iz, 83)) * big, (iz + hash2(ix, iz, 84)) * big, size, ix * 104729 + iz * 31 + 5);
      }
    }
    for (const m of rockMeshes) m.instanceMatrix.needsUpdate = true;
  }

  /** Keep the patch under the given world point; rebuild when it has drifted. Returns true if rebuilt. */
  function follow(x, z, force = false) {
    const snap = SPACING * 10;
    if (!force && Math.max(Math.abs(x - cx), Math.abs(z - cz)) < SIZE * 0.14) return false;
    cx = Math.round(x / snap) * snap;
    cz = Math.round(z / snap) * snap;
    rebuildPatch();
    rebuildRocks();
    return true;
  }

  return {
    group,
    groundAt,
    follow,
    addExclusion: (x, z, r) => exclusions.push({ x, z, r }),
    center: () => ({ x: cx, z: cz }),
    dispose() {
      geo.dispose(); mat.dispose(); rockMat.dispose(); boulderMat.dispose();
      for (const m of rockMeshes) m.geometry.dispose();
    },
  };
}

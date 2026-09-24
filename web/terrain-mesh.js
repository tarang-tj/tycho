// Far-field terrain geometry: the full-resolution DEM mesh (one vertex per
// DEM pixel), an edge skirt, and two coarser rings of procedural
// surroundings out to the horizon. Plus a GPU bake of terrain self-shadowing.
import * as THREE from "three";

function finishGeometry(positions, normals, indices) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeBoundingSphere();
  return geo;
}

/** DEM mesh with analytic normals from central differences. `step` subsamples (1 = every pixel). */
export function buildDemGeometry(field, step = 1) {
  const { W, H, cell, x0, z0, heights } = field;
  const { xs, ys } = field.setMeshStep(step);
  const nx = xs.length;
  const nz = ys.length;
  const positions = new Float32Array(nx * nz * 3);
  const normals = new Float32Array(nx * nz * 3);
  const h = (x, y) => heights[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))];
  for (let j = 0; j < nz; j++) {
    const py = ys[j];
    for (let i = 0; i < nx; i++) {
      const px = xs[i];
      const k = (j * nx + i) * 3;
      positions[k] = x0 + px * cell;
      positions[k + 1] = h(px, py);
      positions[k + 2] = z0 + py * cell;
      const dx = (h(px + step, py) - h(px - step, py)) / (2 * step * cell);
      const dz = (h(px, py + step) - h(px, py - step)) / (2 * step * cell);
      const len = Math.hypot(dx, 1, dz);
      normals[k] = -dx / len;
      normals[k + 1] = 1 / len;
      normals[k + 2] = -dz / len;
    }
  }
  const indices = new Uint32Array((nx - 1) * (nz - 1) * 6);
  let n = 0;
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      indices[n++] = a; indices[n++] = c; indices[n++] = b;
      indices[n++] = b; indices[n++] = c; indices[n++] = d;
    }
  }
  return finishGeometry(positions, normals, indices);
}

/** Vertical skirt hanging from the DEM edge, hiding T-junction cracks against the outer ring. */
export function buildSkirtGeometry(field, drop = 40, step = 1) {
  const { W, H, cell, x0, z0, heights } = field;
  const xs = [];
  for (let v = 0; v < W - 1; v += step) xs.push(v);
  xs.push(W - 1);
  const ys = [];
  for (let v = 0; v < H - 1; v += step) ys.push(v);
  ys.push(H - 1);
  const edge = [];
  for (const x of xs) edge.push([x, 0, 0, -1]);
  for (const y of ys) edge.push([W - 1, y, 1, 0]);
  for (const x of [...xs].reverse()) edge.push([x, H - 1, 0, 1]);
  for (const y of [...ys].reverse()) edge.push([0, y, -1, 0]);
  const positions = new Float32Array(edge.length * 6);
  const normals = new Float32Array(edge.length * 6);
  edge.forEach(([px, py, onx, onz], i) => {
    const x = x0 + px * cell, z = z0 + py * cell, y = heights[py * W + px];
    positions.set([x, y, z, x, y - drop, z], i * 6);
    normals.set([onx * 0.3, 0.95, onz * 0.3, onx * 0.3, 0.95, onz * 0.3], i * 6);
  });
  const indices = new Uint32Array((edge.length - 1) * 6);
  for (let i = 0; i < edge.length - 1; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    indices.set([a, b, c, c, b, d], i * 6);
  }
  return finishGeometry(positions, normals, indices);
}

function axisCoords(min, max, spacing, holeMin, holeMax) {
  const set = new Set([min, max, holeMin, holeMax]);
  for (let v = Math.ceil(min / spacing) * spacing; v <= max; v += spacing) set.add(v);
  return [...set].sort((a, b) => a - b);
}

/**
 * A square ring of terrain in DEM-pixel space: covers [holeMin - extent, holeMax + extent]
 * minus the hole. Heights come from field.outerAt (which returns DEM heights inside the tile).
 */
export function buildRingGeometry(field, { spacingPx, extentPx, holeMinX, holeMaxX, holeMinY, holeMaxY, innerStepPx }) {
  const xs = axisCoords(holeMinX - extentPx, holeMaxX + extentPx, spacingPx, holeMinX, holeMaxX);
  const ys = axisCoords(holeMinY - extentPx, holeMaxY + extentPx, spacingPx, holeMinY, holeMaxY);
  const nx = xs.length, nz = ys.length;
  const positions = new Float32Array(nx * nz * 3);
  const hgrid = new Float32Array(nx * nz);
  // On the hole boundary, sit at the MIN of the finer inner edge across this
  // vertex's span, so the ring never pokes above the inner mesh's edge: any
  // crack then opens downward, where the inner skirt covers it.
  const onEdge = (px, py) => px >= holeMinX && px <= holeMaxX && py >= holeMinY && py <= holeMaxY
    && (px === holeMinX || px === holeMaxX || py === holeMinY || py === holeMaxY);
  function boundaryMin(px, py) {
    let m = Infinity;
    const alongX = py === holeMinY || py === holeMaxY;
    const c = alongX ? px : py;
    const lo = alongX ? holeMinX : holeMinY;
    const hi = alongX ? holeMaxX : holeMaxY;
    for (let v = Math.max(lo, c - spacingPx); v <= Math.min(hi, c + spacingPx); v += innerStepPx) {
      const w = alongX ? field.pxToWorld(v, py) : field.pxToWorld(px, v);
      m = Math.min(m, field.outerAt(w.x, w.z));
    }
    return m;
  }
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const { x, z } = field.pxToWorld(xs[i], ys[j]);
      const y = innerStepPx && onEdge(xs[i], ys[j]) ? boundaryMin(xs[i], ys[j]) - 0.3 : field.outerAt(x, z);
      hgrid[j * nx + i] = y;
      positions.set([x, y, z], (j * nx + i) * 3);
    }
  }
  const normals = new Float32Array(nx * nz * 3);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const il = Math.max(0, i - 1), ir = Math.min(nx - 1, i + 1);
      const jd = Math.max(0, j - 1), ju = Math.min(nz - 1, j + 1);
      const dx = (hgrid[j * nx + ir] - hgrid[j * nx + il]) / ((xs[ir] - xs[il]) * field.cell);
      const dz = (hgrid[ju * nx + i] - hgrid[jd * nx + i]) / ((ys[ju] - ys[jd]) * field.cell);
      const len = Math.hypot(dx, 1, dz);
      normals.set([-dx / len, 1 / len, -dz / len], (j * nx + i) * 3);
    }
  }
  const idx = [];
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const inside = xs[i] >= holeMinX && xs[i + 1] <= holeMaxX && ys[j] >= holeMinY && ys[j + 1] <= holeMaxY;
      if (inside) continue;
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  return finishGeometry(positions, normals, new Uint32Array(idx));
}

const BAKE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uH;
uniform vec2 uRes;
uniform vec2 uSunXZ;
uniform float uCell;
uniform float uElev;
uniform float uSpread;
varying vec2 vUv;
float hAt(vec2 p) { return texture2D(uH, (p + 0.5) / uRes).r; }
void main() {
  vec2 p = vUv * uRes - 0.5;
  float h0 = hAt(p) + 0.4;
  float maxAng = -1.5;
  float t = 0.75;
  for (int i = 0; i < 180; i++) {
    vec2 q = p + uSunXZ * t;
    if (q.x < 0.0 || q.y < 0.0 || q.x > uRes.x - 1.0 || q.y > uRes.y - 1.0) break;
    maxAng = max(maxAng, atan(hAt(q) - h0, t * uCell));
    t += max(0.75, t * 0.035);
  }
  float vis = clamp((uElev - maxAng) / uSpread + 0.5, 0.0, 1.0);
  gl_FragColor = vec4(vis, vis, vis, 1.0);
}
`;

/** Render terrain self-shadowing toward the sun into a DEM-sized texture (1 = lit). */
export function bakeSunMask(renderer, field, sunDir, spreadDeg) {
  const { W, H, heights, cell } = field;
  const hTex = new THREE.DataTexture(heights, W, H, THREE.RedFormat, THREE.FloatType);
  hTex.magFilter = hTex.minFilter = THREE.LinearFilter;
  hTex.needsUpdate = true;
  const target = new THREE.WebGLRenderTarget(W, H, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
  const sunXZ = new THREE.Vector2(sunDir.x, sunDir.z).normalize();
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uH: { value: hTex },
      uRes: { value: new THREE.Vector2(W, H) },
      uSunXZ: { value: sunXZ },
      uCell: { value: cell },
      uElev: { value: Math.asin(sunDir.y / sunDir.length()) },
      uSpread: { value: THREE.MathUtils.degToRad(spreadDeg) },
    },
    vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
    fragmentShader: BAKE_FRAG,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  const bakeScene = new THREE.Scene();
  bakeScene.add(quad);
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.render(bakeScene, new THREE.Camera());
  renderer.setRenderTarget(prev);
  quad.geometry.dispose();
  mat.dispose();
  hTex.dispose();
  return target;
}

/** World-space DEM normals (x, z in RG, half float) at full DEM resolution. */
export function buildDemNormalTexture(field) {
  const { W, H, cell, heights } = field;
  const data = new Uint16Array(W * H * 2);
  const h = (x, y) => heights[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (h(x + 1, y) - h(x - 1, y)) / (2 * cell);
      const dz = (h(x, y + 1) - h(x, y - 1)) / (2 * cell);
      const len = Math.hypot(dx, 1, dz);
      data[(y * W + x) * 2] = THREE.DataUtils.toHalfFloat(-dx / len);
      data[(y * W + x) * 2 + 1] = THREE.DataUtils.toHalfFloat(-dz / len);
    }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGFormat, THREE.HalfFloatType);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

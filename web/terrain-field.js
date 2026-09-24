// Render-side height field: the DEM resampled to a grid, with no-data fill
// regions (flat row/column streaks left by the DTM crop) detected and
// re-filled smoothly so they don't render as stripes. Also provides the
// procedural surroundings beyond the DEM tile and the near-field micro-relief.
// The simulation keeps using the raw terrain-data module; this is visual only.
import { fbm, hash2 } from "./noise.js";

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function markRuns(values, W, H, mask, horizontal, minRun = 6) {
  const outer = horizontal ? H : W;
  const inner = horizontal ? W : H;
  const idx = (o, i) => (horizontal ? o * W + i : i * W + o);
  for (let o = 0; o < outer; o++) {
    let start = 0;
    for (let i = 1; i <= inner; i++) {
      if (i < inner && values[idx(o, i)] === values[idx(o, start)]) continue;
      if (i - start >= minRun) for (let k = start; k < i; k++) mask[idx(o, k)] = 1;
      start = i;
    }
  }
}

/** Push-pull fill: masked pixels take a smooth blend of valid neighbours at every scale. */
function pushPull(values, mask, W, H) {
  const levels = [];
  let w = W, h = H;
  let v = new Float32Array(W * H);
  let wt = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) { wt[i] = mask[i] ? 0 : 1; v[i] = values[i]; }
  levels.push({ w, h, v, wt });
  while (w > 1 || h > 1) {
    const nw = Math.max(1, Math.ceil(w / 2));
    const nh = Math.max(1, Math.ceil(h / 2));
    const nv = new Float32Array(nw * nh);
    const nwt = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        let s = 0, ws = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const fx = Math.min(w - 1, x * 2 + dx);
            const fy = Math.min(h - 1, y * 2 + dy);
            const k = fy * w + fx;
            s += v[k] * wt[k];
            ws += wt[k];
          }
        }
        nv[y * nw + x] = ws > 0 ? s / ws : 0;
        nwt[y * nw + x] = Math.min(1, ws);
      }
    }
    w = nw; h = nh; v = nv; wt = nwt;
    levels.push({ w, h, v, wt });
  }
  for (let L = levels.length - 2; L >= 0; L--) {
    const fine = levels[L];
    const coarse = levels[L + 1];
    for (let y = 0; y < fine.h; y++) {
      for (let x = 0; x < fine.w; x++) {
        const k = y * fine.w + x;
        if (fine.wt[k] >= 1) continue;
        const cx = Math.max(0, Math.min(coarse.w - 1, (x + 0.5) / 2 - 0.5));
        const cy = Math.max(0, Math.min(coarse.h - 1, (y + 0.5) / 2 - 0.5));
        const x0 = Math.floor(cx), y0 = Math.floor(cy);
        const x1 = Math.min(coarse.w - 1, x0 + 1), y1 = Math.min(coarse.h - 1, y0 + 1);
        const tx = cx - x0, ty = cy - y0;
        const c = coarse.v;
        const up = (c[y0 * coarse.w + x0] * (1 - tx) + c[y0 * coarse.w + x1] * tx) * (1 - ty)
          + (c[y1 * coarse.w + x0] * (1 - tx) + c[y1 * coarse.w + x1] * tx) * ty;
        fine.v[k] = fine.wt[k] * fine.v[k] + (1 - fine.wt[k]) * up;
        fine.wt[k] = 1;
      }
    }
  }
  return levels[0].v;
}

function blur5(src, W, H) {
  const k = [1, 4, 6, 4, 1];
  const tmp = new Float32Array(W * H);
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0;
    for (let i = -2; i <= 2; i++) s += k[i + 2] * src[y * W + Math.min(W - 1, Math.max(0, x + i))];
    tmp[y * W + x] = s / 16;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0;
    for (let i = -2; i <= 2; i++) s += k[i + 2] * tmp[Math.min(H - 1, Math.max(0, y + i)) * W + x];
    out[y * W + x] = s / 16;
  }
  return out;
}

/**
 * Build the render height field. World mapping (matches the original
 * scene.js): pixel (px, py) -> x = x0 + px * cell, z = z0 + py * cell,
 * where x0 = -worldW / 2 and cell = worldW / (W - 1).
 */
export function createTerrainField(terrain, body, exaggeration = 1) {
  const W = terrain.width;
  const H = terrain.height;
  const worldW = W * terrain.metersPerPixel;
  const worldH = H * terrain.metersPerPixel;
  const cell = worldW / (W - 1);
  const x0 = -worldW / 2;
  const z0 = -worldH / 2;

  const raw = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) raw[y * W + x] = terrain.elev(x, y) * exaggeration;
  const fill = new Uint8Array(W * H);
  if (!terrain.synthetic) {
    markRuns(raw, W, H, fill, true);
    markRuns(raw, W, H, fill, false);
  }
  let filled = 0;
  for (let i = 0; i < fill.length; i++) filled += fill[i];
  let heights = raw;
  if (filled > 0) {
    // Dilate by 2 px so the blend covers the streak edges too.
    const grown = new Uint8Array(fill);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!fill[y * W + x]) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < W && yy < H) grown[yy * W + xx] = 1;
      }
    }
    heights = pushPull(raw, grown, W, H);
    for (let i = 0; i < W * H; i++) {
      if (!grown[i]) continue;
      const px = i % W, py = (i / W) | 0;
      heights[i] += fbm(px / 14, py / 14, { octaves: 4, seed: 12 }) * 5 * cell / 5;
    }
    fill.set(grown);
  }

  // Oversampled orbital DTMs carry pixel-scale stereo noise (~0.5 m at
  // 2.3 m/px) that renders as a crawling "cotton" texture under low sun.
  // A light separable blur removes it; the sim keeps the raw heights.
  if (!terrain.synthetic && terrain.metersPerPixel < 4) heights = blur5(heights, W, H);

  let minH = Infinity, maxH = -Infinity;
  for (let i = 0; i < heights.length; i++) { minH = Math.min(minH, heights[i]); maxH = Math.max(maxH, heights[i]); }

  // Coarse average field for extending the DEM smoothly beyond its edge.
  const CW = 64;
  const coarse = new Float32Array(CW * CW);
  for (let cy = 0; cy < CW; cy++) for (let cx = 0; cx < CW; cx++) {
    let s = 0, n = 0;
    const xa = Math.floor((cx / CW) * W), xb = Math.floor(((cx + 1) / CW) * W);
    const ya = Math.floor((cy / CW) * H), yb = Math.floor(((cy + 1) / CW) * H);
    for (let y = ya; y < yb; y += 2) for (let x = xa; x < xb; x += 2) { s += heights[y * W + x]; n++; }
    coarse[cy * CW + cx] = s / Math.max(1, n);
  }

  function demAtPx(px, py) {
    const fx = Math.max(0, Math.min(W - 1, px));
    const fy = Math.max(0, Math.min(H - 1, py));
    const xa = Math.floor(fx), ya = Math.floor(fy);
    const xb = Math.min(W - 1, xa + 1), yb = Math.min(H - 1, ya + 1);
    const tx = fx - xa, ty = fy - ya;
    const top = heights[ya * W + xa] * (1 - tx) + heights[ya * W + xb] * tx;
    const bot = heights[yb * W + xa] * (1 - tx) + heights[yb * W + xb] * tx;
    return top * (1 - ty) + bot * ty;
  }
  function coarseAtPx(px, py) {
    const cx = Math.max(0, Math.min(CW - 1, (px / W) * CW - 0.5));
    const cy = Math.max(0, Math.min(CW - 1, (py / H) * CW - 0.5));
    const xa = Math.floor(cx), ya = Math.floor(cy);
    const xb = Math.min(CW - 1, xa + 1), yb = Math.min(CW - 1, ya + 1);
    const tx = cx - xa, ty = cy - ya;
    return (coarse[ya * CW + xa] * (1 - tx) + coarse[ya * CW + xb] * tx) * (1 - ty)
      + (coarse[yb * CW + xa] * (1 - tx) + coarse[yb * CW + xb] * tx) * ty;
  }

  const toPx = (x) => (x - x0) / cell;
  const toPy = (z) => (z - z0) / cell;
  const demAt = (x, z) => demAtPx(toPx(x), toPy(z));

  // Highest point: the Moon's crater rim is centred on the central peak.
  let peakIdx = 0;
  for (let i = 0; i < heights.length; i++) if (heights[i] > heights[peakIdx]) peakIdx = i;
  const peak = { x: x0 + (peakIdx % W) * cell, z: z0 + Math.floor(peakIdx / W) * cell, h: heights[peakIdx] };
  const floorH = body === "moon" ? minH : minH + (maxH - minH) * 0.35;

  /** Surroundings beyond the DEM: smooth extension, hummocky floor, Tycho's rim far out (Moon). */
  function outerAt(x, z) {
    const px = toPx(x), py = toPy(z);
    const cx = Math.max(0, Math.min(W - 1, px));
    const cy = Math.max(0, Math.min(H - 1, py));
    const d = Math.hypot(px - cx, py - cy) * cell;
    if (d <= 0) return demAtPx(px, py);
    // Blend off the clamped edge quickly (a clamped edge extrudes into
    // streaks), onto a blurred field, then down to the regional floor.
    const edge = demAtPx(cx, cy);
    const soft = coarseAtPx(cx, cy);
    let h = soft + (edge - soft) * Math.exp(-d / 70);
    h += fbm(x / 90, z / 90, { octaves: 3, seed: 35 }) * 6 * smoothstep(0, 250, d);
    h += (floorH - h) * smoothstep(300, body === "moon" ? 6500 : 9000, d);
    const rough = smoothstep(0, 1500, d);
    h += fbm(x / 1100, z / 1100, { octaves: 4, seed: 31 }) * (body === "moon" ? 60 : 45) * rough;
    h += fbm(x / 260, z / 260, { octaves: 3, seed: 32 }) * 14 * smoothstep(0, 600, d);
    if (body === "moon") {
      const r = Math.hypot(x - peak.x, z - peak.z) * (1 + 0.05 * fbm(Math.atan2(z - peak.z, x - peak.x) * 3, 0.5, { octaves: 3, seed: 33 }));
      const t = smoothstep(25000, 42000, r);
      const terr = Math.floor(t * 5) / 5 + smoothstep(0.35, 1, (t * 5) % 1) / 5;
      h += 4700 * (0.45 * t + 0.55 * terr) - 1400 * smoothstep(43000, 62000, r);
      h += fbm(x / 2600, z / 2600, { octaves: 4, seed: 34 }) * 420 * smoothstep(20000, 40000, r);
    }
    return h;
  }

  /** Grid coordinates used by the far mesh at a given subsample step (always includes the last pixel). */
  function gridCoords(n, step) {
    const out = [];
    for (let v = 0; v < n - 1; v += step) out.push(v);
    out.push(n - 1);
    return out;
  }
  let meshStep = 1;
  let meshXs = gridCoords(W, 1);
  let meshYs = gridCoords(H, 1);
  const findCell = (coords, v) => {
    const step = meshStep;
    return Math.max(0, Math.min(coords.length - 2, Math.floor(v / step)));
  };
  /** Height of the far DEM mesh surface itself (same triangle split as terrain-mesh.js). */
  function meshAt(x, z) {
    const px = Math.max(0, Math.min(W - 1, toPx(x)));
    const py = Math.max(0, Math.min(H - 1, toPy(z)));
    const i = findCell(meshXs, px), j = findCell(meshYs, py);
    const xa = meshXs[i], xb = meshXs[i + 1], ya = meshYs[j], yb = meshYs[j + 1];
    const u = (px - xa) / (xb - xa), v = (py - ya) / (yb - ya);
    const ha = heights[ya * W + xa], hb = heights[ya * W + xb], hc = heights[yb * W + xa], hd = heights[yb * W + xb];
    return u + v <= 1 ? ha + (hb - ha) * u + (hc - ha) * v : hd + (hc - hd) * (1 - u) + (hb - hd) * (1 - v);
  }
  function setMeshStep(step) {
    meshStep = step;
    meshXs = gridCoords(W, step);
    meshYs = gridCoords(H, step);
    return { xs: meshXs, ys: meshYs };
  }

  return {
    W, H, cell, x0, z0, worldW, worldH, heights, fill, filledFraction: filled / (W * H),
    minH, maxH, peak, demAt, demAtPx, outerAt, toPx, toPy, meshAt, setMeshStep,
    inDem: (x, z) => { const px = toPx(x), py = toPy(z); return px >= 0 && py >= 0 && px <= W - 1 && py <= H - 1; },
    pxToWorld: (px, py) => ({ x: x0 + px * cell, z: z0 + py * cell }),
  };
}

function craterAt(x, z, cellM, prob, seed, depthK) {
  const ix = Math.floor(x / cellM), iz = Math.floor(z / cellM);
  let h = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx, cz = iz + dz;
      if (hash2(cx, cz, seed) > prob) continue;
      const r = 0.6 + (cellM * 0.42 - 0.6) * hash2(cx, cz, seed + 1) ** 2.5;
      const ox = (cx + hash2(cx, cz, seed + 2)) * cellM;
      const oz = (cz + hash2(cx, cz, seed + 3)) * cellM;
      const s = Math.hypot(x - ox, z - oz) / r;
      if (s > 2) continue;
      const depth = r * depthK * (0.2 + 0.8 * hash2(cx, cz, seed + 4) ** 2);
      const rim = depth * 0.3;
      if (s < 1) h += depth * (s * s - 1) + rim * s ** 6;
      else { const t = (s - 1) * 2.6; h += rim * Math.exp(-t * t); }
    }
  }
  return h;
}

/** Near-field micro-relief in meters (world-anchored, so it never swims). */
export function microRelief(body) {
  if (body === "mars") {
    return (x, z) => fbm(x / 1.7, z / 1.7, { octaves: 2, seed: 51 }) * 0.03
      + fbm(x / 6, z / 6, { octaves: 3, seed: 52 }) * 0.1
      + fbm(x / 18, z / 18, { octaves: 2, seed: 53 }) * 0.28
      + craterAt(x, z, 14, 0.07, 54, 0.08);
  }
  return (x, z) => fbm(x / 1.5, z / 1.5, { octaves: 2, seed: 41 }) * 0.03
    + fbm(x / 5, z / 5, { octaves: 3, seed: 42 }) * 0.07
    + fbm(x / 15, z / 15, { octaves: 2, seed: 43 }) * 0.16
    + craterAt(x, z, 9, 0.2, 44, 0.12)
    + craterAt(x, z, 30, 0.22, 45, 0.1);
}

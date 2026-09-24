// Pure terrain module. Testable in node (no DOM/three.js dependency).
//
// Data contract (matches ~/plans/260923-2234-tycho-rover/plan.md):
//   assets/<body>/height.bin  Uint16 LE, width*height samples, row-major
//   assets/<body>/meta.json   { width, height, metersPerPixel, minElev,
//                               maxElev, heightScale, spawn:{x,y}, goal:{x,y},
//                               source, license, delayOneWaySec }
//
// Every terrain object (real or synthetic) exposes the SAME interface, so
// the renderer and gameplay code never branch on where the data came from:
//   { width, height, metersPerPixel, synthetic,
//     elev(x, y), slopeDeg(x, y), normal(x, y), meta }

/**
 * Convert a raw Uint16 height sample to meters using the meta.json scale.
 * heightScale maps the 0..65535 sample range to minElev..maxElev meters.
 */
function sampleToMeters(sample, meta) {
  const t = sample / 65535;
  return meta.minElev + t * (meta.maxElev - meta.minElev);
}

/**
 * Build the shared terrain interface over a flat Float32Array of elevations
 * in meters, indexed [y * width + x].
 */
function buildTerrain({ width, height, metersPerPixel, elevations, synthetic, meta }) {
  function clampIndex(v, max) {
    return Math.max(0, Math.min(max, v));
  }

  // Bilinear-sampled elevation at fractional pixel coordinates (x, y).
  function elev(x, y) {
    const fx = clampIndex(x, width - 1);
    const fy = clampIndex(y, height - 1);
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, width - 1);
    const y1 = Math.min(y0 + 1, height - 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const e00 = elevations[y0 * width + x0];
    const e10 = elevations[y0 * width + x1];
    const e01 = elevations[y1 * width + x0];
    const e11 = elevations[y1 * width + x1];
    const top = e00 + (e10 - e00) * tx;
    const bottom = e01 + (e11 - e01) * tx;
    return top + (bottom - top) * ty;
  }

  // Surface normal via central differences, in meters (pixel spacing = metersPerPixel).
  function normal(x, y) {
    const eps = 1;
    const hL = elev(x - eps, y);
    const hR = elev(x + eps, y);
    const hD = elev(x, y - eps);
    const hU = elev(x, y + eps);
    const dzdx = (hR - hL) / (2 * eps * metersPerPixel);
    const dzdy = (hU - hD) / (2 * eps * metersPerPixel);
    const nx = -dzdx;
    const ny = -dzdy;
    const nz = 1;
    const len = Math.hypot(nx, ny, nz);
    return { x: nx / len, y: ny / len, z: nz / len };
  }

  // Slope of the surface at (x, y) in degrees, derived from the normal's
  // tilt away from straight up.
  function slopeDeg(x, y) {
    const n = normal(x, y);
    const dot = Math.max(-1, Math.min(1, n.z));
    return (Math.acos(dot) * 180) / Math.PI;
  }

  return { width, height, metersPerPixel, synthetic, elev, slopeDeg, normal, meta };
}

/**
 * Synthetic development/test terrain: a cone peak plus low-amplitude
 * deterministic noise. Used whenever real DEM assets are missing so the
 * engine, tests, and UI never special-case "no data yet" - and so real
 * data from the parallel data-pipeline lane drops in with zero code changes.
 */
export function createSyntheticTerrain({ width = 256, height = 256, metersPerPixel = 4, peakHeight = 140, seed = 1 } = {}) {
  const elevations = new Float32Array(width * height);
  const cx = width / 2;
  const cy = height / 2;
  const maxR = Math.min(cx, cy);

  // Deterministic pseudo-random noise (mulberry32), so tests are reproducible.
  let s = seed >>> 0;
  function rand() {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // Low-frequency value noise: sample a coarse lattice (one point every
  // NOISE_CELL pixels) and bilinearly interpolate it up to full resolution.
  // White per-pixel noise would put a near-vertical wall between adjacent
  // samples, which breaks the "gentle summit, steeper flank" shape this
  // terrain is meant to have. Correlated noise stays gentle at any scale.
  const NOISE_CELL = 8;
  const latticeW = Math.ceil(width / NOISE_CELL) + 2;
  const latticeH = Math.ceil(height / NOISE_CELL) + 2;
  const lattice = new Float32Array(latticeW * latticeH);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rand() - 0.5;

  function noiseAt(x, y) {
    const gx = x / NOISE_CELL;
    const gy = y / NOISE_CELL;
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const tx = gx - x0, ty = gy - y0;
    const g = (ix, iy) => lattice[iy * latticeW + ix];
    const top = g(x0, y0) + (g(x0 + 1, y0) - g(x0, y0)) * tx;
    const bottom = g(x0, y0 + 1) + (g(x0 + 1, y0 + 1) - g(x0, y0 + 1)) * tx;
    return top + (bottom - top) * ty;
  }

  // Smoothstep dome (not a linear cone): flat at the summit (r=0) and at the
  // outer rim (r=1), with the slope concentrated on the mid-flank. A linear
  // cone has a CONSTANT gradient magnitude at every radius from just above 0
  // to just below 1, which put the rover's spawn point on an unclimbable
  // wall; smoothstep keeps peak slope bounded and predictable
  // (max |dz/dr| = 1.5 * peakHeight / maxR, at r = 0.5).
  function domeHeight(r) {
    const t = Math.max(0, Math.min(1, r));
    const smooth = t * t * (3 - 2 * t);
    return (1 - smooth) * peakHeight;
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.hypot(dx, dy) / maxR;
      const dome = domeHeight(r);
      const noise = noiseAt(x, y) * peakHeight * 0.03;
      elevations[y * width + x] = dome + noise;
    }
  }
  const meta = {
    width, height, metersPerPixel,
    minElev: 0, maxElev: peakHeight,
    spawn: { x: cx * 0.25, y: cy },
    goal: { x: cx, y: cy },
    source: "synthetic cone + noise (development/test placeholder)",
    license: "n/a (generated)",
    delayOneWaySec: 1.28,
  };
  return buildTerrain({ width, height, metersPerPixel, elevations, synthetic: true, meta });
}

/**
 * Parse a fetched height.bin (Uint16 LE) + meta.json into the shared
 * terrain interface. Pure: takes already-loaded bytes/JSON, does no I/O.
 */
export function parseTerrain(heightBinBuffer, meta) {
  const { width, height } = meta;
  const view = new DataView(heightBinBuffer);
  const elevations = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const sample = view.getUint16(i * 2, true); // little-endian
    elevations[i] = sampleToMeters(sample, meta);
  }
  return buildTerrain({ width, height, metersPerPixel: meta.metersPerPixel, elevations, synthetic: false, meta });
}

/**
 * Load terrain for a body ("moon" | "mars") from assets/<body>/. Falls back
 * to synthetic terrain (with a console warning) if the files are missing,
 * so the engine boots before the data pipeline lane finishes. Relative
 * paths only (GitHub Pages serves this repo from a subpath).
 */
export async function loadTerrain(body) {
  // Relative to web/index.html (the served page); assets/ is a sibling of
  // web/ at the repo root, so this must climb up one level. Both GitHub
  // Pages (served at /tycho/web/) and the local verify_boot server resolve
  // this the same way, since it's relative to the document, not the origin.
  const base = `../assets/${body}/`;
  try {
    const [metaRes, heightRes] = await Promise.all([
      fetch(`${base}meta.json`),
      fetch(`${base}height.bin`),
    ]);
    if (!metaRes.ok || !heightRes.ok) throw new Error(`missing assets for ${body}`);
    const meta = await metaRes.json();
    const heightBuffer = await heightRes.arrayBuffer();
    if (heightBuffer.byteLength < meta.width * meta.height * 2) {
      throw new Error(`height.bin too small for ${body} (${heightBuffer.byteLength} bytes)`);
    }
    return parseTerrain(heightBuffer, meta);
  } catch (error) {
    console.warn(`[terrain] real DEM for "${body}" unavailable (${error.message}); using synthetic test terrain.`);
    return createSyntheticTerrain({ seed: body === "mars" ? 2 : 1 });
  }
}

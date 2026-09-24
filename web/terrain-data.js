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

// Baseline (meters) over which slope is measured for gameplay/physics and
// the co-pilot's hazard grid. A single real-DEM pixel (e.g. 2.34 m/px on the
// Moon asset) carries stereo-correlation noise of roughly +-0.5 m; reading
// slope across ONE pixel lets that noise alias into 40-56 degree "cliffs"
// that don't exist on the ground, tipping the rover within meters of spawn.
// Measuring over a rover-scale footprint (a real rover's wheelbase is a few
// meters) averages the noise out while still catching real terrain slope.
const SLOPE_BASELINE_M = 3;

/**
 * Build the shared terrain interface over a flat Float32Array of elevations
 * in meters, indexed [y * width + x].
 */
function buildTerrain({ width, height, metersPerPixel, elevations, synthetic, meta, mask = null }) {
  function clampIndex(v, max) {
    return Math.max(0, Math.min(max, v));
  }

  // Uint8 no-data mask (1 = no orbital data, see meta.maskMeaning). Absent
  // for synthetic terrain and tolerated as absent for real terrain (older
  // asset bundles, or a fetch that 404s) - noData() then always reads false.
  function noData(x, y) {
    if (!mask) return false;
    const ix = clampIndex(Math.round(x), width - 1);
    const iy = clampIndex(Math.round(y), height - 1);
    return mask[iy * width + ix] === 1;
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

  // Smoothed slope grid, precomputed once per terrain: a box blur over the
  // raw elevations (radius sized so the blur footprint plus the finite-
  // difference offset span >= SLOPE_BASELINE_M) removes per-pixel DEM noise,
  // then slope is the gradient of the BLURRED heights over that same
  // baseline. Both rover-sim (tip/stall) and the co-pilot's A* hazard grid
  // read this same precomputed array via slopeDeg(), so they always agree.
  let slopeGrid = null;
  function buildSlopeGrid() {
    const R = Math.max(1, Math.round(SLOPE_BASELINE_M / 2 / metersPerPixel));
    const blurred = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sum = 0, count = 0;
        for (let dy = -R; dy <= R; dy++) {
          const sy = clampIndex(y + dy, height - 1);
          for (let dx = -R; dx <= R; dx++) {
            const sx = clampIndex(x + dx, width - 1);
            sum += elevations[sy * width + sx];
            count++;
          }
        }
        blurred[y * width + x] = sum / count;
      }
    }
    const grid = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      const y0 = clampIndex(y - R, height - 1);
      const y1 = clampIndex(y + R, height - 1);
      const spanY = Math.max(1e-6, (y1 - y0) * metersPerPixel);
      for (let x = 0; x < width; x++) {
        const x0 = clampIndex(x - R, width - 1);
        const x1 = clampIndex(x + R, width - 1);
        const spanX = Math.max(1e-6, (x1 - x0) * metersPerPixel);
        const dzdx = (blurred[y * width + x1] - blurred[y * width + x0]) / spanX;
        const dzdy = (blurred[y1 * width + x] - blurred[y0 * width + x]) / spanY;
        grid[y * width + x] = (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
      }
    }
    return grid;
  }

  // Slope of the surface at (x, y) in degrees, bilinearly sampled from the
  // precomputed smoothed slope grid (built lazily, once, on first use).
  function slopeDeg(x, y) {
    if (!slopeGrid) slopeGrid = buildSlopeGrid();
    const fx = clampIndex(x, width - 1);
    const fy = clampIndex(y, height - 1);
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, width - 1);
    const y1 = Math.min(y0 + 1, height - 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const s00 = slopeGrid[y0 * width + x0];
    const s10 = slopeGrid[y0 * width + x1];
    const s01 = slopeGrid[y1 * width + x0];
    const s11 = slopeGrid[y1 * width + x1];
    const top = s00 + (s10 - s00) * tx;
    const bottom = s01 + (s11 - s01) * tx;
    return top + (bottom - top) * ty;
  }

  // "Has a mask worth showing the no-data legend for" - an all-zero mask
  // (every cell has real orbital data, e.g. Mars's shipped mask.bin) is
  // still a mask object, but `!!mask` alone would wrongly flag it as
  // having no-data terrain and show the legend anyway.
  const hasMask = !!mask && mask.some((v) => v !== 0);

  return { width, height, metersPerPixel, synthetic, elev, slopeDeg, normal, noData, hasMask, meta };
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
 * Parse a fetched height.bin (Uint16 LE) + meta.json (+ optional mask.bin,
 * Uint8) into the shared terrain interface. Pure: takes already-loaded
 * bytes/JSON, does no I/O.
 */
export function parseTerrain(heightBinBuffer, meta, maskBinBuffer = null) {
  const { width, height } = meta;
  const view = new DataView(heightBinBuffer);
  const elevations = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const sample = view.getUint16(i * 2, true); // little-endian
    elevations[i] = sampleToMeters(sample, meta);
  }
  let mask = null;
  if (maskBinBuffer && maskBinBuffer.byteLength >= width * height) {
    mask = new Uint8Array(maskBinBuffer);
  }
  return buildTerrain({ width, height, metersPerPixel: meta.metersPerPixel, elevations, synthetic: false, meta, mask });
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
    // mask.bin is optional: tolerate a missing file (older asset bundle, or
    // a body with no no-data cells) without failing the whole terrain load.
    let maskBuffer = null;
    if (meta.maskFile) {
      try {
        const maskRes = await fetch(`${base}${meta.maskFile}`);
        if (maskRes.ok) maskBuffer = await maskRes.arrayBuffer();
      } catch {
        // no-op: mask stays null, noData() reports everything passable.
      }
    }
    return parseTerrain(heightBuffer, meta, maskBuffer);
  } catch (error) {
    console.warn(`[terrain] real DEM for "${body}" unavailable (${error.message}); using synthetic test terrain.`);
    return createSyntheticTerrain({ seed: body === "mars" ? 2 : 1 });
  }
}

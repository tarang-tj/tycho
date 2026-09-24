// Synthetic development/test terrain generator, split out of terrain-data.js
// (U4: keep files under ~250 lines). Re-exported from terrain-data.js so
// every existing import path (`import { createSyntheticTerrain } from
// "./terrain-data.js"`) keeps working unchanged.
//
// Used whenever real DEM assets are missing so the engine, tests, and UI
// never special-case "no data yet" - and so real data from the data
// pipeline drops in with zero code changes.

/**
 * Build a deterministic pseudo-random source (mulberry32) for a given seed,
 * so terrain generation is reproducible across runs/tests.
 */
function mulberry32(seed) {
  let s = seed >>> 0;
  return function rand() {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Low-frequency value noise: sample a coarse lattice (one point every
 * `cell` pixels) and bilinearly interpolate it up to full resolution.
 * White per-pixel noise would put a near-vertical wall between adjacent
 * samples, which breaks the "gentle summit, steeper flank" shape this
 * terrain is meant to have. Correlated noise stays gentle at any scale.
 */
function buildNoiseSampler(width, height, cell, rand) {
  const latticeW = Math.ceil(width / cell) + 2;
  const latticeH = Math.ceil(height / cell) + 2;
  const lattice = new Float32Array(latticeW * latticeH);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rand() - 0.5;

  return function noiseAt(x, y) {
    const gx = x / cell;
    const gy = y / cell;
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const tx = gx - x0, ty = gy - y0;
    const g = (ix, iy) => lattice[iy * latticeW + ix];
    const top = g(x0, y0) + (g(x0 + 1, y0) - g(x0, y0)) * tx;
    const bottom = g(x0, y0 + 1) + (g(x0 + 1, y0 + 1) - g(x0, y0 + 1)) * tx;
    return top + (bottom - top) * ty;
  };
}

// Smoothstep dome (not a linear cone): flat at the summit (r=0) and at the
// outer rim (r=1), with the slope concentrated on the mid-flank. A linear
// cone has a CONSTANT gradient magnitude at every radius from just above 0
// to just below 1, which put the rover's spawn point on an unclimbable
// wall; smoothstep keeps peak slope bounded and predictable
// (max |dz/dr| = 1.5 * peakHeight / maxR, at r = 0.5).
function domeHeight(r, peakHeight) {
  const t = Math.max(0, Math.min(1, r));
  const smooth = t * t * (3 - 2 * t);
  return (1 - smooth) * peakHeight;
}

/**
 * Generate a synthetic development/test terrain: a cone peak plus
 * low-amplitude deterministic noise. Returns { width, height,
 * metersPerPixel, elevations, meta } - the raw shape buildTerrain() (in
 * terrain-data.js) wraps into the shared terrain interface.
 */
export function generateSyntheticTerrain({ width = 256, height = 256, metersPerPixel = 4, peakHeight = 140, seed = 1 } = {}) {
  const elevations = new Float32Array(width * height);
  const cx = width / 2;
  const cy = height / 2;
  const maxR = Math.min(cx, cy);

  const rand = mulberry32(seed);
  const NOISE_CELL = 8;
  const noiseAt = buildNoiseSampler(width, height, NOISE_CELL, rand);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.hypot(dx, dy) / maxR;
      const dome = domeHeight(r, peakHeight);
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
  return { width, height, metersPerPixel, elevations, meta };
}

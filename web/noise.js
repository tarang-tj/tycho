// Deterministic hash + value noise shared by procedural textures and the
// near-field micro-relief. Pure (no DOM, no three.js) so it runs anywhere.

/** Integer hash of (ix, iy, seed) to a float in [0, 1). */
export function hash2(ix, iy, seed = 0) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smooth(t) {
  return t * t * (3 - 2 * t);
}

/**
 * 2D value noise in [-1, 1]. With `period` > 0 the lattice wraps, so the
 * result tiles seamlessly over [0, period) in both axes.
 */
export function valueNoise(x, y, seed = 0, period = 0) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smooth(x - x0);
  const ty = smooth(y - y0);
  let ax = x0, bx = x0 + 1, ay = y0, by = y0 + 1;
  if (period > 0) {
    ax = ((ax % period) + period) % period;
    bx = ((bx % period) + period) % period;
    ay = ((ay % period) + period) % period;
    by = ((by % period) + period) % period;
  }
  const a = hash2(ax, ay, seed);
  const b = hash2(bx, ay, seed);
  const c = hash2(ax, by, seed);
  const d = hash2(bx, by, seed);
  const top = a + (b - a) * tx;
  const bottom = c + (d - c) * tx;
  return (top + (bottom - top) * ty) * 2 - 1;
}

/** Fractal sum of value noise. `period` (in base-frequency units) keeps it tileable. */
export function fbm(x, y, { octaves = 4, seed = 0, period = 0, gain = 0.5, lacunarity = 2 } = {}) {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x * freq, y * freq, seed + o * 17, period ? period * freq : 0);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Mulberry32 PRNG: deterministic stream of floats in [0, 1). */
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

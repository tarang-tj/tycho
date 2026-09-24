// Tileable procedural regolith/rock detail normal+albedo maps, split out of
// textures.js (U4: keep files under ~250 lines). Re-exported from
// textures.js so `import { makeRegolithDetail } from "./textures.js"` keeps
// working unchanged.
import { fbm, rng } from "./noise.js";
import { dataTexture } from "./texture-canvas.js";

/** Stamp a radial feature with wrap-around; fn(s) returns [dh, dAlbedo] for s = dist / radius. */
function stamp(height, albedo, size, cx, cy, radiusPx, reach, fn) {
  const r = Math.ceil(radiusPx * reach);
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const s = Math.hypot(dx, dy) / radiusPx;
      if (s > reach) continue;
      const x = (((cx + dx) % size) + size) % size;
      const y = (((cy + dy) % size) + size) % size;
      const [dh, da] = fn(s);
      height[y * size + x] += dh;
      albedo[y * size + x] += da;
    }
  }
}

function craterProfile(depth, fresh) {
  const rim = depth * 0.28;
  return (s) => {
    if (s < 1) return [depth * (s * s - 1) + rim * s ** 6, fresh * 0.05 * (1 - s)];
    const t = (s - 1) * 2.6;
    return [rim * Math.exp(-t * t), fresh * 0.07 * Math.exp(-t * t)];
  };
}

/**
 * Tileable regolith detail: RGB = tangent-space normal (x = world +x,
 * y = world +z), A = albedo variation centred on 0.5.
 * `tileMeters` is the world size one repeat covers.
 */
export function makeRegolithDetail({ body = "moon", scale = "fine", size = 512, seed = 7 } = {}) {
  const mars = body === "mars";
  const tileMeters = scale === "fine" ? 3 : scale === "mid" ? 160 : 24;
  const pxm = tileMeters / size;
  const height = new Float32Array(size * size);
  const albedo = new Float32Array(size * size);
  const rand = rng(seed + (scale === "fine" ? 11 : scale === "mid" ? 47 : 29) + (mars ? 101 : 0));

  const layers = scale === "fine"
    ? [[64, 0.0035, 3], [12, 0.009, 3]]
    : scale === "mid" ? [[8, mars ? 0.9 : 0.6, 4]]
    : [[6, mars ? 0.16 : 0.1, 4], [28, 0.025, 3]];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let h = 0;
      let a = 0;
      for (const [period, amp, octaves] of layers) {
        const n = fbm((x / size) * period, (y / size) * period, { octaves, seed: seed + period, period });
        h += n * amp;
        a += n * 0.04;
      }
      if (mars && scale === "coarse") {
        // Wind ripples: long-crested, slightly wavy, ~2.4 m wavelength.
        const warp = fbm((x / size) * 3, (y / size) * 3, { octaves: 2, seed: 5, period: 3 }) * 0.9;
        const phase = ((x + y * 0.35) / size) * 10 * Math.PI * 2 + warp * 4;
        h += Math.sin(phase) * 0.035 * (0.5 + 0.5 * fbm((x / size) * 4, (y / size) * 4, { octaves: 2, seed: 9, period: 4 }));
      }
      height[y * size + x] = h;
      albedo[y * size + x] = a;
    }
  }

  if (scale === "mid") {
    for (let i = 0; i < (mars ? 8 : 44); i++) {
      const rPx = 6 + rand() ** 2.2 * 60;
      const fresh = rand() ** 1.5;
      stamp(height, albedo, size, Math.floor(rand() * size), Math.floor(rand() * size), rPx, 2,
        craterProfile(rPx * pxm * (mars ? 0.06 : 0.08 + 0.14 * fresh), mars ? 0 : fresh * 0.6));
    }
  } else if (scale === "fine") {
    const pebbles = mars ? 140 : 180;
    for (let i = 0; i < pebbles; i++) {
      const rPx = 1.5 + rand() ** 2 * 8;
      const hM = rPx * pxm * (0.5 + rand() * 0.4);
      const bright = mars ? -0.05 + rand() * 0.1 : 0.04 + rand() * 0.12;
      stamp(height, albedo, size, Math.floor(rand() * size), Math.floor(rand() * size), rPx, 1, (s) => [hM * Math.sqrt(Math.max(0, 1 - s * s)), bright]);
    }
    for (let i = 0; i < (mars ? 1 : 3); i++) {
      const rPx = 14 + rand() * 36;
      stamp(height, albedo, size, Math.floor(rand() * size), Math.floor(rand() * size), rPx, 2, craterProfile(rPx * pxm * 0.1, mars ? 0 : 0.5));
    }
  } else {
    for (let i = 0; i < (mars ? 2 : 9); i++) {
      const rPx = 4 + rand() ** 2.2 * 40;
      const fresh = rand() ** 3;
      stamp(height, albedo, size, Math.floor(rand() * size), Math.floor(rand() * size), rPx, 2, craterProfile(rPx * pxm * (mars ? 0.05 : 0.04 + 0.1 * fresh), mars ? 0 : fresh * 0.6));
    }
    for (let i = 0; i < (mars ? 0 : 12); i++) {
      const rPx = 1.2 + rand() ** 2 * 3.5;
      const hM = rPx * pxm * 0.6;
      stamp(height, albedo, size, Math.floor(rand() * size), Math.floor(rand() * size), rPx, 1, (s) => [hM * Math.sqrt(Math.max(0, 1 - s * s)), mars ? -0.08 : 0.08]);
    }
  }

  const out = new Uint8Array(size * size * 4);
  const at = (x, y) => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) / (2 * pxm);
      const dz = (at(x, y + 1) - at(x, y - 1)) / (2 * pxm);
      const len = Math.hypot(dx, dz, 1);
      const i = (y * size + x) * 4;
      out[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      out[i + 1] = ((-dz / len) * 0.5 + 0.5) * 255;
      out[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      out[i + 3] = Math.max(0, Math.min(255, (0.5 + albedo[y * size + x]) * 255));
    }
  }
  const tex = dataTexture(out, size);
  tex.userData.tileMeters = tileMeters;
  return tex;
}

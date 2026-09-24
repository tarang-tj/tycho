import { test } from "node:test";
import assert from "node:assert/strict";
import { createSyntheticTerrain, parseTerrain } from "../web/terrain-data.js";

test("synthetic terrain exposes the shared interface and is flagged synthetic", () => {
  const terrain = createSyntheticTerrain({ width: 64, height: 64, metersPerPixel: 2, peakHeight: 100 });
  assert.equal(terrain.synthetic, true);
  assert.equal(terrain.width, 64);
  assert.equal(terrain.height, 64);
  assert.equal(typeof terrain.elev, "function");
  assert.equal(typeof terrain.slopeDeg, "function");
  assert.equal(typeof terrain.normal, "function");
});

test("synthetic cone peak is highest at the center", () => {
  const terrain = createSyntheticTerrain({ width: 128, height: 128, metersPerPixel: 2, peakHeight: 400, seed: 7 });
  const center = terrain.elev(64, 64);
  const edge = terrain.elev(2, 2);
  assert.ok(center > edge, `center (${center}) should be higher than edge (${edge})`);
  assert.ok(center > 350, `center elevation ${center} should be near the peak height`);
});

test("synthetic terrain slope is near zero at the flat summit and rises on the flank", () => {
  const terrain = createSyntheticTerrain({ width: 128, height: 128, metersPerPixel: 2, peakHeight: 400, seed: 3 });
  const summitSlope = terrain.slopeDeg(64, 64);
  const flankSlope = terrain.slopeDeg(96, 64);
  assert.ok(summitSlope < 10, `summit slope ${summitSlope} should be gentle`);
  assert.ok(flankSlope > summitSlope, `flank slope ${flankSlope} should exceed summit slope ${summitSlope}`);
});

test("bilinear elev() interpolates between grid samples, not just nearest", () => {
  const terrain = createSyntheticTerrain({ width: 8, height: 8, metersPerPixel: 1, peakHeight: 100, seed: 1 });
  const a = terrain.elev(3, 3);
  const b = terrain.elev(3.5, 3);
  const c = terrain.elev(4, 3);
  const between = b >= Math.min(a, c) - 5 && b <= Math.max(a, c) + 5;
  assert.ok(between, `interpolated value ${b} should lie roughly between ${a} and ${c}`);
});

test("terrain is deterministic for a fixed seed", () => {
  const t1 = createSyntheticTerrain({ width: 32, height: 32, seed: 42 });
  const t2 = createSyntheticTerrain({ width: 32, height: 32, seed: 42 });
  assert.equal(t1.elev(10, 10), t2.elev(10, 10));
  assert.equal(t1.elev(20, 5), t2.elev(20, 5));
});

test("parseTerrain reads Uint16 LE height.bin into meter elevations", () => {
  const width = 4;
  const height = 4;
  const meta = { width, height, metersPerPixel: 1, minElev: 0, maxElev: 1000 };
  const buffer = new ArrayBuffer(width * height * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < width * height; i++) {
    view.setUint16(i * 2, i === 5 ? 65535 : 0, true);
  }
  const terrain = parseTerrain(buffer, meta);
  assert.equal(terrain.synthetic, false);
  // index 5 -> x=1, y=1 -> max elevation
  assert.ok(Math.abs(terrain.elev(1, 1) - 1000) < 1);
  assert.ok(Math.abs(terrain.elev(0, 0) - 0) < 1);
});

test("slopeDeg is measured over a rover-scale baseline, not a single noisy pixel", () => {
  // A perfectly flat plane (0deg true slope) with alternating +-0.5m
  // per-pixel checkerboard noise, mimicking real DTM stereo-correlation
  // noise. A single-pixel central difference reads this as a near-cliff
  // (atan(1m / 1 * mpp) at mpp=2.34 -> ~23deg minimum, worse at smaller
  // mpp); the smoothed slope grid must read it as gentle.
  const width = 64, height = 64, metersPerPixel = 2.34;
  const meta = { width, height, metersPerPixel, minElev: -10, maxElev: 10 };
  const buffer = new ArrayBuffer(width * height * 2);
  const view = new DataView(buffer);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const noisy = ((x + y) % 2 === 0) ? 0.5 : -0.5; // true elevation: flat plane + checkerboard noise
      const t = (noisy - meta.minElev) / (meta.maxElev - meta.minElev);
      view.setUint16((y * width + x) * 2, Math.round(t * 65535), true);
    }
  }
  const terrain = parseTerrain(buffer, meta);
  const slope = terrain.slopeDeg(32, 32);
  assert.ok(slope < 10, `noisy-but-flat plane should read gentle, got ${slope.toFixed(1)}deg`);
});

test("slopeDeg still reads a real, non-noisy incline as steep", () => {
  const width = 64, height = 64, metersPerPixel = 2.34;
  const meta = { width, height, metersPerPixel, minElev: 0, maxElev: 200 };
  const buffer = new ArrayBuffer(width * height * 2);
  const view = new DataView(buffer);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const elevM = x * 3; // a real, steady ~52deg ramp (3m rise per 2.34m pixel)
      const t = Math.max(0, Math.min(1, elevM / meta.maxElev));
      view.setUint16((y * width + x) * 2, Math.round(t * 65535), true);
    }
  }
  const terrain = parseTerrain(buffer, meta);
  const slope = terrain.slopeDeg(32, 32);
  assert.ok(slope > 40, `a real steady incline should read steep, got ${slope.toFixed(1)}deg`);
});

test("noData() is false everywhere when no mask is supplied, and reads a supplied mask correctly", () => {
  const width = 4, height = 4;
  const meta = { width, height, metersPerPixel: 1, minElev: 0, maxElev: 100 };
  const buffer = new ArrayBuffer(width * height * 2);
  const noMaskTerrain = parseTerrain(buffer, meta);
  assert.equal(noMaskTerrain.noData(1, 1), false);
  assert.equal(noMaskTerrain.hasMask, false);

  const mask = new Uint8Array(width * height);
  mask[1 * width + 2] = 1; // (x=2, y=1) is no-data
  const maskedTerrain = parseTerrain(buffer, meta, mask.buffer);
  assert.equal(maskedTerrain.hasMask, true);
  assert.equal(maskedTerrain.noData(2, 1), true);
  assert.equal(maskedTerrain.noData(0, 0), false);
});

test("an all-zero mask (e.g. Mars's shipped mask.bin: every cell has real data) does not set hasMask", () => {
  const width = 4, height = 4;
  const meta = { width, height, metersPerPixel: 1, minElev: 0, maxElev: 100 };
  const buffer = new ArrayBuffer(width * height * 2);
  const allZeroMask = new Uint8Array(width * height); // every cell = 0 = "has data"
  const terrain = parseTerrain(buffer, meta, allZeroMask.buffer);
  assert.equal(terrain.hasMask, false, "an all-zero mask must not trigger the 'no orbital data' legend");
  assert.equal(terrain.noData(0, 0), false);
});

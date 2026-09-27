// L4 (plan-wave3.md): pure lon/lat -> Jezero crop pixel projection for the
// NASA M20 traverse snapshot, plus route-match scoring. No DOM/canvas.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  projectLonLatToPixel,
  projectTrackSegments,
  flattenTrackPoints,
  clipToCrop,
  projectAndClipTrack,
  routeMatchPercent,
} from "../web/historic-track.js";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SNAPSHOT_PATH = path.join(REPO_ROOT, "assets", "mars", "m20-traverse.json");

function loadSnapshot() {
  return JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
}

const PROJECTION = {
  radiusM: 3396190.0,
  latTrueScaleDeg: 18.4663,
  metersPerPixel: 20.0,
  landingLatDeg: 18.4447,
  landingLonDeg: 77.4508,
  spawnPixel: { x: 512, y: 512 },
};

test("projectLonLatToPixel: the landing site itself projects to the spawn pixel", () => {
  const p = projectLonLatToPixel(PROJECTION.landingLonDeg, PROJECTION.landingLatDeg, PROJECTION);
  assert.ok(Math.abs(p.x - 512) < 1e-9);
  assert.ok(Math.abs(p.y - 512) < 1e-9);
});

test("A3: the real snapshot's first vertex projects within 1px of the meta.json spawn (512,512)", () => {
  const snapshot = loadSnapshot();
  const firstCoord = snapshot.segments[0].coords[0];
  const p = projectLonLatToPixel(firstCoord[0], firstCoord[1], snapshot.projection);
  assert.ok(Math.abs(p.x - 512) <= 1, `x offset ${Math.abs(p.x - 512)} > 1px`);
  assert.ok(Math.abs(p.y - 512) <= 1, `y offset ${Math.abs(p.y - 512)} > 1px`);
});

test("the committed snapshot decimates to <= 300 KB", () => {
  const bytes = Buffer.byteLength(readFileSync(SNAPSHOT_PATH));
  assert.ok(bytes <= 300_000, `snapshot is ${bytes} bytes`);
});

test("projectTrackSegments + flattenTrackPoints: preserves segment metadata, flattens points", () => {
  const snapshot = {
    projection: PROJECTION,
    segments: [
      { sol: 14, fromRMC: "3_0", toRMC: "3_1", length: 6.25, coords: [[77.4508, 18.4447], [77.4509, 18.4448]] },
      { sol: 15, fromRMC: "3_1", toRMC: "3_2", length: 3.0, coords: [[77.451, 18.445]] },
    ],
  };
  const segments = projectTrackSegments(snapshot);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].sol, 14);
  assert.equal(segments[0].fromRMC, "3_0");
  assert.equal(segments[0].toRMC, "3_1");
  assert.equal(segments[0].length, 6.25);
  assert.equal(segments[0].points.length, 2);
  const flat = flattenTrackPoints(segments);
  assert.equal(flat.length, 3);
});

test("clipToCrop: drops points outside the 1024x1024 crop (off-crop vertices)", () => {
  const points = [{ x: -5, y: 5 }, { x: 500, y: 500 }, { x: 1024, y: 5 }, { x: 5, y: 1023 }];
  const clipped = clipToCrop(points, 1024, 1024);
  assert.deepEqual(clipped, [{ x: 500, y: 500 }, { x: 5, y: 1023 }]);
});

test("projectAndClipTrack: end-to-end pipeline clips out-of-crop segments' points", () => {
  const snapshot = {
    projection: PROJECTION,
    segments: [
      // landing site (in-crop) then a point ~40 km away (well off the 20.48km crop)
      { sol: 14, fromRMC: "3_0", toRMC: "3_1", length: 0, coords: [[77.4508, 18.4447], [77.8, 18.8]] },
    ],
  };
  const { segments, points } = projectAndClipTrack(snapshot);
  assert.equal(segments[0].points.length, 2); // per-segment breakdown keeps every point
  assert.equal(points.length, 1); // flat/clipped list drops the off-crop one
});

test("routeMatchPercent: empty player path -> 0", () => {
  assert.equal(routeMatchPercent([], [{ x: 0, y: 0 }]), 0);
});

test("routeMatchPercent: empty track path -> 0", () => {
  assert.equal(routeMatchPercent([{ x: 0, y: 0 }], []), 0);
});

test("routeMatchPercent: identical path -> 100", () => {
  const path = [{ x: 10, y: 10 }, { x: 20, y: 20 }, { x: 30, y: 15 }];
  assert.equal(routeMatchPercent(path, path, { toleranceMeters: 100, metersPerPixel: 20 }), 100);
});

test("routeMatchPercent: a route entirely beyond tolerance scores 0", () => {
  const player = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  const track = [{ x: 900, y: 900 }]; // 890px away, far beyond 100m/20mpp = 5px tolerance
  assert.equal(routeMatchPercent(player, track, { toleranceMeters: 100, metersPerPixel: 20 }), 0);
});

test("routeMatchPercent: a partial overlap scores the matching fraction", () => {
  const track = [{ x: 0, y: 0 }, { x: 500, y: 500 }];
  const player = [
    { x: 1, y: 0 }, // within 5px of track[0] (100m/20mpp)
    { x: 900, y: 900 }, // far from both track points
  ];
  assert.equal(routeMatchPercent(player, track, { toleranceMeters: 100, metersPerPixel: 20 }), 50);
});

// F1: the Perseverance reveal summary (pure). Uses the real committed
// snapshot so the sol range and match maths are checked against real data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { summarizeHistoric, resampleByDistance, MATCH_TOLERANCE_M } from "../web/historic-reveal.js";
import { projectTrackSegments } from "../web/historic-track.js";

const snapshot = JSON.parse(readFileSync(fileURLToPath(new URL("../assets/mars/m20-traverse.json", import.meta.url)), "utf8"));
const terrain = { width: 1024, height: 1024, metersPerPixel: 20 };

test("resampleByDistance: evenly spaced points, keeps both ends, ignores zero-length steps", () => {
  const out = resampleByDistance([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }], 2.5);
  assert.deepEqual(out.map((p) => p.x), [0, 2.5, 5, 7.5, 10]);
  assert.deepEqual(resampleByDistance([], 1), []);
});

test("the sol range is the real min/max sol over segments that reach the crop", () => {
  const s = summarizeHistoric(snapshot, [], terrain);
  const inside = (p) => p.x >= 0 && p.x < 1024 && p.y >= 0 && p.y < 1024;
  const sols = projectTrackSegments(snapshot).filter((g) => g.points.some(inside)).map((g) => g.sol);
  assert.equal(s.solMin, Math.min(...sols));
  assert.equal(s.solMax, Math.max(...sols));
  assert.equal(s.solMin, 14, "Perseverance's first drive (sol 14) starts at the landing site, inside the crop");
  assert.equal(s.sourceLabel, `NASA rover-reported drive segments, sols ${s.solMin}-${s.solMax}`);
  assert.ok(s.trackPoints.length > 1000);
});

test("no route driven: no percentage is invented", () => {
  const s = summarizeHistoric(snapshot, [{ x: 512, y: 512 }], terrain);
  assert.equal(s.matchPct, null);
  assert.match(s.matchLine, /did not move/);
});

test("a route that follows Perseverance's own first drive scores 100%, a far one 0%", () => {
  const first = projectTrackSegments(snapshot).slice(0, 3).flatMap((g) => g.points);
  const on = summarizeHistoric(snapshot, first, terrain);
  assert.equal(on.matchPct, 100);
  assert.equal(on.matchLine, `100% of your route within ${MATCH_TOLERANCE_M} m of Perseverance's.`);
  const far = summarizeHistoric(snapshot, [{ x: 5, y: 5 }, { x: 40, y: 5 }], terrain);
  assert.equal(far.matchPct, 0);
});

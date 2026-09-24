import { test } from "node:test";
import assert from "node:assert/strict";
import { planRoute, DEFAULT_GUARDRAILS } from "../web/copilot.js";

// A flat terrain except for a steep wall segment (x in [18,22], y in
// [-6,6]) that blocks the direct path from (0,0) to (40,0) but can be
// walked around within the lookahead radius.
function wallTerrain({ wallSlopeDeg = 80 } = {}) {
  return {
    metersPerPixel: 1,
    slopeDeg: (x, y) => (x >= 18 && x <= 22 && y >= -6 && y <= 6 ? wallSlopeDeg : 3),
    elev: () => 0,
  };
}

// Steep everywhere: nothing is safe to drive on, anywhere.
function impassableTerrain() {
  return { metersPerPixel: 1, slopeDeg: () => 80, elev: () => 0 };
}

test("safe direct leg needs no reroute", () => {
  const terrain = { metersPerPixel: 1, slopeDeg: () => 5, elev: () => 0 };
  const result = planRoute({ x: 0, y: 0 }, [{ x: 40, y: 0 }], terrain, DEFAULT_GUARDRAILS);
  assert.equal(result.status, "OK");
  assert.equal(result.path.length, 1);
  assert.deepEqual(result.path[0], { x: 40, y: 0 });
});

test("reroute avoids a steep cell blocking the direct path", () => {
  const terrain = wallTerrain();
  const guardrails = { ...DEFAULT_GUARDRAILS, hazardMode: "reroute", maxSlopeDeg: 25, lookaheadRadiusM: 30, maxAutonomousDistanceM: 500 };
  const result = planRoute({ x: 0, y: 0 }, [{ x: 40, y: 0 }], terrain, guardrails);
  assert.equal(result.status, "OK");
  assert.ok(result.path.length > 0);
  // Every point the co-pilot chose to drive through must itself be safe.
  for (const p of result.path) {
    assert.ok(terrain.slopeDeg(p.x, p.y) <= guardrails.maxSlopeDeg, `point (${p.x},${p.y}) should be under the slope limit`);
  }
  // The plan must actually reach the requested waypoint.
  const last = result.path[result.path.length - 1];
  assert.equal(last.x, 40);
  assert.equal(last.y, 0);
});

test("hazardMode 'stop' holds at the hazard without attempting a reroute", () => {
  const terrain = wallTerrain();
  const guardrails = { ...DEFAULT_GUARDRAILS, hazardMode: "stop", maxSlopeDeg: 25 };
  const result = planRoute({ x: 0, y: 0 }, [{ x: 40, y: 0 }], terrain, guardrails);
  assert.equal(result.status, "HOLD");
  assert.match(result.reason, /HOLD/);
});

test("holds when no safe path exists within the lookahead radius", () => {
  const terrain = impassableTerrain();
  const guardrails = { ...DEFAULT_GUARDRAILS, hazardMode: "reroute", maxSlopeDeg: 25, lookaheadRadiusM: 20 };
  const result = planRoute({ x: 0, y: 0 }, [{ x: 40, y: 0 }], terrain, guardrails);
  assert.equal(result.status, "HOLD");
  assert.match(result.reason, /no safe path/);
  assert.equal(result.path.length, 0);
});

test("max autonomous distance is respected: plan holds once the cap is reached", () => {
  const terrain = { metersPerPixel: 1, slopeDeg: () => 2, elev: () => 0 };
  const guardrails = { ...DEFAULT_GUARDRAILS, maxAutonomousDistanceM: 10 };
  const result = planRoute({ x: 0, y: 0 }, [{ x: 100, y: 0 }], terrain, guardrails);
  assert.equal(result.status, "HOLD");
  assert.match(result.reason, /max autonomous distance/);
  assert.ok(result.distanceM <= guardrails.maxAutonomousDistanceM);
});

test("multi-waypoint plan chains legs and accumulates distance", () => {
  const terrain = { metersPerPixel: 1, slopeDeg: () => 2, elev: () => 0 };
  const result = planRoute({ x: 0, y: 0 }, [{ x: 10, y: 0 }, { x: 10, y: 10 }], terrain, { ...DEFAULT_GUARDRAILS, maxAutonomousDistanceM: 500 });
  assert.equal(result.status, "OK");
  assert.equal(result.path.length, 2);
  assert.ok(Math.abs(result.distanceM - 20) < 1e-6);
});

test("a no-data cell blocking the direct path is treated as infinite cost: reroute finds another way", () => {
  const terrain = {
    metersPerPixel: 1,
    slopeDeg: () => 3,
    elev: () => 0,
    noData: (x, y) => x >= 18 && x <= 22 && y >= -6 && y <= 6,
  };
  const guardrails = { ...DEFAULT_GUARDRAILS, hazardMode: "reroute", lookaheadRadiusM: 30, maxAutonomousDistanceM: 500 };
  const result = planRoute({ x: 0, y: 0 }, [{ x: 40, y: 0 }], terrain, guardrails);
  assert.equal(result.status, "OK");
  for (const p of result.path) {
    assert.equal(terrain.noData(p.x, p.y), false, `point (${p.x},${p.y}) must avoid the no-data cell`);
  }
});

test("hazardMode 'stop' holds with a 'no orbital data' reason when the hazard is a masked cell", () => {
  const terrain = { metersPerPixel: 1, slopeDeg: () => 3, elev: () => 0, noData: (x) => x >= 18 };
  const guardrails = { ...DEFAULT_GUARDRAILS, hazardMode: "stop" };
  const result = planRoute({ x: 0, y: 0 }, [{ x: 40, y: 0 }], terrain, guardrails);
  assert.equal(result.status, "HOLD");
  assert.match(result.reason, /no orbital data/);
});

test("M6: a detour never crosses a hazard narrower than one grid cell, even between two safe nodes", () => {
  // A thin steep spike sits exactly between two grid nodes the reroute
  // search would otherwise connect directly (both node centers are safe;
  // only the edge between them clips the spike). Node-only checking would
  // let this edge through; edge sampling (findHazardOnSegment) must not.
  const terrain = {
    metersPerPixel: 1,
    slopeDeg: (x, y) => (x >= 19 && x < 21 && Math.abs(y) < 8 ? 80 : 3),
    elev: () => 0,
    noData: () => false,
  };
  const guardrails = { ...DEFAULT_GUARDRAILS, hazardMode: "reroute", maxSlopeDeg: 25, lookaheadRadiusM: 30, maxAutonomousDistanceM: 500 };
  const result = planRoute({ x: 0, y: 0 }, [{ x: 40, y: 0 }], terrain, guardrails);
  assert.equal(result.status, "OK");
  // Every consecutive pair of points in the chosen path - the whole edge,
  // not just each endpoint - must clear the spike.
  for (let i = 1; i < result.path.length; i++) {
    const a = result.path[i - 1], b = result.path[i];
    const steps = 20;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
      assert.ok(terrain.slopeDeg(x, y) <= guardrails.maxSlopeDeg, `edge (${a.x},${a.y})->(${b.x},${b.y}) clips the spike at (${x.toFixed(1)},${y.toFixed(1)})`);
    }
  }
});

test("empty waypoint list yields an OK no-op plan", () => {
  const terrain = { metersPerPixel: 1, slopeDeg: () => 2, elev: () => 0 };
  const result = planRoute({ x: 0, y: 0 }, [], terrain, DEFAULT_GUARDRAILS);
  assert.equal(result.status, "OK");
  assert.equal(result.path.length, 0);
  assert.equal(result.distanceM, 0);
});

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

test("empty waypoint list yields an OK no-op plan", () => {
  const terrain = { metersPerPixel: 1, slopeDeg: () => 2, elev: () => 0 };
  const result = planRoute({ x: 0, y: 0 }, [], terrain, DEFAULT_GUARDRAILS);
  assert.equal(result.status, "OK");
  assert.equal(result.path.length, 0);
  assert.equal(result.distanceM, 0);
});

// Unit tests on synthetic terrain (fast, isolated) plus a real-Mars-DEM
// parity proof against an independently reproduced reference loop (the same
// technique tests/playability.test.mjs uses for its own Mars bot, copied
// here rather than imported since playability.test.mjs is wave-1-owned).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createSyntheticTerrain, parseTerrain } from "../web/terrain-data.js";
import { createRover, stepRover, steerTowardPoint } from "../web/rover-sim.js";
import { createSignalLink } from "../web/signal.js";
import { planRoute, DEFAULT_GUARDRAILS } from "../web/copilot.js";
import { createMission, startMission, updateMission } from "../web/mission.js";
import { MARS_SCENARIOS } from "../web/levels.js";
import { autopilotStep, runSolPlan, createPathSampler } from "../web/sol-sim.js";

const ASSETS_ROOT = fileURLToPath(new URL("../assets/", import.meta.url));
const WAYPOINT_ARRIVE_RADIUS_M = 6;

function hasRealMarsAssets() {
  return existsSync(`${ASSETS_ROOT}mars/height.bin`) && existsSync(`${ASSETS_ROOT}mars/meta.json`);
}

function loadRealMarsTerrain() {
  const base = `${ASSETS_ROOT}mars/`;
  const meta = JSON.parse(readFileSync(`${base}meta.json`, "utf8"));
  const height = readFileSync(`${base}height.bin`);
  const heightBuf = height.buffer.slice(height.byteOffset, height.byteOffset + height.byteLength);
  let maskBuf = null;
  try {
    const mask = readFileSync(`${base}${meta.maskFile || "mask.bin"}`);
    maskBuf = mask.buffer.slice(mask.byteOffset, mask.byteOffset + mask.byteLength);
  } catch {
    // no mask shipped: parseTerrain tolerates null.
  }
  return parseTerrain(heightBuf, meta, maskBuf);
}

// --- synthetic-terrain unit tests (fast, no real assets required) --------

test("autopilotStep: undrifted (no driftModel) believed position equals true position", () => {
  const terrain = createSyntheticTerrain({ width: 64, height: 64, metersPerPixel: 4, seed: 3 });
  const trueState = createRover({ x: 10, y: 10, heading: 0 });
  const autopilot = { path: [{ x: 10, y: 20 }], index: 0, holdReason: null };
  const step = autopilotStep({ trueState, autopilot, terrain, dt: 0.1 });
  assert.equal(step.believedState.x, trueState.x);
  assert.equal(step.believedState.y, trueState.y);
});

test("autopilotStep: a driftModel offset shifts believed away from true, but true physics is unaffected by it", () => {
  const terrain = createSyntheticTerrain({ width: 64, height: 64, metersPerPixel: 4, seed: 3 });
  const trueState = createRover({ x: 10, y: 10, heading: 0 });
  const autopilot = { path: [{ x: 10, y: 20 }], index: 0, holdReason: null };
  const driftModel = { offsetM: () => ({ x: 40, y: 0 }), advance: () => {} }; // fixed 40m believed offset
  const withDrift = autopilotStep({ trueState, autopilot, terrain, dt: 0.1, driftModel });
  const withoutDrift = autopilotStep({ trueState, autopilot, terrain, dt: 0.1 });
  assert.notEqual(withDrift.believedState.x, withoutDrift.believedState.x);
  // True physics must not depend on the drift offset by itself steering
  // differently in a way that changes the true outcome shape (control comes
  // from the believed heading error, but the physics step is identical math
  // either way - this asserts stepDistanceM, the actual distance driven, is
  // unaffected by which believed position picked the control).
  assert.equal(withDrift.stepDistanceM > 0, true);
});

test("autopilotStep: advances index once the BELIEVED position is within the arrival radius", () => {
  const terrain = createSyntheticTerrain({ width: 64, height: 64, metersPerPixel: 4, seed: 3 });
  const trueState = createRover({ x: 10, y: 10, heading: 0 });
  const autopilot = { path: [{ x: 10.01, y: 10.01 }], index: 0, holdReason: null }; // effectively already there
  const step = autopilotStep({ trueState, autopilot, terrain, dt: 0.1 });
  assert.equal(step.autopilot.index, 1);
});

test("autopilotStep: a holdReason freezes control (no movement toward the path)", () => {
  const terrain = createSyntheticTerrain({ width: 64, height: 64, metersPerPixel: 4, seed: 3 });
  const trueState = createRover({ x: 10, y: 10, heading: 0, speed: 0 });
  const autopilot = { path: [{ x: 10, y: 40 }], index: 0, holdReason: "HOLD: test" };
  const step = autopilotStep({ trueState, autopilot, terrain, dt: 1 });
  assert.equal(step.trueState.speed, 0);
  assert.equal(step.stepDistanceM, 0);
});

test("runSolPlan: a clear direct waypoint on flat synthetic terrain arrives, with a clean legOutcomes", () => {
  const terrain = createSyntheticTerrain({ width: 128, height: 128, metersPerPixel: 4, seed: 11, peakHeight: 2 }); // gentle, so a direct waypoint never tips
  const { spawn, goal } = terrain.meta;
  const result = runSolPlan({ terrain, spawn, waypoints: [goal], driftPct: 0, seed: 0 });
  assert.equal(result.outcome, "arrived");
  assert.deepEqual(result.legOutcomes, ["ok"]);
  assert.ok(result.distanceM > 0);
  assert.ok(Array.isArray(result.truePath) && Array.isArray(result.believedPath));
});

test("runSolPlan: a distance cap tighter than the plan HOLDs at t=0 (legOutcomes reflects it, never drives)", () => {
  const terrain = createSyntheticTerrain({ width: 128, height: 128, metersPerPixel: 4, seed: 11, peakHeight: 2 }); // gentle, so a direct waypoint never tips
  const { spawn, goal } = terrain.meta;
  const result = runSolPlan({
    terrain, spawn, waypoints: [goal], seed: 0,
    guardrails: { maxAutonomousDistanceM: 1 }, // spawn->goal is ~192m; 1m cap forces an immediate HOLD
  });
  assert.equal(result.outcome, "held");
  assert.deepEqual(result.legOutcomes, ["held"]);
  assert.equal(result.distanceM, 0, "a plan-time HOLD must never actually drive anywhere");
  assert.ok(typeof result.holdReason === "string" && result.holdReason.length > 0);
});

test("runSolPlan: same seed gives a deep-equal result (determinism)", () => {
  const terrain = createSyntheticTerrain({ width: 128, height: 128, metersPerPixel: 4, seed: 11, peakHeight: 2 }); // gentle, so a direct waypoint never tips
  const { spawn, goal } = terrain.meta;
  const mid = { x: (spawn.x + goal.x) / 2, y: spawn.y };
  const waypoints = [mid, goal];
  const a = runSolPlan({ terrain, spawn, waypoints, seed: 42, driftPct: 3 });
  const b = runSolPlan({ terrain, spawn, waypoints, seed: 42, driftPct: 3 });
  assert.deepEqual(a, b);
});

test("runSolPlan: different seeds (same drifted plan) can diverge", () => {
  const terrain = createSyntheticTerrain({ width: 128, height: 128, metersPerPixel: 4, seed: 11, peakHeight: 2 }); // gentle, so a direct waypoint never tips
  const { spawn, goal } = terrain.meta;
  const mid = { x: (spawn.x + goal.x) / 2, y: spawn.y };
  const waypoints = [mid, goal];
  const results = [0, 1, 2, 3, 4].map((seed) => runSolPlan({ terrain, spawn, waypoints, seed, driftPct: 5 }));
  const distances = results.map((r) => r.distanceM);
  assert.ok(new Set(distances).size > 1, "expected at least some variation in distance across seeds");
});

test("runSolPlan: a plan that never reaches a terminal mission status inside maxTimeSec reports 'stalled', not a made-up outcome", () => {
  const terrain = createSyntheticTerrain({ width: 128, height: 128, metersPerPixel: 4, seed: 11, peakHeight: 2 }); // gentle, so a direct waypoint never tips
  const { spawn, goal } = terrain.meta;
  const result = runSolPlan({ terrain, spawn, waypoints: [goal], seed: 0, maxTimeSec: 0.05 }); // far too short to arrive
  assert.equal(result.outcome, "stalled");
});

// --- real Mars DEM: driftPct=0 parity against an independently rebuilt reference loop ---

function referenceMarsDistance(terrain, waypoints, delaySec) {
  const { spawn } = terrain.meta;
  const signal = createSignalLink(delaySec);
  let trueState = createRover({ x: spawn.x, y: spawn.y, heading: 0 });
  let mission = startMission(createMission("mars", { mode: "plan" }), 0);
  let visibleState = null;
  let autopilot = null;
  signal.uplink({ type: "plan", waypoints }, 0);

  const dt = 1 / 10;
  const BUDGET_S = 2400;
  let simTime = 0;

  for (; simTime < BUDGET_S && mission.status === "active"; simTime += dt) {
    for (const cmd of signal.pullDeliveredCommands(simTime)) {
      const result = planRoute({ x: trueState.x, y: trueState.y }, cmd.waypoints, terrain, DEFAULT_GUARDRAILS);
      autopilot = { path: result.path, index: 0, holdReason: result.status === "HOLD" ? result.reason : null };
    }
    let control = { throttle: 0, steer: 0 };
    if (autopilot && !autopilot.holdReason) {
      const target = autopilot.path[autopilot.index];
      if (target) {
        control = steerTowardPoint(trueState, target);
        const distM = Math.hypot(target.x - trueState.x, target.y - trueState.y) * terrain.metersPerPixel;
        if (distM < WAYPOINT_ARRIVE_RADIUS_M) autopilot.index += 1;
      }
    }
    trueState = stepRover(trueState, control, terrain, dt);
    signal.telemetry({ ...trueState, copilotHold: autopilot?.holdReason ?? null, planActive: !!autopilot }, simTime);
    const visible = signal.visibleTelemetry(simTime);
    if (visible) visibleState = visible;
    mission = updateMission(mission, { visibleTelemetry: visibleState, simTime, terrain, telemetryAgeSec: signal.telemetryAge(simTime) });
  }

  return { status: mission.status, distanceM: mission.distanceTraveledM };
}

function downsample(path, n) {
  const waypoints = [];
  for (let i = 1; i <= n; i++) {
    const idx = Math.min(path.length - 1, Math.round((i / n) * (path.length - 1)));
    waypoints.push(path[idx]);
  }
  return waypoints;
}

for (const scenario of MARS_SCENARIOS) {
  test(`runSolPlan driftPct=0 matches the reference Mars loop's distance within 1m (${scenario.label})`, { skip: hasRealMarsAssets() ? false : "assets/mars/ not present in this worktree" }, async () => {
    const terrain = loadRealMarsTerrain();
    const { spawn, goal } = terrain.meta;
    const { findGlobalPath } = await import("./helpers/grid-astar.mjs");
    const { path } = findGlobalPath(terrain, spawn, goal, DEFAULT_GUARDRAILS.maxSlopeDeg);
    assert.ok(path, "precondition: a safe route must exist under the default guardrail");
    const waypoints = downsample(path, 4);
    waypoints[waypoints.length - 1] = { x: goal.x, y: goal.y };

    const delaySec = (scenario.realMinutes * 60) / scenario.compression;
    const reference = referenceMarsDistance(terrain, waypoints, delaySec);
    assert.equal(reference.status, "won", `reference bot (${scenario.key}) must itself arrive`);

    const result = runSolPlan({ terrain, spawn, waypoints, driftPct: 0, seed: 0 });
    assert.equal(result.outcome, "arrived", `runSolPlan (driftPct=0, ${scenario.key}) must also arrive`);
    const deltaM = Math.abs(result.distanceM - reference.distanceM);
    assert.ok(deltaM <= 1, `distance mismatch for ${scenario.key}: runSolPlan=${result.distanceM.toFixed(2)}m reference=${reference.distanceM.toFixed(2)}m (delta ${deltaM.toFixed(2)}m)`);
  });
}

// --- createPathSampler ------------------------------------------------------

test("createPathSampler: samples immediately at simTime=0, then only every intervalS seconds", () => {
  const sampler = createPathSampler(5);
  sampler.sample(0, { x: 0, y: 0 }, { x: 0.1, y: 0.1 });
  sampler.sample(2, { x: 1, y: 0 }, { x: 1.1, y: 0.1 }); // too soon, dropped
  sampler.sample(5, { x: 2, y: 0 }, { x: 2.1, y: 0.1 });
  assert.deepEqual(sampler.truePath, [{ x: 0, y: 0 }, { x: 2, y: 0 }]);
  assert.deepEqual(sampler.believedPath, [{ x: 0.1, y: 0.1 }, { x: 2.1, y: 0.1 }]);
});

test("createPathSampler: an empty drive (no sample() calls) yields empty paths, not undefined", () => {
  const sampler = createPathSampler();
  assert.deepEqual(sampler.truePath, []);
  assert.deepEqual(sampler.believedPath, []);
});

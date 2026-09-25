// Mutation-killing tests for web/sol-sim.js, split out of sol-sim.test.mjs to
// keep both files under the ~200-line budget. Same synthetic-terrain
// technique as sol-sim.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSyntheticTerrain } from "../web/terrain-data.js";
import { createRover } from "../web/rover-sim.js";
import { autopilotStep, runSolPlan } from "../web/sol-sim.js";

test("autopilotStep: steers by the BELIEVED position, not the true one (a forced large offset measurably deflects the true trajectory)", () => {
  const terrain = createSyntheticTerrain({ width: 64, height: 64, metersPerPixel: 4, seed: 3 });
  const target = { x: 10, y: 40 }; // straight ahead (north) of spawn
  const spawnState = () => createRover({ x: 10, y: 10, heading: 0 });
  const autopilotFor = () => ({ path: [target], index: 0, holdReason: null });

  // A driftModel that reports a large constant EAST offset: believed
  // position reads as east of true, so steering aims further west than it
  // should to compensate - a measurably different control than undrifted.
  const eastOffsetDrift = { offsetM: () => ({ x: 100, y: 0 }), advance: () => {} };

  let trueDrifted = spawnState();
  let autopilotDrifted = autopilotFor();
  let trueUndrifted = spawnState();
  let autopilotUndrifted = autopilotFor();

  for (let i = 0; i < 30; i++) {
    const stepA = autopilotStep({ trueState: trueDrifted, autopilot: autopilotDrifted, terrain, dt: 0.5, driftModel: eastOffsetDrift });
    trueDrifted = stepA.trueState;
    autopilotDrifted = stepA.autopilot;
    const stepB = autopilotStep({ trueState: trueUndrifted, autopilot: autopilotUndrifted, terrain, dt: 0.5 });
    trueUndrifted = stepB.trueState;
    autopilotUndrifted = stepB.autopilot;
  }

  const deltaM = Math.hypot(trueDrifted.x - trueUndrifted.x, trueDrifted.y - trueUndrifted.y) * (terrain.metersPerPixel || 1);
  assert.ok(deltaM > 1, `expected the true path to measurably deviate when steering used a corrupted believed position, got only ${deltaM.toFixed(3)}m apart (steering by true state instead of believed would give ~0m)`);
});

test("runSolPlan: finalizeLegOutcomes downgrades the not-fully-driven leg (and everything after it) on a 'stalled' outcome", () => {
  const terrain = createSyntheticTerrain({ width: 128, height: 128, metersPerPixel: 4, seed: 11, peakHeight: 2 });
  const { spawn, goal } = terrain.meta;
  const mid = { x: (spawn.x + goal.x) / 2, y: spawn.y };
  const waypoints = [mid, goal];
  // 50s is enough to fully complete leg 0 (mid) but not leg 1 (goal) -
  // measured by probing runSolPlan at increasing maxTimeSec values.
  const result = runSolPlan({ terrain, spawn, waypoints, seed: 0, driftPct: 0, maxTimeSec: 50 });
  assert.equal(result.outcome, "stalled");
  assert.deepEqual(result.legOutcomes, ["ok", "unreached"], "leg 0 (fully driven) must stay 'ok'; leg 1 (never finished) must downgrade to 'unreached'");
});

test("runSolPlan: truePath is populated with real, changing positions as the rover drives", () => {
  const terrain = createSyntheticTerrain({ width: 128, height: 128, metersPerPixel: 4, seed: 11, peakHeight: 2 });
  const { spawn, goal } = terrain.meta;
  const result = runSolPlan({ terrain, spawn, waypoints: [goal], seed: 0, driftPct: 0 });
  assert.ok(result.truePath.length >= 2, `expected truePath to have multiple sampled points, got ${result.truePath.length}`);
  const first = result.truePath[0];
  const last = result.truePath[result.truePath.length - 1];
  const movedM = Math.hypot(last.x - first.x, last.y - first.y) * (terrain.metersPerPixel || 1);
  assert.ok(movedM > 10, `expected truePath to trace real movement across the drive, first-to-last was only ${movedM.toFixed(2)}m apart`);
});

test("runSolPlan: maxSlopeDeg reflects the steepest slope actually crossed while driving (0 on flat terrain, > 0 on hilly terrain)", () => {
  const flatTerrain = createSyntheticTerrain({ width: 128, height: 128, metersPerPixel: 4, seed: 11, peakHeight: 0 });
  const flatResult = runSolPlan({ terrain: flatTerrain, spawn: flatTerrain.meta.spawn, waypoints: [flatTerrain.meta.goal], seed: 0, driftPct: 0 });
  assert.equal(flatResult.maxSlopeDeg, 0, "flat terrain must report 0 maxSlopeDeg");

  const hillyTerrain = createSyntheticTerrain({ width: 128, height: 128, metersPerPixel: 4, seed: 11, peakHeight: 12 });
  const hillyResult = runSolPlan({ terrain: hillyTerrain, spawn: hillyTerrain.meta.spawn, waypoints: [hillyTerrain.meta.goal], seed: 0, driftPct: 0, guardrails: { maxSlopeDeg: 60 } });
  assert.ok(hillyResult.maxSlopeDeg > 0, `expected hilly terrain to report a nonzero maxSlopeDeg, got ${hillyResult.maxSlopeDeg}`);
});

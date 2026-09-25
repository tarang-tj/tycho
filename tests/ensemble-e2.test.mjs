// Mutation-killing unit tests for web/ensemble.js's private wilson95/median
// helpers and driftPct passthrough, split out of ensemble.test.mjs to keep
// both files under the ~200-line budget.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSyntheticTerrain } from "../web/terrain-data.js";
import { ensemble } from "../web/ensemble.js";
import { DRIFT_PCT } from "../web/drift.js";

test("ensemble: wilson95 matches the exact closed-form interval for a known all-arrived count (n=20, successes=20)", () => {
  // Flat, gentle synthetic terrain + driftPct=0: every one of the N seeds
  // arrives identically and deterministically, so successes=n=N=20 exactly.
  const terrain = createSyntheticTerrain({ width: 128, height: 128, metersPerPixel: 4, seed: 11, peakHeight: 2 });
  const { spawn, goal } = terrain.meta;
  const result = ensemble({ terrain, spawn, waypoints: [goal], N: 20, driftPct: 0 });
  assert.equal(result.counts.arrived, 20, "precondition: every seed must arrive for this closed-form check to apply");
  // Independently computed (not re-derived from ensemble.js's own code): the
  // Wilson 95% score interval for successes=20, n=20 has a known closed
  // form since p=1 makes p*(1-p)=0. Values below computed by hand/calculator.
  assert.ok(Math.abs(result.wilson95[0] - 0.8388748418837426) < 1e-9, `wilson95 lower bound mismatch: ${result.wilson95[0]}`);
  assert.equal(result.wilson95[1], 1, "wilson95 upper bound must be exactly 1 for successes=n");
});

test("ensemble: wilson95 matches the exact closed-form interval for a known all-failed count (n=20, successes=0)", () => {
  const terrain = createSyntheticTerrain({ width: 128, height: 128, metersPerPixel: 4, seed: 11, peakHeight: 2 });
  const { spawn, goal } = terrain.meta;
  // An impossibly tight distance cap forces every seed to HOLD at t=0, so
  // successes=0 deterministically, independent of seed.
  const result = ensemble({ terrain, spawn, waypoints: [goal], N: 20, driftPct: 0, guardrails: { maxAutonomousDistanceM: 0.01 } });
  assert.equal(result.counts.arrived, 0, "precondition: every seed must fail to arrive for this closed-form check to apply");
  assert.equal(result.wilson95[0], 0, "wilson95 lower bound must be exactly 0 for successes=0");
  assert.ok(Math.abs(result.wilson95[1] - 0.16112515811625733) < 1e-9, `wilson95 upper bound mismatch: ${result.wilson95[1]}`);
});

test("ensemble: medianDistanceM is the true statistical median of run distances, not just the shortest run", () => {
  const terrain = createSyntheticTerrain({ width: 128, height: 128, metersPerPixel: 4, seed: 11, peakHeight: 2 });
  const { spawn, goal } = terrain.meta;
  // driftPct > 0 so distances vary seed-to-seed (drift changes the steered
  // path length even when every seed still arrives).
  const result = ensemble({ terrain, spawn, waypoints: [goal], N: 20, driftPct: 5 });
  const distances = result.runs.map((r) => r.distanceM);
  const sorted = [...distances].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const trueMedian = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  assert.equal(result.medianDistanceM, trueMedian);
  assert.notEqual(result.medianDistanceM, Math.min(...distances), "precondition: the true median must differ from the minimum for this test to distinguish median() from sorted[0]");
});

test("ensemble: driftPct is passed through to every run - driftPct=0 is deterministic across seeds, DRIFT_PCT produces a spread", () => {
  const terrain = createSyntheticTerrain({ width: 128, height: 128, metersPerPixel: 4, seed: 11, peakHeight: 2 });
  const { spawn, goal } = terrain.meta;
  const undrifted = ensemble({ terrain, spawn, waypoints: [goal], N: 10, driftPct: 0 });
  const drifted = ensemble({ terrain, spawn, waypoints: [goal], N: 10, driftPct: DRIFT_PCT });
  const undriftedDistances = new Set(undrifted.runs.map((r) => r.distanceM));
  const driftedDistances = new Set(drifted.runs.map((r) => r.distanceM));
  assert.equal(undriftedDistances.size, 1, `expected driftPct=0 to give identical distances across seeds, got ${undriftedDistances.size} distinct values`);
  assert.ok(driftedDistances.size > 1, `expected driftPct=${DRIFT_PCT} to give varying distances across seeds, got only ${driftedDistances.size} distinct value(s)`);
});

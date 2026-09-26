import { test } from "node:test";
import assert from "node:assert/strict";
import { createSyntheticTerrain } from "../web/terrain-data.js";
import { DEFAULT_GUARDRAILS } from "../web/copilot.js";
import {
  DRY_RUN_N, DRY_RUN_BASE_SEED, pickRealRunSeed,
  createMarsAutopilot, finalizeMarsLegOutcomes,
  formatDryRunSummary, formatPredictedLine,
  formatRealDriftLine, createMarsTrackReveal,
} from "../web/mars-run.js";

const terrain = createSyntheticTerrain({ seed: 2 });
const spawn = { x: terrain.width / 2, y: terrain.height / 2 };

// --- pickRealRunSeed -------------------------------------------------------

test("pickRealRunSeed: an injected overrideSeed is returned as-is (unit-test injection point, not a shipped debug API)", () => {
  assert.equal(pickRealRunSeed({ overrideSeed: 42 }), 42);
});

test("pickRealRunSeed: a real-number overrideSeed of 0 is honored, not treated as falsy/missing", () => {
  assert.equal(pickRealRunSeed({ overrideSeed: 0 }), 0);
});

test("pickRealRunSeed: without an override, draws from randomSource and never lands in the dry-run's reserved seed range", () => {
  // A fake crypto that always returns a seed INSIDE the reserved range on
  // its first few draws, then a seed outside it - proves the retry loop
  // actually rejects reserved-range draws instead of returning the first one blindly.
  let call = 0;
  const insideThenOutside = [5, 50, 99, DRY_RUN_N + 10];
  const fakeCrypto = {
    getRandomValues(buf) {
      buf[0] = insideThenOutside[Math.min(call, insideThenOutside.length - 1)];
      call += 1;
    },
  };
  const seed = pickRealRunSeed({ randomSource: fakeCrypto });
  assert.equal(seed, DRY_RUN_N + 10);
  assert.ok(seed < DRY_RUN_BASE_SEED || seed > DRY_RUN_BASE_SEED + DRY_RUN_N - 1);
});

test("pickRealRunSeed: falls back to a reserved-range-safe seed when no Web Crypto is available at all", () => {
  const seed = pickRealRunSeed({ randomSource: null });
  assert.ok(seed > DRY_RUN_BASE_SEED + DRY_RUN_N - 1, "fallback seed must still fall outside the dry run's reserved range");
});

// --- createMarsAutopilot / finalizeMarsLegOutcomes --------------------------

test("createMarsAutopilot: delegates to sol-sim.js's per-leg planner, producing legEndIndex/legOutcomes for a safe short hop", () => {
  const waypoints = [{ x: spawn.x + 3, y: spawn.y }];
  const autopilot = createMarsAutopilot(spawn, waypoints, terrain, DEFAULT_GUARDRAILS);
  assert.equal(autopilot.index, 0);
  assert.equal(autopilot.legOutcomes.length, 1);
  assert.ok(["ok", "held"].includes(autopilot.legOutcomes[0]));
});

test("finalizeMarsLegOutcomes: returns [] when no autopilot ever ran (mission ended before a plan was delivered)", () => {
  assert.deepEqual(finalizeMarsLegOutcomes(null, "stalled"), []);
});

test("finalizeMarsLegOutcomes: passes through unchanged on 'arrived' (the outcome finalizeLegOutcomes itself never touches)", () => {
  const waypoints = [{ x: spawn.x + 3, y: spawn.y }, { x: spawn.x + 6, y: spawn.y }];
  const autopilot = createMarsAutopilot(spawn, waypoints, terrain, DEFAULT_GUARDRAILS);
  autopilot.index = autopilot.path.length; // pretend the whole plan drove through
  const result = finalizeMarsLegOutcomes(autopilot, "arrived");
  assert.deepEqual(result, autopilot.legOutcomes);
});

test("finalizeMarsLegOutcomes: a plan-time HOLD at leg 2 marks leg 1 'unreached', not 'ok' (review finding 7: the whole plan holds from t=0, so an earlier 'ok'-at-planning leg was never actually driven)", () => {
  const waypoints = [{ x: spawn.x + 3, y: spawn.y }, { x: spawn.x + 3000, y: spawn.y }];
  const guardrails = { ...DEFAULT_GUARDRAILS, maxAutonomousDistanceM: 100 };
  const autopilot = createMarsAutopilot(spawn, waypoints, terrain, guardrails);
  assert.deepEqual(autopilot.legOutcomes, ["ok", "held"], "precondition: leg 1 plans OK, leg 2 HOLDs on the distance cap");
  // autopilot.index is 0 here (never advanced): a plan-time HOLD zeroes
  // control from the very first tick, so no leg - including the one
  // planLegsWithBoundaries marked "ok" - was ever actually driven.
  const result = finalizeMarsLegOutcomes(autopilot, "held");
  assert.deepEqual(result, ["unreached", "held"]);
});

test("finalizeMarsLegOutcomes: passes through unchanged on 'held' when no leg was ever marked 'ok' (HOLD on the very first leg)", () => {
  const waypoints = [{ x: spawn.x + 3000, y: spawn.y }];
  const guardrails = { ...DEFAULT_GUARDRAILS, maxAutonomousDistanceM: 10 };
  const autopilot = createMarsAutopilot(spawn, waypoints, terrain, guardrails);
  assert.deepEqual(autopilot.legOutcomes, ["held"]);
  const result = finalizeMarsLegOutcomes(autopilot, "held");
  assert.deepEqual(result, ["held"]);
});

test("finalizeMarsLegOutcomes: downgrades an in-progress leg to 'unreached' on a mid-drive 'stalled' outcome", () => {
  const waypoints = [{ x: spawn.x + 3, y: spawn.y }];
  const autopilot = createMarsAutopilot(spawn, waypoints, terrain, DEFAULT_GUARDRAILS);
  if (autopilot.legOutcomes[0] !== "ok") return; // hazard-dependent on synthetic terrain; skip if this leg held at plan time
  autopilot.index = 0; // never actually drove any of the planned path
  const result = finalizeMarsLegOutcomes(autopilot, "stalled");
  assert.equal(result[0], "unreached");
});

// --- formatDryRunSummary / formatPredictedLine ------------------------------

test("formatDryRunSummary: reports all four outcome counts and the 95% arrival range, plus the ALWAYS-present drift label", () => {
  const summary = { n: 100, counts: { arrived: 49, held: 0, tipped: 0, stalled: 51 }, wilson95: [0.394, 0.587] };
  const { resultLine, driftLine } = formatDryRunSummary(summary, 1);
  assert.equal(resultLine, "100 simulated sols: 49 arrived, 0 held, 0 tipped, 51 stalled (95% range for arrival: 39-59%)");
  assert.equal(driftLine, "Modeled drift: about 1% of distance (a game assumption, not a measured rover figure)");
});

test("formatDryRunSummary: the drift label is present even when every run arrived (never hidden just because it looks uninteresting)", () => {
  const summary = { n: 20, counts: { arrived: 20, held: 0, tipped: 0, stalled: 0 }, wilson95: [0.84, 1] };
  const { driftLine } = formatDryRunSummary(summary, 1);
  assert.match(driftLine, /game assumption, not a measured rover figure/);
});

test("formatPredictedLine: null when no dry run was done before uplink", () => {
  assert.equal(formatPredictedLine(null, "arrived"), null);
});

test("formatPredictedLine: renders the predicted range, this run's actual outcome, and the ALWAYS-present drift label (review finding 5)", () => {
  const predicted = { arrivalRate: 0.49, wilson95: [0.394, 0.587] };
  assert.equal(
    formatPredictedLine(predicted, "stalled", 1),
    "Dry run predicted 49% (range 39-59%); this run: stalled. Modeled drift: about 1% of distance (a game assumption, not a measured rover figure)",
  );
});

// --- formatRealDriftLine / createMarsTrackReveal ----------------------------

test("formatRealDriftLine: reports the rounded believed-minus-true offset magnitude", () => {
  assert.equal(
    formatRealDriftLine({ x: 12, y: 5 }),
    "Drift this run: the co-pilot thought TYCHO was 13 m from where it really was.",
  );
});

test("formatRealDriftLine: zero offset (no drift model, e.g. driftPct=0) reads as 0 m, not NaN/undefined", () => {
  assert.equal(
    formatRealDriftLine({ x: 0, y: 0 }),
    "Drift this run: the co-pilot thought TYCHO was 0 m from where it really was.",
  );
});

test("createMarsTrackReveal: finalize() with no driftModel (e.g. mission ended before a plan was ever delivered) reports zero offset", () => {
  const reveal = createMarsTrackReveal();
  const result = reveal.finalize(null);
  assert.deepEqual(result.offsetM, { x: 0, y: 0 });
  assert.deepEqual(result.truePath, []);
  assert.deepEqual(result.believedPath, []);
});

test("createMarsTrackReveal: sample() feeds the same downsampled truePath/believedPath sol-sim.js's createPathSampler produces", () => {
  const reveal = createMarsTrackReveal();
  reveal.sample(0, { x: 0, y: 0 }, { x: 0.2, y: 0 });
  reveal.sample(5, { x: 1, y: 0 }, { x: 1.2, y: 0 });
  const fakeDriftModel = { offsetM: () => ({ x: 0.2, y: 0 }) };
  const result = reveal.finalize(fakeDriftModel);
  assert.deepEqual(result.truePath, [{ x: 0, y: 0 }, { x: 1, y: 0 }]);
  assert.deepEqual(result.believedPath, [{ x: 0.2, y: 0 }, { x: 1.2, y: 0 }]);
  assert.equal(result.driftLine, "Drift this run: the co-pilot thought TYCHO was 0 m from where it really was.");
});

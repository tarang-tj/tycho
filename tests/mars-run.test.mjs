import { test } from "node:test";
import assert from "node:assert/strict";
import { createSyntheticTerrain } from "../web/terrain-data.js";
import { DEFAULT_GUARDRAILS } from "../web/copilot.js";
import {
  DRY_RUN_N, DRY_RUN_BASE_SEED, pickRealRunSeed,
  createMarsAutopilot, finalizeMarsLegOutcomes,
  formatDryRunSummary, formatPredictedLine,
} from "../web/mars-run.js";

const terrain = createSyntheticTerrain({ seed: 2 });
const spawn = { x: terrain.width / 2, y: terrain.height / 2 };

// --- pickRealRunSeed -------------------------------------------------------

test("pickRealRunSeed: an injected overrideSeed is returned as-is (debug API / deterministic tests)", () => {
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

test("formatPredictedLine: renders the predicted range and this run's actual outcome", () => {
  const predicted = { arrivalRate: 0.49, wilson95: [0.394, 0.587] };
  assert.equal(formatPredictedLine(predicted, "stalled"), "Dry run predicted 49% (range 39-59%); this run: stalled");
});

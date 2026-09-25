import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createSyntheticTerrain, parseTerrain } from "../web/terrain-data.js";
import { DEFAULT_GUARDRAILS } from "../web/copilot.js";
import { ensemble } from "../web/ensemble.js";
import { runSolPlan } from "../web/sol-sim.js";
import { DRIFT_PCT } from "../web/drift.js";

const ASSETS_ROOT = fileURLToPath(new URL("../assets/", import.meta.url));
const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/mars-mixed-plan.json", import.meta.url));

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

function loadFixture() {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
}

// --- basic shape, on fast synthetic terrain -------------------------------

test("ensemble: basic shape (counts sum to N, arrivalRate/wilson95/medianDistanceM well-formed)", () => {
  const terrain = createSyntheticTerrain({ width: 96, height: 96, metersPerPixel: 4, seed: 2 });
  const { spawn, goal } = terrain.meta;
  const result = ensemble({ terrain, spawn, waypoints: [goal], N: 12, baseSeed: 0 });
  assert.equal(result.n, 12);
  assert.equal(result.runs.length, 12);
  const sum = Object.values(result.counts).reduce((a, b) => a + b, 0);
  assert.equal(sum, 12);
  assert.equal(result.arrivalRate, result.counts.arrived / 12);
  assert.equal(result.wilson95.length, 2);
  assert.ok(result.wilson95[0] <= result.wilson95[1]);
  assert.ok(result.wilson95[0] >= 0 && result.wilson95[1] <= 1);
  assert.ok(typeof result.medianDistanceM === "number");
  for (const run of result.runs) {
    assert.ok(Number.isInteger(run.seed));
    assert.ok(typeof run.outcome === "string");
  }
});

test("ensemble: baseSeed offsets which seeds are drawn, so results can differ from baseSeed 0", () => {
  const terrain = createSyntheticTerrain({ width: 96, height: 96, metersPerPixel: 4, seed: 2 });
  const { spawn, goal } = terrain.meta;
  const a = ensemble({ terrain, spawn, waypoints: [goal], N: 10, baseSeed: 0 });
  const b = ensemble({ terrain, spawn, waypoints: [goal], N: 10, baseSeed: 500 });
  assert.deepEqual(a.runs.map((r) => r.seed), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(b.runs.map((r) => r.seed), [500, 501, 502, 503, 504, 505, 506, 507, 508, 509]);
});

test("ensemble: wilson95 collapses to [0,0] at N=0 instead of dividing by zero", () => {
  const terrain = createSyntheticTerrain({ width: 96, height: 96, metersPerPixel: 4, seed: 2 });
  const { spawn, goal } = terrain.meta;
  const result = ensemble({ terrain, spawn, waypoints: [goal], N: 0 });
  assert.deepEqual(result.wilson95, [0, 0]);
  assert.equal(result.arrivalRate, 0);
});

// --- the real-DEM fixture: acceptance (c), (d), (e), (f) ------------------

const marsTest = hasRealMarsAssets() ? test : test.skip;

marsTest("(c) the committed mars-mixed-plan.json fixture yields >= 2 distinct outcomes over ensemble(N=20) at DRIFT_PCT on the real Mars DEM", () => {
  const fixture = loadFixture();
  assert.equal(fixture.driftPct, DRIFT_PCT, "the fixture must be built for the frozen DRIFT_PCT, never a retuned value");
  const terrain = loadRealMarsTerrain();
  assert.deepEqual(terrain.meta.spawn, fixture.spawn, "fixture was hand-tuned to this exact spawn; a DEM change invalidates it");
  assert.deepEqual(terrain.meta.goal, fixture.goal, "fixture was hand-tuned to this exact goal; a DEM change invalidates it");

  const result = ensemble({
    terrain, spawn: fixture.spawn, waypoints: fixture.waypoints,
    guardrails: fixture.guardrails, N: 20, baseSeed: fixture.baseSeed, driftPct: fixture.driftPct,
  });
  const distinctOutcomes = Object.values(result.counts).filter((c) => c > 0).length;
  assert.ok(distinctOutcomes >= 2, `expected >= 2 distinct outcomes, got ${JSON.stringify(result.counts)}`);
});

marsTest("(d) HELD half of the trade-off proof: a tighter maxSlopeDeg holds the fixture more than DEFAULT_GUARDRAILS (planning is deterministic, so this is all-or-nothing per guardrail)", () => {
  const fixture = loadFixture();
  const terrain = loadRealMarsTerrain();
  const mid = ensemble({ terrain, spawn: fixture.spawn, waypoints: fixture.waypoints, guardrails: fixture.guardrails, N: 20, baseSeed: fixture.baseSeed, driftPct: fixture.driftPct });
  const tight = ensemble({ terrain, spawn: fixture.spawn, waypoints: fixture.waypoints, guardrails: { ...fixture.guardrails, maxSlopeDeg: 18 }, N: 20, baseSeed: fixture.baseSeed, driftPct: fixture.driftPct });
  assert.ok(tight.counts.held > mid.counts.held, `expected tight(18).held > mid(25).held, got tight=${tight.counts.held} mid=${mid.counts.held}`);
  assert.equal(mid.counts.held, 0, "DEFAULT_GUARDRAILS (25deg) must pass this fixture's plan-time hazard check clean");
  assert.equal(tight.counts.held, 20, "maxSlopeDeg 18 must hold on every seed (a plan-time decision, independent of drift's seed)");
});

marsTest(
  "(d) TIPPED half of the trade-off proof is BLOCKED on the shipped Mars DEM: documented, not faked",
  () => {
    // Measured this session: the nearest real cell >= the rover's fixed 32deg
    // physical tip limit (rover-sim.js DEFAULT_OPTS.maxSlopeDeg, not
    // overridable by guardrails) is (271,852) at 32.17deg, 8335m from spawn.
    // mission.js's STALL_TIMEOUT_S (75s, unmodified, wave-1-owned) caps any
    // sustained move-away-from-goal excursion at ~75s * 3 m/s = 225m before
    // the mission is force-ended "stalled". No plan can stay under that
    // grace AND reach a >=32deg cell, so "tipped" cannot occur near the
    // goal on this DEM at ANY guardrail setting - confirmed below by
    // running the loosest legal preset (maxSlopeDeg 31, hazardMode "stop")
    // on the committed fixture and observing zero tips, matching mid(25).
    // Per plan-wave2.md's honesty rule, DRIFT_PCT is NOT retuned to force
    // this; the finding is reported BLOCKED (see the fixture's own
    // "measured.tippedTradeoffBlocked" field) rather than faked here.
    const fixture = loadFixture();
    const terrain = loadRealMarsTerrain();
    const loose = ensemble({ terrain, spawn: fixture.spawn, waypoints: fixture.waypoints, guardrails: { ...fixture.guardrails, maxSlopeDeg: 31, hazardMode: "stop" }, N: 20, baseSeed: fixture.baseSeed, driftPct: fixture.driftPct });
    const mid = ensemble({ terrain, spawn: fixture.spawn, waypoints: fixture.waypoints, guardrails: fixture.guardrails, N: 20, baseSeed: fixture.baseSeed, driftPct: fixture.driftPct });
    assert.equal(loose.counts.tipped, 0, "measured/documented: tipped is unreachable on this DEM (see comment above)");
    assert.equal(mid.counts.tipped, 0, "measured/documented: tipped is unreachable on this DEM (see comment above)");
    // Fails loud if the DEM ever changes and a reachable >=32deg cell
    // appears: an actual increase should show up here, at which point this
    // BLOCKED status should be revisited instead of silently staying green.
  },
);

// The picker bot uses the committed mars-mixed-plan.json route, not a route
// chosen for its outcome. It sees ONLY ensemble() summaries. Its choice is
// then checked on HELD-OUT seeds (baseSeed 1000) it never saw, instead of on
// one hand-picked seed. Note: "loose" (31 deg, stop) and "default" (25 deg,
// reroute) produce identical counts on this route (measured), so which of
// the two is picked is decided by list order, and the test does not claim
// the ensemble tells them apart. What it does tell apart is "tight": 18 deg
// holds this plan at plan time on every seed.
marsTest("(e) a guardrail-picker bot choosing by ensemble()-predicted arrival rate picks a best-predicted preset, and its held-out arrival rate beats the worst preset", () => {
  const fixture = loadFixture();
  const terrain = loadRealMarsTerrain();
  const { spawn, waypoints } = fixture;
  const presets = [
    { name: "loose", guardrails: { ...DEFAULT_GUARDRAILS, maxSlopeDeg: 31, hazardMode: "stop" } },
    { name: "default", guardrails: DEFAULT_GUARDRAILS },
    { name: "tight", guardrails: { ...DEFAULT_GUARDRAILS, maxSlopeDeg: 18, hazardMode: "reroute" } },
  ];
  const predicted = presets.map((preset) => ({
    preset,
    summary: ensemble({ terrain, spawn, waypoints, guardrails: preset.guardrails, N: 20, baseSeed: 0, driftPct: DRIFT_PCT }),
  }));
  const bestRate = Math.max(...predicted.map((p) => p.summary.arrivalRate));
  const best = predicted.find((p) => p.summary.arrivalRate === bestRate);
  const worst = predicted.reduce((a, b) => (b.summary.arrivalRate < a.summary.arrivalRate ? b : a));
  assert.ok(bestRate > worst.summary.arrivalRate, "the presets must not all tie, or the picker has nothing to choose");

  const heldOut = (preset) => ensemble({ terrain, spawn, waypoints, guardrails: preset.guardrails, N: 20, baseSeed: 1000, driftPct: DRIFT_PCT });
  const bestHeld = heldOut(best.preset);
  const worstHeld = heldOut(worst.preset);
  console.log(`  [picker] chose "${best.preset.name}": predicted ${best.summary.arrivalRate} ${JSON.stringify(best.summary.wilson95)}, held-out ${bestHeld.arrivalRate}; worst "${worst.preset.name}" predicted ${worst.summary.arrivalRate}, held-out ${worstHeld.arrivalRate}`);
  assert.ok(bestHeld.arrivalRate > worstHeld.arrivalRate, `held-out: picked "${best.preset.name}" (${bestHeld.arrivalRate}) should beat "${worst.preset.name}" (${worstHeld.arrivalRate})`);
});

marsTest("(f) ensemble({N:20}) completes in under 5s in node", () => {
  const terrain = loadRealMarsTerrain();
  const { spawn, goal } = terrain.meta;
  const waypoints = [{ x: (spawn.x + goal.x) / 2, y: (spawn.y + goal.y) / 2 }, { x: goal.x, y: goal.y }];
  const start = Date.now();
  ensemble({ terrain, spawn, waypoints, N: 20 });
  const elapsedMs = Date.now() - start;
  console.log(`  [ensemble timing] N=20 took ${elapsedMs}ms`);
  assert.ok(elapsedMs < 5000, `ensemble(N=20) took ${elapsedMs}ms, over the 5000ms budget`);
});

// --- (g) no DOM/three.js imports in any of this lane's 4 modules ---------

test("(g) prng.js, drift.js, sol-sim.js, ensemble.js have no DOM/three.js imports (pure modules)", () => {
  for (const file of ["prng.js", "drift.js", "sol-sim.js", "ensemble.js"]) {
    const src = readFileSync(fileURLToPath(new URL(`../web/${file}`, import.meta.url)), "utf8");
    assert.doesNotMatch(src, /from\s+["']three["']/, `${file} must not import three.js`);
    assert.doesNotMatch(src, /\bdocument\.|:\s*window\.|^window\./m, `${file} must not reference the DOM`);
  }
});

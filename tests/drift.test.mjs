import { test } from "node:test";
import assert from "node:assert/strict";
import { createDriftModel, DRIFT_PCT } from "../web/drift.js";

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Drive a straight line of totalDistanceM (heading 0) in fixed stepM chunks and return the final |offset|. */
function straightDriveOffsetMag(seed, driftPct, totalDistanceM, stepM) {
  const drift = createDriftModel({ seed, driftPct });
  let driven = 0;
  while (driven < totalDistanceM) {
    const step = Math.min(stepM, totalDistanceM - driven);
    drift.advance(step, 0);
    driven += step;
  }
  const { x, y } = drift.offsetM();
  return Math.hypot(x, y);
}

test("drift: DRIFT_PCT is fixed and documented as a game assumption", () => {
  assert.equal(DRIFT_PCT, 1);
});

test("drift: starts at zero offset before any distance is driven", () => {
  const drift = createDriftModel({ seed: 1 });
  assert.deepEqual(drift.offsetM(), { x: 0, y: 0 });
});

test("drift: advance(0, 0) is a no-op", () => {
  const drift = createDriftModel({ seed: 1 });
  drift.advance(0, 0);
  assert.deepEqual(drift.offsetM(), { x: 0, y: 0 });
});

test("drift: driftPct=0 gives exactly zero offset regardless of distance or seed", () => {
  for (const seed of [0, 1, 7, 99]) {
    const drift = createDriftModel({ seed, driftPct: 0 });
    for (let i = 0; i < 50; i++) drift.advance(20, 5);
    assert.deepEqual(drift.offsetM(), { x: 0, y: 0 }, `seed ${seed} must stay at zero offset with driftPct=0`);
  }
});

test("drift: same seed reproduces the identical offset sequence", () => {
  const a = createDriftModel({ seed: 99 });
  const b = createDriftModel({ seed: 99 });
  const seqA = [];
  const seqB = [];
  for (let i = 0; i < 30; i++) {
    a.advance(10, 0);
    b.advance(10, 0);
    seqA.push(a.offsetM());
    seqB.push(b.offsetM());
  }
  assert.deepEqual(seqA, seqB);
});

test("drift: different seeds diverge", () => {
  const a = createDriftModel({ seed: 1 });
  const b = createDriftModel({ seed: 2 });
  for (let i = 0; i < 30; i++) {
    a.advance(10, 0);
    b.advance(10, 0);
  }
  assert.notDeepEqual(a.offsetM(), b.offsetM());
});

// (1) Step invariance: the same 1.8km straight drive integrated at two very
// different tick sizes must give the same MEDIAN final offset over many
// seeds, because a fixed per-run heading bias rotates the whole straight
// displacement the same way no matter how it's chopped into ticks.
test("drift: step invariance - median final offset over 200 seeds is ~equal at dt=0.1 and dt=1/60 step sizes", () => {
  const N_SEEDS = 200;
  const DISTANCE_M = 1800;
  const SPEED_MPS = 3;
  const stepAt = (dt) => SPEED_MPS * dt;

  const magsDt01 = [];
  const magsDt60 = [];
  for (let seed = 0; seed < N_SEEDS; seed++) {
    magsDt01.push(straightDriveOffsetMag(seed, DRIFT_PCT, DISTANCE_M, stepAt(0.1)));
    magsDt60.push(straightDriveOffsetMag(seed, DRIFT_PCT, DISTANCE_M, stepAt(1 / 60)));
  }

  const medianDt01 = median(magsDt01);
  const medianDt60 = median(magsDt60);
  const deltaPct = (Math.abs(medianDt01 - medianDt60) / medianDt01) * 100;
  assert.ok(deltaPct < 5, `expected step-size invariance within 5%, got ${deltaPct.toFixed(2)}% (dt=0.1: ${medianDt01.toFixed(3)}m, dt=1/60: ${medianDt60.toFixed(3)}m)`);
});

// (2) Meaning: that median offset must actually land near DRIFT_PCT percent
// of distance driven, not just be step-invariant at some arbitrary value.
test("drift: median final offset over 200 seeds is within 15% of DRIFT_PCT percent of distance driven", () => {
  const N_SEEDS = 200;
  const DISTANCE_M = 1800;
  const mags = [];
  for (let seed = 0; seed < N_SEEDS; seed++) mags.push(straightDriveOffsetMag(seed, DRIFT_PCT, DISTANCE_M, 0.3));

  const medianMag = median(mags);
  const target = (DRIFT_PCT / 100) * DISTANCE_M;
  const deltaPct = (Math.abs(medianMag - target) / target) * 100;
  assert.ok(deltaPct <= 15, `expected median offset within 15% of ${target}m, got ${medianMag.toFixed(3)}m (${deltaPct.toFixed(2)}% off)`);
});

test("drift: a higher driftPct produces a larger median offset for the same drive", () => {
  const N_SEEDS = 60;
  const DISTANCE_M = 1800;
  const magsLow = [];
  const magsHigh = [];
  for (let seed = 0; seed < N_SEEDS; seed++) {
    magsLow.push(straightDriveOffsetMag(seed, 1, DISTANCE_M, 0.3));
    magsHigh.push(straightDriveOffsetMag(seed, 5, DISTANCE_M, 0.3));
  }
  assert.ok(median(magsHigh) > median(magsLow), `expected driftPct 5's median offset > driftPct 1's`);
});

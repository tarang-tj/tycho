import { test } from "node:test";
import assert from "node:assert/strict";
import { createDriftModel, DRIFT_PCT } from "../web/drift.js";

test("drift: DRIFT_PCT is fixed, documented, and in [1, 5]", () => {
  assert.equal(DRIFT_PCT, 3);
  assert.ok(DRIFT_PCT >= 1 && DRIFT_PCT <= 5);
});

test("drift: starts at zero offset before any distance is driven", () => {
  const drift = createDriftModel({ seed: 1 });
  assert.deepEqual(drift.offsetM(), { x: 0, y: 0 });
});

test("drift: advance(0) is a no-op", () => {
  const drift = createDriftModel({ seed: 1 });
  drift.advance(0);
  assert.deepEqual(drift.offsetM(), { x: 0, y: 0 });
});

test("drift: offset grows with distance driven", () => {
  const drift = createDriftModel({ seed: 5 });
  const mags = [];
  for (let i = 0; i < 50; i++) {
    drift.advance(20); // 20 m per step, matching a rover-scale tick
    const { x, y } = drift.offsetM();
    mags.push(Math.hypot(x, y));
  }
  // Not monotonic tick-to-tick (it's a walk), but the running max should
  // climb well past its early value as more distance accumulates.
  const earlyMax = Math.max(...mags.slice(0, 5));
  const lateMax = Math.max(...mags.slice(-5));
  assert.ok(lateMax > earlyMax, `expected drift to grow: early=${earlyMax} late=${lateMax}`);
});

test("drift: same seed reproduces the identical offset sequence", () => {
  const a = createDriftModel({ seed: 99 });
  const b = createDriftModel({ seed: 99 });
  const seqA = [];
  const seqB = [];
  for (let i = 0; i < 30; i++) {
    a.advance(10);
    b.advance(10);
    seqA.push(a.offsetM());
    seqB.push(b.offsetM());
  }
  assert.deepEqual(seqA, seqB);
});

test("drift: different seeds diverge", () => {
  const a = createDriftModel({ seed: 1 });
  const b = createDriftModel({ seed: 2 });
  for (let i = 0; i < 30; i++) {
    a.advance(10);
    b.advance(10);
  }
  assert.notDeepEqual(a.offsetM(), b.offsetM());
});

test("drift: a higher driftPct produces a larger offset for the same seed and distance", () => {
  const low = createDriftModel({ seed: 3, driftPct: 1 });
  const high = createDriftModel({ seed: 3, driftPct: 5 });
  for (let i = 0; i < 40; i++) {
    low.advance(20);
    high.advance(20);
  }
  const lowMag = Math.hypot(low.offsetM().x, low.offsetM().y);
  const highMag = Math.hypot(high.offsetM().x, high.offsetM().y);
  assert.ok(highMag > lowMag, `expected driftPct 5 > driftPct 1: ${highMag} vs ${lowMag}`);
});

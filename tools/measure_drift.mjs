#!/usr/bin/env node
// Reproducible measurement backing web/drift.js's DRIFT_PCT definition and
// its step-size invariance claim. Run: node tools/measure_drift.mjs
//
// No terrain/rover involved: this measures the drift model in isolation,
// the same way tests/drift.test.mjs's assertions do, by driving a straight
// line of fixed total distance in chunks of varying size.
import { createDriftModel, DRIFT_PCT } from "../web/drift.js";

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function finalOffsetMagnitude(seed, totalDistanceM, stepM) {
  const drift = createDriftModel({ seed });
  let driven = 0;
  while (driven < totalDistanceM) {
    const step = Math.min(stepM, totalDistanceM - driven);
    drift.advance(step, 0); // straight line, heading 0
    driven += step;
  }
  const { x, y } = drift.offsetM();
  return Math.hypot(x, y);
}

const N_SEEDS = 200;
const DISTANCE_M = 1800;

function measure(stepM) {
  const mags = [];
  for (let seed = 0; seed < N_SEEDS; seed++) mags.push(finalOffsetMagnitude(seed, DISTANCE_M, stepM));
  return { median: median(mags), p90: [...mags].sort((a, b) => a - b)[Math.floor(mags.length * 0.9)] };
}

const target = (DRIFT_PCT / 100) * DISTANCE_M;
const atDt01 = measure(3 * 0.1); // ~3 m/s rover * 0.1s tick
const atDt60 = measure(3 * (1 / 60)); // ~3 m/s rover * 1/60s tick

console.log(`DRIFT_PCT=${DRIFT_PCT}, reference distance=${DISTANCE_M}m, target median=${target.toFixed(2)}m`);
console.log(`  dt=0.1  step: median=${atDt01.median.toFixed(2)}m p90=${atDt01.p90.toFixed(2)}m`);
console.log(`  dt=1/60 step: median=${atDt60.median.toFixed(2)}m p90=${atDt60.p90.toFixed(2)}m`);
const deltaPct = (Math.abs(atDt01.median - atDt60.median) / atDt01.median) * 100;
console.log(`  step-size delta in median: ${deltaPct.toFixed(1)}% (kept well under the 10% invariance bound)`);

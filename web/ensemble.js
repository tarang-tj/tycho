// Pure N-seed ensemble summary over sol-sim.js's headless drive, for the
// "Dry run" flight-rules loop. No DOM/three.js dependency, deterministic
// given (terrain, plan, guardrails, baseSeed).
import { runSolPlan } from "./sol-sim.js";

const Z_95 = 1.959963985; // two-sided 95% normal quantile

/** Wilson score interval for `successes` out of `n`, safe at n=0. */
function wilson95(successes, n) {
  if (n === 0) return [0, 0];
  const p = successes / n;
  const z2 = Z_95 * Z_95;
  const denom = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = Z_95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return [Math.max(0, (center - margin) / denom), Math.min(1, (center + margin) / denom)];
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Run N seeded headless sols of the same plan/guardrails and summarize the
 * outcome distribution.
 * @param {object} params
 * @param {object} params.terrain
 * @param {{x:number,y:number}} params.spawn
 * @param {{x:number,y:number}[]} params.waypoints
 * @param {object} [params.guardrails]
 * @param {number} [params.N]
 * @param {number} [params.baseSeed]
 * @param {number} [params.driftPct]
 */
export function ensemble({ terrain, spawn, waypoints, guardrails, N = 20, baseSeed = 0, driftPct } = {}) {
  const runs = [];
  const counts = { arrived: 0, held: 0, tipped: 0, stalled: 0 };

  for (let i = 0; i < N; i++) {
    const seed = baseSeed + i;
    const result = runSolPlan({ terrain, spawn, waypoints, guardrails, seed, driftPct });
    counts[result.outcome] = (counts[result.outcome] ?? 0) + 1;
    runs.push({ seed, outcome: result.outcome, distanceM: result.distanceM, timeSec: result.timeSec });
  }

  return {
    n: N,
    counts,
    arrivalRate: N ? counts.arrived / N : 0,
    wilson95: wilson95(counts.arrived, N),
    medianDistanceM: median(runs.map((r) => r.distanceM)),
    runs,
  };
}

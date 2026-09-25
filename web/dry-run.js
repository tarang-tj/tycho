// Orchestrates a Flight Rules "Dry run": N seeded headless sols of the
// current plan (ensemble.js's shape), run off the main thread via a module
// Worker (ensemble-worker.js) so the render loop keeps rendering, with a
// same-thread chunked fallback for engines without module Worker support.
// Both paths resolve with the SAME shape ensemble.js's ensemble() returns.
import { runSolPlan } from "./sol-sim.js";
import { DRY_RUN_N, DRY_RUN_BASE_SEED } from "./mars-run.js";

const CHUNK_SIZE = 5; // seeds run per macrotask in the fallback path - small
// enough (at the ~4ms/run node rate tools/measure_fixture_rate.mjs
// measured; a browser main thread may be slower but this still keeps each
// chunk well under a frame budget) that requestAnimationFrame keeps firing
// between chunks instead of the dry run blocking the render loop outright.

const Z_95 = 1.959963985; // two-sided 95% normal quantile - the same
// constant ensemble.js uses for its Wilson score interval. Duplicated here
// (with wilson95()/median() below) only because the chunked fallback
// accumulates results ACROSS setTimeout yields, which ensemble.js's single
// synchronous call has no hook for; tests/dry-run.test.mjs pins this
// module's output against ensemble.js's own output for identical inputs,
// so a future change to ensemble.js's formula fails loudly here too instead
// of the two silently drifting apart.
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

function summarize(runs, n) {
  const counts = { arrived: 0, held: 0, tipped: 0, stalled: 0 };
  for (const r of runs) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
  return {
    n,
    counts,
    arrivalRate: n ? counts.arrived / n : 0,
    wilson95: wilson95(counts.arrived, n),
    medianDistanceM: median(runs.map((r) => r.distanceM)),
    runs,
  };
}

/**
 * Same-thread chunked ensemble: identical inputs/output shape to
 * ensemble.js's ensemble(), but yields to the event loop every CHUNK_SIZE
 * seeds via setTimeout(0) so requestAnimationFrame keeps firing during the
 * run. Used when a module Worker can't be constructed.
 */
export async function runChunkedEnsemble({ terrain, spawn, waypoints, guardrails, N = DRY_RUN_N, baseSeed = DRY_RUN_BASE_SEED, driftPct }, onProgress) {
  const runs = [];
  for (let i = 0; i < N; i++) {
    const seed = baseSeed + i;
    const result = runSolPlan({ terrain, spawn, waypoints, guardrails, seed, driftPct });
    runs.push({ seed, outcome: result.outcome, distanceM: result.distanceM, timeSec: result.timeSec });
    if ((i + 1) % CHUNK_SIZE === 0 || i === N - 1) {
      onProgress?.(i + 1, N);
      // eslint-disable-next-line no-await-in-loop -- the whole point is to yield here
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  return summarize(runs, N);
}

/**
 * Run a Flight Rules dry run: N=100 seeded headless sols of the current
 * plan (see mars-run.js for why N=100). Tries a module Worker first
 * (ensemble-worker.js, off the main thread entirely), handing it the
 * caller's ALREADY-LOADED terrain (raw elevations/mask arrays + meta) so it
 * never re-fetches the asset files itself; falls back to the same-thread
 * chunked run above - on this same real terrain - if module Workers can't
 * be constructed, error out, or report failure (`ok: false`). The worker
 * never invents synthetic terrain on a failure (review finding 3): any
 * failure to build/run against the real terrain always lands here, on the
 * real terrain, never a silent synthetic-terrain prediction.
 */
export function runDryRun({ terrain, spawn, waypoints, guardrails, N = DRY_RUN_N, baseSeed = DRY_RUN_BASE_SEED, driftPct }, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const fallback = () => runChunkedEnsemble({ terrain, spawn, waypoints, guardrails, N, baseSeed, driftPct }, onProgress).then(resolve, reject);

    let worker;
    try {
      worker = new Worker(new URL("./ensemble-worker.js", import.meta.url), { type: "module" });
    } catch {
      fallback();
      return;
    }

    const requestId = `${Date.now()}-${Math.random()}`;
    let settled = false;
    worker.addEventListener("message", (event) => {
      if (settled || event.data?.requestId !== requestId) return;
      settled = true;
      worker.terminate();
      if (event.data.ok) resolve(event.data.result);
      else fallback(); // the worker ran but couldn't build/use the real terrain: still answer the dry run, on the main thread's real terrain
    });
    worker.addEventListener("error", () => {
      if (settled) return;
      settled = true;
      worker.terminate();
      fallback(); // the Worker itself failed to boot/run: still answer the dry run, just on the main thread
    });
    worker.postMessage({
      requestId, spawn, waypoints, guardrails, N, baseSeed, driftPct,
      terrain: {
        width: terrain.width, height: terrain.height, metersPerPixel: terrain.metersPerPixel,
        synthetic: terrain.synthetic, meta: terrain.meta, elevations: terrain.elevations, mask: terrain.mask,
      },
    });
  });
}

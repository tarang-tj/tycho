// Node has no global Worker (verified: `typeof Worker === "undefined"`), so
// every runDryRun() call in this suite exercises the same-thread chunked
// fallback path (runChunkedEnsemble) - the Worker path itself is proven by
// scripts/verify_boot.mjs in a real browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSyntheticTerrain } from "../web/terrain-data.js";
import { DEFAULT_GUARDRAILS } from "../web/copilot.js";
import { ensemble } from "../web/ensemble.js";
import { runChunkedEnsemble, runDryRun } from "../web/dry-run.js";
import { DRY_RUN_N, DRY_RUN_BASE_SEED } from "../web/mars-run.js";

const terrain = createSyntheticTerrain({ seed: 2 });
const spawn = { x: terrain.width / 2, y: terrain.height / 2 };
const waypoints = [{ x: spawn.x + 3, y: spawn.y }];

test("runChunkedEnsemble: output shape/values match ensemble.js's ensemble() for identical inputs", async () => {
  const params = { terrain, spawn, waypoints, guardrails: DEFAULT_GUARDRAILS, N: 10, baseSeed: 0, driftPct: 1 };
  const chunked = await runChunkedEnsemble(params);
  const direct = ensemble(params);
  assert.deepEqual(chunked, direct);
});

test("runChunkedEnsemble: calls onProgress with monotonically increasing counts up to N", async () => {
  const calls = [];
  await runChunkedEnsemble({ terrain, spawn, waypoints, guardrails: DEFAULT_GUARDRAILS, N: 12, baseSeed: 0, driftPct: 1 }, (done, n) => calls.push([done, n]));
  assert.ok(calls.length > 0);
  for (const [done, n] of calls) assert.equal(n, 12);
  assert.equal(calls.at(-1)[0], 12);
  for (let i = 1; i < calls.length; i++) assert.ok(calls[i][0] > calls[i - 1][0]);
});

test("runDryRun: falls back to the chunked path (no Worker in node) and resolves the same shape ensemble() returns", async () => {
  assert.equal(typeof Worker, "undefined", "precondition: this suite must run where Worker is unavailable");
  const summary = await runDryRun({ terrain, assetKey: "mars", spawn, waypoints, guardrails: DEFAULT_GUARDRAILS, N: DRY_RUN_N, baseSeed: DRY_RUN_BASE_SEED, driftPct: 1 });
  assert.equal(summary.n, DRY_RUN_N);
  assert.equal(summary.counts.arrived + summary.counts.held + summary.counts.tipped + summary.counts.stalled, DRY_RUN_N);
  assert.equal(summary.runs.length, DRY_RUN_N);
  assert.equal(summary.runs[0].seed, DRY_RUN_BASE_SEED);
});

test("runDryRun: is deterministic for the same inputs (same seeds -> same summary)", async () => {
  const params = { terrain, assetKey: "mars", spawn, waypoints, guardrails: DEFAULT_GUARDRAILS, N: 8, baseSeed: 0, driftPct: 1 };
  const a = await runDryRun(params);
  const b = await runDryRun(params);
  assert.deepEqual(a, b);
});

// review W2 re-review new_issues #3: no automated test covered the
// ok:false branch (worker built/ran but couldn't use the real terrain) -
// only the "no Worker at all" path above was exercised. A fake Worker that
// constructs fine but always replies ok:false proves that branch falls
// back to the SAME chunked result runChunkedEnsemble()/ensemble() give for
// identical inputs, same as the no-Worker path already proves.
test("runDryRun: an ok:false Worker reply falls back to the chunked result matching ensemble()", async () => {
  const params = { terrain, spawn, waypoints, guardrails: DEFAULT_GUARDRAILS, N: 8, baseSeed: 0, driftPct: 1 };

  class FakeFailingWorker {
    constructor() {
      this.listeners = {};
    }
    addEventListener(type, cb) {
      this.listeners[type] = cb;
    }
    postMessage(data) {
      setTimeout(() => this.listeners.message?.({ data: { requestId: data.requestId, ok: false } }), 0);
    }
    terminate() {}
  }

  const originalWorker = globalThis.Worker;
  globalThis.Worker = FakeFailingWorker;
  let fallbackResult;
  try {
    fallbackResult = await runDryRun(params);
  } finally {
    if (originalWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = originalWorker;
  }

  const direct = ensemble(params);
  assert.deepEqual(fallbackResult, direct);
});

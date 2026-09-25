// Measures the committed Mars fixture's arrival rate over many seed blocks,
// to size the in-game dry run honestly (how noisy is an N-run estimate?).
// Usage: node tools/measure_fixture_rate.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseTerrain } from "../web/terrain-data.js";
import { DEFAULT_GUARDRAILS } from "../web/copilot.js";
import { ensemble } from "../web/ensemble.js";
import { DRIFT_PCT } from "../web/drift.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const meta = JSON.parse(readFileSync(`${root}assets/mars/meta.json`, "utf8"));
const h = readFileSync(`${root}assets/mars/height.bin`);
const m = readFileSync(`${root}assets/mars/mask.bin`);
const terrain = parseTerrain(
  h.buffer.slice(h.byteOffset, h.byteOffset + h.byteLength),
  meta,
  m.buffer.slice(m.byteOffset, m.byteOffset + m.byteLength),
);
const fixture = JSON.parse(readFileSync(`${root}tests/fixtures/mars-mixed-plan.json`, "utf8"));
const guardrails = { ...DEFAULT_GUARDRAILS, maxSlopeDeg: 31, hazardMode: "stop" };
const t0 = Date.now();
const big = ensemble({ terrain, spawn: fixture.spawn, waypoints: fixture.waypoints, guardrails, N: 400, baseSeed: 0, driftPct: DRIFT_PCT });
console.log(`N=400 arrivalRate ${big.arrivalRate} wilson95 ${big.wilson95.map((v) => v.toFixed(3)).join("-")} (${Date.now() - t0} ms)`);
for (const n of [20, 50, 100]) {
  const rates = [];
  for (let block = 0; block < 400 / n; block += 1) {
    rates.push(ensemble({ terrain, spawn: fixture.spawn, waypoints: fixture.waypoints, guardrails, N: n, baseSeed: block * n, driftPct: DRIFT_PCT }).arrivalRate);
  }
  const min = Math.min(...rates).toFixed(2);
  const max = Math.max(...rates).toFixed(2);
  console.log(`N=${n}: ${rates.length} blocks, arrival rate ranges ${min}..${max}`);
}

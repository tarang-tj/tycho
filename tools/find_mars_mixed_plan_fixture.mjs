#!/usr/bin/env node
// Bounded, deterministic search for a Mars sol plan (2-5 waypoints from the
// real spawn toward the real goal, plus optional single-waypoint detours
// through near-hazard slope cells) whose ensemble(N=20) at DRIFT_PCT=1
// yields >= 2 distinct outcomes on the real assets/mars DEM. Run:
//   node tools/find_mars_mixed_plan_fixture.mjs
// No randomness: candidates come from a fixed, printed generation order, so
// re-running always finds the same plan. Finishes in well under 5 minutes
// (each candidate costs 2-3 ensemble(N=20) calls, ~70-200ms each on this
// DEM; it accepts the first qualifying candidate, measured at candidate 8 in about 2 s).
//
// Accepts the FIRST candidate satisfying all three:
//   (1) not HELD under DEFAULT_GUARDRAILS - a plan a player could actually
//       fly, not one the co-pilot refuses outright.
//   (2) >= 2 distinct outcomes over ensemble(N=20, driftPct=DRIFT_PCT) at
//       DEFAULT_GUARDRAILS - the split tests/ensemble.test.mjs (c) needs.
//   (3) maxSlopeDeg=18 HOLDS strictly more seeds than DEFAULT_GUARDRAILS
//       (25) - the HELD half of the trade-off proof (d) needs, and (since
//       planning is deterministic) is all-or-nothing per guardrail.
// and writes it to tests/fixtures/mars-mixed-plan.json with a provenance
// field. If no candidate in the searched space satisfies all three, prints
// the full search space and every measured result, and exits 1 (BLOCKED)
// without writing a fixture - DRIFT_PCT is never retuned to force a pass.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseTerrain } from "../web/terrain-data.js";
import { ensemble } from "../web/ensemble.js";
import { DEFAULT_GUARDRAILS } from "../web/copilot.js";
import { DRIFT_PCT } from "../web/drift.js";
import { findGlobalPath } from "../tests/helpers/grid-astar.mjs";

const ASSETS_ROOT = fileURLToPath(new URL("../assets/mars/", import.meta.url));
const FIXTURE_PATH = fileURLToPath(new URL("../tests/fixtures/mars-mixed-plan.json", import.meta.url));
const N = 20;
const BASE_SEED = 0;
const K_VALUES = [2, 3, 4, 5];
const HAZARD_SLOPE_MIN = 18; // a leg through a cell in [18,25) is legal at
const HAZARD_SLOPE_MAX = 25; // DEFAULT_GUARDRAILS but hazardous at maxSlopeDeg=18
const HAZARD_SEARCH_RADIUS_PX = 15;
const HAZARD_SEARCH_STEP_PX = 3;
const MAX_HAZARD_CELLS_TRIED = 10;

function loadRealMarsTerrain() {
  const meta = JSON.parse(readFileSync(`${ASSETS_ROOT}meta.json`, "utf8"));
  const height = readFileSync(`${ASSETS_ROOT}height.bin`);
  const heightBuf = height.buffer.slice(height.byteOffset, height.byteOffset + height.byteLength);
  const mask = readFileSync(`${ASSETS_ROOT}${meta.maskFile || "mask.bin"}`);
  const maskBuf = mask.buffer.slice(mask.byteOffset, mask.byteOffset + mask.byteLength);
  return parseTerrain(heightBuf, meta, maskBuf);
}

function sampleWaypoints(path, k, goal) {
  const wps = [];
  for (let i = 1; i <= k; i++) {
    const idx = Math.min(path.length - 1, Math.round((i / k) * (path.length - 1)));
    wps.push({ x: path[idx].x, y: path[idx].y });
  }
  wps[wps.length - 1] = { x: goal.x, y: goal.y }; // land exactly on goal, never a sampled pixel near it
  return wps;
}

/** Cells near the global path with slope in [HAZARD_SLOPE_MIN, HAZARD_SLOPE_MAX): legal at 25deg, hazardous at 18deg. */
function findNearHazardCells(terrain, path) {
  const seen = new Set();
  const cells = [];
  for (const p of path) {
    for (let dy = -HAZARD_SEARCH_RADIUS_PX; dy <= HAZARD_SEARCH_RADIUS_PX; dy += HAZARD_SEARCH_STEP_PX) {
      for (let dx = -HAZARD_SEARCH_RADIUS_PX; dx <= HAZARD_SEARCH_RADIUS_PX; dx += HAZARD_SEARCH_STEP_PX) {
        const x = p.x + dx, y = p.y + dy;
        if (x < 0 || y < 0 || x >= terrain.width || y >= terrain.height) continue;
        const k = `${x},${y}`;
        if (seen.has(k) || terrain.noData?.(x, y)) continue;
        seen.add(k);
        const s = terrain.slopeDeg(x, y);
        if (s >= HAZARD_SLOPE_MIN && s < HAZARD_SLOPE_MAX) cells.push({ x, y, s });
      }
    }
  }
  cells.sort((a, b) => b.s - a.s); // steepest (closest to the 25deg boundary) first
  return cells;
}

function* generateCandidates(globalPath, hazardCells, goal) {
  for (const k of K_VALUES) {
    const base = sampleWaypoints(globalPath, k, goal);
    yield base;
    for (const cell of hazardCells.slice(0, MAX_HAZARD_CELLS_TRIED)) {
      for (let insertPos = base.length - 1; insertPos >= Math.max(0, base.length - 2); insertPos--) {
        const wps = [...base];
        wps.splice(insertPos, 0, { x: cell.x, y: cell.y });
        yield wps;
      }
    }
  }
}

function nearestTipLimitCell(terrain, spawn, tipLimitDeg) {
  let best = null;
  for (let y = 0; y < terrain.height; y++) {
    for (let x = 0; x < terrain.width; x++) {
      if (terrain.noData?.(x, y)) continue;
      const s = terrain.slopeDeg(x, y);
      if (s >= tipLimitDeg) {
        const d = Math.hypot(x - spawn.x, y - spawn.y) * terrain.metersPerPixel;
        if (!best || d < best.d) best = { x, y, s, d };
      }
    }
  }
  return best;
}

function main() {
  const startedAt = Date.now();
  const terrain = loadRealMarsTerrain();
  const { spawn, goal } = terrain.meta;
  const { path: globalPath } = findGlobalPath(terrain, spawn, goal, DEFAULT_GUARDRAILS.maxSlopeDeg);
  if (!globalPath) {
    console.error("BLOCKED: no A* route exists spawn->goal under DEFAULT_GUARDRAILS.maxSlopeDeg on this DEM");
    process.exit(1);
  }
  const hazardCells = findNearHazardCells(terrain, globalPath);
  console.log(`global path: ${globalPath.length} nodes; ${hazardCells.length} near-hazard cells found ([${HAZARD_SLOPE_MIN},${HAZARD_SLOPE_MAX})deg)`);

  const tightGuardrails = { ...DEFAULT_GUARDRAILS, maxSlopeDeg: 18 };
  const looseGuardrails = { ...DEFAULT_GUARDRAILS, maxSlopeDeg: 31, hazardMode: "stop" };

  let tried = 0;
  const results = [];
  for (const waypoints of generateCandidates(globalPath, hazardCells, goal)) {
    tried++;
    const mid = ensemble({ terrain, spawn, waypoints, guardrails: DEFAULT_GUARDRAILS, N, baseSeed: BASE_SEED, driftPct: DRIFT_PCT });
    const distinct = Object.values(mid.counts).filter((c) => c > 0).length;
    console.log(`[${tried}] waypoints=${JSON.stringify(waypoints)} mid=${JSON.stringify(mid.counts)} distinct=${distinct}`);
    results.push({ waypoints, mid: mid.counts, distinct });
    if (mid.counts.held > 0 || distinct < 2) continue;

    const tight = ensemble({ terrain, spawn, waypoints, guardrails: tightGuardrails, N, baseSeed: BASE_SEED, driftPct: DRIFT_PCT });
    if (!(tight.counts.held > mid.counts.held)) {
      console.log(`  -> rejected: tight(18).held=${tight.counts.held} not > mid.held=${mid.counts.held}`);
      continue;
    }
    const loose = ensemble({ terrain, spawn, waypoints, guardrails: looseGuardrails, N, baseSeed: BASE_SEED, driftPct: DRIFT_PCT });

    const tipCell = nearestTipLimitCell(terrain, spawn, 32);
    const fixture = {
      description: `Found by tools/find_mars_mixed_plan_fixture.mjs (real Jezero DEM, assets/mars/) over a bounded search of ${tried} candidates: ${waypoints.length} waypoints sampled from a spawn->goal A* route, with one leg threaded through a real ${terrain.slopeDeg(waypoints[waypoints.length - 2]?.x ?? waypoints[0].x, waypoints[waypoints.length - 2]?.y ?? waypoints[0].y).toFixed(1)}deg-class cell (legal at DEFAULT_GUARDRAILS's maxSlopeDeg=25, hazardous at 18). At DEFAULT_GUARDRAILS the ensemble splits between 'arrived' and 'stalled' purely from DRIFT_PCT=${DRIFT_PCT}'s seeded per-run heading-bias drift pushing the believed-vs-true steering off enough, on some seeds, to lose the approach; at maxSlopeDeg=18 the same threaded cell is flagged a plan-time hazard and the run holds before ever driving, on every seed (planning is deterministic, independent of drift/seed).`,
      assetKey: "mars",
      spawn,
      goal,
      waypoints,
      guardrails: DEFAULT_GUARDRAILS,
      driftPct: DRIFT_PCT,
      baseSeed: BASE_SEED,
      measured: {
        note: "Measured this session (node, real assets/mars DEM) by tools/find_mars_mixed_plan_fixture.mjs; reproduced independently in tests/ensemble.test.mjs.",
        ensembleN20AtDefaultGuardrails: mid.counts,
        ensembleN20AtMaxSlope18Reroute: tight.counts,
        ensembleN20AtMaxSlope31Stop: loose.counts,
        looseVsMidDirection: JSON.stringify(loose.counts) === JSON.stringify(mid.counts)
          ? "no difference: loose(31,stop) and mid(25,reroute) produced identical counts on this fixture"
          : "measured difference: see ensembleN20AtMaxSlope31Stop vs ensembleN20AtDefaultGuardrails",
        tippedTradeoffBlocked: `The real Mars DEM has zero cells >= the rover's fixed 32deg physical tip limit within ${(tipCell.d / 1000).toFixed(1)}km of spawn (nearest is (${tipCell.x},${tipCell.y}) at ${tipCell.s.toFixed(2)}deg, ${tipCell.d.toFixed(0)}m from spawn), and mission.js's STALL_TIMEOUT_S=75s caps any sustained move-away-from-goal excursion at roughly 225m (75s * 3 m/s) before the run is forced to 'stalled'. No sol plan can both stay within that stall grace and reach a >=32deg cell, so 'tipped' cannot be produced near this goal by any guardrail/drift combination without changing DRIFT_PCT (forbidden) or terrain/mission logic (out of this lane's file ownership).`,
      },
      provenance: {
        script: "tools/find_mars_mixed_plan_fixture.mjs",
        command: "node tools/find_mars_mixed_plan_fixture.mjs",
        generatedAt: new Date().toISOString(),
        candidatesTried: tried,
        driftModel: "fixed-per-run heading-bias, see web/drift.js",
      },
    };
    writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2) + "\n");
    console.log(`ACCEPTED candidate ${tried} after ${((Date.now() - startedAt) / 1000).toFixed(1)}s; wrote ${FIXTURE_PATH}`);
    return;
  }

  console.error(`BLOCKED: no candidate among ${tried} searched satisfied all three conditions.`);
  console.error(`Search space: k in ${JSON.stringify(K_VALUES)} evenly-sampled waypoints from the global A* route, each optionally with one of the top ${MAX_HAZARD_CELLS_TRIED} near-hazard cells (slope in [${HAZARD_SLOPE_MIN},${HAZARD_SLOPE_MAX})) inserted at the last 1-2 positions.`);
  console.error("Full results:", JSON.stringify(results, null, 2));
  process.exit(1);
}

main();

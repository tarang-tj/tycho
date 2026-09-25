// Winnability proof: loads the REAL shipped assets (height.bin, meta.json,
// mask.bin via fs) and runs headless bots built only from the pure modules
// (no DOM/three.js) to prove both levels are actually completable end to
// end - not just that the individual modules pass their own unit tests.
//
// Moon: a controller that sees only DELAYED telemetry (signal.js, 1.28s
// each way) and steers toward the goal along a precomputed safe route,
// exactly as a live player would steer against what they last saw.
// Mars: a 2-4 waypoint sol plan uplinked (through the real compressed
// delay) and driven autonomously by the co-pilot (copilot.js's planRoute),
// exactly as main.js drives a delivered "plan" command.
//
// Deterministic, fixed-dt, no wall-clock reads: fast and reproducible.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseTerrain } from "../web/terrain-data.js";
import { createRover, stepRover, steerTowardPoint } from "../web/rover-sim.js";
import { createSignalLink } from "../web/signal.js";
import { planRoute, DEFAULT_GUARDRAILS } from "../web/copilot.js";
import { createMission, startMission, updateMission, whatHappenedLine } from "../web/mission.js";
import { LEVELS, LEVEL_ORDER, MARS_SCENARIOS, resolveDelaySec, resolveScenario } from "../web/levels.js";
import { findGlobalPath } from "./helpers/grid-astar.mjs";

const ASSETS_ROOT = fileURLToPath(new URL("../assets/", import.meta.url));
const GOAL_RADIUS_M = 15;
const WAYPOINT_ARRIVE_RADIUS_M = 6;
// Every live-mode level's delayed-telemetry bot must arrive within this
// much SIMULATED game time, or the level is too long to be fun (not a
// winnability question - all these levels ARE winnable, this is a
// playability/pacing budget). Chang'e-4 blew through this at ~4700s before
// its spawn-selection fix (levelup v3); this constant is the regression
// guard for that class of bug.
const LIVE_BOT_ARRIVAL_BUDGET_S = 2000;

/** True only if a level's real height.bin + meta.json are present in this checkout. */
function hasRealAssets(assetKey) {
  return existsSync(`${ASSETS_ROOT}${assetKey}/height.bin`) && existsSync(`${ASSETS_ROOT}${assetKey}/meta.json`);
}

// M4: missing assets for a level that ships (is in LEVEL_ORDER) must FAIL
// the gate, not silently SKIP - a level with missing assets used to slip
// through as a green skip while the data lane was pending; now every
// LEVEL_ORDER level ships, so a missing directory is a real regression.
// Set TYCHO_ALLOW_MISSING_ASSETS=1 to intentionally skip during a data
// lane still in progress.
const ALLOW_MISSING_ASSETS = process.env.TYCHO_ALLOW_MISSING_ASSETS === "1";

/** Registers `name` as a real test, a `skip`ped test (only if explicitly allowed), or a failing test. */
function registerAssetGatedTest(name, assetKey, run) {
  if (hasRealAssets(assetKey)) {
    test(name, run);
    return;
  }
  if (ALLOW_MISSING_ASSETS) {
    test(name, { skip: `assets/${assetKey}/ not present in this worktree (TYCHO_ALLOW_MISSING_ASSETS=1)` }, () => {});
    return;
  }
  test(name, () => {
    assert.fail(`assets/${assetKey}/ is missing (height.bin/meta.json not found). Every level in ` +
      "LEVEL_ORDER must ship real assets. If this is intentional (e.g. a data lane still in progress), " +
      "set TYCHO_ALLOW_MISSING_ASSETS=1 to skip it explicitly.");
  });
}

function loadRealTerrain(body) {
  const base = `${ASSETS_ROOT}${body}/`;
  const meta = JSON.parse(readFileSync(`${base}meta.json`, "utf8"));
  const height = readFileSync(`${base}height.bin`);
  const heightBuf = height.buffer.slice(height.byteOffset, height.byteOffset + height.byteLength);
  let maskBuf = null;
  try {
    const mask = readFileSync(`${base}${meta.maskFile || "mask.bin"}`);
    maskBuf = mask.buffer.slice(mask.byteOffset, mask.byteOffset + mask.byteLength);
  } catch {
    // no mask shipped for this body: parseTerrain tolerates null.
  }
  const terrain = parseTerrain(heightBuf, meta, maskBuf);
  assert.equal(terrain.synthetic, false, `${body}: expected the real DEM, not a synthetic fallback`);
  return terrain;
}

/** Downsample a dense A* path into at most `n` evenly-spaced intermediate waypoints (excluding the start). */
function downsample(path, n) {
  const waypoints = [];
  for (let i = 1; i <= n; i++) {
    const idx = Math.min(path.length - 1, Math.round((i / n) * (path.length - 1)));
    waypoints.push(path[idx]);
  }
  return waypoints;
}

// --- A* reachability: both bodies must have a real spawn->goal route -----

// One directory per distinct assets/<assetKey>/ (several levels can share
// one, e.g. Tycho and Mars/Jezero use "moon"/"mars"; dedupe so each real
// asset directory is only walked once).
const ASSET_DIRS = [...new Set(LEVEL_ORDER.map((key) => LEVELS[key].assetKey))];

for (const assetKey of ASSET_DIRS) {
  registerAssetGatedTest(`${assetKey}: A* finds a spawn->goal path under the default slope guardrail`, assetKey, () => {
    const terrain = loadRealTerrain(assetKey);
    const { spawn, goal } = terrain.meta;
    const { path, iterations } = findGlobalPath(terrain, spawn, goal, DEFAULT_GUARDRAILS.maxSlopeDeg);
    assert.ok(path, `${assetKey}: no path found from spawn to goal under ${DEFAULT_GUARDRAILS.maxSlopeDeg}deg after ${iterations} iterations`);
    assert.ok(path.length > 1, `${assetKey}: path should have more than one point`);
    for (const p of path) {
      assert.ok(terrain.slopeDeg(p.x, p.y) <= DEFAULT_GUARDRAILS.maxSlopeDeg + 1e-6, `${assetKey}: path point (${p.x},${p.y}) exceeds the slope guardrail`);
      assert.equal(terrain.noData?.(p.x, p.y) ?? false, false, `${assetKey}: path point (${p.x},${p.y}) crosses a no-data cell`);
    }
  });
}

// --- Moon: live delayed-telemetry bot, driven through the REAL mission state machine ---

test("moon: a delayed-telemetry bot reaches the goal from spawn without tipping or driving onto no-data terrain", () => {
  const terrain = loadRealTerrain("moon");
  const { spawn, goal } = terrain.meta;
  const delaySec = terrain.meta.delayOneWaySec ?? 1.28;
  assert.ok(delaySec > 0, "moon delay must be the real, positive one-way light-time delay");

  // Plan the route with a safety margin (30deg) below rover-sim's physical
  // tip limit (32deg) AND a one-cell dilation (~4.7m real safety buffer on
  // every side of the route, not just the sampled centerline): a live-
  // delayed player reacts to stale telemetry and will not track the
  // planned line with pixel precision, so a route that only just barely
  // threads between two hazards (a "knife-edge") is not actually safe to
  // follow under real control lag, even though every individual sampled
  // point on it is under the limit.
  const PLANNING_MARGIN_DEG = 30;
  const { path } = findGlobalPath(terrain, spawn, goal, PLANNING_MARGIN_DEG, 1, 500000, 1);
  assert.ok(path, "precondition: a safe, dilated (margin-buffered) route must exist");

  const signal = createSignalLink(delaySec);
  let trueState = createRover({ x: spawn.x, y: spawn.y, heading: 0 });
  let currentControl = { throttle: 0, steer: 0 };
  let waypointIndex = 0;
  let lastCommandAt = -Infinity;
  const CONTROL_INTERVAL_S = 0.1; // how often a "player" reacts to new telemetry
  const dt = 1 / 20;
  const BUDGET_S = 3000; // generous SIMULATED time; runs in well under a second of wall clock
  let maxSlopeEncountered = 0;
  let simTime = 0;

  let mission = startMission(createMission("moon"), 0);
  let visibleState = null;

  for (; simTime < BUDGET_S && mission.status === "active"; simTime += dt) {
    for (const cmd of signal.pullDeliveredCommands(simTime)) currentControl = cmd;

    trueState = stepRover(trueState, currentControl, terrain, dt);
    assert.equal(trueState.tipped, false, `moon bot tipped at simTime=${simTime.toFixed(2)}s, slope=${trueState.slopeDeg?.toFixed(1)}deg`);
    assert.equal(trueState.stopped, false, `moon bot stopped (${trueState.stopReason}) at simTime=${simTime.toFixed(2)}s`);
    maxSlopeEncountered = Math.max(maxSlopeEncountered, trueState.slopeDeg);

    // Mirrors main.js's tickPhysics telemetry stamp: Moon has no sol plan, so
    // planActive is always true (mission.js only gates the stall clock on it
    // for Mars - see the C1 fix in mission.js).
    signal.telemetry({ ...trueState, copilotHold: null, planActive: true }, simTime);
    const visible = signal.visibleTelemetry(simTime);
    if (visible) visibleState = visible;

    mission = updateMission(mission, { visibleTelemetry: visibleState, simTime, terrain, telemetryAgeSec: signal.telemetryAge(simTime) });

    if (visibleState && simTime - lastCommandAt >= CONTROL_INTERVAL_S) {
      lastCommandAt = simTime;
      let target = path[waypointIndex] ?? goal;
      const distM = Math.hypot(visibleState.state.x - target.x, visibleState.state.y - target.y) * terrain.metersPerPixel;
      if (distM < WAYPOINT_ARRIVE_RADIUS_M && waypointIndex < path.length - 1) { waypointIndex += 1; target = path[waypointIndex]; }
      const control = steerTowardPoint(visibleState.state, target);
      signal.uplink(control, simTime);
    }
  }

  assert.equal(mission.status, "won", `moon bot failed to reach the goal within ${BUDGET_S}s (sim); mission ended "${mission.status}" (${whatHappenedLine(mission)}); final true position (${trueState.x.toFixed(1)},${trueState.y.toFixed(1)})`);
  assert.equal(mission.outcome, "arrived");
  assert.ok(simTime <= LIVE_BOT_ARRIVAL_BUDGET_S,
    `moon bot took ${simTime.toFixed(1)}s to arrive, exceeding the ${LIVE_BOT_ARRIVAL_BUDGET_S}s playability budget`);
  console.log(`  [moon bot] arrived in ${simTime.toFixed(1)}s sim time, max slope encountered ${maxSlopeEncountered.toFixed(1)}deg, path points ${path.length}`);
});

// --- Lunokhod: live delayed-telemetry bot, same shape as the Moon/Tycho bot ---
// (U1: the flagship level - drive to where Lunokhod 2 has been parked since 1973)

// Le Monnier's crater-field microterrain (small scattered craters near the
// spawn->goal line) makes the raw 1px-step A* route noticeably more jagged
// than Tycho's single
// clean climb: following it one waypoint at a time (WAYPOINT_ARRIVE_RADIUS_M)
// forces a full course-correction at every zigzag and never lets the rover
// build speed. A pure-pursuit lookahead (steer at the farthest path point
// within PURSUIT_LOOKAHEAD_M of the current position, not just the next
// point) smooths that out - the same thing a real driver does on a winding
// road - while the underlying route still never leaves the margin-dilated
// safety corridor computed above. Verified: without this, the bot crawls
// (heading oscillates every waypoint, effective speed ~0.25 m/s) and never
// reaches the goal within a generous budget; with it, ~1680s sim time.
const PURSUIT_LOOKAHEAD_M = 20;
function pursuitTarget(path, fromIdx, pos, mpp) {
  let idx = fromIdx;
  while (idx < path.length - 1 && Math.hypot(path[idx].x - pos.x, path[idx].y - pos.y) * mpp < WAYPOINT_ARRIVE_RADIUS_M) idx++;
  let target = path[idx];
  let j = idx;
  while (j < path.length - 1 && Math.hypot(path[j].x - pos.x, path[j].y - pos.y) * mpp < PURSUIT_LOOKAHEAD_M) { j++; target = path[j]; }
  return { idx, target };
}

test("lunokhod: a delayed-telemetry bot reaches the parked Lunokhod 2 from spawn without tipping or driving onto no-data terrain", () => {
  const terrain = loadRealTerrain("lunokhod");
  const { spawn, goal } = terrain.meta;
  const delaySec = terrain.meta.delayOneWaySec ?? 1.28;
  assert.ok(delaySec > 0, "lunokhod delay must be the real, positive one-way light-time delay");

  const PLANNING_MARGIN_DEG = 30;
  const { path } = findGlobalPath(terrain, spawn, goal, PLANNING_MARGIN_DEG, 1, 500000, 1);
  assert.ok(path, "precondition: a safe, dilated (margin-buffered) route must exist");

  const signal = createSignalLink(delaySec);
  let trueState = createRover({ x: spawn.x, y: spawn.y, heading: 0 });
  let currentControl = { throttle: 0, steer: 0 };
  let waypointIndex = 0;
  let lastCommandAt = -Infinity;
  const CONTROL_INTERVAL_S = 0.1;
  const dt = 1 / 20;
  const BUDGET_S = 3000;
  let maxSlopeEncountered = 0;
  let simTime = 0;

  let mission = startMission(createMission("lunokhod"), 0);
  let visibleState = null;

  for (; simTime < BUDGET_S && mission.status === "active"; simTime += dt) {
    for (const cmd of signal.pullDeliveredCommands(simTime)) currentControl = cmd;

    trueState = stepRover(trueState, currentControl, terrain, dt);
    assert.equal(trueState.tipped, false, `lunokhod bot tipped at simTime=${simTime.toFixed(2)}s, slope=${trueState.slopeDeg?.toFixed(1)}deg`);
    assert.equal(trueState.stopped, false, `lunokhod bot stopped (${trueState.stopReason}) at simTime=${simTime.toFixed(2)}s`);
    maxSlopeEncountered = Math.max(maxSlopeEncountered, trueState.slopeDeg);

    signal.telemetry({ ...trueState, copilotHold: null, planActive: true }, simTime);
    const visible = signal.visibleTelemetry(simTime);
    if (visible) visibleState = visible;

    mission = updateMission(mission, { visibleTelemetry: visibleState, simTime, terrain, telemetryAgeSec: signal.telemetryAge(simTime) });

    if (visibleState && simTime - lastCommandAt >= CONTROL_INTERVAL_S) {
      lastCommandAt = simTime;
      const { idx, target } = pursuitTarget(path, waypointIndex, visibleState.state, terrain.metersPerPixel);
      waypointIndex = idx;
      const control = steerTowardPoint(visibleState.state, target);
      signal.uplink(control, simTime);
    }
  }

  assert.equal(mission.status, "won", `lunokhod bot failed to reach Lunokhod 2 within ${BUDGET_S}s (sim); mission ended "${mission.status}" (${whatHappenedLine(mission)}); final true position (${trueState.x.toFixed(1)},${trueState.y.toFixed(1)})`);
  assert.equal(mission.outcome, "arrived");
  assert.ok(simTime <= LIVE_BOT_ARRIVAL_BUDGET_S,
    `lunokhod bot took ${simTime.toFixed(1)}s to arrive, exceeding the ${LIVE_BOT_ARRIVAL_BUDGET_S}s playability budget`);
  console.log(`  [lunokhod bot] arrived in ${simTime.toFixed(1)}s sim time, max slope encountered ${maxSlopeEncountered.toFixed(1)}deg, path points ${path.length}`);
});

// --- Mars: uplinked sol plan driven by the co-pilot, ALL 3 scenarios, real defaults ---
//
// This is also the C1 AND H2 regression test: it runs the REAL mission
// state machine (web/mission.js) for every real delay scenario in
// web/levels.js, with the shipped DEFAULT_GUARDRAILS untouched (no test-only
// override) - exactly what a first-time player gets on Start. Before the
// C1/H2 fixes this stalled on "typical" and "near conjunction" (the stall
// clock started before the player could see any motion) and HELD outright
// on the shipped 300m default distance cap.

for (const scenario of MARS_SCENARIOS) {
  test(`mars (${scenario.label}): a sol plan uplinked through the real ${scenario.label} delay reaches the goal under the shipped DEFAULT guardrails`, () => {
    const terrain = loadRealTerrain("mars");
    const { spawn, goal } = terrain.meta;
    const delaySec = (scenario.realMinutes * 60) / scenario.compression;

    const { path } = findGlobalPath(terrain, spawn, goal, DEFAULT_GUARDRAILS.maxSlopeDeg);
    assert.ok(path, "precondition: a safe route must exist under the default slope guardrail");
    const waypoints = downsample(path, 4); // 4 waypoints: within the plan's 2-4 waypoint spec
    waypoints[waypoints.length - 1] = { x: goal.x, y: goal.y }; // final leg lands exactly on the goal, not a grid-rounded approximation
    assert.ok(waypoints.length >= 2 && waypoints.length <= 4);

    const signal = createSignalLink(delaySec);
    let trueState = createRover({ x: spawn.x, y: spawn.y, heading: 0 });
    let mission = startMission(createMission("mars", { mode: "plan" }), 0);
    let visibleState = null;
    let autopilot = null;
    signal.uplink({ type: "plan", waypoints }, 0);

    // The shipped defaults, unmodified: this IS the H2 regression check.
    const guardrails = DEFAULT_GUARDRAILS;

    const dt = 1 / 10;
    const BUDGET_S = 2400;
    let maxSlopeEncountered = 0;
    let simTime = 0;
    let planDelivered = false;
    let movedBeforeDelivery = false;

    for (; simTime < BUDGET_S && mission.status === "active"; simTime += dt) {
      for (const cmd of signal.pullDeliveredCommands(simTime)) {
        assert.equal(cmd.type, "plan");
        planDelivered = true;
        const result = planRoute({ x: trueState.x, y: trueState.y }, cmd.waypoints, terrain, guardrails);
        autopilot = { path: result.path, index: 0, holdReason: result.status === "HOLD" ? result.reason : null };
      }
      if (!planDelivered && (trueState.x !== spawn.x || trueState.y !== spawn.y)) movedBeforeDelivery = true;

      let control = { throttle: 0, steer: 0 };
      if (autopilot && !autopilot.holdReason) {
        const target = autopilot.path[autopilot.index];
        if (target) {
          control = steerTowardPoint(trueState, target);
          const distM = Math.hypot(target.x - trueState.x, target.y - trueState.y) * terrain.metersPerPixel;
          if (distM < WAYPOINT_ARRIVE_RADIUS_M) autopilot.index += 1;
        }
      }

      trueState = stepRover(trueState, control, terrain, dt);
      assert.equal(trueState.tipped, false, `mars rover (${scenario.key}) tipped at simTime=${simTime.toFixed(2)}s`);
      assert.equal(trueState.stopped, false, `mars rover (${scenario.key}) stopped (${trueState.stopReason}) at simTime=${simTime.toFixed(2)}s`);
      maxSlopeEncountered = Math.max(maxSlopeEncountered, trueState.slopeDeg);

      // Mirrors main.js's tickPhysics telemetry stamp exactly: copilotHold/
      // planActive/autopilotPath ride the SAME delayed channel as position
      // (see the C1/H1 fixes) - the mission state machine never sees them
      // before the player would.
      signal.telemetry({ ...trueState, copilotHold: autopilot?.holdReason ?? null, planActive: !!autopilot, autopilotPath: autopilot?.path ?? null }, simTime);
      const visible = signal.visibleTelemetry(simTime);
      if (visible) visibleState = visible;

      mission = updateMission(mission, { visibleTelemetry: visibleState, simTime, terrain, telemetryAgeSec: signal.telemetryAge(simTime) });
    }

    assert.equal(movedBeforeDelivery, false, "the rover must not move before the delayed plan arrives");
    assert.ok(planDelivered, "the sol plan never arrived within the sim budget");
    assert.equal(mission.status, "won", `mars (${scenario.key}, ${scenario.label}): expected "won", got "${mission.status}" at simTime=${simTime.toFixed(1)}s (${whatHappenedLine(mission)}); true pos (${trueState.x.toFixed(1)},${trueState.y.toFixed(1)})`);
    assert.equal(mission.outcome, "arrived");
    console.log(`  [mars bot ${scenario.key}] arrived in ${simTime.toFixed(1)}s sim time (delay ${delaySec.toFixed(1)}s), max slope encountered ${maxSlopeEncountered.toFixed(1)}deg, ${waypoints.length} waypoints`);
  });
}

// --- New wave-1 sites (Chang'e-4, Apollo 17): generic bots ----
//
// Same shapes as the hand-tuned Lunokhod (live, pursuit steering) and Mars
// (sol plan) bots above, generalized over any level config so a new site's
// assets are proven winnable the moment the data lane ships them - never
// silently skipped as a false pass. Runs on real assets when present in
// this worktree; SKIPs (node:test skip, with the reason) when they are not,
// which is the parallel data lane's job, not this lane's.

/** Live-mode bot: delayed telemetry + pure-pursuit steering along a margin-dilated A* route (same technique proven on Lunokhod above). */
function runLiveDelayedBot(level) {
  const terrain = loadRealTerrain(level.assetKey);
  const { spawn, goal } = terrain.meta;
  const delaySec = resolveDelaySec(level, terrain.meta);
  assert.ok(delaySec > 0, `${level.key}: delay must be the real, positive one-way light-time delay`);

  const PLANNING_MARGIN_DEG = 30;
  const { path } = findGlobalPath(terrain, spawn, goal, PLANNING_MARGIN_DEG, 1, 500000, 1);
  assert.ok(path, `${level.key}: precondition: a safe, dilated (margin-buffered) route must exist`);

  const signal = createSignalLink(delaySec);
  let trueState = createRover({ x: spawn.x, y: spawn.y, heading: 0 });
  let currentControl = { throttle: 0, steer: 0 };
  let waypointIndex = 0;
  let lastCommandAt = -Infinity;
  const CONTROL_INTERVAL_S = 0.1;
  const dt = 1 / 20;
  // Same sim-time budget as the hand-tuned moon/lunokhod bots above - a
  // generous ceiling for the bot to finish at all, distinct from the
  // tighter LIVE_BOT_ARRIVAL_BUDGET_S playability check below (a level
  // that only finishes between 2000s and this ceiling is a real gate
  // failure via that check, not a silent pass).
  const BUDGET_S = 3000;
  let simTime = 0;

  let mission = startMission(createMission(level.key, level), 0);
  let visibleState = null;

  for (; simTime < BUDGET_S && mission.status === "active"; simTime += dt) {
    for (const cmd of signal.pullDeliveredCommands(simTime)) currentControl = cmd;

    trueState = stepRover(trueState, currentControl, terrain, dt);
    assert.equal(trueState.tipped, false, `${level.key} bot tipped at simTime=${simTime.toFixed(2)}s, slope=${trueState.slopeDeg?.toFixed(1)}deg`);
    assert.equal(trueState.stopped, false, `${level.key} bot stopped (${trueState.stopReason}) at simTime=${simTime.toFixed(2)}s`);

    signal.telemetry({ ...trueState, copilotHold: null, planActive: true }, simTime);
    const visible = signal.visibleTelemetry(simTime);
    if (visible) visibleState = visible;

    mission = updateMission(mission, { visibleTelemetry: visibleState, simTime, terrain, telemetryAgeSec: signal.telemetryAge(simTime) });

    if (visibleState && simTime - lastCommandAt >= CONTROL_INTERVAL_S) {
      lastCommandAt = simTime;
      const { idx, target } = pursuitTarget(path, waypointIndex, visibleState.state, terrain.metersPerPixel);
      waypointIndex = idx;
      signal.uplink(steerTowardPoint(visibleState.state, target), simTime);
    }
  }

  assert.equal(mission.status, "won", `${level.key} bot failed to reach the goal within ${BUDGET_S}s (sim); mission ended "${mission.status}" (${whatHappenedLine(mission)}); final true position (${trueState.x.toFixed(1)},${trueState.y.toFixed(1)})`);
  assert.equal(mission.outcome, "arrived");
  assert.ok(simTime <= LIVE_BOT_ARRIVAL_BUDGET_S,
    `${level.key} bot took ${simTime.toFixed(1)}s to arrive, exceeding the ${LIVE_BOT_ARRIVAL_BUDGET_S}s playability budget`);
  console.log(`  [${level.key} bot] arrived in ${simTime.toFixed(1)}s sim time`);
}

/** Plan-mode bot: a downsampled A* route uplinked as a sol plan and driven by the real co-pilot (same technique proven on Mars/Jezero above). */
function runSolPlanBot(level, scenario) {
  const terrain = loadRealTerrain(level.assetKey);
  const { spawn, goal } = terrain.meta;
  const delaySec = resolveDelaySec(level, terrain.meta, scenario.key);

  const { path } = findGlobalPath(terrain, spawn, goal, DEFAULT_GUARDRAILS.maxSlopeDeg);
  assert.ok(path, `${level.key}: precondition: a safe route must exist under the default slope guardrail`);
  const waypoints = downsample(path, 4);
  waypoints[waypoints.length - 1] = { x: goal.x, y: goal.y };

  const signal = createSignalLink(delaySec);
  let trueState = createRover({ x: spawn.x, y: spawn.y, heading: 0 });
  let mission = startMission(createMission(level.key, level), 0);
  let visibleState = null;
  let autopilot = null;
  signal.uplink({ type: "plan", waypoints }, 0);

  const dt = 1 / 10;
  const BUDGET_S = 2400;
  let simTime = 0;
  let planDelivered = false;
  let movedBeforeDelivery = false;

  for (; simTime < BUDGET_S && mission.status === "active"; simTime += dt) {
    for (const cmd of signal.pullDeliveredCommands(simTime)) {
      planDelivered = true;
      const result = planRoute({ x: trueState.x, y: trueState.y }, cmd.waypoints, terrain, DEFAULT_GUARDRAILS);
      autopilot = { path: result.path, index: 0, holdReason: result.status === "HOLD" ? result.reason : null };
    }
    if (!planDelivered && (trueState.x !== spawn.x || trueState.y !== spawn.y)) movedBeforeDelivery = true;

    let control = { throttle: 0, steer: 0 };
    if (autopilot && !autopilot.holdReason) {
      const target = autopilot.path[autopilot.index];
      if (target) {
        control = steerTowardPoint(trueState, target);
        const distM = Math.hypot(target.x - trueState.x, target.y - trueState.y) * terrain.metersPerPixel;
        if (distM < WAYPOINT_ARRIVE_RADIUS_M) autopilot.index += 1;
      }
    }

    trueState = stepRover(trueState, control, terrain, dt);
    assert.equal(trueState.tipped, false, `${level.key} rover (${scenario.key}) tipped at simTime=${simTime.toFixed(2)}s`);
    assert.equal(trueState.stopped, false, `${level.key} rover (${scenario.key}) stopped (${trueState.stopReason}) at simTime=${simTime.toFixed(2)}s`);

    signal.telemetry({ ...trueState, copilotHold: autopilot?.holdReason ?? null, planActive: !!autopilot, autopilotPath: autopilot?.path ?? null }, simTime);
    const visible = signal.visibleTelemetry(simTime);
    if (visible) visibleState = visible;

    mission = updateMission(mission, { visibleTelemetry: visibleState, simTime, terrain, telemetryAgeSec: signal.telemetryAge(simTime) });
  }

  assert.equal(movedBeforeDelivery, false, `${level.key}: the rover must not move before the delayed plan arrives`);
  assert.ok(planDelivered, `${level.key}: the sol plan never arrived within the sim budget`);
  assert.equal(mission.status, "won", `${level.key} (${scenario.key}): expected "won", got "${mission.status}" at simTime=${simTime.toFixed(1)}s (${whatHappenedLine(mission)})`);
  assert.equal(mission.outcome, "arrived");
  console.log(`  [${level.key} bot ${scenario.key}] arrived in ${simTime.toFixed(1)}s sim time`);
}

const COVERED_ELSEWHERE = new Set(["lunokhod", "tycho", "mars"]); // already proven above with hand-tuned bots

for (const key of LEVEL_ORDER) {
  if (COVERED_ELSEWHERE.has(key)) continue;
  const level = LEVELS[key];
  const name = level.mode === "plan"
    ? `${key}: a sol plan uplinked through the real delay reaches the goal under the shipped DEFAULT guardrails`
    : `${key}: a delayed-telemetry bot reaches the goal from spawn without tipping or driving onto no-data terrain`;
  registerAssetGatedTest(name, level.assetKey, () => {
    if (level.mode === "plan") runSolPlanBot(level, resolveScenario());
    else runLiveDelayedBot(level);
  });
}

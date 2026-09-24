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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseTerrain } from "../web/terrain-data.js";
import { createRover, stepRover, steerTowardPoint } from "../web/rover-sim.js";
import { createSignalLink } from "../web/signal.js";
import { planRoute, DEFAULT_GUARDRAILS } from "../web/copilot.js";
import { createMission, startMission, updateMission, whatHappenedLine } from "../web/mission.js";
import { MARS_SCENARIOS } from "../web/levels.js";
import { findGlobalPath } from "./helpers/grid-astar.mjs";

const ASSETS_ROOT = fileURLToPath(new URL("../assets/", import.meta.url));
const GOAL_RADIUS_M = 15;
const WAYPOINT_ARRIVE_RADIUS_M = 6;

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

for (const body of ["moon", "mars"]) {
  test(`${body}: A* finds a spawn->goal path under the default slope guardrail`, () => {
    const terrain = loadRealTerrain(body);
    const { spawn, goal } = terrain.meta;
    const { path, iterations } = findGlobalPath(terrain, spawn, goal, DEFAULT_GUARDRAILS.maxSlopeDeg);
    assert.ok(path, `${body}: no path found from spawn to goal under ${DEFAULT_GUARDRAILS.maxSlopeDeg}deg after ${iterations} iterations`);
    assert.ok(path.length > 1, `${body}: path should have more than one point`);
    for (const p of path) {
      assert.ok(terrain.slopeDeg(p.x, p.y) <= DEFAULT_GUARDRAILS.maxSlopeDeg + 1e-6, `${body}: path point (${p.x},${p.y}) exceeds the slope guardrail`);
      assert.equal(terrain.noData?.(p.x, p.y) ?? false, false, `${body}: path point (${p.x},${p.y}) crosses a no-data cell`);
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
  console.log(`  [moon bot] arrived in ${simTime.toFixed(1)}s sim time, max slope encountered ${maxSlopeEncountered.toFixed(1)}deg, path points ${path.length}`);
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
    let mission = startMission(createMission("mars"), 0);
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

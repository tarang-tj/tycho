// PAR_SEC regression guard: re-runs the SAME delayed-telemetry bot loop
// shapes as tests/playability.test.mjs (copied here, not imported - that
// file is wave-1 territory and this lane does not edit it) against the real
// shipped assets, and asserts web/objectives.js's PAR_SEC stays within 10%
// of what the bot actually measures. If wave-1 patches terrain and a bot's
// time drifts more than that, this test catches it before the par numbers
// go stale.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseTerrain } from "../web/terrain-data.js";
import { createRover, stepRover, steerTowardPoint } from "../web/rover-sim.js";
import { createSignalLink } from "../web/signal.js";
import { createMission, startMission, updateMission } from "../web/mission.js";
import { LEVELS, resolveDelaySec } from "../web/levels.js";
import { evaluateObjectives, PAR_SEC } from "../web/objectives.js";
import { findGlobalPath } from "./helpers/grid-astar.mjs";

const ASSETS_ROOT = fileURLToPath(new URL("../assets/", import.meta.url));
const WAYPOINT_ARRIVE_RADIUS_M = 6;
const PURSUIT_LOOKAHEAD_M = 20;
const PLANNING_MARGIN_DEG = 30;
const PAR_TOLERANCE = 0.1; // 10%

function loadRealTerrain(assetKey) {
  const base = `${ASSETS_ROOT}${assetKey}/`;
  const meta = JSON.parse(readFileSync(`${base}meta.json`, "utf8"));
  const height = readFileSync(`${base}height.bin`);
  const heightBuf = height.buffer.slice(height.byteOffset, height.byteOffset + height.byteLength);
  let maskBuf = null;
  try {
    const mask = readFileSync(`${base}${meta.maskFile || "mask.bin"}`);
    maskBuf = mask.buffer.slice(mask.byteOffset, mask.byteOffset + mask.byteLength);
  } catch {
    // no mask shipped: parseTerrain tolerates null.
  }
  return parseTerrain(heightBuf, meta, maskBuf);
}

function pursuitTarget(path, fromIdx, pos, mpp) {
  let idx = fromIdx;
  while (idx < path.length - 1 && Math.hypot(path[idx].x - pos.x, path[idx].y - pos.y) * mpp < WAYPOINT_ARRIVE_RADIUS_M) idx++;
  let target = path[idx];
  let j = idx;
  while (j < path.length - 1 && Math.hypot(path[j].x - pos.x, path[j].y - pos.y) * mpp < PURSUIT_LOOKAHEAD_M) { j++; target = path[j]; }
  return { idx, target };
}

/** Generic pure-pursuit delayed-telemetry bot (same shape as playability.test.mjs's lunokhod/change4/apollo17 bots). */
function runPursuitBot(level) {
  const terrain = loadRealTerrain(level.assetKey);
  const { spawn, goal } = terrain.meta;
  const delaySec = resolveDelaySec(level, terrain.meta);
  const { path } = findGlobalPath(terrain, spawn, goal, PLANNING_MARGIN_DEG, 1, 500000, 1);
  assert.ok(path, `${level.key}: precondition: a safe route must exist`);

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

  let mission = startMission(createMission(level.key, level), 0);
  let visibleState = null;

  for (; simTime < BUDGET_S && mission.status === "active"; simTime += dt) {
    for (const cmd of signal.pullDeliveredCommands(simTime)) currentControl = cmd;
    trueState = stepRover(trueState, currentControl, terrain, dt);
    assert.equal(trueState.tipped, false, `${level.key} par bot tipped at simTime=${simTime.toFixed(2)}s`);
    assert.equal(trueState.stopped, false, `${level.key} par bot stopped at simTime=${simTime.toFixed(2)}s`);
    maxSlopeEncountered = Math.max(maxSlopeEncountered, trueState.slopeDeg);
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
  assert.equal(mission.status, "won", `${level.key} par bot failed to reach the goal within ${BUDGET_S}s`);
  assert.equal(mission.outcome, "arrived");
  return { timeSec: simTime, maxSlopeDeg: maxSlopeEncountered, distanceM: mission.distanceTraveledM };
}

/** Single-target-at-a-time delayed-telemetry bot (same shape as playability.test.mjs's "moon"/Tycho bot). */
function runWaypointIndexBot(level) {
  const terrain = loadRealTerrain(level.assetKey);
  const { spawn, goal } = terrain.meta;
  const delaySec = resolveDelaySec(level, terrain.meta);
  const { path } = findGlobalPath(terrain, spawn, goal, PLANNING_MARGIN_DEG, 1, 500000, 1);
  assert.ok(path, `${level.key}: precondition: a safe route must exist`);

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

  let mission = startMission(createMission(level.key, level), 0);
  let visibleState = null;

  for (; simTime < BUDGET_S && mission.status === "active"; simTime += dt) {
    for (const cmd of signal.pullDeliveredCommands(simTime)) currentControl = cmd;
    trueState = stepRover(trueState, currentControl, terrain, dt);
    assert.equal(trueState.tipped, false, `${level.key} par bot tipped at simTime=${simTime.toFixed(2)}s`);
    assert.equal(trueState.stopped, false, `${level.key} par bot stopped at simTime=${simTime.toFixed(2)}s`);
    maxSlopeEncountered = Math.max(maxSlopeEncountered, trueState.slopeDeg);
    signal.telemetry({ ...trueState, copilotHold: null, planActive: true }, simTime);
    const visible = signal.visibleTelemetry(simTime);
    if (visible) visibleState = visible;
    mission = updateMission(mission, { visibleTelemetry: visibleState, simTime, terrain, telemetryAgeSec: signal.telemetryAge(simTime) });
    if (visibleState && simTime - lastCommandAt >= CONTROL_INTERVAL_S) {
      lastCommandAt = simTime;
      let target = path[waypointIndex] ?? goal;
      const distM = Math.hypot(visibleState.state.x - target.x, visibleState.state.y - target.y) * terrain.metersPerPixel;
      if (distM < WAYPOINT_ARRIVE_RADIUS_M && waypointIndex < path.length - 1) { waypointIndex += 1; target = path[waypointIndex]; }
      signal.uplink(steerTowardPoint(visibleState.state, target), simTime);
    }
  }
  assert.equal(mission.status, "won", `${level.key} par bot failed to reach the goal within ${BUDGET_S}s`);
  assert.equal(mission.outcome, "arrived");
  return { timeSec: simTime, maxSlopeDeg: maxSlopeEncountered, distanceM: mission.distanceTraveledM };
}

// tycho reuses the "moon" test's single-target bot shape (playability.test.mjs's
// hand-tuned Tycho-peak bot); the other three live levels use the generalized
// pure-pursuit bot (same as playability.test.mjs's runLiveDelayedBot).
const BOT_RUNNERS = {
  lunokhod: runPursuitBot,
  change4: runPursuitBot,
  apollo17: runPursuitBot,
  tycho: runWaypointIndexBot,
};

for (const levelKey of Object.keys(PAR_SEC)) {
  test(`par.${levelKey}: PAR_SEC is within 10% of the bot's actual measured arrival time`, () => {
    const runner = BOT_RUNNERS[levelKey];
    const { timeSec } = runner(LEVELS[levelKey]);
    const par = PAR_SEC[levelKey];
    const deviation = Math.abs(timeSec - par) / timeSec;
    assert.ok(deviation <= PAR_TOLERANCE,
      `${levelKey}: PAR_SEC=${par}s is ${(deviation * 100).toFixed(1)}% off the measured ${timeSec.toFixed(1)}s (tolerance ${PAR_TOLERANCE * 100}%)`);
  });

  test(`par.${levelKey}: the bot's own run meets "arrive" but NOT "beat par" (par equals its own time -> tie, not a beat)`, () => {
    // PAR_SEC[levelKey] IS the bot's own measured time (the test above
    // proves that within tolerance), so feeding it back in as timeSec
    // simulates "a run that exactly matches the bot".
    const runSummary = { outcome: "arrived", timeSec: PAR_SEC[levelKey], maxSlopeDeg: 0, distanceM: 1 };
    const objectives = evaluateObjectives(levelKey, runSummary);
    assert.equal(objectives.find((o) => o.id === "arrive").met, true);
    assert.equal(objectives.find((o) => o.id === "beat-par").met, false,
      `${levelKey}: a run at exactly PAR_SEC must not meet beat-par (strictly-less-than rule)`);
  });
}

// Pure headless sol-plan simulator for Flight Rules. Extracts the SAME
// autopilot loop main.js's tickPhysics runs for a delivered Mars "plan"
// command (steerTowardPoint/stepRover under planRoute's guardrails, with
// mission.js's hold/tip/stall rules) into a reusable, testable shape:
// `autopilotStep` advances one tick exactly like main.js will, and
// `runSolPlan` drives a whole sol headlessly for ensemble.js. No DOM/
// three.js dependency, deterministic, unit-testable in node.
//
// Delivery delay is intentionally NOT modeled here: main.js/signal.js
// already proved (playability.test.mjs) that the rover never moves before
// a plan is delivered, so the delay only shifts WHEN driving starts, never
// the physics/route outcome of driving it. This module starts driving at
// t=0, so its outputs are delay-independent by construction.
import { planRoute, DEFAULT_GUARDRAILS } from "./copilot.js";
import { createRover, stepRover, steerTowardPoint } from "./rover-sim.js";
import { createMission, startMission, updateMission } from "./mission.js";
import { createDriftModel, DRIFT_PCT } from "./drift.js";

const WAYPOINT_ARRIVE_RADIUS_M = 6;
const DEFAULT_MAX_TIME_SEC = 2400;
const PATH_SAMPLE_INTERVAL_S = 5; // downsample interval for truePath/believedPath output

/**
 * Advance a sol-plan autopilot by one physics tick. Steers the TRUE rover
 * toward the current path target using its BELIEVED (drift-offset)
 * position, steps physics on the true state, and advances the drift model
 * by the true displacement driven this tick. Shares the same steer/step
 * primitives as main.js's tickPhysics Mars branch, but is NOT an exact
 * mirror of it - two real differences, both intentional for headless
 * ensemble use:
 *   - holdReason zeroes control immediately here (this function checks
 *     `!autopilot.holdReason` before steering); tickPhysics has no such
 *     check and instead keeps driving any already-planned partial path
 *     until it runs out of waypoints, only then going idle.
 *   - this module plans each waypoint leg individually (see
 *     planLegsWithBoundaries below) to recover per-leg boundaries;
 *     tickPhysics calls copilot.js's planRoute once over the whole
 *     waypoint list and never sees leg boundaries at all.
 *
 * @param {object} params
 * @param {object} params.trueState - current true rover state (rover-sim.js `createRover`/`stepRover` shape)
 * @param {{path: {x:number,y:number}[], index: number, holdReason: string|null}} params.autopilot
 * @param {object} params.terrain - shared terrain interface (terrain-data.js shape)
 * @param {number} params.dt - fixed timestep, seconds
 * @param {{advance(dxTrueM:number, dyTrueM:number):void, offsetM():{x:number,y:number}}|null} [params.driftModel] - omit/null for undrifted (believed === true)
 * @param {number} [params.waypointArriveRadiusM]
 * @returns {{trueState: object, autopilot: {path, index, holdReason}, believedState: {x:number,y:number}, stepDistanceM: number}}
 */
export function autopilotStep({ trueState, autopilot, terrain, dt, driftModel = null, waypointArriveRadiusM = WAYPOINT_ARRIVE_RADIUS_M }) {
  const mpp = terrain.metersPerPixel || 1;
  const offset = driftModel ? driftModel.offsetM() : { x: 0, y: 0 };
  const believedState = { ...trueState, x: trueState.x + offset.x / mpp, y: trueState.y + offset.y / mpp };

  let control = { throttle: 0, steer: 0 };
  let nextIndex = autopilot?.index ?? 0;
  const target = autopilot?.path?.[nextIndex];
  if (autopilot && !autopilot.holdReason && target) {
    control = steerTowardPoint(believedState, target);
    const distM = Math.hypot(target.x - believedState.x, target.y - believedState.y) * mpp;
    if (distM < waypointArriveRadiusM) nextIndex += 1;
  }

  const nextTrueState = stepRover(trueState, control, terrain, dt);
  const dxTrueM = (nextTrueState.x - trueState.x) * mpp;
  const dyTrueM = (nextTrueState.y - trueState.y) * mpp;
  const stepDistanceM = Math.hypot(dxTrueM, dyTrueM);
  if (driftModel) driftModel.advance(dxTrueM, dyTrueM);

  return {
    trueState: nextTrueState,
    autopilot: autopilot ? { ...autopilot, index: nextIndex } : autopilot,
    believedState,
    stepDistanceM,
  };
}

/** Plan every waypoint leg individually (via copilot.js's own planRoute, unmodified) so callers can recover per-leg boundaries planRoute's single-call return doesn't expose. */
function planLegsWithBoundaries(spawn, waypoints, terrain, g) {
  const path = [];
  const legEndIndex = new Array(waypoints.length).fill(-1);
  const legOutcomes = new Array(waypoints.length).fill("unreached");
  let cursor = { x: spawn.x, y: spawn.y };
  let cumulativeDistanceM = 0;
  let holdReason = null;

  for (let i = 0; i < waypoints.length; i++) {
    if (holdReason) break;
    const remainingCap = g.maxAutonomousDistanceM - cumulativeDistanceM;
    const leg = planRoute(cursor, [waypoints[i]], terrain, { ...g, maxAutonomousDistanceM: remainingCap });
    if (leg.status === "HOLD") {
      legOutcomes[i] = "held";
      holdReason = leg.reason;
      break;
    }
    cumulativeDistanceM += leg.distanceM;
    path.push(...leg.path);
    cursor = waypoints[i];
    legOutcomes[i] = "ok";
    legEndIndex[i] = path.length - 1;
  }
  return { path, legEndIndex, legOutcomes, holdReason };
}

/**
 * Downgrade the first not-fully-driven "ok" leg (and everything after it) to
 * "tipped"/"unreached", so legOutcomes reflects what actually happened while
 * driving, not just the plan. Only applies on a failure outcome: on
 * "arrived" the mission can (correctly) end via the 15 m goal-arrival radius
 * before the rover closes to within the final waypoint's own 6 m arrival
 * radius, which must not read as "unreached" when the plan in fact
 * succeeded; "held" is already fully decided at planning time, before any
 * driving happens, so it never needs a drive-time downgrade either.
 */
function finalizeLegOutcomes(legOutcomes, legEndIndex, finalIndex, outcome) {
  if (outcome !== "tipped" && outcome !== "stalled") return legOutcomes;
  const result = [...legOutcomes];
  for (let i = 0; i < result.length; i++) {
    if (result[i] !== "ok") break; // a held/unreached leg means nothing after it was ever attempted
    if (finalIndex > legEndIndex[i]) continue; // fully driven
    result[i] = outcome === "tipped" ? "tipped" : "unreached";
    for (let j = i + 1; j < result.length; j++) result[j] = "unreached";
    break;
  }
  return result;
}

const MISSION_OUTCOME = { won: "arrived", tipped: "tipped", stalled: "stalled", held: "held" };

/**
 * Drive one full sol plan headlessly, starting at t=0 (delivery delay is not
 * modeled - see the module header). Same physics/hazard/stall rules as
 * main.js's live Mars run.
 *
 * @param {object} params
 * @param {object} params.terrain
 * @param {{x:number,y:number}} params.spawn
 * @param {{x:number,y:number}[]} params.waypoints
 * @param {object} [params.guardrails]
 * @param {number} [params.seed]
 * @param {number} [params.driftPct]
 * @param {number} [params.dt]
 * @param {number} [params.maxTimeSec]
 */
export function runSolPlan({ terrain, spawn, waypoints = [], guardrails = {}, seed = 0, driftPct = DRIFT_PCT, dt = 0.1, maxTimeSec = DEFAULT_MAX_TIME_SEC }) {
  const g = { ...DEFAULT_GUARDRAILS, ...guardrails };
  const { path, legEndIndex, legOutcomes, holdReason: planHoldReason } = planLegsWithBoundaries(spawn, waypoints, terrain, g);

  let trueState = createRover({ x: spawn.x, y: spawn.y, heading: 0 });
  let autopilot = { path, index: 0, holdReason: planHoldReason };
  const driftModel = createDriftModel({ seed, driftPct });
  let mission = startMission(createMission("sol-sim", { mode: "plan" }), 0);

  const truePath = [];
  const believedPath = [];
  let believedState = { x: trueState.x, y: trueState.y };
  let simTime = 0;
  let maxSlopeDeg = 0;
  let distanceM = 0;
  let lastSampleAt = -Infinity;

  for (; simTime < maxTimeSec && mission.status === "active"; simTime += dt) {
    const step = autopilotStep({ trueState, autopilot, terrain, dt, driftModel });
    trueState = step.trueState;
    autopilot = step.autopilot;
    believedState = step.believedState;
    distanceM += step.stepDistanceM;
    maxSlopeDeg = Math.max(maxSlopeDeg, trueState.slopeDeg);

    mission = updateMission(mission, {
      visibleTelemetry: { state: { ...trueState, copilotHold: autopilot.holdReason, planActive: true }, sentAt: simTime },
      simTime,
      terrain,
      telemetryAgeSec: 0,
    });

    if (simTime - lastSampleAt >= PATH_SAMPLE_INTERVAL_S) {
      lastSampleAt = simTime;
      truePath.push({ x: trueState.x, y: trueState.y });
      believedPath.push({ x: believedState.x, y: believedState.y });
    }
  }

  // A run that never reaches a terminal mission status inside maxTimeSec has
  // made no more progress than a stall would; report it as one rather than
  // inventing a new outcome category the contract doesn't list.
  const outcome = MISSION_OUTCOME[mission.status] ?? "stalled";
  const finalLegOutcomes = finalizeLegOutcomes(legOutcomes, legEndIndex, autopilot.index, outcome);

  return {
    outcome,
    timeSec: simTime,
    distanceM,
    maxSlopeDeg,
    legOutcomes: finalLegOutcomes,
    holdReason: outcome === "held" ? (mission.copilotHoldReason ?? planHoldReason ?? null) : undefined,
    truePath,
    believedPath,
  };
}

// Pure mission state machine: brief -> active -> won/tipped/stalled/held.
// No DOM/three.js dependency; every tick's inputs are passed in explicitly
// so this is deterministic and unit-testable in node.

export const GOAL_RADIUS_M = 15;
export const STALL_TIMEOUT_S = 20;
export const STALL_PROGRESS_EPS_M = 0.5;

export const BRIEFS = {
  moon: [
    "LUNOKHOD - MOON, TYCHO CENTRAL PEAK",
    "One-way delay 1.28 s: close enough to steer live, like the 1970s Soviet crews did.",
    "Reach the summit marker without exceeding the slope limit or stalling out.",
  ],
  mars: [
    "JEZERO - MARS SOL PLAN",
    "The one-way delay is minutes, so you are watching the past. Place waypoints, then uplink the plan.",
    "TYCHO's co-pilot drives the plan under the guardrails you set, and reports back after the delay.",
  ],
};

export function createMission(levelKey) {
  return {
    level: levelKey,
    status: "brief", // brief | active | won | tipped | stalled | held
    outcome: null,
    startSimTime: null,
    endSimTime: null,
    distanceTraveledM: 0,
    lastPos: null,
    delaySampleSum: 0,
    delaySampleCount: 0,
    progressBestM: Infinity,
    stallSinceSimTime: null,
    planUplinked: false,
    copilotHoldReason: null,
  };
}

/** Move a mission from "brief" to "active", resetting all run-scoped counters. */
export function startMission(mission, simTime) {
  return { ...createMission(mission.level), status: "active", startSimTime: simTime };
}

/**
 * Advance the mission one tick from the latest VISIBLE (delayed) telemetry.
 * Only "active" missions transition; a mission with no telemetry yet is
 * returned unchanged. `visibleTelemetry` is the { state, sentAt } shape
 * returned by signal.js's visibleTelemetry()/getVisibleState().
 */
export function updateMission(mission, { visibleTelemetry, simTime, terrain, telemetryAgeSec }) {
  if (mission.status !== "active" || !visibleTelemetry) return mission;
  const state = visibleTelemetry.state;
  let m = { ...mission };

  if (m.lastPos) {
    const dx = (state.x - m.lastPos.x) * terrain.metersPerPixel;
    const dy = (state.y - m.lastPos.y) * terrain.metersPerPixel;
    m.distanceTraveledM += Math.hypot(dx, dy);
  }
  m.lastPos = { x: state.x, y: state.y };
  if (telemetryAgeSec != null) {
    m.delaySampleSum += telemetryAgeSec;
    m.delaySampleCount += 1;
  }
  if (state.copilotHold && !m.copilotHoldReason) m.copilotHoldReason = state.copilotHold;

  if (state.tipped) {
    return { ...m, status: "tipped", outcome: "tipped", endSimTime: simTime };
  }

  const goal = terrain?.meta?.goal;
  const distToGoal = goal
    ? Math.hypot((state.x - goal.x) * terrain.metersPerPixel, (state.y - goal.y) * terrain.metersPerPixel)
    : null;

  if (distToGoal != null && distToGoal <= GOAL_RADIUS_M) {
    return { ...m, status: "won", outcome: "arrived", endSimTime: simTime };
  }

  if (m.copilotHoldReason) {
    return { ...m, status: "held", outcome: "held", endSimTime: simTime };
  }

  // Mars sol plans sit parked at spawn while the player is still placing
  // waypoints; only start the stall clock once a plan has actually been
  // uplinked (or immediately, for Moon's live driving).
  const stallEligible = mission.level !== "mars" || m.planUplinked;
  if (stallEligible && distToGoal != null) {
    if (distToGoal < m.progressBestM - STALL_PROGRESS_EPS_M) {
      m.progressBestM = distToGoal;
      m.stallSinceSimTime = null;
    } else if (m.stallSinceSimTime == null) {
      m.stallSinceSimTime = simTime;
    } else if (simTime - m.stallSinceSimTime > STALL_TIMEOUT_S) {
      return { ...m, status: "stalled", outcome: "stalled", endSimTime: simTime };
    }
  }
  return m;
}

/** Mark that a sol plan has been uplinked (Mars only), enabling the stall clock. */
export function markPlanUplinked(mission) {
  return { ...mission, planUplinked: true };
}

export function averageDelaySec(mission) {
  return mission.delaySampleCount ? mission.delaySampleSum / mission.delaySampleCount : 0;
}

/** A short, honest, human-readable line describing what just happened, for the end card. */
export function whatHappenedLine(mission) {
  const avg = averageDelaySec(mission).toFixed(1);
  switch (mission.outcome) {
    case "arrived":
      return `You steered ${avg} s into the past on average, and TYCHO still made it.`;
    case "tipped":
      return "The slope under TYCHO exceeded the limit before the order to stop could arrive; the rover tipped.";
    case "stalled":
      return "TYCHO stopped making progress toward the goal and the run stalled out.";
    case "held":
      return `TYCHO's co-pilot held rather than risk the terrain ahead: ${mission.copilotHoldReason ?? "no safe path"}.`;
    default:
      return "";
  }
}

// Pure mission state machine: brief -> active -> won/tipped/stalled/held.
// No DOM/three.js dependency; every tick's inputs are passed in explicitly
// so this is deterministic and unit-testable in node.

export const GOAL_RADIUS_M = 15;
// U1: real micro-terrain (small craters near the Lunokhod 2 site, see
// plans/260923-2234-tycho-rover/reports/lunokhod-data.md) can force a safe
// route to detour away from the goal in straight-line terms for over a
// minute while still making real progress along the ground - a 20s window
// (the pre-Lunokhod value) false-stalled a bot driving the real safe route
// there (measured plateau: 62.9s of rover-time). 75s covers that with
// margin and only makes every level's stall check MORE lenient, never less.
export const STALL_TIMEOUT_S = 75;
export const STALL_PROGRESS_EPS_M = 0.5;

export const BRIEFS = {
  lunokhod: [
    "LUNOKHOD - MOON, LE MONNIER CRATER",
    "One-way delay 1.28 s: close enough to steer live, like the 1970s Soviet crews did.",
    "Drive to where Lunokhod 2 has been parked since 1973, without exceeding the slope limit or stalling out.",
  ],
  tycho: [
    "TYCHO - MOON, TYCHO CENTRAL PEAK",
    "One-way delay 1.28 s: close enough to steer live, like the 1970s Soviet crews did.",
    "Steep real terrain: a short climb to the high point, without exceeding the slope limit or stalling out.",
  ],
  mars: [
    "JEZERO - MARS SOL PLAN",
    "The one-way delay is minutes, so you are watching the past. Place waypoints, then uplink the plan.",
    "TYCHO's co-pilot drives the plan under the guardrails you set, and reports back after the delay.",
  ],
  change4: [
    "CHANG'E-4 - MOON, VON KARMAN CRATER, FAR SIDE",
    "One-way delay via the Queqiao relay: close enough to steer live.",
    "Drive to where China's Chang'e-4 lander has sat since January 2019, without exceeding the slope limit or stalling out.",
  ],
  apollo17: [
    "APOLLO 17 - MOON, TAURUS-LITTROW VALLEY",
    "One-way delay 1.28 s: close enough to steer live.",
    "The astronauts drove the real LRV here with no delay at all, in December 1972. You are driving TYCHO to it remotely from Earth.",
  ],
};

/**
 * `context` carries the two level-config fields mission logic actually needs
 * (see web/levels.js): `mode` ("live" | "plan", default "live") gates the
 * Mars-style "don't stall before the plan is visibly active" rule, and
 * `arrivalLine` (optional) is an honest, level-specific arrival sentence for
 * a real landmark goal (e.g. Lunokhod 2). Passing the level object itself
 * works too, since only these two fields are read.
 */
export function createMission(levelKey, context = {}) {
  return {
    level: levelKey,
    mode: context.mode ?? "live",
    arrivalLine: context.arrivalLine ?? null,
    status: "brief", // brief | active | won | tipped | stalled | held
    outcome: null,
    startSimTime: null,
    endSimTime: null,
    distanceTraveledM: 0,
    lastPos: null,
    delaySampleSum: 0,
    delaySampleCount: 0,
    progressBestM: Infinity,
    // Rover-true time (visibleTelemetry.sentAt) the stall clock started, NOT
    // simTime (see C1: simTime is the present-time clock and includes the
    // one-way telemetry delay the player hasn't seen through yet, which used
    // to run the stall clock down before any progress could even arrive).
    stallSinceRoverTime: null,
    copilotHoldReason: null,
  };
}

/** Move a mission from "brief" to "active", resetting all run-scoped counters. */
export function startMission(mission, simTime) {
  return { ...createMission(mission.level, mission), status: "active", startSimTime: simTime };
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
  // Rover-true timestamp of THIS visible snapshot (when the rover actually
  // generated it, not when the player received it). Using this - not
  // simTime - as the stall-clock basis means the constant one-way telemetry
  // delay cancels out between samples instead of silently eating into the
  // timeout (see C1).
  const roverTime = visibleTelemetry.sentAt;
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

  // "plan"-mode levels (sol plans) sit parked at spawn while the player is
  // still placing waypoints; only start the stall clock once the VISIBLE
  // telemetry itself shows the plan is active on the rover (state.planActive,
  // stamped by the caller - see main.js's tickPhysics) - never at the
  // rover's true present-time delivery moment, which the player can't see
  // yet (C1/H1). Keyed on mode, not a specific level key, so every
  // plan-mode level (Jezero, or any future one) gets the same protection.
  const stallEligible = mission.mode !== "plan" || state.planActive;
  if (stallEligible && distToGoal != null) {
    if (distToGoal < m.progressBestM - STALL_PROGRESS_EPS_M) {
      m.progressBestM = distToGoal;
      m.stallSinceRoverTime = null;
    } else if (m.stallSinceRoverTime == null) {
      m.stallSinceRoverTime = roverTime;
    } else if (roverTime - m.stallSinceRoverTime > STALL_TIMEOUT_S) {
      return { ...m, status: "stalled", outcome: "stalled", endSimTime: simTime };
    }
  }
  return m;
}

export function averageDelaySec(mission) {
  return mission.delaySampleCount ? mission.delaySampleSum / mission.delaySampleCount : 0;
}

/** A short, honest, human-readable line describing what just happened, for the end card. */
export function whatHappenedLine(mission) {
  const avg = averageDelaySec(mission).toFixed(1);
  switch (mission.outcome) {
    case "arrived":
      if (mission.mode === "plan") {
        return `TYCHO's co-pilot drove the plan you set, landing on target after ${avg} s of telemetry delay each way. You planned the route and guardrails; the co-pilot did the driving.`;
      }
      if (mission.arrivalLine) {
        return mission.arrivalLine;
      }
      return `You steered ${avg} s into the past on average, and TYCHO still made it.`;
    case "abandoned":
      return "Run abandoned before it finished; not counted toward the success rate.";
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

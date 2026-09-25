// Per-level objectives: arrive, beat par, and (for live levels) stay under a
// slope threshold. Pure: no DOM/three.js dependency, everything is a plain
// data lookup plus one comparison function so it is trivially unit-testable.
//
// PAR_SEC comes from the shipped delayed-telemetry bots (tests/playability.test.mjs
// and the generalized live bot it runs for change4/apollo17): the bot sees
// only delayed telemetry too, so "beat the bot" takes real driving skill, not
// foreknowledge. Re-measured this session (levelup v3 wave 2); see
// tests/par.test.mjs, which re-runs the same bot loop shape against the real
// shipped assets and asserts these numbers stay within 10% of that run.
export const PAR_SEC = {
  lunokhod: 1681.6,
  change4: 1696.3,
  apollo17: 1199.0,
  tycho: 826.4,
};

// Max-slope objective threshold, degrees. Every value sits below rover-sim's
// physical tip limit (32deg, rover-sim.js DEFAULT_OPTS.maxSlopeDeg) so it is
// a real skill constraint, not a restatement of "don't tip". Set per level
// from the terrain the bot actually has to cross (measured max slope along
// the bot's route, tests/par.test.mjs) plus headroom for imprecise live
// steering:
//   lunokhod: bot route tops out ~14.6deg (Le Monnier's crater field is
//     mostly gentle) -> 18deg leaves room for live driving, still a real cap.
//   change4: bot route tops out ~6.2deg (Von Karman's floor is flat) -> 10deg.
//   apollo17: bot route tops out ~11.0deg (Taurus-Littrow valley floor) -> 15deg.
//   tycho: bot route tops out ~26.2deg climbing the central peak -> 28deg,
//     just under the 30deg planning margin used everywhere else in this repo
//     (tests/playability.test.mjs PLANNING_MARGIN_DEG) and clearly under the
//     32deg tip limit, since this level's whole point is a steep climb.
export const MAX_SLOPE_DEG = {
  lunokhod: 18,
  change4: 10,
  apollo17: 15,
  tycho: 28,
};

const LIVE_LEVEL_KEYS = new Set(["lunokhod", "change4", "apollo17", "tycho"]);

function formatMinSec(timeSec) {
  const total = Math.max(0, Math.round(timeSec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function arrivedObjective(runSummary) {
  return { id: "arrive", label: "Arrive", met: runSummary.outcome === "arrived" };
}

// Strictly less-than: par equals the bot's own measured time, so a run that
// merely TIES the bot has not beaten it. See tests/par.test.mjs for the
// regression proof (the bot's own run meets "arrive" but not "beat-par").
function beatParObjective(levelKey, runSummary) {
  const par = PAR_SEC[levelKey];
  const met = runSummary.outcome === "arrived" && runSummary.timeSec < par;
  return { id: "beat-par", label: `Beat the bot's time (par ${formatMinSec(par)})`, met };
}

function slopeObjective(levelKey, runSummary) {
  const maxDeg = MAX_SLOPE_DEG[levelKey];
  const met = runSummary.outcome === "arrived" && (runSummary.maxSlopeDeg ?? Infinity) <= maxDeg;
  return { id: "gentle-line", label: `Arrive without ever exceeding ${maxDeg} deg of slope`, met };
}

// Mars has no par (the delay length is a player-picked scenario, not a
// skill measure) and no live steering, so its second objective is about the
// one decision plan mode actually offers: whether the co-pilot's reroute
// assist was on for the uplinked plan. `runSummary.copilotOn` is optional
// (main.js's own field name for this, web/main.js:126) and treated as false
// when absent so callers that don't pass it just don't meet the objective.
function rerouteAssistObjective(runSummary) {
  const met = runSummary.outcome === "arrived" && runSummary.copilotOn === true;
  return { id: "reroute-assist", label: "Arrive with the co-pilot's reroute assist on", met };
}

/**
 * Evaluate a level's objectives against a finished run.
 * `runSummary`: { outcome, timeSec, maxSlopeDeg, distanceM, copilotOn? }.
 * Returns [] for unknown level keys so any level not covered here (including
 * future wave-1 levels) degrades gracefully instead of throwing.
 */
export function evaluateObjectives(levelKey, runSummary) {
  if (LIVE_LEVEL_KEYS.has(levelKey)) {
    return [arrivedObjective(runSummary), beatParObjective(levelKey, runSummary), slopeObjective(levelKey, runSummary)];
  }
  if (levelKey === "mars") {
    return [arrivedObjective(runSummary), rerouteAssistObjective(runSummary)];
  }
  return [];
}

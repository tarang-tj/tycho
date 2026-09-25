// Small UI-lane helpers gluing the Flight Rules dry run and the real Mars
// run together, split out of main.js to keep it inside its net-line budget.
// Pure/injectable: no DOM dependency, unit-testable in node.
import { planLegsWithBoundaries, finalizeLegOutcomes } from "./sol-sim.js";
import { DRIFT_PCT } from "./drift.js";

// A dry run always samples the fixed seed range [DRY_RUN_BASE_SEED,
// DRY_RUN_BASE_SEED + DRY_RUN_N - 1] (see dry-run.js). N=100 was chosen
// this session: tools/measure_fixture_rate.mjs measured the committed mixed
// fixture (tests/fixtures/mars-mixed-plan.json) at DRIFT_PCT=1 and found
// 20-run block estimates of its arrival rate ranging 0.30-0.65 against a
// true (N=400) rate of ~0.49, while 100-run block estimates stayed within
// ~0.40-0.56 - noisy enough at N=20 to mislead a player, tight enough at
// N=100 to be a fair "trust the model" signal without the mission-brief-to-
// uplink wait growing noticeably long.
export const DRY_RUN_N = 100;
export const DRY_RUN_BASE_SEED = 0;

/**
 * Pick a fresh seed for the REAL Mars run, guaranteed to fall outside the
 * dry run's reserved seed range - so the real run is never a re-play of a
 * seed the player already saw summarized in the dry run.
 * `overrideSeed`, if a finite number (the debug API, for deterministic
 * tests), is returned as-is. `randomSource` defaults to the real Web
 * Crypto API and is injectable for unit tests.
 */
export function pickRealRunSeed({ overrideSeed = null, randomSource = globalThis.crypto } = {}) {
  if (Number.isFinite(overrideSeed)) return overrideSeed >>> 0;
  const reservedMax = DRY_RUN_BASE_SEED + DRY_RUN_N - 1;
  if (!randomSource?.getRandomValues) {
    // No Web Crypto available at all (very old browser): still guaranteed
    // outside the reserved range, just not cryptographically random.
    return reservedMax + 1 + (Date.now() >>> 0) % 1000;
  }
  const buf = new Uint32Array(1);
  for (let attempt = 0; attempt < 50; attempt++) {
    randomSource.getRandomValues(buf);
    const seed = buf[0];
    if (seed < DRY_RUN_BASE_SEED || seed > reservedMax) return seed;
  }
  // Exhausted retries: a 100-in-2^32 collision chance per draw makes this
  // astronomically unlikely, but fail safe rather than loop forever.
  return reservedMax + 1;
}

// mission.js's `outcome` field already uses this same vocabulary (arrived/
// tipped/stalled/held - see mission.js's updateMission), so main.js can
// pass mission.outcome straight into sol-sim.js's finalizeLegOutcomes with
// no translation step.

/**
 * Build the REAL Mars run's autopilot state from an uplinked plan, using the
 * SAME per-leg planning the headless dry run uses (sol-sim.js's
 * planLegsWithBoundaries) instead of copilot.js's single-call planRoute, so
 * the real run's leg outcomes are directly comparable to the dry run's (see
 * finalizeMarsLegOutcomes below). `guardrails` must already be the merged
 * (defaults + player overrides) object; this module does not know the
 * defaults.
 */
export function createMarsAutopilot(spawn, waypoints, terrain, guardrails) {
  const { path, legEndIndex, legOutcomes, holdReason } = planLegsWithBoundaries(spawn, waypoints, terrain, guardrails);
  return { path, index: 0, holdReason, legEndIndex, legOutcomes };
}

/**
 * Finalize the real Mars run's per-leg outcome grid once the mission has
 * ended, via sol-sim.js's own finalizeLegOutcomes (see its header for why
 * only tipped/stalled need this). `missionOutcome` is mission.js's
 * `mission.outcome` field, already in the right vocabulary. Returns `[]` if
 * no autopilot ran (e.g. the mission ended before any plan was delivered).
 */
export function finalizeMarsLegOutcomes(autopilot, missionOutcome) {
  if (!autopilot?.legOutcomes) return [];
  return finalizeLegOutcomes(autopilot.legOutcomes, autopilot.legEndIndex, autopilot.index, missionOutcome);
}

const OUTCOME_WORD = { arrived: "arrived", held: "held", tipped: "tipped", stalled: "stalled" };

/**
 * Plain-text Flight Rules dry-run result, e.g.:
 *   "100 simulated sols: 49 arrived, 0 held, 0 tipped, 51 stalled (95% range for arrival: 39-59%)"
 *   "Modeled drift: about 1% of distance (a game assumption, not a measured rover figure)"
 * Two lines (caller joins with however it renders paragraphs); the drift
 * label is ALWAYS present, per the Flight Rules honesty rule - it must never
 * be omitted just because a run happens not to show any drift-caused loss.
 */
export function formatDryRunSummary({ n, counts, wilson95 }, driftPct = DRIFT_PCT) {
  const pct = (v) => Math.round(v * 100);
  const range = `${pct(wilson95[0])}-${pct(wilson95[1])}%`;
  const resultLine = `${n} simulated sols: ${counts.arrived} arrived, ${counts.held} held, ${counts.tipped} tipped, ${counts.stalled} stalled (95% range for arrival: ${range})`;
  const driftLine = `Modeled drift: about ${driftPct}% of distance (a game assumption, not a measured rover figure)`;
  return { resultLine, driftLine };
}

/**
 * End-card "predicted vs actual" line, e.g.:
 *   "Dry run predicted 49% (range 39-59%); this run: arrived"
 * Returns null if no dry run was done before uplink (`predicted` is null),
 * so the caller can skip the line entirely rather than show a blank one.
 */
export function formatPredictedLine(predicted, outcome) {
  if (!predicted) return null;
  const pct = (v) => Math.round(v * 100);
  const range = `${pct(predicted.wilson95[0])}-${pct(predicted.wilson95[1])}%`;
  return `Dry run predicted ${pct(predicted.arrivalRate)}% (range ${range}); this run: ${OUTCOME_WORD[outcome] ?? outcome}`;
}

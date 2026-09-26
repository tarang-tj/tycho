// Small UI-lane helpers gluing the Flight Rules dry run and the real Mars
// run together, split out of main.js to keep it inside its net-line budget.
// Pure/injectable: no DOM dependency, unit-testable in node.
import { planLegsWithBoundaries, finalizeLegOutcomes, createPathSampler } from "./sol-sim.js";
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
 * `overrideSeed`, if a finite number, is returned as-is - an injection point
 * for deterministic unit tests (see mars-run.test.mjs); main.js always
 * calls this with no arguments, so nothing in the shipped game overrides it.
 * `randomSource` defaults to the real Web Crypto API and is injectable for
 * unit tests.
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
 * The ALWAYS-present Flight Rules drift disclosure, e.g.:
 *   "Modeled drift: about 1% of distance (a game assumption, not a measured rover figure)"
 * The single source for this text (review finding 5: DRY) - every place the
 * drift model's output appears on screen (the dry-run panel, the end card's
 * predicted-vs-actual line, the scoreboard's calibration row) reuses this,
 * instead of each re-typing its own copy that could drift out of sync.
 */
export function driftLabel(driftPct = DRIFT_PCT) {
  return `Modeled drift: about ${driftPct}% of distance (a game assumption, not a measured rover figure)`;
}

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
  return { resultLine, driftLine: driftLabel(driftPct) };
}

/**
 * End-card "predicted vs actual" line, e.g.:
 *   "Dry run predicted 49% (range 39-59%); this run: arrived. Modeled drift:
 *   about 1% of distance (a game assumption, not a measured rover figure)"
 * Returns null if no dry run was done before uplink (`predicted` is null),
 * so the caller can skip the line entirely rather than show a blank one.
 * Carries the same drift label formatDryRunSummary's driftLine does (review
 * finding 5): the predicted number is a product of the drift model, so it
 * must be labeled everywhere it appears, not just on the panel it came from.
 */
export function formatPredictedLine(predicted, outcome, driftPct = DRIFT_PCT) {
  if (!predicted) return null;
  const pct = (v) => Math.round(v * 100);
  const range = `${pct(predicted.wilson95[0])}-${pct(predicted.wilson95[1])}%`;
  return `Dry run predicted ${pct(predicted.arrivalRate)}% (range ${range}); this run: ${OUTCOME_WORD[outcome] ?? outcome}. ${driftLabel(driftPct)}`;
}

/**
 * Present-time rule for the drift reveal: main.js samples the REAL Mars
 * run's true/believed positions into this every physics tick while
 * `autopilot` is active, via sol-sim.js's OWN `createPathSampler` (the same
 * downsample bookkeeping `runSolPlan` uses for the dry run) - so the drive
 * loop and its sampling stay single-sourced. `finalize()` is called ONLY at
 * mission end (main.js's handleMissionTransition); nothing here is readable
 * before that, since the caller simply never calls `finalize()` early.
 */
export function createMarsTrackReveal() {
  const sampler = createPathSampler();
  return {
    sample: sampler.sample,
    /**
     * Review finding 5: push one final true/believed pair from the CURRENT
     * true state and the drift model's current offset before returning, so
     * the drawn tracks' endpoints always match the reported meters exactly -
     * without this, the last periodic sample() point (up to
     * PATH_SAMPLE_INTERVAL_S seconds stale) could trail the reported offset
     * on a mission that ends mid-drive (e.g. a "won" transition).
     * @param {{offsetM():{x:number,y:number}}|null} driftModel
     * @param {{x:number,y:number}|null} [trueState] - the true rover state at mission end
     * @param {{metersPerPixel:number}|null} [terrain] - needed to convert offsetM (meters) into the same pixel space truePath/believedPath use
     */
    finalize(driftModel, trueState = null, terrain = null) {
      const offsetM = driftModel ? driftModel.offsetM() : { x: 0, y: 0 };
      if (trueState) {
        const mpp = terrain?.metersPerPixel || 1;
        sampler.truePath.push({ x: trueState.x, y: trueState.y });
        sampler.believedPath.push({ x: trueState.x + offsetM.x / mpp, y: trueState.y + offsetM.y / mpp });
      }
      return {
        truePath: sampler.truePath,
        believedPath: sampler.believedPath,
        offsetM,
        driftLine: formatRealDriftLine(offsetM),
      };
    },
  };
}

/**
 * The REAL Mars run's end-of-mission drift disclosure, e.g.:
 *   "Drift this run: the co-pilot thought TYCHO was 14 m from where it really was."
 * Shown only at mission end (main.js's handleMissionTransition), never
 * during the run (present-time rule) - see hud.js's showEndCard.
 */
export function formatRealDriftLine(offsetM) {
  const magnitudeM = Math.hypot(offsetM.x, offsetM.y);
  return `Drift this run: the co-pilot thought TYCHO was ${Math.round(magnitudeM)} m from where it really was.`;
}

/**
 * Deterministic signature of a sol plan's waypoints + guardrails, used to
 * detect a stale dry-run prediction (review finding 2): a summary is only
 * trustworthy at uplink time if it was computed against the EXACT plan
 * being uplinked, not an earlier waypoint set or guardrail combination.
 */
export function planSignature(waypoints, guardrails) {
  return JSON.stringify({ waypoints, guardrails });
}

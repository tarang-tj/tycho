// Per-level run history, backed by localStorage (wrapped in try/catch so a
// disabled/full/private-mode localStorage degrades to "runs aren't saved"
// rather than a crash). All functions are pure over their inputs except
// load/save, which are the only ones that touch localStorage.

const STORAGE_KEY = "tycho.scoreboard.v1";
export const LOW_SAMPLE_THRESHOLD = 5;

// v1 shipped a single Moon level under the key "moon", using what is now the
// Tycho-peak terrain (assets/moon). v2 splits that into "lunokhod" (new site)
// and "tycho" (the old level, renamed). Old "moon" runs were all Tycho-peak
// runs, so they migrate to "tycho" - never dropped, never guessed at.
const KEY_MIGRATIONS = [["moon", "tycho"]];

/** Pure migration step: rename `fromKey`'s history to `toKey` if `toKey` doesn't already exist. Does not mutate `data`. */
export function migrateLevelKey(data, fromKey, toKey) {
  if (!data[fromKey] || data[toKey]) return data;
  const next = { ...data, [toKey]: data[fromKey] };
  delete next[fromKey];
  return next;
}

function migrateAll(data) {
  return KEY_MIGRATIONS.reduce((acc, [from, to]) => migrateLevelKey(acc, from, to), data);
}

/** Load all scoreboard data ({ [levelKey]: run[] }). Returns {} on any failure or if storage is unavailable. */
export function loadScoreboard() {
  try {
    if (!globalThis.localStorage) return {};
    const raw = globalThis.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? migrateAll(parsed) : {};
  } catch {
    return {};
  }
}

/** Persist scoreboard data. Returns true on success, false if storage is unavailable/failed (data is not lost from memory). */
export function saveScoreboard(data) {
  try {
    if (!globalThis.localStorage) return false;
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

/**
 * Append a run to a level's history and return the new data object (does
 * not mutate the input). `run`: { outcome, timeSec, distanceM, copilotOn,
 * predictedArrival?, medals? }. `predictedArrival` (0..1, the dry-run
 * ensemble's arrival rate at uplink time) and `medals` (string[]) are both
 * optional and validated at this boundary: an out-of-range or wrong-typed
 * value is dropped rather than stored, so a caller bug can't corrupt a
 * player's saved history.
 */
export function recordRun(data, levelKey, run) {
  // Tolerate tampered/corrupt storage (e.g. `{"moon":5}`): only spread a
  // real array, otherwise start a fresh history for this level (L4) - a
  // render-loop exception here would otherwise freeze the whole game.
  const existing = data[levelKey];
  const runs = Array.isArray(existing) ? [...existing] : [];
  const entry = { ...run, at: Date.now() };
  if (typeof entry.predictedArrival !== "number" || Number.isNaN(entry.predictedArrival) ||
      entry.predictedArrival < 0 || entry.predictedArrival > 1) {
    delete entry.predictedArrival;
  }
  if (!Array.isArray(entry.medals) || !entry.medals.every((m) => typeof m === "string")) {
    delete entry.medals;
  }
  runs.push(entry);
  return { ...data, [levelKey]: runs };
}

function successRate(runs) {
  if (!runs.length) return null;
  const wins = runs.filter((r) => r.outcome === "arrived").length;
  return wins / runs.length;
}

/**
 * Calibration: predicted vs actual arrival rate over runs that carried a
 * dry-run `predictedArrival` (0..1) at uplink time. Only over `runs` (the
 * abandoned-excluded set already computed by the caller). `actualRate` is
 * the arrival rate WITHIN that predicted-run subset, so it is directly
 * comparable to `meanPredicted` - not the level's overall success rate.
 */
function calibration(runs) {
  const predicted = runs.filter((r) => typeof r.predictedArrival === "number");
  const nPredicted = predicted.length;
  const meanPredicted = nPredicted ? predicted.reduce((sum, r) => sum + r.predictedArrival, 0) / nPredicted : null;
  const actualRate = nPredicted ? successRate(predicted) : null;
  return { nPredicted, meanPredicted, actualRate, note: sampleSizeNote(nPredicted) };
}

/**
 * Aggregate stats for a level: overall + co-pilot on/off success rates, plus
 * predicted-vs-actual calibration. "abandoned" runs (level switched or
 * retried mid-run, never reaching a real outcome) are recorded but excluded
 * from every rate denominator, including calibration - a run the player
 * walked away from is not a failure the rover caused.
 */
export function aggregate(data, levelKey) {
  const allRuns = data[levelKey] || [];
  const runs = allRuns.filter((r) => r.outcome !== "abandoned");
  const abandonedCount = allRuns.length - runs.length;
  const withCopilot = runs.filter((r) => r.copilotOn);
  const withoutCopilot = runs.filter((r) => !r.copilotOn);
  return {
    n: runs.length,
    abandonedCount,
    runs: allRuns,
    successRateAll: successRate(runs),
    successRateWith: successRate(withCopilot),
    successRateWithout: successRate(withoutCopilot),
    nWith: withCopilot.length,
    nWithout: withoutCopilot.length,
    calibration: calibration(runs),
  };
}

/** A one-line sample-size honesty note for a given run count. `abandonedCount` (if any) is disclosed, not folded into n. */
export function sampleSizeNote(n, abandonedCount = 0) {
  const abandonedNote = abandonedCount > 0 ? `; ${abandonedCount} abandoned (excluded)` : "";
  if (n === 0) return `n=0: no runs yet${abandonedNote}`;
  return (n < LOW_SAMPLE_THRESHOLD ? `n=${n}: too few runs to trust this rate` : `n=${n}`) + abandonedNote;
}

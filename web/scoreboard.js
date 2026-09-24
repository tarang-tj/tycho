// Per-level run history, backed by localStorage (wrapped in try/catch so a
// disabled/full/private-mode localStorage degrades to "runs aren't saved"
// rather than a crash). All functions are pure over their inputs except
// load/save, which are the only ones that touch localStorage.

const STORAGE_KEY = "tycho.scoreboard.v1";
export const LOW_SAMPLE_THRESHOLD = 5;

/** Load all scoreboard data ({ [levelKey]: run[] }). Returns {} on any failure or if storage is unavailable. */
export function loadScoreboard() {
  try {
    if (!globalThis.localStorage) return {};
    const raw = globalThis.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
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
 * not mutate the input). `run`: { outcome, timeSec, distanceM, copilotOn }.
 */
export function recordRun(data, levelKey, run) {
  // Tolerate tampered/corrupt storage (e.g. `{"moon":5}`): only spread a
  // real array, otherwise start a fresh history for this level (L4) - a
  // render-loop exception here would otherwise freeze the whole game.
  const existing = data[levelKey];
  const runs = Array.isArray(existing) ? [...existing] : [];
  runs.push({ ...run, at: Date.now() });
  return { ...data, [levelKey]: runs };
}

function successRate(runs) {
  if (!runs.length) return null;
  const wins = runs.filter((r) => r.outcome === "arrived").length;
  return wins / runs.length;
}

/** Aggregate stats for a level: overall + co-pilot on/off success rates. */
export function aggregate(data, levelKey) {
  const runs = data[levelKey] || [];
  const withCopilot = runs.filter((r) => r.copilotOn);
  const withoutCopilot = runs.filter((r) => !r.copilotOn);
  return {
    n: runs.length,
    runs,
    successRateAll: successRate(runs),
    successRateWith: successRate(withCopilot),
    successRateWithout: successRate(withoutCopilot),
    nWith: withCopilot.length,
    nWithout: withoutCopilot.length,
  };
}

/** A one-line sample-size honesty note for a given run count. */
export function sampleSizeNote(n) {
  if (n === 0) return "n=0: no runs yet";
  return n < LOW_SAMPLE_THRESHOLD ? `n=${n}: too few runs to trust this rate` : `n=${n}`;
}

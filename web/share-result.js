// Pure text formatter for the end card's "Copy result" button. No DOM/
// clipboard dependency here (that lives in hud.js) so the exact string is
// unit-testable in node.

const OUTCOME_WORDS = {
  arrived: "arrived in",
  tipped: "tipped after",
  stalled: "stalled after",
  held: "held after",
  abandoned: "abandoned after",
};

function formatMinSec(timeSec) {
  const total = Math.max(0, Math.round(timeSec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Build the plain-text share line for an end card, e.g.:
 *   "TYCHO · Lunokhod · arrived in 3:12 · delay 1.28 s · co-pilot off · https://tarang-tj.github.io/tycho/"
 * Separator is a middle dot, not an em dash.
 */
export function formatShareResult({ levelLabel, outcome, timeSec, delaySec, copilotOn, url }) {
  const outcomeWord = OUTCOME_WORDS[outcome] ?? "ended after";
  const delayText = delaySec == null ? "n/a" : `${delaySec.toFixed(2)} s`;
  const copilotText = copilotOn ? "on" : "off";
  return `TYCHO · ${levelLabel} · ${outcomeWord} ${formatMinSec(timeSec)} · delay ${delayText} · co-pilot ${copilotText} · ${url}`;
}

// Plain-ASCII glyph per leg outcome (web/sol-sim.js's `legOutcomes`: one of
// "ok" | "held" | "tipped" | "unreached"). Plain ASCII, not unicode blocks,
// so the grid survives being pasted into anything (chat apps, plain-text
// notes) without a font that supports box-drawing glyphs. "?" is the
// defensive fallback for any outcome string this module doesn't know about,
// so a future new outcome degrades visibly instead of throwing.
const LEG_GLYPHS = { ok: "#", held: "H", tipped: "X", unreached: "." };

/** Build the daily-share leg grid: one glyph per waypoint leg, in order. */
export function formatLegGrid(legOutcomes) {
  if (!Array.isArray(legOutcomes)) return "";
  return legOutcomes.map((outcome) => LEG_GLYPHS[outcome] ?? "?").join("");
}

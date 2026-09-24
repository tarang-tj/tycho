// Level + Mars-scenario configuration. Split out of main.js purely to keep
// files under the project's ~200-line guideline; pure data plus one small
// pure helper, no DOM/three.js dependency.
import { BRIEFS } from "./mission.js";

// Mars scenarios: honest real one-way delay, compressed for play. "Typical"
// matches the plan's worked example (12 min compressed 40x -> 18s wait).
export const MARS_SCENARIOS = [
  { key: "close", label: "Close approach", realMinutes: 3, compression: 15 },
  { key: "typical", label: "Typical", realMinutes: 12, compression: 40 },
  { key: "conjunction", label: "Near conjunction", realMinutes: 22, compression: 55 },
];

export const LEVELS = {
  lunokhod: { body: "lunokhod", label: "Lunokhod", mode: "live", delaySec: 1.28, briefLines: BRIEFS.lunokhod },
  tycho: { body: "moon", label: "Tycho", mode: "live", delaySec: 1.28, briefLines: BRIEFS.tycho },
  mars: { body: "mars", label: "Mars", mode: "plan", briefLines: BRIEFS.mars, scenarios: MARS_SCENARIOS },
};

// Level keys in the order they cycle (title screen arrow keys, etc).
export const LEVEL_ORDER = ["lunokhod", "tycho", "mars"];

/** Resolve a Mars scenario by key, defaulting to "typical" if unknown/omitted. */
export function resolveScenario(level, scenarioKey) {
  return level.scenarios.find((s) => s.key === scenarioKey) ?? level.scenarios[1];
}

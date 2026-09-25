// Level + delay-model configuration. Split out of main.js purely to keep
// files under the project's ~200-line guideline; pure data plus small pure
// helpers, no DOM/three.js dependency.
//
// Every level separates THREE independent axes so no code elsewhere needs to
// branch on a level key or asset directory name:
//   planet ("moon" | "mars")   drives rendering look only (sky.js, scene.js
//                               LOOK table, ground-fx.js, textures.js, ...)
//   mode   ("live" | "plan")   drives mission stall/telemetry logic
//                               (mission.js) and input routing (main.js)
//   delay  (see below)         how the one-way light-time delay is resolved
// `assetKey` is only ever used to pick the assets/<assetKey>/ directory to
// fetch (terrain-data.js) - it never leaks into rendering or mission logic.
import { BRIEFS } from "./mission.js";

// Mars scenarios: honest real one-way delay, compressed for play. "Typical"
// matches the plan's worked example (12 min compressed 40x -> 18s wait).
// Shared by every "mars-scenarios" delay-type level (currently just Jezero;
// Opportunity would have been a second one, but it's blocked - see the
// LEVEL_ORDER comment below).
export const MARS_SCENARIOS = [
  { key: "close", label: "Close approach", realMinutes: 3, compression: 15 },
  { key: "typical", label: "Typical", realMinutes: 12, compression: 40 },
  { key: "conjunction", label: "Near conjunction", realMinutes: 22, compression: 55 },
];

// Delay model shapes:
//   { type: "direct", oneWaySec }
//     A fixed live one-way delay (line-of-sight or a relay close enough to
//     treat as constant for play).
//   { type: "relay", fallbackOneWaySec, pathLabel }
//     Real value comes from the loaded terrain's meta.delayModel (produced
//     by the data pipeline) at RUN time - see resolveDelaySec/resolveDelayLabel
//     below. Falls back to `fallbackOneWaySec`, clearly labelled as a
//     fallback, if that asset doesn't ship a delayModel yet.
//   { type: "mars-scenarios" }
//     Player picks one of MARS_SCENARIOS on the mission brief; see
//     resolveScenario/resolveDelaySec.
export const LEVELS = {
  lunokhod: {
    key: "lunokhod", assetKey: "lunokhod", planet: "moon", mode: "live",
    delay: { type: "direct", oneWaySec: 1.28 },
    landmarkKind: "lunokhod2",
    label: "Lunokhod", siteLabel: "Le Monnier crater",
    briefLines: BRIEFS.lunokhod,
    arrivalLine: "You reached Lunokhod 2. It has been parked here since 1973.",
  },
  tycho: {
    key: "tycho", assetKey: "moon", planet: "moon", mode: "live",
    delay: { type: "direct", oneWaySec: 1.28 },
    label: "Tycho", siteLabel: "Tycho central peak",
    briefLines: BRIEFS.tycho,
  },
  mars: {
    key: "mars", assetKey: "mars", planet: "mars", mode: "plan",
    delay: { type: "mars-scenarios" },
    label: "Jezero", siteLabel: "Jezero crater",
    briefLines: BRIEFS.mars,
  },
  change4: {
    key: "change4", assetKey: "change4", planet: "moon", mode: "live",
    delay: { type: "relay", fallbackOneWaySec: 1.28, pathLabel: "Earth > Queqiao relay > far side" },
    landmarkKind: "change4",
    label: "Chang'e-4", siteLabel: "Von Karman crater, lunar far side",
    briefLines: BRIEFS.change4,
    arrivalLine: "You reached the Chang'e-4 lander. It has sat on the lunar far side since January 2019.",
  },
  apollo17: {
    key: "apollo17", assetKey: "apollo17", planet: "moon", mode: "live",
    delay: { type: "direct", oneWaySec: 1.28 },
    landmarkKind: "lrv",
    label: "Apollo 17", siteLabel: "Taurus-Littrow valley",
    briefLines: BRIEFS.apollo17,
    arrivalLine: "You reached the Apollo 17 Lunar Roving Vehicle, left here by the astronauts in December 1972.",
  },
};

// Level keys in the order they cycle (title screen arrow keys, level cards,
// top-bar buttons). Grouped by mode: the four "live" Moon sites first,
// easiest/most-immediate first (Lunokhod, Chang'e-4, Apollo 17 are all a
// short drive to a real parked object), Tycho's steeper climb next, then the
// one "plan" site (Jezero) last since it's a different mechanic (sol plan +
// co-pilot) introduced only after the player already understands live
// driving. Opportunity was dropped: TYCHO's premise is real terrain, and no
// primary source for Opportunity's precise final position was found (see
// plans/260923-2234-tycho-rover/levelup-v3/reports/w1-d-data.md) - shipping
// it on synthetic terrain would contradict that premise, so it's cut
// entirely rather than shipped fake. See README's "Next" note.
export const LEVEL_ORDER = ["lunokhod", "change4", "apollo17", "tycho", "mars"];

/** Resolve a Mars-scenarios-type delay scenario by key, defaulting to "typical" if unknown/omitted. */
export function resolveScenario(scenarioKey) {
  return MARS_SCENARIOS.find((s) => s.key === scenarioKey) ?? MARS_SCENARIOS[1];
}

/** The scenario list for a level, or null if its delay isn't scenario-based. */
export function getScenarios(level) {
  return level.delay.type === "mars-scenarios" ? MARS_SCENARIOS : null;
}

/**
 * Resolve a level's one-way delay in SECONDS for the run about to start.
 * `terrainMeta` is the loaded terrain's meta.json (only consulted for the
 * "relay" type); `scenarioKey` only matters for "mars-scenarios".
 */
export function resolveDelaySec(level, terrainMeta, scenarioKey) {
  switch (level.delay.type) {
    case "direct":
      return level.delay.oneWaySec;
    case "relay":
      return terrainMeta?.delayModel?.oneWaySec ?? level.delay.fallbackOneWaySec;
    case "mars-scenarios": {
      const scenario = resolveScenario(scenarioKey);
      return (scenario.realMinutes * 60) / scenario.compression;
    }
    default:
      throw new Error(`unknown delay type "${level.delay.type}"`);
  }
}

/**
 * A human-readable relay-path HUD label for "relay" delay levels, e.g.
 * "Earth > Queqiao relay > far side". Prefers the real path from the loaded
 * terrain's meta.delayModel; falls back to the level's own label, clearly
 * marked as a fallback, if the asset hasn't shipped a delayModel yet.
 * Returns null for every other delay type (nothing to show).
 */
export function resolveDelayLabel(level, terrainMeta) {
  if (level.delay.type !== "relay") return null;
  const real = terrainMeta?.delayModel;
  if (real?.pathLabel) return real.pathLabel;
  return `${level.delay.pathLabel} (fallback path label; this asset has not shipped a delay model yet)`;
}

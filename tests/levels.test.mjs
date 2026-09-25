// Unit tests for the level model (web/levels.js): every level resolves a
// valid planet/mode/delay, delay resolution is correct for each delay type
// (including the relay fallback), and the old hardcoded level/body string
// checks this wave removed do not creep back into mission/scene/main logic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  LEVELS, LEVEL_ORDER, MARS_SCENARIOS,
  getScenarios, resolveScenario, resolveDelaySec, resolveDelayLabel,
} from "../web/levels.js";

test("every level in LEVEL_ORDER resolves a valid planet, mode, and delay type", () => {
  for (const key of LEVEL_ORDER) {
    const level = LEVELS[key];
    assert.ok(level, `LEVELS is missing an entry for "${key}"`);
    assert.equal(level.key, key, `level.key must match its own LEVELS key ("${key}")`);
    assert.ok(["moon", "mars"].includes(level.planet), `${key}: planet must be "moon" or "mars", got "${level.planet}"`);
    assert.ok(["live", "plan"].includes(level.mode), `${key}: mode must be "live" or "plan", got "${level.mode}"`);
    assert.ok(["direct", "relay", "mars-scenarios"].includes(level.delay.type), `${key}: unknown delay type "${level.delay.type}"`);
    assert.ok(typeof level.assetKey === "string" && level.assetKey.length > 0, `${key}: assetKey must be a non-empty string`);
    assert.ok(Array.isArray(level.briefLines) && level.briefLines.length > 0, `${key}: briefLines must be non-empty`);
  }
});

test("a plan-mode level always has a mars-scenarios delay, and vice versa", () => {
  for (const key of LEVEL_ORDER) {
    const level = LEVELS[key];
    assert.equal(level.mode === "plan", level.delay.type === "mars-scenarios", `${key}: mode="${level.mode}" but delay.type="${level.delay.type}" (these must agree)`);
  }
});

test("getScenarios returns MARS_SCENARIOS only for mars-scenarios levels", () => {
  assert.equal(getScenarios(LEVELS.mars), MARS_SCENARIOS);
  assert.equal(getScenarios(LEVELS.opportunity), MARS_SCENARIOS);
  assert.equal(getScenarios(LEVELS.lunokhod), null);
  assert.equal(getScenarios(LEVELS.change4), null);
});

test("resolveScenario defaults to typical and finds a scenario by key", () => {
  assert.equal(resolveScenario(undefined).key, "typical");
  assert.equal(resolveScenario("close").key, "close");
  assert.equal(resolveScenario("nonexistent-key").key, "typical");
});

test("resolveDelaySec: direct delay is the fixed configured value", () => {
  assert.equal(resolveDelaySec(LEVELS.lunokhod, {}), 1.28);
  assert.equal(resolveDelaySec(LEVELS.apollo17, {}), 1.28);
});

test("resolveDelaySec: mars-scenarios delay compresses the real minutes by the scenario's factor", () => {
  const sec = resolveDelaySec(LEVELS.mars, {}, "close");
  assert.equal(sec, (3 * 60) / 15);
  const secOpportunity = resolveDelaySec(LEVELS.opportunity, {}, "conjunction");
  assert.equal(secOpportunity, (22 * 60) / 55);
});

test("resolveDelaySec: relay delay reads terrain.meta.delayModel.oneWaySec when the asset ships one", () => {
  const sec = resolveDelaySec(LEVELS.change4, { delayModel: { oneWaySec: 2.1 } });
  assert.equal(sec, 2.1);
});

test("resolveDelaySec: relay delay falls back to the level's labelled fallback when meta has no delayModel yet", () => {
  const sec = resolveDelaySec(LEVELS.change4, {});
  assert.equal(sec, LEVELS.change4.delay.fallbackOneWaySec);
  const secNoMeta = resolveDelaySec(LEVELS.change4, null);
  assert.equal(secNoMeta, LEVELS.change4.delay.fallbackOneWaySec);
});

test("resolveDelayLabel: only relay-type levels get a label; real path label wins over the fallback", () => {
  assert.equal(resolveDelayLabel(LEVELS.mars, {}), null, "mars-scenarios levels have no relay label");
  assert.equal(resolveDelayLabel(LEVELS.lunokhod, {}), null, "direct-delay levels have no relay label");
  assert.match(resolveDelayLabel(LEVELS.change4, {}), /fallback/i, "no meta.delayModel yet: label must say so, not invent a path");
  const real = resolveDelayLabel(LEVELS.change4, { delayModel: { pathLabel: "Earth > Queqiao > far side" } });
  assert.equal(real, "Earth > Queqiao > far side");
});

// --- Regression: the level-identity string checks this wave removed must not creep back in ---

const webSrc = (name) => readFileSync(fileURLToPath(new URL(`../web/${name}`, import.meta.url)), "utf8");

test("mission.js gates stall/arrival logic on mode/arrivalLine, not a hardcoded level key", () => {
  const src = webSrc("mission.js");
  assert.doesNotMatch(src, /["']mars["']/, 'mission.js must not reference the level key "mars" directly');
  assert.doesNotMatch(src, /["']lunokhod["']/, 'mission.js must not reference the level key "lunokhod" directly');
});

test("scene.js resolves the render look from opts.planet, not a level/asset key", () => {
  const src = webSrc("scene.js");
  assert.doesNotMatch(src, /opts\.body\s*===\s*["']lunokhod["']/, "scene.js must not special-case the Lunokhod asset key directly");
  assert.doesNotMatch(src, /opts\.body\s*===\s*["']m(oon|ars)["']/, "scene.js must resolve the planet from opts.planet, not opts.body");
});

test("main.js loads terrain and scene options from level.assetKey/planet, not a level.body field", () => {
  const src = webSrc("main.js");
  assert.doesNotMatch(src, /level\.body\b/, "main.js must not read a level.body field (use level.assetKey/level.planet)");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { formatShareResult, formatLegGrid } from "../web/share-result.js";

test("formats an arrived result with delay and co-pilot off", () => {
  const line = formatShareResult({
    levelLabel: "Lunokhod", outcome: "arrived", timeSec: 192, delaySec: 1.28,
    copilotOn: false, url: "https://tarang-tj.github.io/tycho/",
  });
  assert.equal(line, "TYCHO · Lunokhod · arrived in 3:12 · delay 1.28 s · co-pilot off · https://tarang-tj.github.io/tycho/");
});

test("formats a co-pilot-on Mars result", () => {
  const line = formatShareResult({
    levelLabel: "Mars", outcome: "arrived", timeSec: 65, delaySec: 12.0,
    copilotOn: true, url: "https://tarang-tj.github.io/tycho/",
  });
  assert.match(line, /co-pilot on/);
  assert.match(line, /1:05/);
});

test("formats a non-arrived outcome (held)", () => {
  const line = formatShareResult({
    levelLabel: "Mars", outcome: "held", timeSec: 30, delaySec: 12.0,
    copilotOn: true, url: "https://tarang-tj.github.io/tycho/",
  });
  assert.match(line, /held after 0:30/);
});

test("never contains an em dash", () => {
  const line = formatShareResult({
    levelLabel: "Tycho", outcome: "stalled", timeSec: 5, delaySec: null,
    copilotOn: false, url: "https://tarang-tj.github.io/tycho/",
  });
  assert.equal(line.includes("—"), false);
  assert.match(line, /delay n\/a/);
});

// --- byte-identical regression: fixtures captured from this exact function
// BEFORE the formatLegGrid addition below, so a future edit to
// formatShareResult that changes its output for any of these inputs fails
// loudly here rather than silently reaching players.
test("formatShareResult regression fixtures stay byte-identical", () => {
  const fixtures = [
    [
      { levelLabel: "Apollo 17", outcome: "arrived", timeSec: 725, delaySec: 1.28, copilotOn: false, url: "https://tarang-tj.github.io/tycho/" },
      "TYCHO · Apollo 17 · arrived in 12:05 · delay 1.28 s · co-pilot off · https://tarang-tj.github.io/tycho/",
    ],
    [
      { levelLabel: "Chang'e-4", outcome: "tipped", timeSec: 41.9, delaySec: 1.28, copilotOn: false, url: "https://tarang-tj.github.io/tycho/" },
      "TYCHO · Chang'e-4 · tipped after 0:42 · delay 1.28 s · co-pilot off · https://tarang-tj.github.io/tycho/",
    ],
    [
      { levelLabel: "Jezero", outcome: "abandoned", timeSec: 0, delaySec: 18, copilotOn: true, url: "https://tarang-tj.github.io/tycho/" },
      "TYCHO · Jezero · abandoned after 0:00 · delay 18.00 s · co-pilot on · https://tarang-tj.github.io/tycho/",
    ],
  ];
  for (const [input, expected] of fixtures) assert.equal(formatShareResult(input), expected);
});

// --- formatLegGrid -------------------------------------------------------

test("formatLegGrid maps each leg outcome to its glyph in order", () => {
  assert.equal(formatLegGrid(["ok", "ok", "held", "tipped", "unreached"]), "##HX.");
});

test("formatLegGrid returns an empty string for an empty or non-array input", () => {
  assert.equal(formatLegGrid([]), "");
  assert.equal(formatLegGrid(null), "");
  assert.equal(formatLegGrid(undefined), "");
});

test("formatLegGrid maps an unrecognized outcome to a defensive fallback glyph, not a throw", () => {
  assert.equal(formatLegGrid(["ok", "some-future-outcome"]), "#?");
});

test("formatLegGrid never contains an em dash", () => {
  assert.equal(formatLegGrid(["ok", "held", "tipped", "unreached"]).includes("—"), false);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { formatShareResult } from "../web/share-result.js";

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

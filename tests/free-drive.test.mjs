import { test } from "node:test";
import assert from "node:assert/strict";
import { freeDriveApplies, runDelaySec, FREE_DRIVE_NOTE } from "../web/free-drive.js";
import { formatShareResult } from "../web/share-result.js";

test("free drive applies only to live-drive levels, never to Mars' plan mode", () => {
  assert.equal(freeDriveApplies({ mode: "live" }, true), true);
  assert.equal(freeDriveApplies({ mode: "plan" }, true), false);
  assert.equal(freeDriveApplies({ mode: "live" }, false), false);
  assert.equal(freeDriveApplies(undefined, true), false);
});

test("free drive removes the delay; otherwise the real delay is kept exactly", () => {
  assert.equal(runDelaySec(1.28, true), 0);
  assert.equal(runDelaySec(1.71, false), 1.71);
});

test("the free drive label says it is not realistic and not counted", () => {
  assert.match(FREE_DRIVE_NOTE, /not realistic/i);
  assert.match(FREE_DRIVE_NOTE, /not counted/i);
  assert.doesNotMatch(FREE_DRIVE_NOTE, /—/);
});

test("a free-drive share line says free drive instead of a delay; normal lines are unchanged", () => {
  const base = { levelLabel: "Lunokhod", outcome: "arrived", timeSec: 192, delaySec: 1.28, copilotOn: false, url: "https://tarang-tj.github.io/tycho/" };
  assert.equal(formatShareResult(base), "TYCHO · Lunokhod · arrived in 3:12 · delay 1.28 s · co-pilot off · https://tarang-tj.github.io/tycho/");
  assert.equal(formatShareResult({ ...base, delaySec: 0, freeDrive: true }), "TYCHO · Lunokhod · arrived in 3:12 · free drive, no delay (not realistic) · co-pilot off · https://tarang-tj.github.io/tycho/");
});

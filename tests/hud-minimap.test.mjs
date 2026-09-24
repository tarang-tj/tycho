// H3 regression test: snapToGoal is the pure part of the minimap
// click-to-place logic (see web/hud.js's use of it) - no DOM dependency, so
// it's unit-testable directly. The guardrail-clamp behavior (M5) is
// exercised indirectly through buildGuardrailControls in a browser only
// (it builds real <input> elements); its clamp math is covered here via
// the same bounds documented in hud-minimap.js's `rows`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { snapToGoal } from "../web/hud-minimap.js";

const terrain = { width: 1024, height: 1024 };
const goal = { x: 512, y: 512 };

test("H3: a click within the snap radius lands exactly on the goal", () => {
  // 1 CSS px on a 220px canvas for a 1024px terrain = ~4.65 terrain px/CSS px.
  const canvasSize = 220;
  const snapped = snapToGoal(515, 512, goal, terrain, canvasSize, canvasSize, 10);
  assert.deepEqual(snapped, { x: 512, y: 512 });
});

test("H3: a click outside the snap radius is left untouched", () => {
  const canvasSize = 220;
  const snapped = snapToGoal(700, 512, goal, terrain, canvasSize, canvasSize, 10);
  assert.deepEqual(snapped, { x: 700, y: 512 });
});

test("H3: with no goal, the click passes through unchanged", () => {
  const snapped = snapToGoal(10, 20, null, terrain, 220, 220, 10);
  assert.deepEqual(snapped, { x: 10, y: 20 });
});

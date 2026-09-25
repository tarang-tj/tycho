import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateObjectives, PAR_SEC, MAX_SLOPE_DEG } from "../web/objectives.js";

test("evaluateObjectives returns [] for an unknown level key", () => {
  assert.deepEqual(evaluateObjectives("nonexistent-level", { outcome: "arrived", timeSec: 1, maxSlopeDeg: 1, distanceM: 1 }), []);
});

test("evaluateObjectives returns [] for a wave-1 level not yet covered", () => {
  assert.deepEqual(evaluateObjectives("future-site", { outcome: "arrived" }), []);
});

for (const levelKey of ["lunokhod", "change4", "apollo17", "tycho"]) {
  test(`${levelKey}: arrive objective is met only on outcome "arrived"`, () => {
    const arrived = evaluateObjectives(levelKey, { outcome: "arrived", timeSec: 1, maxSlopeDeg: 1, distanceM: 1 });
    const tipped = evaluateObjectives(levelKey, { outcome: "tipped", timeSec: 1, maxSlopeDeg: 1, distanceM: 1 });
    assert.equal(arrived.find((o) => o.id === "arrive").met, true);
    assert.equal(tipped.find((o) => o.id === "arrive").met, false);
  });

  test(`${levelKey}: beat-par objective requires arriving strictly under PAR_SEC`, () => {
    const par = PAR_SEC[levelKey];
    // Tie: exactly at par does NOT count as beating it.
    const tie = evaluateObjectives(levelKey, { outcome: "arrived", timeSec: par, maxSlopeDeg: 0, distanceM: 1 });
    assert.equal(tie.find((o) => o.id === "beat-par").met, false, `${levelKey}: tying par must not count as beating it`);

    const faster = evaluateObjectives(levelKey, { outcome: "arrived", timeSec: par - 1, maxSlopeDeg: 0, distanceM: 1 });
    assert.equal(faster.find((o) => o.id === "beat-par").met, true);

    const slower = evaluateObjectives(levelKey, { outcome: "arrived", timeSec: par + 1, maxSlopeDeg: 0, distanceM: 1 });
    assert.equal(slower.find((o) => o.id === "beat-par").met, false);
  });

  test(`${levelKey}: gentle-line objective requires arriving at/under MAX_SLOPE_DEG`, () => {
    const maxDeg = MAX_SLOPE_DEG[levelKey];
    const atLimit = evaluateObjectives(levelKey, { outcome: "arrived", timeSec: 1, maxSlopeDeg: maxDeg, distanceM: 1 });
    assert.equal(atLimit.find((o) => o.id === "gentle-line").met, true, `${levelKey}: exactly at the limit should still count`);

    const overLimit = evaluateObjectives(levelKey, { outcome: "arrived", timeSec: 1, maxSlopeDeg: maxDeg + 0.1, distanceM: 1 });
    assert.equal(overLimit.find((o) => o.id === "gentle-line").met, false);

    // Below the physical tip limit for every level (a real skill constraint, not a restatement of "don't tip").
    assert.ok(maxDeg < 32, `${levelKey}: MAX_SLOPE_DEG must stay under the 32deg tip limit`);
  });

  test(`${levelKey}: gentle-line objective is not met without arriving, even under the slope limit`, () => {
    const objectives = evaluateObjectives(levelKey, { outcome: "held", timeSec: 1, maxSlopeDeg: 0, distanceM: 1 });
    assert.equal(objectives.find((o) => o.id === "gentle-line").met, false);
  });

  test(`${levelKey}: labels are plain text with no em dashes`, () => {
    const objectives = evaluateObjectives(levelKey, { outcome: "arrived", timeSec: 1, maxSlopeDeg: 1, distanceM: 1 });
    for (const o of objectives) assert.ok(!o.label.includes("—"), `${levelKey}: "${o.label}" contains an em dash`);
  });
}

test("mars: arrive objective is met only on outcome \"arrived\"", () => {
  const arrived = evaluateObjectives("mars", { outcome: "arrived", timeSec: 1, maxSlopeDeg: 1, distanceM: 1 });
  const held = evaluateObjectives("mars", { outcome: "held", timeSec: 1, maxSlopeDeg: 1, distanceM: 1 });
  assert.equal(arrived.find((o) => o.id === "arrive").met, true);
  assert.equal(held.find((o) => o.id === "arrive").met, false);
});

test("mars: reroute-assist objective requires arriving AND copilotOn true", () => {
  const withAssist = evaluateObjectives("mars", { outcome: "arrived", timeSec: 1, maxSlopeDeg: 1, distanceM: 1, copilotOn: true });
  assert.equal(withAssist.find((o) => o.id === "reroute-assist").met, true);

  const withoutAssist = evaluateObjectives("mars", { outcome: "arrived", timeSec: 1, maxSlopeDeg: 1, distanceM: 1, copilotOn: false });
  assert.equal(withoutAssist.find((o) => o.id === "reroute-assist").met, false);

  // copilotOn is optional: an absent field must not throw and must not count as "on".
  const omitted = evaluateObjectives("mars", { outcome: "arrived", timeSec: 1, maxSlopeDeg: 1, distanceM: 1 });
  assert.equal(omitted.find((o) => o.id === "reroute-assist").met, false);
});

test("mars: no beat-par or gentle-line objectives (Mars has no par or live slope skill)", () => {
  const objectives = evaluateObjectives("mars", { outcome: "arrived", timeSec: 1, maxSlopeDeg: 1, distanceM: 1 });
  assert.equal(objectives.length, 2);
  assert.deepEqual(objectives.map((o) => o.id).sort(), ["arrive", "reroute-assist"]);
});

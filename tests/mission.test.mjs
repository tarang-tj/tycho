import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createMission, startMission, updateMission,
  whatHappenedLine, averageDelaySec, GOAL_RADIUS_M, STALL_TIMEOUT_S,
} from "../web/mission.js";
import { LEVELS } from "../web/levels.js";

const TERRAIN = { metersPerPixel: 1, meta: { goal: { x: 100, y: 0 } } };

// `sentAt` is the rover-true timestamp of this snapshot (see C1: the stall
// clock is measured against this, not the caller's simTime).
function telem(x, y, sentAt, extra = {}) {
  return { state: { x, y, tipped: false, ...extra }, sentAt };
}

test("mission starts in brief and moves to active on startMission", () => {
  const brief = createMission("moon");
  assert.equal(brief.status, "brief");
  const active = startMission(brief, 5);
  assert.equal(active.status, "active");
  assert.equal(active.startSimTime, 5);
});

test("a brief/non-active mission is unaffected by updateMission", () => {
  const brief = createMission("moon");
  const result = updateMission(brief, { visibleTelemetry: telem(0, 0, 0), simTime: 1, terrain: TERRAIN });
  assert.equal(result.status, "brief");
});

test("reaching the goal radius transitions to won/arrived", () => {
  let m = startMission(createMission("moon"), 0);
  m = updateMission(m, { visibleTelemetry: telem(100 - GOAL_RADIUS_M + 1, 0, 1), simTime: 1, terrain: TERRAIN });
  assert.equal(m.status, "won");
  assert.equal(m.outcome, "arrived");
});

test("a tipped telemetry state transitions to tipped", () => {
  let m = startMission(createMission("moon"), 0);
  m = updateMission(m, { visibleTelemetry: telem(0, 0, 2, { tipped: true }), simTime: 2, terrain: TERRAIN });
  assert.equal(m.status, "tipped");
  assert.equal(m.outcome, "tipped");
});

test("no progress toward the goal for STALL_TIMEOUT_S of ROVER time transitions to stalled", () => {
  let m = startMission(createMission("moon"), 0);
  // First tick establishes the progress baseline (no stall clock yet).
  m = updateMission(m, { visibleTelemetry: telem(0, 0, 0), simTime: 0, terrain: TERRAIN });
  assert.equal(m.status, "active");
  // Second tick with no progress starts the stall clock (rover time 1).
  m = updateMission(m, { visibleTelemetry: telem(0, 0, 1), simTime: 1, terrain: TERRAIN });
  assert.equal(m.status, "active");
  // Once STALL_TIMEOUT_S has elapsed in ROVER time since the clock started, the run stalls.
  m = updateMission(m, { visibleTelemetry: telem(0, 0, 1 + STALL_TIMEOUT_S + 1), simTime: 1, terrain: TERRAIN });
  assert.equal(m.status, "stalled");
  assert.equal(m.outcome, "stalled");
});

test("C1: a large gap between simTime and the telemetry's rover-true sentAt does not itself cause a stall", () => {
  // Reproduces the exact C1 shape: the player's clock (simTime) can be far
  // ahead of the rover's true timestamp on this snapshot (a long one-way
  // telemetry delay) - that gap alone must never count as stall time.
  let m = startMission(createMission("moon"), 0);
  m = updateMission(m, { visibleTelemetry: telem(0, 0, 0), simTime: 0, terrain: TERRAIN });
  // simTime jumps 24s ahead (as if a 24s one-way delay just elapsed) while
  // the visible telemetry's own rover-true time only advanced 1s.
  m = updateMission(m, { visibleTelemetry: telem(0, 0, 1), simTime: 24, terrain: TERRAIN });
  assert.equal(m.status, "active", "a telemetry delay gap alone must not trigger a stall");
});

test("progress resets the stall clock", () => {
  let m = startMission(createMission("moon"), 0);
  m = updateMission(m, { visibleTelemetry: telem(0, 0, 0), simTime: 0, terrain: TERRAIN });
  m = updateMission(m, { visibleTelemetry: telem(1, 0, STALL_TIMEOUT_S - 1), simTime: STALL_TIMEOUT_S - 1, terrain: TERRAIN });
  assert.equal(m.status, "active", "progress should have reset the stall timer");
});

test("Mars stall clock does not start until the VISIBLE telemetry shows planActive (C1)", () => {
  let m = startMission(createMission("mars", LEVELS.mars), 0);
  // Telemetry visible but planActive is still false (plan not yet delivered,
  // or delivered but not yet visible to the player): no stall clock at all,
  // however much rover-true time passes.
  m = updateMission(m, { visibleTelemetry: telem(0, 0, 0), simTime: 0, terrain: TERRAIN });
  m = updateMission(m, { visibleTelemetry: telem(0, 0, STALL_TIMEOUT_S + 100), simTime: STALL_TIMEOUT_S + 100, terrain: TERRAIN });
  assert.equal(m.status, "active", "should not stall while planActive is false in visible telemetry");

  // First tick where visible telemetry shows planActive: establishes the
  // progress baseline (no stall clock yet).
  m = updateMission(m, { visibleTelemetry: telem(0, 0, 500, { planActive: true }), simTime: 500, terrain: TERRAIN });
  assert.equal(m.status, "active");
  // Second tick with no progress starts the stall clock (rover time 501).
  m = updateMission(m, { visibleTelemetry: telem(0, 0, 501, { planActive: true }), simTime: 501, terrain: TERRAIN });
  assert.equal(m.status, "active");
  // Once STALL_TIMEOUT_S has elapsed in rover time with still no progress, the run stalls.
  m = updateMission(m, { visibleTelemetry: telem(0, 0, 501 + STALL_TIMEOUT_S + 1, { planActive: true }), simTime: 501, terrain: TERRAIN });
  assert.equal(m.status, "stalled");
});

test("a copilotHold telemetry field transitions to held", () => {
  let m = startMission(createMission("mars", LEVELS.mars), 0);
  m = updateMission(m, { visibleTelemetry: telem(0, 0, 1, { copilotHold: "HOLD: no safe path", planActive: true }), simTime: 1, terrain: TERRAIN });
  assert.equal(m.status, "held");
  assert.equal(m.outcome, "held");
  assert.match(whatHappenedLine(m), /HOLD/);
});

test("averageDelaySec and whatHappenedLine reflect accumulated telemetry age", () => {
  let m = startMission(createMission("moon"), 0);
  m = updateMission(m, { visibleTelemetry: telem(0, 0, 0), simTime: 0, terrain: TERRAIN, telemetryAgeSec: 2 });
  m = updateMission(m, { visibleTelemetry: telem(100, 0, 1), simTime: 1, terrain: TERRAIN, telemetryAgeSec: 4 });
  assert.equal(averageDelaySec(m), 3);
  assert.equal(m.status, "won");
  assert.match(whatHappenedLine(m), /3\.0 s/);
});

// --- U2/U1: outcome wording must credit the right actor -----------------

test("U2: a Mars arrival credits the co-pilot's driving, not the player's steering", () => {
  let m = startMission(createMission("mars", LEVELS.mars), 0);
  m = updateMission(m, { visibleTelemetry: telem(100 - GOAL_RADIUS_M + 1, 0, 1, { planActive: true }), simTime: 1, terrain: TERRAIN });
  assert.equal(m.status, "won");
  const line = whatHappenedLine(m);
  assert.match(line, /co-pilot/i);
  assert.doesNotMatch(line, /you steered/i);
});

test("U1: a Lunokhod arrival states the true parked-since fact, nothing more", () => {
  let m = startMission(createMission("lunokhod", LEVELS.lunokhod), 0);
  m = updateMission(m, { visibleTelemetry: telem(100 - GOAL_RADIUS_M + 1, 0, 1), simTime: 1, terrain: TERRAIN });
  assert.equal(m.status, "won");
  assert.equal(whatHappenedLine(m), "You reached Lunokhod 2. It has been parked here since 1973.");
});

test("U2: an abandoned outcome has an honest, non-blaming line", () => {
  const m = { ...startMission(createMission("mars", LEVELS.mars), 0), outcome: "abandoned" };
  assert.match(whatHappenedLine(m), /abandoned/i);
});

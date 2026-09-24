import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createMission, startMission, updateMission, markPlanUplinked,
  whatHappenedLine, averageDelaySec, GOAL_RADIUS_M, STALL_TIMEOUT_S,
} from "../web/mission.js";

const TERRAIN = { metersPerPixel: 1, meta: { goal: { x: 100, y: 0 } } };

function telem(x, y, extra = {}) {
  return { state: { x, y, tipped: false, ...extra }, sentAt: 0 };
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
  const result = updateMission(brief, { visibleTelemetry: telem(0, 0), simTime: 1, terrain: TERRAIN });
  assert.equal(result.status, "brief");
});

test("reaching the goal radius transitions to won/arrived", () => {
  let m = startMission(createMission("moon"), 0);
  m = updateMission(m, { visibleTelemetry: telem(100 - GOAL_RADIUS_M + 1, 0), simTime: 1, terrain: TERRAIN });
  assert.equal(m.status, "won");
  assert.equal(m.outcome, "arrived");
});

test("a tipped telemetry state transitions to tipped", () => {
  let m = startMission(createMission("moon"), 0);
  m = updateMission(m, { visibleTelemetry: telem(0, 0, { tipped: true }), simTime: 2, terrain: TERRAIN });
  assert.equal(m.status, "tipped");
  assert.equal(m.outcome, "tipped");
});

test("no progress toward the goal for STALL_TIMEOUT_S transitions to stalled", () => {
  let m = startMission(createMission("moon"), 0);
  // First tick establishes the progress baseline (no stall clock yet).
  m = updateMission(m, { visibleTelemetry: telem(0, 0), simTime: 0, terrain: TERRAIN });
  assert.equal(m.status, "active");
  // Second tick with no progress starts the stall clock.
  m = updateMission(m, { visibleTelemetry: telem(0, 0), simTime: 1, terrain: TERRAIN });
  assert.equal(m.status, "active");
  // Once STALL_TIMEOUT_S has elapsed since the clock started, the run stalls.
  m = updateMission(m, { visibleTelemetry: telem(0, 0), simTime: 1 + STALL_TIMEOUT_S + 1, terrain: TERRAIN });
  assert.equal(m.status, "stalled");
  assert.equal(m.outcome, "stalled");
});

test("progress resets the stall clock", () => {
  let m = startMission(createMission("moon"), 0);
  m = updateMission(m, { visibleTelemetry: telem(0, 0), simTime: 0, terrain: TERRAIN });
  m = updateMission(m, { visibleTelemetry: telem(1, 0), simTime: STALL_TIMEOUT_S - 1, terrain: TERRAIN });
  assert.equal(m.status, "active", "progress should have reset the stall timer");
});

test("Mars stall clock does not start until a plan is uplinked", () => {
  let m = startMission(createMission("mars"), 0);
  m = updateMission(m, { visibleTelemetry: telem(0, 0), simTime: 0, terrain: TERRAIN });
  m = updateMission(m, { visibleTelemetry: telem(0, 0), simTime: STALL_TIMEOUT_S + 100, terrain: TERRAIN });
  assert.equal(m.status, "active", "should not stall before a plan is uplinked");
  m = markPlanUplinked(m);
  assert.equal(m.planUplinked, true);
  // First post-uplink tick establishes the progress baseline (no stall clock yet).
  m = updateMission(m, { visibleTelemetry: telem(0, 0), simTime: 500, terrain: TERRAIN });
  assert.equal(m.status, "active");
  // Second tick with no progress starts the stall clock.
  m = updateMission(m, { visibleTelemetry: telem(0, 0), simTime: 501, terrain: TERRAIN });
  assert.equal(m.status, "active");
  // Once STALL_TIMEOUT_S has elapsed with still no progress, the run stalls.
  m = updateMission(m, { visibleTelemetry: telem(0, 0), simTime: 501 + STALL_TIMEOUT_S + 1, terrain: TERRAIN });
  assert.equal(m.status, "stalled");
});

test("a copilotHold telemetry field transitions to held", () => {
  let m = startMission(createMission("mars"), 0);
  m = markPlanUplinked(m);
  m = updateMission(m, { visibleTelemetry: telem(0, 0, { copilotHold: "HOLD: no safe path" }), simTime: 1, terrain: TERRAIN });
  assert.equal(m.status, "held");
  assert.equal(m.outcome, "held");
  assert.match(whatHappenedLine(m), /HOLD/);
});

test("averageDelaySec and whatHappenedLine reflect accumulated telemetry age", () => {
  let m = startMission(createMission("moon"), 0);
  m = updateMission(m, { visibleTelemetry: telem(0, 0), simTime: 0, terrain: TERRAIN, telemetryAgeSec: 2 });
  m = updateMission(m, { visibleTelemetry: telem(100, 0), simTime: 1, terrain: TERRAIN, telemetryAgeSec: 4 });
  assert.equal(averageDelaySec(m), 3);
  assert.equal(m.status, "won");
  assert.match(whatHappenedLine(m), /3\.0 s/);
});

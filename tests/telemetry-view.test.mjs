// H1 regression test: no present-time leak. The co-pilot's rerouted path,
// the HOLD status, and "plan active" must reach the player only through
// telemetry - i.e. only once visible (delayed) telemetry carries them, not
// at the rover's true present-time moment they happened. web/main.js wires
// these same pure helpers to drive the scene overlay/status line, so fixing
// the leak here fixes it there too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSignalLink } from "../web/signal.js";
import { deriveCopilotDisplay, planVisibleToPlayer } from "../web/telemetry-view.js";

test("H1: an event stamped into telemetry at rover time t is invisible to the HUD-facing state before t + delay", () => {
  const delaySec = 5;
  const signal = createSignalLink(delaySec);
  const t = 10;

  // The rover's plan goes active and hits a hazard HOLD at true rover time t.
  signal.telemetry({ x: 0, y: 0, copilotHold: "HOLD: slope 30deg exceeds the 25deg limit ahead", planActive: true, autopilotPath: [{ x: 1, y: 1 }] }, t);

  // Just before t + delay: nothing has arrived yet - the player must see nothing.
  const early = signal.visibleTelemetry(t + delaySec - 0.01);
  assert.equal(early, null, "no telemetry should be visible yet");
  assert.equal(planVisibleToPlayer(early?.state), false);
  const earlyDisplay = deriveCopilotDisplay(early?.state, false);
  assert.equal(earlyDisplay.holdReason, null, "the HOLD must not leak before its telemetry delay elapses");
  assert.equal(earlyDisplay.mode, "", "no hold/waiting mode should show before the event is visible");

  // At/after t + delay: the event has now arrived and must be visible.
  const arrived = signal.visibleTelemetry(t + delaySec);
  assert.ok(arrived, "telemetry should have arrived by t + delay");
  assert.equal(planVisibleToPlayer(arrived.state), true);
  const display = deriveCopilotDisplay(arrived.state, false);
  assert.equal(display.holdReason, "HOLD: slope 30deg exceeds the 25deg limit ahead");
  assert.equal(display.mode, "hold");
  assert.deepEqual(display.path, [{ x: 1, y: 1 }]);
});

test("H1: waitingOnSignal (Earth-side knowledge of an in-flight command) is allowed on present time", () => {
  // Unlike the rover-side HOLD/path, "a command is currently in flight" is
  // something the player legitimately knows the instant they send it - it
  // must NOT be gated on visible telemetry.
  const display = deriveCopilotDisplay(null, true);
  assert.equal(display.mode, "waiting");
  assert.equal(display.holdReason, null);
});

test("H1: a HOLD reported in telemetry always outranks a merely in-flight command for display mode", () => {
  const display = deriveCopilotDisplay({ copilotHold: "HOLD: no safe path", autopilotPath: [] }, true);
  assert.equal(display.mode, "hold");
});

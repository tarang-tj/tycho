import { test } from "node:test";
import assert from "node:assert/strict";
import { createSignalLink } from "../web/signal.js";

test("uplinked command is invisible to the rover before tNow + delay", () => {
  const link = createSignalLink(1.28);
  link.uplink({ throttle: 1 }, 0);
  assert.deepEqual(link.pullDeliveredCommands(0), []);
  assert.deepEqual(link.pullDeliveredCommands(1.0), []);
  assert.deepEqual(link.pullDeliveredCommands(1.27), []);
});

test("uplinked command is delivered at exactly tNow + delay and after", () => {
  const link = createSignalLink(1.28);
  link.uplink({ throttle: 1 }, 0);
  const delivered = link.pullDeliveredCommands(1.28);
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0], { throttle: 1 });
});

test("delivered commands are popped once, oldest first", () => {
  const link = createSignalLink(1);
  link.uplink({ cmd: "a" }, 0);
  link.uplink({ cmd: "b" }, 0.5);
  const delivered = link.pullDeliveredCommands(2);
  assert.deepEqual(delivered.map((c) => c.cmd), ["a", "b"]);
  assert.deepEqual(link.pullDeliveredCommands(3), []);
});

test("telemetry is not visible before tNow + delay, then lags by delay", () => {
  const link = createSignalLink(1.28);
  link.telemetry({ x: 5 }, 0);
  assert.equal(link.visibleTelemetry(1.0), null);
  const visible = link.visibleTelemetry(1.28);
  assert.deepEqual(visible.state, { x: 5 });
  assert.equal(link.telemetryAge(1.28), 1.28);
  assert.equal(link.telemetryAge(2.28), 2.28);
});

test("visibleTelemetry always returns the latest arrived snapshot", () => {
  const link = createSignalLink(1);
  link.telemetry({ x: 1 }, 0);
  link.telemetry({ x: 2 }, 0.5);
  const visible = link.visibleTelemetry(2);
  assert.deepEqual(visible.state, { x: 2 });
});

test("commandsInFlight counts only undelivered commands", () => {
  const link = createSignalLink(2);
  link.uplink({}, 0);
  link.uplink({}, 1);
  assert.equal(link.commandsInFlight(0), 2);
  assert.equal(link.commandsInFlight(2), 1); // first command arrives exactly at t=2, so only the second is still in flight
  link.pullDeliveredCommands(2);
  assert.equal(link.commandsInFlight(2), 1);
  assert.equal(link.commandsInFlight(3), 0);
});

test("rejects a negative delay", () => {
  assert.throws(() => createSignalLink(-1));
});

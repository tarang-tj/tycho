// Pure helpers that decide what the player is ALLOWED to see. Everything
// about the rover's own decisions (co-pilot reroute path, HOLD status,
// "plan delivered") must be derived from VISIBLE (delayed) telemetry only -
// never from the rover's true present-time state - or the HUD/scene leaks
// present-time information the player shouldn't have yet (see H1 in the
// pre-publish review). The one exception is "a command is currently in
// flight": that's Earth-side knowledge the player has the instant they
// press a key, so it's passed in separately and allowed on present time.
//
// No DOM/three.js dependency; deterministic, unit-testable in node.

/**
 * The co-pilot overlay state to show, derived only from visible telemetry
 * plus Earth-side "is a command in flight" knowledge.
 * `visibleState`: the `state` object from signal.js's visibleTelemetry()
 * (may be undefined/null if nothing has arrived yet).
 */
export function deriveCopilotDisplay(visibleState, waitingOnSignal) {
  const holdReason = visibleState?.copilotHold ?? null;
  const path = visibleState?.autopilotPath ?? [];
  const mode = holdReason ? "hold" : waitingOnSignal ? "waiting" : "";
  return { mode, path, holdReason };
}

/**
 * True only once the delayed telemetry itself shows the sol plan is active
 * on the rover - i.e. once that fact has actually become visible to the
 * player, never at the rover's true present-time plan-delivery moment.
 */
export function planVisibleToPlayer(visibleState) {
  return !!visibleState?.planActive;
}

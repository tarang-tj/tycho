// Pure light-time link. Simulates the one-way speed-of-light delay between
// Earth (the player) and the rover.
//
// The simulation runs in "true present" time (tNow, seconds, injected by the
// caller - never Date.now() inside this module, so it is deterministic and
// testable). Two one-way legs exist:
//   uplink:    a command sent at tNow arrives at the rover at tNow + delay
//   telemetry: a state sent at tNow is visible to the player at tNow + delay
// A full command-and-see-the-result round trip therefore takes 2x delay.

/**
 * Create a signal link with a fixed one-way delay (seconds). Returns an
 * object with independent uplink and telemetry queues so command delay and
 * telemetry delay stay separately testable and separately swappable (e.g.
 * a future variable-delay Mars model).
 */
export function createSignalLink(oneWayDelaySec) {
  if (!(oneWayDelaySec >= 0)) throw new Error("oneWayDelaySec must be a non-negative number");

  const uplinkQueue = []; // { cmd, sentAt, arriveAt }
  const telemetryQueue = []; // { state, sentAt, arriveAt }
  let lastVisibleTelemetry = null;

  /** Queue a command sent at tNow; returns the time it will arrive. */
  function uplink(cmd, tNow) {
    const arriveAt = tNow + oneWayDelaySec;
    uplinkQueue.push({ cmd, sentAt: tNow, arriveAt });
    return arriveAt;
  }

  /**
   * Pop and return every command that has now arrived (arriveAt <= tNow),
   * oldest first. Call once per simulation tick on the rover side.
   */
  function pullDeliveredCommands(tNow) {
    const delivered = [];
    while (uplinkQueue.length && uplinkQueue[0].arriveAt <= tNow) {
      delivered.push(uplinkQueue.shift().cmd);
    }
    return delivered;
  }

  /** Queue a telemetry snapshot sent (from the rover) at tNow. */
  function telemetry(state, tNow) {
    telemetryQueue.push({ state, sentAt: tNow, arriveAt: tNow + oneWayDelaySec });
  }

  /**
   * The most recent telemetry snapshot that has arrived by tNow, or null if
   * none has arrived yet. Older arrived snapshots are discarded (the player
   * only cares about the latest picture of the past).
   */
  function visibleTelemetry(tNow) {
    while (telemetryQueue.length && telemetryQueue[0].arriveAt <= tNow) {
      lastVisibleTelemetry = telemetryQueue.shift();
    }
    return lastVisibleTelemetry ? { ...lastVisibleTelemetry } : null;
  }

  /** Count of commands sent but not yet delivered - drives the "signal in flight" HUD. */
  function commandsInFlight(tNow) {
    return uplinkQueue.filter((entry) => entry.arriveAt > tNow).length;
  }

  /** Age (seconds) of the currently visible telemetry, or null if none yet. */
  function telemetryAge(tNow) {
    const visible = visibleTelemetry(tNow);
    return visible ? tNow - visible.sentAt : null;
  }

  return {
    oneWayDelaySec,
    uplink,
    pullDeliveredCommands,
    telemetry,
    visibleTelemetry,
    commandsInFlight,
    telemetryAge,
  };
}

// Top HUD strip readout: body/delay/in-flight/telemetry-age/speed/slope/
// goal-distance text. Pure DOM text updates, no state of its own - reads
// whatever main.js's render loop passes in each frame.

/** Distance (meters) from the currently VISIBLE (delayed) telemetry to the level's goal, or null if unknown. */
export function distanceToGoal(terrain, visibleState) {
  const goal = terrain?.meta?.goal;
  if (!goal || !visibleState) return null;
  const dx = (visibleState.state.x - goal.x) * terrain.metersPerPixel;
  const dy = (visibleState.state.y - goal.y) * terrain.metersPerPixel;
  return Math.hypot(dx, dy);
}

/** Update the top HUD strip's text content from the current frame's state. */
export function updateHudReadout(el, { level, terrain, signal, simTime, visibleState }) {
  el.body.textContent = level.label;
  el.delay.textContent = signal ? `${signal.oneWayDelaySec.toFixed(2)} s` : "--";
  el.inFlight.textContent = String(signal ? signal.commandsInFlight(simTime) : 0);
  const age = signal ? signal.telemetryAge(simTime) : null;
  el.telemetryAge.textContent = age == null ? "no signal yet" : `${age.toFixed(1)} s ago`;
  const vs = visibleState?.state;
  el.speed.textContent = vs ? `${vs.speed.toFixed(2)} m/s` : "--";
  el.slope.textContent = vs ? `${vs.slopeDeg.toFixed(1)}°` : "--";
  const dist = distanceToGoal(terrain, visibleState);
  el.goalDist.textContent = dist == null ? "--" : `${dist.toFixed(0)} m`;
}

// Pure rover physics. Fixed-dt step, no DOM/three.js dependency, no
// wall-clock reads — every input is a parameter, so it is deterministic
// and unit-testable in node.

const DEFAULT_OPTS = {
  maxSlopeDeg: 25,   // beyond this the rover stops and is flagged tipped
  accel: 1.2,        // m/s^2 at full throttle
  drag: 0.6,         // m/s^2 deceleration when throttle is released
  maxSpeed: 3.0,      // m/s
  turnRateDegPerSec: 45, // at full steer and max speed
};

/** Create an initial rover state (x, y in terrain pixel coords, meters via metersPerPixel is caller's job). */
export function createRover({ x = 0, y = 0, heading = 0, speed = 0 } = {}) {
  return { x, y, heading, speed, tipped: false, elevM: 0, slopeDeg: 0 };
}

/**
 * Advance the rover one fixed timestep under a control input and a terrain.
 * control: { throttle: -1..1, steer: -1..1 }
 * terrain: shared terrain interface from terrain-data.js (elev, slopeDeg),
 *          with x/y in the SAME pixel units as rover.x/rover.y.
 * Returns a NEW state object (pure function, no mutation of the input).
 */
export function stepRover(state, control, terrain, dt, opts = {}) {
  const cfg = { ...DEFAULT_OPTS, ...opts };
  const throttle = Math.max(-1, Math.min(1, control?.throttle ?? 0));
  const steer = Math.max(-1, Math.min(1, control?.steer ?? 0));

  if (state.tipped) {
    // A tipped rover stays put until the caller resets it (e.g. new level).
    return { ...state, speed: 0 };
  }

  // Steering: turn rate scales with how fast the rover is moving.
  const speedFactor = Math.min(1, Math.abs(state.speed) / cfg.maxSpeed || 0) || (throttle !== 0 ? 0.3 : 0);
  const headingDeg = state.heading + steer * cfg.turnRateDegPerSec * speedFactor * dt;
  const heading = ((headingDeg % 360) + 360) % 360;

  // Throttle: accelerate toward maxSpeed*throttle, otherwise decay via drag.
  let speed = state.speed;
  const targetSpeed = throttle * cfg.maxSpeed;
  if (Math.abs(targetSpeed - speed) < 1e-9) {
    // already there
  } else if (targetSpeed > speed) {
    speed = Math.min(targetSpeed, speed + cfg.accel * dt);
  } else {
    speed = Math.max(targetSpeed, speed - (throttle === 0 ? cfg.drag : cfg.accel) * dt);
  }

  const headingRad = (heading * Math.PI) / 180;
  const metersPerPixel = terrain.metersPerPixel || 1;
  const dxMeters = Math.sin(headingRad) * speed * dt;
  const dyMeters = Math.cos(headingRad) * speed * dt;
  const x = state.x + dxMeters / metersPerPixel;
  const y = state.y + dyMeters / metersPerPixel;

  const slope = terrain.slopeDeg(x, y);
  if (slope > cfg.maxSlopeDeg) {
    // Too steep: stop the rover in place (does not commit the move) and flag it tipped.
    return { ...state, speed: 0, tipped: true, slopeDeg: slope, elevM: terrain.elev(state.x, state.y) };
  }

  return {
    x, y, heading, speed,
    tipped: false,
    slopeDeg: slope,
    elevM: terrain.elev(x, y),
  };
}

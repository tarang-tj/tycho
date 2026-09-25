// Pure localization-drift model for Flight Rules sol plans. No DOM/three.js
// dependency, deterministic (seeded), unit-testable in node.
import { mulberry32 } from "./prng.js";

// game assumption, not a measured rover figure
export const DRIFT_PCT = 1;

/** Standard normal draw via Box-Muller, fed by a mulberry32 stream. */
function boxMullerNormal(rng) {
  let u1 = rng();
  while (u1 <= Number.EPSILON) u1 = rng(); // avoid log(0)
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * A seeded heading-bias model of rover localization drift: once per run, a
 * single heading bias `b` (radians) is drawn from Normal(0, sigma), with
 * sigma chosen so the MEDIAN of |b| equals driftPct/100 radians. Every true
 * displacement driven this run is rotated by that same fixed `b` to produce
 * the BELIEVED displacement; the accumulated (believed - true) vector is
 * what corrupts the steering loop's read of position (`believed = true +
 * offset`). It never corrupts the control output itself, and it never
 * touches the physics/terrain the rover actually stands on (see
 * sol-sim.js's autopilotStep). For a straight drive of length d, the final
 * offset magnitude is approximately d*|b|, so its MEDIAN is driftPct
 * percent of distance driven, independent of step size (dt).
 *
 * @param {{seed?: number, driftPct?: number}} [opts]
 * @returns {{advance(dxTrueM: number, dyTrueM: number): void, offsetM(): {x: number, y: number}}}
 */
export function createDriftModel({ seed = 0, driftPct = DRIFT_PCT } = {}) {
  const rng = mulberry32(seed);
  // z ~ N(0,1) has median|z| = 0.6745 (the standard normal's quartile
  // constant), so dividing driftPct/100 by 0.6745 makes the median of |b|
  // land exactly on driftPct/100 radians.
  const sigma = (driftPct / 100) / 0.6745;
  const bias = sigma * boxMullerNormal(rng);
  const cosB = Math.cos(bias);
  const sinB = Math.sin(bias);
  let x = 0;
  let y = 0;
  return {
    /** Rotate this tick's true displacement (meters) by the run's fixed heading bias and accumulate believed-minus-true. */
    advance(dxTrueM, dyTrueM) {
      if (!dxTrueM && !dyTrueM) return;
      const believedDx = dxTrueM * cosB - dyTrueM * sinB;
      const believedDy = dxTrueM * sinB + dyTrueM * cosB;
      x += believedDx - dxTrueM;
      y += believedDy - dyTrueM;
    },
    /** Current accumulated believed-minus-true offset, in meters. */
    offsetM() {
      return { x, y };
    },
  };
}

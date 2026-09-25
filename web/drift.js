// Pure localization-drift model for Flight Rules sol plans. No DOM/three.js
// dependency, deterministic (seeded), unit-testable in node.
import { mulberry32 } from "./prng.js";

// Modeled drift, a game assumption, not a measured rover figure: fixed ONCE,
// up front, at a documented value in [1, 5] percent of distance driven.
// Must NOT be retuned to make ensemble results look more interesting - see
// plan-wave2.md's honesty rules. Labeled on screen everywhere it appears.
export const DRIFT_PCT = 3;

// Per-meter wander of the walk's own heading. Two failure modes bound this
// constant, both measured this session over a representative ~1.8km Mars
// sol-plan drive at DRIFT_PCT=3 (see tools/tune_drift_heading_wander.mjs):
// resampling the direction fully independently every tick (no correlation
// at all) mostly cancels itself out over thousands of small ticks, netting
// well under a meter of drift - nowhere near enough for a 6-15 m arrival
// radius to ever notice, defeating the whole feature. A wander rate that is
// too SLOW (direction barely turns over the whole drive) instead makes the
// walk nearly a fixed vector, netting close to the full driftPct% of total
// distance driven (~54 m here) on almost every seed - enough to break even
// an easy, hazard-free plan on every run, which is just as dishonest in the
// other direction. 1.5 rad of heading wander per meter driven sits between
// those two extremes (median final offset ~9 m, p90 ~17 m over that same
// drive): correlated enough to matter, decorrelated enough to still vary
// run to run.
const HEADING_WANDER_RAD_PER_M = 1.5;

/**
 * A seeded 2D random-walk model of rover localization drift: the rover's
 * BELIEVED position drifts away from its TRUE position as it drives,
 * growing with distance traveled. This corrupts only what the steering
 * loop reads (`believed = true + offset`); it never corrupts the control
 * output itself, and it never touches the physics/terrain the rover
 * actually stands on (see sol-sim.js's autopilotStep).
 *
 * @param {{seed?: number, driftPct?: number}} [opts]
 * @returns {{advance(distanceM: number): void, offsetM(): {x: number, y: number}}}
 */
export function createDriftModel({ seed = 0, driftPct = DRIFT_PCT } = {}) {
  const rng = mulberry32(seed);
  let angleRad = rng() * Math.PI * 2; // seeded initial heading bias
  let x = 0;
  let y = 0;
  return {
    /** Accumulate one more correlated random-walk step sized to the distance just driven (meters). */
    advance(distanceM) {
      if (!distanceM) return;
      angleRad += (rng() - 0.5) * HEADING_WANDER_RAD_PER_M * distanceM;
      const magnitudeM = distanceM * (driftPct / 100);
      x += Math.cos(angleRad) * magnitudeM;
      y += Math.sin(angleRad) * magnitudeM;
    },
    /** Current accumulated believed-minus-true offset, in meters. */
    offsetM() {
      return { x, y };
    },
  };
}

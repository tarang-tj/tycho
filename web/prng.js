// Deterministic 32-bit PRNG (mulberry32). Pure, no DOM/three.js dependency,
// no wall-clock reads: same seed always produces the same stream, which is
// what lets sol-sim.js/ensemble.js reproduce a run byte-for-byte.

/**
 * Create a mulberry32 generator seeded by a uint32.
 * @param {number} seed
 * @returns {() => number} a function returning a float in [0, 1) each call
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

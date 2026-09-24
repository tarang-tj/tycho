// Two small, DOM-free guards against the level-load race described in the
// pre-publish review (H4): a stale async terrain load finishing after a
// newer one started, and two concurrent requestAnimationFrame loop chains
// both scheduling themselves forever (double physics ticks, double
// renders, leaked GPU memory). Both are pure and injected with
// schedule/cancel so they're unit-testable without a browser - see
// tests/async-guards.test.mjs. main.js wires the real requestAnimationFrame/
// cancelAnimationFrame for production use.

/**
 * A load-generation token. Call `next()` when a new async load starts; it
 * invalidates every earlier generation. After an `await`, call
 * `isCurrent(gen)` to check whether a newer load has since started, and
 * bail out (drop this result) if not.
 */
export function createGenerationGuard() {
  let gen = 0;
  return {
    next: () => ++gen,
    isCurrent: (g) => g === gen,
  };
}

/**
 * A run loop that guarantees at most one active `schedule` chain at a time,
 * even if `start()` is called again before the previous chain notices it
 * was superseded. `schedule`/`cancel` are injected
 * (requestAnimationFrame/cancelAnimationFrame in production, fakes in
 * tests). `getLiveCount()` exposes how many step chains are currently still
 * alive (i.e. still rescheduling themselves) - this should never exceed 1
 * and is the debug counter H4 asks for.
 */
export function createSingleLoop(schedule, cancel) {
  let token = 0;
  let handle = null;
  let liveCount = 0;

  function stop() {
    if (handle != null) {
      cancel(handle);
      handle = null;
      liveCount = Math.max(0, liveCount - 1); // the cancelled chain is no longer live
    }
  }

  /** Start (or restart) the loop; `step(arg)` runs once per scheduled tick. */
  function start(step) {
    stop();
    const myToken = ++token;
    liveCount += 1;
    const tick = (arg) => {
      if (myToken !== token) {
        // Defense in depth: only reachable if `cancel` failed to actually
        // prevent this callback (stop() already accounts for the normal path).
        liveCount = Math.max(0, liveCount - 1);
        return;
      }
      handle = schedule(tick);
      step(arg);
    };
    handle = schedule(tick);
  }

  return { start, stop, getLiveCount: () => liveCount };
}

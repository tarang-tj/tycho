// DOM input wiring: keyboard, touch pad, level-select buttons, and the
// render-loop lifecycle (resize, pause on tab-hide). Pure glue - all game
// logic (what a command DOES) lives in main.js/rover-sim.js; this module
// only turns DOM events into `sendCommand()` calls and starts/stops the
// single render loop main.js owns (see web/async-guards.js).
const KEY_MAP = { w: "forward", arrowup: "forward", s: "back", arrowdown: "back", a: "left", arrowleft: "left", d: "right", arrowright: "right" };

/**
 * Wire keyboard/touch/level-select/lifecycle listeners.
 * `runtime` bundles the small pieces of main.js's mutable render-loop state
 * this module needs to touch, since main.js owns that state (not a global):
 *   sendCommand(cmd), loadLevel(key), resizeCanvas(), isReady(),
 *   startLoop(), stopLoop()
 */
export function wireControls(runtime) {
  const { sendCommand, loadLevel, resizeCanvas, isReady, startLoop, stopLoop } = runtime;
  const held = new Set();
  let lastSentControl = { throttle: 0, steer: 0 };

  /** Forget the last-sent intent (e.g. on mission restart) so a still-held key resends its command to the fresh run. */
  function resetIntent() {
    lastSentControl = { throttle: 0, steer: 0 };
  }

  function intentFromHeld() {
    const throttle = (held.has("forward") ? 1 : 0) - (held.has("back") ? 1 : 0);
    const steer = (held.has("right") ? 1 : 0) - (held.has("left") ? 1 : 0);
    return { throttle, steer };
  }

  function applyIntentChange() {
    const next = intentFromHeld();
    if (next.throttle !== lastSentControl.throttle || next.steer !== lastSentControl.steer) {
      lastSentControl = next;
      sendCommand(next);
    }
  }

  /** Forget every held key without sending a final "stop" (the run may already
   * be gone/reset) - just clears local intent state (M7). */
  function releaseAllHeld() {
    if (!held.size) return;
    held.clear();
    applyIntentChange();
  }

  // --- Keyboard controls (edge-triggered: a command is sent only when intent changes) ---
  window.addEventListener("keydown", (event) => {
    const control = KEY_MAP[event.key.toLowerCase()];
    if (!control) return;
    held.add(control);
    applyIntentChange();
  });
  window.addEventListener("keyup", (event) => {
    const control = KEY_MAP[event.key.toLowerCase()];
    if (!control) return;
    held.delete(control);
    applyIntentChange();
  });
  // M7: a lost focus/tab switch can drop the matching keyup (e.g. alt-tab
  // while holding W), leaving the rover driving forever on return.
  window.addEventListener("blur", releaseAllHeld);

  // --- Touch pad ---
  for (const btn of document.querySelectorAll(".pad-btn")) {
    const control = btn.dataset.control;
    btn.addEventListener("pointerdown", () => { held.add(control); applyIntentChange(); });
    const release = () => { held.delete(control); applyIntentChange(); };
    btn.addEventListener("pointerup", release);
    btn.addEventListener("pointerleave", release);
    btn.addEventListener("pointercancel", release);
  }

  // --- Level select ---
  for (const btn of document.querySelectorAll(".level-btn")) {
    btn.addEventListener("click", () => loadLevel(btn.dataset.level));
  }

  // --- Lifecycle: pause the loop when the tab is hidden, clear stuck keys (M7) ---
  window.addEventListener("resize", resizeCanvas);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      releaseAllHeld();
      stopLoop();
    } else if (isReady()) {
      startLoop();
    }
  });

  return { resetIntent };
}

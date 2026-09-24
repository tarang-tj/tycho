// H4 regression tests: web/main.js's level loader had two races (see the
// pre-publish review) - a stale async terrain load finishing after a newer
// one started, and two concurrent requestAnimationFrame loop chains both
// scheduling themselves forever. Both fixes live in a small DOM-free module
// (web/async-guards.js) so they're provable here without a browser; main.js
// wires the same module for the real fix (see main.js's loadLevel/startLoop).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGenerationGuard, createSingleLoop } from "../web/async-guards.js";

test("H4: a stale async load is dropped by the generation guard", async () => {
  const guard = createGenerationGuard();
  const applied = [];

  async function load(id, delayMs) {
    const gen = guard.next();
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (!guard.isCurrent(gen)) return; // a newer load started meanwhile: drop this one
    applied.push(id);
  }

  // "moon" starts first but resolves slow (like a boot-time terrain fetch);
  // "mars" starts after and resolves fast (like the player mashing Start).
  // Only the LAST call to start should ever apply its result.
  const first = load("moon", 30);
  const second = load("mars", 5);
  await Promise.all([first, second]);

  assert.deepEqual(applied, ["mars"], "the stale 'moon' load must never apply after 'mars' superseded it");
});

test("H4: a load that finishes before anything supersedes it still applies", async () => {
  const guard = createGenerationGuard();
  const applied = [];
  async function load(id, delayMs) {
    const gen = guard.next();
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (!guard.isCurrent(gen)) return;
    applied.push(id);
  }
  await load("moon", 1);
  assert.deepEqual(applied, ["moon"]);
});

function makeFakeRaf() {
  let nextId = 0;
  const pending = new Map();
  return {
    schedule(cb) {
      const id = ++nextId;
      pending.set(id, cb);
      return id;
    },
    cancel(id) {
      pending.delete(id);
    },
    tick() {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const cb of callbacks) cb();
    },
  };
}

test("H4: repeated fast start() calls (level-switch spam) leave exactly one active loop chain", () => {
  const raf = makeFakeRaf();
  const loop = createSingleLoop(raf.schedule, raf.cancel);
  const stepCounts = { moon: 0, mars: 0, moon2: 0 };

  // Simulate the player mashing level-select before the previous loop even
  // gets a chance to render a single frame - the exact H4 scenario.
  loop.start(() => { stepCounts.moon += 1; });
  loop.start(() => { stepCounts.mars += 1; });
  loop.start(() => { stepCounts.moon2 += 1; });

  raf.tick();
  raf.tick();
  raf.tick();

  assert.equal(loop.getLiveCount(), 1, "exactly one loop chain must still be alive after repeated fast switches");
  assert.equal(stepCounts.moon, 0, "the first (superseded) loop must never have run a frame");
  assert.equal(stepCounts.mars, 0, "the second (superseded) loop must never have run a frame");
  assert.equal(stepCounts.moon2, 3, "only the last-started loop should have rendered frames");
});

test("H4: stop() halts the loop and getLiveCount drops to 0", () => {
  const raf = makeFakeRaf();
  const loop = createSingleLoop(raf.schedule, raf.cancel);
  let calls = 0;
  loop.start(() => { calls += 1; });
  raf.tick();
  assert.equal(calls, 1);
  loop.stop();
  raf.tick(); // nothing pending after stop(), tick() is a no-op
  assert.equal(calls, 1, "no more frames should render after stop()");
});

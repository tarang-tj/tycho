import { test } from "node:test";
import assert from "node:assert/strict";
import { createRover, stepRover } from "../web/rover-sim.js";
import { createSyntheticTerrain } from "../web/terrain-data.js";

const FLAT_TERRAIN = {
  metersPerPixel: 1,
  elev: () => 0,
  slopeDeg: () => 0,
};

test("rover accelerates forward under positive throttle", () => {
  let state = createRover({ x: 0, y: 0, heading: 0 });
  for (let i = 0; i < 60; i++) {
    state = stepRover(state, { throttle: 1, steer: 0 }, FLAT_TERRAIN, 1 / 60);
  }
  assert.ok(state.speed > 0, "speed should increase under throttle");
  assert.ok(state.y > 0 || state.x !== 0, "rover should have moved");
});

test("rover decelerates toward zero when throttle released", () => {
  let state = { ...createRover(), speed: 2 };
  for (let i = 0; i < 60; i++) {
    state = stepRover(state, { throttle: 0, steer: 0 }, FLAT_TERRAIN, 1 / 60);
  }
  assert.ok(state.speed < 2, "speed should decay without throttle");
});

test("rover follows terrain height: elevM tracks the terrain under it", () => {
  const terrain = createSyntheticTerrain({ width: 128, height: 128, metersPerPixel: 2, peakHeight: 400, seed: 5 });
  let state = createRover({ x: 10, y: 64, heading: 90 }); // heading 90deg = +x direction
  for (let i = 0; i < 300; i++) {
    state = stepRover(state, { throttle: 1, steer: 0 }, terrain, 1 / 60, { maxSlopeDeg: 89 });
  }
  const expectedElev = terrain.elev(state.x, state.y);
  assert.ok(Math.abs(state.elevM - expectedElev) < 1e-6, "elevM should equal terrain elevation at the rover's position");
});

test("rover stops and flags tipped when slope exceeds the configured limit", () => {
  const steepTerrain = {
    metersPerPixel: 1,
    elev: (x) => x * 50, // very steep ramp
    slopeDeg: (x) => (x > 1 ? 60 : 0), // steep only ahead of the rover
  };
  let state = createRover({ x: 0, y: 0, heading: 90 });
  let tippedAt = -1;
  for (let i = 0; i < 200; i++) {
    state = stepRover(state, { throttle: 1, steer: 0 }, steepTerrain, 1 / 60, { maxSlopeDeg: 25 });
    if (state.tipped) { tippedAt = i; break; }
  }
  assert.ok(tippedAt >= 0, "rover should have tipped on the steep slope");
  assert.equal(state.speed, 0, "tipped rover should have zero speed");
  // Once tipped, further steps must not move it.
  const before = { x: state.x, y: state.y };
  state = stepRover(state, { throttle: 1, steer: 0 }, steepTerrain, 1 / 60, { maxSlopeDeg: 25 });
  assert.deepEqual({ x: state.x, y: state.y }, before, "a tipped rover must stay in place");
});

test("stepRover does not mutate the input state object", () => {
  const state = createRover({ x: 0, y: 0 });
  const frozen = Object.freeze({ ...state });
  assert.doesNotThrow(() => stepRover(frozen, { throttle: 1, steer: 0 }, FLAT_TERRAIN, 1 / 60));
});

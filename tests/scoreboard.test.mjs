import { test } from "node:test";
import assert from "node:assert/strict";
import { loadScoreboard, saveScoreboard, recordRun, aggregate, sampleSizeNote } from "../web/scoreboard.js";

function withFakeStorage(store, fn) {
  const original = globalThis.localStorage;
  globalThis.localStorage = store;
  try {
    return fn();
  } finally {
    if (original === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = original;
  }
}

function memoryStorage() {
  const backing = new Map();
  return {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => backing.set(k, v),
  };
}

test("loadScoreboard returns {} when localStorage is unavailable", () => {
  const result = withFakeStorage(undefined, () => loadScoreboard());
  assert.deepEqual(result, {});
});

test("saveScoreboard returns false when localStorage is unavailable", () => {
  const result = withFakeStorage(undefined, () => saveScoreboard({ moon: [] }));
  assert.equal(result, false);
});

test("loadScoreboard tolerates a localStorage that throws", () => {
  const angry = { getItem: () => { throw new Error("quota exceeded"); } };
  const result = withFakeStorage(angry, () => loadScoreboard());
  assert.deepEqual(result, {});
});

test("saveScoreboard tolerates a localStorage that throws", () => {
  const angry = { setItem: () => { throw new Error("quota exceeded"); } };
  const result = withFakeStorage(angry, () => saveScoreboard({ moon: [] }));
  assert.equal(result, false);
});

test("save then load round-trips through a working storage", () => {
  withFakeStorage(memoryStorage(), () => {
    const data = recordRun({}, "moon", { outcome: "arrived", timeSec: 12, distanceM: 40, copilotOn: false });
    assert.equal(saveScoreboard(data), true);
    const loaded = loadScoreboard();
    assert.equal(loaded.moon.length, 1);
    assert.equal(loaded.moon[0].outcome, "arrived");
  });
});

test("recordRun appends without mutating the original data", () => {
  const before = { moon: [{ outcome: "tipped", timeSec: 3, distanceM: 1, copilotOn: false }] };
  const after = recordRun(before, "moon", { outcome: "arrived", timeSec: 9, distanceM: 20, copilotOn: true });
  assert.equal(before.moon.length, 1, "original data must not be mutated");
  assert.equal(after.moon.length, 2);
});

test("L4: recordRun tolerates a tampered non-array value for a level (e.g. {\"moon\":5}) instead of throwing", () => {
  const before = { moon: 5 }; // corrupt/tampered localStorage shape
  const after = recordRun(before, "moon", { outcome: "arrived", timeSec: 1, distanceM: 1, copilotOn: false });
  assert.equal(Array.isArray(after.moon), true);
  assert.equal(after.moon.length, 1);
});

test("aggregate computes overall and co-pilot on/off success rates", () => {
  let data = {};
  data = recordRun(data, "mars", { outcome: "arrived", timeSec: 10, distanceM: 50, copilotOn: true });
  data = recordRun(data, "mars", { outcome: "held", timeSec: 8, distanceM: 20, copilotOn: true });
  data = recordRun(data, "mars", { outcome: "tipped", timeSec: 4, distanceM: 5, copilotOn: false });
  const stats = aggregate(data, "mars");
  assert.equal(stats.n, 3);
  assert.equal(stats.nWith, 2);
  assert.equal(stats.nWithout, 1);
  assert.ok(Math.abs(stats.successRateWith - 0.5) < 1e-9);
  assert.equal(stats.successRateWithout, 0);
});

test("aggregate on an empty level returns null success rates, not NaN", () => {
  const stats = aggregate({}, "moon");
  assert.equal(stats.n, 0);
  assert.equal(stats.successRateAll, null);
});

test("sampleSizeNote flags low n as noisy", () => {
  assert.match(sampleSizeNote(0), /no runs yet/);
  assert.match(sampleSizeNote(2), /too few runs to trust/);
  assert.equal(sampleSizeNote(10), "n=10");
});

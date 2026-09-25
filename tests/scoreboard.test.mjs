import { test } from "node:test";
import assert from "node:assert/strict";
import { loadScoreboard, saveScoreboard, recordRun, aggregate, sampleSizeNote, migrateLevelKey } from "../web/scoreboard.js";

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
    const data = recordRun({}, "tycho", { outcome: "arrived", timeSec: 12, distanceM: 40, copilotOn: false });
    assert.equal(saveScoreboard(data), true);
    const loaded = loadScoreboard();
    assert.equal(loaded.tycho.length, 1);
    assert.equal(loaded.tycho[0].outcome, "arrived");
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

// --- U2: abandoned runs -----------------------------------------------

test("U2: abandoned runs are recorded but excluded from n and every success rate", () => {
  let data = {};
  data = recordRun(data, "lunokhod", { outcome: "arrived", timeSec: 100, distanceM: 2000, copilotOn: false });
  data = recordRun(data, "lunokhod", { outcome: "abandoned", timeSec: 5, distanceM: 30, copilotOn: false });
  data = recordRun(data, "lunokhod", { outcome: "abandoned", timeSec: 2, distanceM: 10, copilotOn: false });
  const stats = aggregate(data, "lunokhod");
  assert.equal(stats.n, 1, "abandoned runs must not count toward n");
  assert.equal(stats.abandonedCount, 2);
  assert.equal(stats.successRateAll, 1, "the one real (arrived) run is the only one counted");
  assert.equal(stats.runs.length, 3, "raw history (runs) still includes abandoned runs, only the aggregate excludes them");
});

test("U2: sampleSizeNote discloses an abandoned count without folding it into n", () => {
  assert.match(sampleSizeNote(3, 2), /n=3/);
  assert.match(sampleSizeNote(3, 2), /2 abandoned \(excluded\)/);
  assert.equal(sampleSizeNote(4, 0).includes("abandoned"), false);
});

// --- migration: v1's single "moon" key -> "tycho" ----------------------

test("migrateLevelKey renames an old key's history to the new key when the new key is absent", () => {
  const data = { moon: [{ outcome: "arrived", timeSec: 1, distanceM: 1, copilotOn: false }] };
  const migrated = migrateLevelKey(data, "moon", "tycho");
  assert.equal(migrated.tycho.length, 1);
  assert.equal(migrated.moon, undefined);
});

test("migrateLevelKey never overwrites existing history at the new key", () => {
  const data = {
    moon: [{ outcome: "tipped", timeSec: 1, distanceM: 1, copilotOn: false }],
    tycho: [{ outcome: "arrived", timeSec: 2, distanceM: 2, copilotOn: false }],
  };
  const migrated = migrateLevelKey(data, "moon", "tycho");
  assert.equal(migrated.tycho.length, 1, "tycho already had its own history and must not be clobbered");
  assert.equal(migrated.moon.length, 1, "unmigrated moon history is left in place, not silently dropped");
});

test("loadScoreboard migrates old \"moon\" runs to \"tycho\" on load", () => {
  withFakeStorage(memoryStorage(), () => {
    globalThis.localStorage.setItem(
      "tycho.scoreboard.v1",
      JSON.stringify({ moon: [{ outcome: "arrived", timeSec: 1, distanceM: 1, copilotOn: false, at: 1 }] }),
    );
    const loaded = loadScoreboard();
    assert.equal(loaded.tycho.length, 1);
    assert.equal(loaded.moon, undefined);
  });
});

// --- old-format (pre-predictedArrival/medals) records still load ---------

test("old-format v1 records (no predictedArrival/medals fields) still load and aggregate unchanged", () => {
  withFakeStorage(memoryStorage(), () => {
    globalThis.localStorage.setItem(
      "tycho.scoreboard.v1",
      JSON.stringify({ tycho: [{ outcome: "arrived", timeSec: 100, distanceM: 500, copilotOn: false, at: 1 }] }),
    );
    const loaded = loadScoreboard();
    assert.equal(loaded.tycho.length, 1);
    const stats = aggregate(loaded, "tycho");
    assert.equal(stats.n, 1);
    assert.equal(stats.successRateAll, 1);
    assert.equal(stats.calibration.nPredicted, 0, "old records never had predictedArrival, so none count toward calibration");
    assert.equal(stats.calibration.meanPredicted, null);
    assert.equal(stats.calibration.actualRate, null);
  });
});

// --- predictedArrival / medals -------------------------------------------

test("recordRun accepts optional predictedArrival and medals fields", () => {
  const data = recordRun({}, "mars", {
    outcome: "arrived", timeSec: 40, distanceM: 300, copilotOn: true,
    predictedArrival: 0.8, medals: ["beat-par"],
  });
  assert.equal(data.mars[0].predictedArrival, 0.8);
  assert.deepEqual(data.mars[0].medals, ["beat-par"]);
});

test("recordRun drops an out-of-range predictedArrival instead of storing it", () => {
  const tooHigh = recordRun({}, "mars", { outcome: "arrived", timeSec: 1, distanceM: 1, predictedArrival: 1.5 });
  assert.equal("predictedArrival" in tooHigh.mars[0], false);
  const negative = recordRun({}, "mars", { outcome: "arrived", timeSec: 1, distanceM: 1, predictedArrival: -0.1 });
  assert.equal("predictedArrival" in negative.mars[0], false);
  const notANumber = recordRun({}, "mars", { outcome: "arrived", timeSec: 1, distanceM: 1, predictedArrival: "0.8" });
  assert.equal("predictedArrival" in notANumber.mars[0], false);
});

test("recordRun drops a malformed medals value instead of storing it", () => {
  const notArray = recordRun({}, "mars", { outcome: "arrived", timeSec: 1, distanceM: 1, medals: "beat-par" });
  assert.equal("medals" in notArray.mars[0], false);
  const wrongElementType = recordRun({}, "mars", { outcome: "arrived", timeSec: 1, distanceM: 1, medals: ["beat-par", 5] });
  assert.equal("medals" in wrongElementType.mars[0], false);
});

// --- calibration -----------------------------------------------------------

test("aggregate computes calibration over only the predicted runs, excluding abandoned", () => {
  let data = {};
  data = recordRun(data, "mars", { outcome: "arrived", timeSec: 10, distanceM: 50, predictedArrival: 0.8 });
  data = recordRun(data, "mars", { outcome: "held", timeSec: 8, distanceM: 20, predictedArrival: 0.6 });
  data = recordRun(data, "mars", { outcome: "tipped", timeSec: 4, distanceM: 5 }); // no prediction: excluded from calibration
  data = recordRun(data, "mars", { outcome: "abandoned", timeSec: 1, distanceM: 1, predictedArrival: 0.9 }); // abandoned: excluded
  const stats = aggregate(data, "mars");
  assert.equal(stats.calibration.nPredicted, 2);
  assert.ok(Math.abs(stats.calibration.meanPredicted - 0.7) < 1e-9);
  assert.ok(Math.abs(stats.calibration.actualRate - 0.5) < 1e-9, "1 of the 2 predicted runs arrived");
});

test("aggregate calibration gives the small-n note when nPredicted < 5", () => {
  let data = {};
  data = recordRun(data, "mars", { outcome: "arrived", timeSec: 10, distanceM: 50, predictedArrival: 0.8 });
  const stats = aggregate(data, "mars");
  assert.equal(stats.calibration.nPredicted, 1);
  assert.match(stats.calibration.note, /too few runs to trust/);
});

test("aggregate calibration on a level with no predicted runs has null rates, not NaN", () => {
  let data = {};
  data = recordRun(data, "mars", { outcome: "arrived", timeSec: 10, distanceM: 50 });
  const stats = aggregate(data, "mars");
  assert.equal(stats.calibration.nPredicted, 0);
  assert.equal(stats.calibration.meanPredicted, null);
  assert.equal(stats.calibration.actualRate, null);
});

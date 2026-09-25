// predictedArrival / medals validation and calibration() aggregation, split
// out of scoreboard.test.mjs (which was over the ~200-line file cap).
import { test } from "node:test";
import assert from "node:assert/strict";
import { recordRun, aggregate } from "../web/scoreboard.js";

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

test("recordRun drops a NaN predictedArrival instead of storing it", () => {
  const nan = recordRun({}, "mars", { outcome: "arrived", timeSec: 1, distanceM: 1, predictedArrival: NaN });
  assert.equal("predictedArrival" in nan.mars[0], false);
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

// recordRun already keeps predictedArrival in [0,1] at write time, but
// localStorage is player-editable: a tampered/pre-validation record can
// still carry an out-of-range value. calibration() must ignore it rather
// than let it skew meanPredicted/actualRate (web/scoreboard.js calibration()).
test("aggregate calibration ignores tampered predictedArrival values outside [0,1]", () => {
  const data = {
    mars: [
      { outcome: "arrived", timeSec: 10, distanceM: 50, predictedArrival: 0.8 },
      { outcome: "arrived", timeSec: 10, distanceM: 50, predictedArrival: 5 }, // tampered: out of range
      { outcome: "tipped", timeSec: 10, distanceM: 50, predictedArrival: -1 }, // tampered: out of range
    ],
  };
  const stats = aggregate(data, "mars");
  assert.equal(stats.calibration.nPredicted, 1, "only the in-range record counts toward calibration");
  assert.equal(stats.calibration.meanPredicted, 0.8);
  assert.equal(stats.calibration.actualRate, 1);
});

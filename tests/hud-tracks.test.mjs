// Review finding 2: computeTrackFit is the pure (no canvas) math behind the
// Flight Rules drift reveal's fitted view - unit-testable directly, unlike
// drawTracks itself which needs a real <canvas>.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTrackFit } from "../web/hud-tracks.js";

test("computeTrackFit: a real drive's bounding box drives the view extent, not the whole terrain", () => {
  const truePath = [{ x: 512, y: 512 }, { x: 494, y: 494 }];
  const believedPath = [{ x: 512, y: 512 }, { x: 495, y: 495 }];
  const fit = computeTrackFit(truePath, believedPath);
  assert.ok(fit.extentPx > 0);
  // The view must be tight around the drive, not the 1024px terrain crop.
  assert.ok(fit.extentPx < 200, `expected a tight fit, got extentPx=${fit.extentPx}`);
  assert.deepEqual(fit.trueEnd, { x: 494, y: 494 });
  assert.deepEqual(fit.believedEnd, { x: 495, y: 495 });
});

test("computeTrackFit: a tiny endpoint gap relative to the main view triggers a labeled zoomed inset", () => {
  // Believed/true endpoints only 0.6px apart on a drive spanning 500px - far
  // under the INSET_TRIGGER_FRACTION, same shape as the review's 517m drive
  // with a 12m (~0.6px at 20m/px) offset.
  const truePath = [{ x: 0, y: 0 }, { x: 500, y: 0 }];
  const believedPath = [{ x: 0, y: 0 }, { x: 500.6, y: 0 }];
  const fit = computeTrackFit(truePath, believedPath);
  assert.ok(fit.inset, "expected an inset when the endpoint gap is sub-pixel at the main view's zoom");
  assert.ok(fit.inset.zoomFactor > 1, `inset must zoom IN, got zoomFactor=${fit.inset.zoomFactor}`);
  assert.ok(fit.inset.extentPx > 0);
});

test("computeTrackFit: a clearly separated endpoint pair (well above the trigger fraction) needs no inset", () => {
  const truePath = [{ x: 0, y: 0 }, { x: 0, y: 0 }];
  const believedPath = [{ x: 100, y: 0 }, { x: 100, y: 0 }]; // gap is the whole bbox span - clearly not sub-pixel
  const fit = computeTrackFit(truePath, believedPath);
  assert.equal(fit.inset, null);
});

test("computeTrackFit: empty paths still return a finite, positive extent (no NaN/Infinity from an empty bounding box)", () => {
  const fit = computeTrackFit([], []);
  assert.ok(Number.isFinite(fit.extentPx) && fit.extentPx > 0);
  assert.equal(fit.trueEnd, null);
  assert.equal(fit.believedEnd, null);
  assert.equal(fit.inset, null);
});

test("computeTrackFit: a single-point (zero-length) drive still returns a sane minimum extent", () => {
  const fit = computeTrackFit([{ x: 10, y: 10 }], [{ x: 10, y: 10 }]);
  assert.ok(fit.extentPx > 0);
  assert.equal(fit.endpointGapPx, 0);
  assert.equal(fit.inset, null); // 0/extentPx = 0, under the trigger fraction, but 0 is a degenerate no-drift case, not worth zooming into further
});

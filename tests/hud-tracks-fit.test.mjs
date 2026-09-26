// W2-X3 review finding 2: the inset must land in the corner OPPOSITE the
// run's own endpoints, not a fixed bottom-right - a SE-bound drive used to
// hide its endpoints, offset segment and only meters label under a fixed
// inset. pickInsetCorner/insetScreenRect are pure (no canvas) geometry,
// unit-testable directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickInsetCorner, insetScreenRect, computeTrackFit, formatOffsetMeters, scaleBarPlacement } from "../web/hud-tracks-fit.js";

test("pickInsetCorner: a NE-bound drive (east, north of center) gets the SW inset", () => {
  assert.equal(pickInsetCorner({ x: 10, y: -10 }, { x: 10.6, y: -10 }, 0, 0), "sw");
});

test("pickInsetCorner: a NW-bound drive (west, north of center) gets the SE inset", () => {
  assert.equal(pickInsetCorner({ x: -10, y: -10 }, { x: -10.6, y: -10 }, 0, 0), "se");
});

test("pickInsetCorner: a SE-bound drive (east, south of center) gets the NW inset", () => {
  assert.equal(pickInsetCorner({ x: 10, y: 10 }, { x: 10.6, y: 10 }, 0, 0), "nw");
});

test("pickInsetCorner: a SW-bound drive (west, south of center) gets the NE inset", () => {
  assert.equal(pickInsetCorner({ x: -10, y: 10 }, { x: -10.6, y: 10 }, 0, 0), "ne");
});

test("insetScreenRect: nw/se/ne/sw place the box in the named corner, inside the canvas", () => {
  const canvasW = 220, canvasH = 220;
  for (const corner of ["nw", "ne", "sw", "se"]) {
    const rect = insetScreenRect(corner, canvasW, canvasH);
    assert.ok(rect.x >= 0 && rect.x + rect.w <= canvasW, `${corner}: x out of bounds (${rect.x}..${rect.x + rect.w})`);
    assert.ok(rect.y >= 0 && rect.y + rect.h <= canvasH, `${corner}: y out of bounds (${rect.y}..${rect.y + rect.h})`);
    const isNorth = corner[0] === "n";
    const isWest = corner[1] === "w";
    assert.equal(rect.x < canvasW / 2, isWest, `${corner}: expected ${isWest ? "west" : "east"} half`);
    assert.equal(rect.y < canvasH / 2, isNorth, `${corner}: expected ${isNorth ? "north" : "south"} half`);
  }
});

test("computeTrackFit: a SE-bound drive's inset carries the opposite (nw) corner, not a fixed side", () => {
  // Mirrors the review's real 517m NW-bound run into a SE-bound one: same
  // shape, endpoints reflected to the opposite quadrant of the view center.
  const truePath = [{ x: 500, y: 500 }, { x: 530, y: 530 }];
  const believedPath = [{ x: 500, y: 500 }, { x: 530.6, y: 530 }];
  const fit = computeTrackFit(truePath, believedPath);
  assert.ok(fit.inset, "expected an inset for a sub-pixel endpoint gap");
  assert.equal(fit.inset.corner, "nw");
});

test("computeTrackFit: the mirrored NW-bound drive's inset carries the opposite (se) corner", () => {
  const truePath = [{ x: 500, y: 500 }, { x: 470, y: 470 }];
  const believedPath = [{ x: 500, y: 500 }, { x: 469.4, y: 470 }];
  const fit = computeTrackFit(truePath, believedPath);
  assert.ok(fit.inset, "expected an inset for a sub-pixel endpoint gap");
  assert.equal(fit.inset.corner, "se");
});

test("formatOffsetMeters keeps one decimal below 1 m so a real sub-meter drift never reads as 0 m", () => {
  assert.equal(formatOffsetMeters(0.41), "0.4 m");
  assert.equal(formatOffsetMeters(0.04), "<0.1 m");
  assert.equal(formatOffsetMeters(0), "0 m");
  assert.equal(formatOffsetMeters(1.4), "1 m");
  assert.equal(formatOffsetMeters(12.257), "12 m");
});

test("scaleBarPlacement never overlaps the zoom inset in any corner (NE-bound drives put the inset bottom-left)", () => {
  const W = 220, H = 220;
  const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  for (const corner of ["nw", "ne", "sw", "se"]) {
    const inset = insetScreenRect(corner, W, H);
    // include the inset's "zoom Nx" label strip (14 px above a north inset, below a south one)
    const box = { x: inset.x - 2, y: corner[0] === "n" ? inset.y - 14 : inset.y, w: inset.w + 4, h: inset.h + 14 };
    for (const barPx of [10, 30, 55]) {
      const { rect } = scaleBarPlacement(corner, W, H, barPx);
      assert.equal(hit(rect, box), false, `scale bar (${barPx}px) overlaps the ${corner} inset`);
      assert.ok(rect.x >= 0 && rect.x + rect.w <= W, `scale bar (${barPx}px) runs off the canvas with a ${corner} inset`);
    }
  }
  assert.equal(scaleBarPlacement("sw", W, H, 30).right, true);
  assert.equal(scaleBarPlacement(null, W, H, 30).right, false);
});

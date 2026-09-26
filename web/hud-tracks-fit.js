// Pure (no canvas) math behind the Flight Rules drift reveal's fitted view -
// split out of hud-tracks.js to keep that file under the ~200-line guideline
// (W2-X3 review finding 5). Unit-testable directly: tests/hud-tracks.test.mjs
// and tests/hud-tracks-fit.test.mjs both import from here.
export const MIN_EXTENT_PX = 20; // floor so a near-zero-length drive still gets a sane view
export const PADDING_FACTOR = 3; // main view extent = max(bbox span, 2x endpoint gap) * this
export const INSET_TRIGGER_FRACTION = 0.15; // add a zoomed inset once the endpoint gap reads as less than this fraction of the main canvas
export const INSET_SIZE_FRACTION = 0.42; // inset box side, as a fraction of the main canvas
export const INSET_PADDING_FACTOR = 4; // inset view extent = endpoint gap * this factor
export const INSET_MARGIN_PX = 4; // gap between the inset box and the canvas edge
export const INSET_LABEL_PAD_PX = 14; // room reserved above the inset box for its "zoom Nx" backdrop

function unionBounds(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Opposite corner from where the run's endpoints actually sit, so the inset
 * box never lands on top of the main view's own endpoints/offset label
 * (W2-X3 review finding 2 - a SE-bound drive used to hide under a
 * bottom-right inset that was always drawn there regardless of heading).
 * Returns one of "nw"|"ne"|"sw"|"se".
 */
export function pickInsetCorner(trueEnd, believedEnd, centerX, centerY) {
  const ex = ((trueEnd?.x ?? centerX) + (believedEnd?.x ?? centerX)) / 2;
  const ey = ((trueEnd?.y ?? centerY) + (believedEnd?.y ?? centerY)) / 2;
  const east = ex >= centerX; // endpoints sit east (right) of the view center
  const south = ey >= centerY; // endpoints sit south (down) of the view center
  return (south ? "n" : "s") + (east ? "w" : "e");
}

/** Screen-space rect for the inset box in the given corner of a `canvasW`x`canvasH` canvas. */
export function insetScreenRect(corner, canvasW, canvasH, sizeFraction = INSET_SIZE_FRACTION, margin = INSET_MARGIN_PX, labelPad = INSET_LABEL_PAD_PX) {
  const size = Math.min(canvasW, canvasH) * sizeFraction;
  const isNorth = corner[0] === "n";
  const isWest = corner[1] === "w";
  return {
    x: isWest ? margin : canvasW - size - margin,
    y: isNorth ? margin + labelPad : canvasH - size - labelPad,
    w: size,
    h: size,
  };
}

/**
 * Pure (no canvas) fit math, unit-testable directly: the union bounding box
 * of both tracks, padded and floored to a minimum extent, plus whether the
 * two final points are still too close together at that zoom to read as
 * distinct - in which case the caller should also draw a zoomed inset,
 * placed in the corner opposite the run's own endpoints.
 */
export function computeTrackFit(truePath = [], believedPath = []) {
  const allPoints = [...truePath, ...believedPath];
  const trueEnd = truePath.length ? truePath[truePath.length - 1] : null;
  const believedEnd = believedPath.length ? believedPath[believedPath.length - 1] : null;
  const endpointGapPx = trueEnd && believedEnd ? Math.hypot(believedEnd.x - trueEnd.x, believedEnd.y - trueEnd.y) : 0;

  const bbox = allPoints.length ? unionBounds(allPoints) : { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const bboxSpan = Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY);
  const extentPx = Math.max(bboxSpan, endpointGapPx * 2, MIN_EXTENT_PX / PADDING_FACTOR) * PADDING_FACTOR;
  const centerX = (bbox.minX + bbox.maxX) / 2;
  const centerY = (bbox.minY + bbox.maxY) / 2;

  // endpointGapPx > 0 excludes a true zero-drift run (nothing to zoom into).
  const needsInset = !!(trueEnd && believedEnd) && endpointGapPx > 0 && endpointGapPx / extentPx < INSET_TRIGGER_FRACTION;
  let inset = null;
  if (needsInset) {
    const insetExtentPx = Math.max(endpointGapPx * INSET_PADDING_FACTOR, MIN_EXTENT_PX / 4);
    inset = {
      viewMinX: (trueEnd.x + believedEnd.x) / 2 - insetExtentPx / 2,
      viewMinY: (trueEnd.y + believedEnd.y) / 2 - insetExtentPx / 2,
      extentPx: insetExtentPx,
      zoomFactor: extentPx / insetExtentPx,
      corner: pickInsetCorner(trueEnd, believedEnd, centerX, centerY),
    };
  }

  return { viewMinX: centerX - extentPx / 2, viewMinY: centerY - extentPx / 2, extentPx, trueEnd, believedEnd, endpointGapPx, inset };
}

export function niceScaleNumber(x) {
  if (!(x > 0)) return 1;
  const exp = Math.floor(Math.log10(x));
  const base = x / 10 ** exp;
  const nice = base < 1.5 ? 1 : base < 3.5 ? 2 : base < 7.5 ? 5 : 10;
  return nice * 10 ** exp;
}

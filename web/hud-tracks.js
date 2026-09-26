// Flight Rules drift reveal: renders the real Mars run's true vs believed
// track, fitted to the run's OWN drive (not the whole 1024px terrain crop
// drawMinimap uses) - review finding 2. Split out of hud-minimap.js (that
// module keeps the planning minimap; this one is end-of-run only) to stay
// under the file-size guideline. No three.js dependency.
const MIN_EXTENT_PX = 20; // floor so a near-zero-length drive still gets a sane view
const PADDING_FACTOR = 3; // main view extent = max(bbox span, 2x endpoint gap) * this
const INSET_TRIGGER_FRACTION = 0.15; // add a zoomed inset once the endpoint gap reads as less than this fraction of the main canvas
const INSET_SIZE_FRACTION = 0.42; // inset box side, as a fraction of the main canvas
const INSET_PADDING_FACTOR = 4; // inset view extent = endpoint gap * this factor

const TRUE_COLOR = "#ffffff";
// Away from #f4c06a (the planning minimap's waypoint color) - review finding 2.
const BELIEVED_COLOR = "#ff5ec4";
const OFFSET_COLOR = "#ffe066";

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
 * Pure (no canvas) fit math, unit-testable directly: the union bounding box
 * of both tracks, padded and floored to a minimum extent, plus whether the
 * two final points are still too close together at that zoom to read as
 * distinct - in which case the caller should also draw a zoomed inset.
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
    };
  }

  return { viewMinX: centerX - extentPx / 2, viewMinY: centerY - extentPx / 2, extentPx, trueEnd, believedEnd, endpointGapPx, inset };
}

function niceScaleNumber(x) {
  if (!(x > 0)) return 1;
  const exp = Math.floor(Math.log10(x));
  const base = x / 10 ** exp;
  const nice = base < 1.5 ? 1 : base < 3.5 ? 2 : base < 7.5 ? 5 : 10;
  return nice * 10 ** exp;
}

function renderElevationBackground(ctx, terrain, viewMinX, viewMinY, extentPx, rect) {
  const grid = 32;
  const img = ctx.createImageData(grid, grid);
  const samples = new Float32Array(grid * grid);
  let min = Infinity, max = -Infinity;
  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      const tx = viewMinX + (gx / (grid - 1)) * extentPx;
      const ty = viewMinY + (gy / (grid - 1)) * extentPx;
      const e = terrain.elev(tx, ty);
      samples[gy * grid + gx] = e;
      if (e < min) min = e;
      if (e > max) max = e;
    }
  }
  const range = max - min || 1;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.round(((samples[i] - min) / range) * 255);
    img.data[i * 4] = v * 0.75;
    img.data[i * 4 + 1] = v * 0.8;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  const off = document.createElement("canvas");
  off.width = grid;
  off.height = grid;
  off.getContext("2d").putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, rect.x, rect.y, rect.w, rect.h);
}

function drawPath(ctx, toCanvas, path, color, dash) {
  if (path.length < 2) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.setLineDash(dash);
  ctx.beginPath();
  path.forEach(({ x, y }, i) => {
    const [cx, cy] = toCanvas(x, y);
    if (i === 0) ctx.moveTo(cx, cy); else ctx.lineTo(cx, cy);
  });
  ctx.stroke();
  ctx.restore();
}

function drawEndpointMarker(ctx, [x, y], color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, 3.5, 0, Math.PI * 2);
  ctx.fill();
}

/** Draw one viewport (main view or the zoomed inset) into `rect` of the canvas. */
function drawViewport(ctx, terrain, truePath, believedPath, view, rect) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();
  renderElevationBackground(ctx, terrain, view.viewMinX, view.viewMinY, view.extentPx, rect);
  const toCanvas = (px, py) => [rect.x + ((px - view.viewMinX) / view.extentPx) * rect.w, rect.y + ((py - view.viewMinY) / view.extentPx) * rect.h];
  drawPath(ctx, toCanvas, truePath, TRUE_COLOR, []);
  drawPath(ctx, toCanvas, believedPath, BELIEVED_COLOR, [5, 3]);
  if (truePath.length) drawEndpointMarker(ctx, toCanvas(truePath[truePath.length - 1].x, truePath[truePath.length - 1].y), TRUE_COLOR);
  if (believedPath.length) drawEndpointMarker(ctx, toCanvas(believedPath[believedPath.length - 1].x, believedPath[believedPath.length - 1].y), BELIEVED_COLOR);
  ctx.restore();
  return toCanvas;
}

function drawScaleBar(ctx, terrain, extentPx, rect) {
  const viewSpanM = extentPx * (terrain.metersPerPixel || 1);
  const barM = niceScaleNumber(viewSpanM * 0.25);
  const barPx = (barM / (terrain.metersPerPixel || 1)) * (rect.w / extentPx);
  const x0 = rect.x + 6;
  const y0 = rect.y + rect.h - 8;
  ctx.save();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x0 + barPx, y0);
  ctx.moveTo(x0, y0 - 3);
  ctx.lineTo(x0, y0 + 3);
  ctx.moveTo(x0 + barPx, y0 - 3);
  ctx.lineTo(x0 + barPx, y0 + 3);
  ctx.stroke();
  ctx.font = "9px sans-serif";
  ctx.fillStyle = "#ffffff";
  ctx.fillText(`${barM} m`, x0, y0 - 5);
  ctx.restore();
}

function drawOffsetLabel(ctx, toCanvas, fit, offsetM) {
  const [tx, ty] = toCanvas(fit.trueEnd.x, fit.trueEnd.y);
  const [bx, by] = toCanvas(fit.believedEnd.x, fit.believedEnd.y);
  ctx.save();
  ctx.strokeStyle = OFFSET_COLOR;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([2, 2]);
  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(bx, by);
  ctx.stroke();
  ctx.setLineDash([]);
  const magnitudeM = Math.round(Math.hypot(offsetM.x, offsetM.y));
  ctx.font = "10px sans-serif";
  ctx.fillStyle = OFFSET_COLOR;
  ctx.fillText(`${magnitudeM} m`, (tx + bx) / 2 + 4, (ty + by) / 2 - 4);
  ctx.restore();
}

function drawInset(ctx, terrain, truePath, believedPath, fit, canvasW, canvasH) {
  const size = canvasW * INSET_SIZE_FRACTION;
  const rect = { x: canvasW - size - 4, y: canvasH - size - 14, w: size, h: size };
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(rect.x - 2, rect.y - 12, rect.w + 4, rect.h + 14);
  ctx.restore();
  drawViewport(ctx, terrain, truePath, believedPath, fit.inset, rect);
  ctx.save();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1;
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  ctx.font = "9px sans-serif";
  ctx.fillStyle = "#ffffff";
  ctx.fillText(`zoom ${fit.inset.zoomFactor.toFixed(0)}x`, rect.x, rect.y - 3);
  ctx.restore();
}

/**
 * Draw the Flight Rules drift reveal, fitted to the run's own drive (never
 * the whole terrain crop) so the true track (solid white) and believed track
 * (dashed, review finding 2's new color) are actually distinguishable, with
 * the two final points marked, the offset between them drawn and labeled in
 * meters, a scale bar, and - when the offset is still visually tiny even at
 * that fit - a small zoomed inset on the two endpoints, labeled with its own
 * zoom factor rather than silently exaggerating the main view.
 * Called ONLY at mission end (main.js's handleMissionTransition, via
 * hud.js's showEndCard) - never while driving.
 */
export function drawTracks(canvas, terrain, truePath = [], believedPath = [], offsetM = { x: 0, y: 0 }) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const fit = computeTrackFit(truePath, believedPath);
  const mainRect = { x: 0, y: 0, w: canvas.width, h: canvas.height };
  const toCanvas = drawViewport(ctx, terrain, truePath, believedPath, fit, mainRect);
  drawScaleBar(ctx, terrain, fit.extentPx, mainRect);
  if (fit.trueEnd && fit.believedEnd) drawOffsetLabel(ctx, toCanvas, fit, offsetM);
  if (fit.inset) drawInset(ctx, terrain, truePath, believedPath, fit, canvas.width, canvas.height);
}

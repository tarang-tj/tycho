// Flight Rules drift reveal: renders the real Mars run's true vs believed
// track, fitted to the run's OWN drive (not the whole 1024px terrain crop
// drawMinimap uses) - review finding 2. Split out of hud-minimap.js (that
// module keeps the planning minimap; this one is end-of-run only) to stay
// under the file-size guideline. No three.js dependency.
//
// The pure fit/inset-placement math lives in hud-tracks-fit.js (W2-X3 review
// finding 5) so it stays unit-testable without a <canvas>; re-exported here
// so existing importers (hud.js, tests/hud-tracks.test.mjs) don't need to
// know about the split.
import { computeTrackFit, niceScaleNumber, insetScreenRect, formatOffsetMeters, scaleBarPlacement } from "./hud-tracks-fit.js";

export { computeTrackFit };

export const TRUE_COLOR = "#ffffff";
// Away from #f4c06a (the planning minimap's waypoint color) - review finding 2.
export const BELIEVED_COLOR = "#ff5ec4";
const OFFSET_COLOR = "#ffe066";

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

function drawScaleBar(ctx, terrain, extentPx, rect, insetCorner = null) {
  const viewSpanM = extentPx * (terrain.metersPerPixel || 1);
  const barM = niceScaleNumber(viewSpanM * 0.25);
  const barPx = (barM / (terrain.metersPerPixel || 1)) * (rect.w / extentPx);
  // Kept clear of the zoom inset (it moves bottom-right when the inset is bottom-left).
  const { x0: bx, y0: by, right } = scaleBarPlacement(insetCorner, rect.w, rect.h, barPx);
  const x0 = rect.x + bx;
  const y0 = rect.y + by;
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
  ctx.font = "12px sans-serif";
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = right ? "right" : "left";
  ctx.fillText(`${barM} m`, right ? x0 + barPx : x0, y0 - 5);
  ctx.restore();
}

function drawOffsetLabel(ctx, toCanvas, fit, offsetM, fontPx = 12) {
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
  ctx.font = `${fontPx}px sans-serif`;
  ctx.fillStyle = OFFSET_COLOR;
  ctx.fillText(formatOffsetMeters(Math.hypot(offsetM.x, offsetM.y)), (tx + bx) / 2 + 4, (ty + by) / 2 - 4);
  ctx.restore();
}

/**
 * The inset box (W2-X3 review finding 2: placed in the corner OPPOSITE the
 * run's own endpoints, via hud-tracks-fit.js's `pickInsetCorner`, instead of
 * always bottom-right - a SE-bound drive used to hide its endpoints, offset
 * segment and only meters label under a fixed inset). Draws the offset
 * segment and its own meters label INSIDE the inset too, since that's the
 * only place the gap is actually visible once it triggers an inset at all.
 */
function drawInset(ctx, terrain, truePath, believedPath, fit, cssW, cssH, offsetM) {
  const rect = insetScreenRect(fit.inset.corner, cssW, cssH);
  const isNorth = fit.inset.corner[0] === "n";
  const labelStripY = isNorth ? rect.y - 14 : rect.y + rect.h;
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(rect.x - 2, labelStripY, rect.w + 4, rect.h + 14);
  ctx.restore();
  const insetToCanvas = drawViewport(ctx, terrain, truePath, believedPath, fit.inset, rect);
  if (fit.trueEnd && fit.believedEnd) drawOffsetLabel(ctx, insetToCanvas, fit, offsetM, 10);
  ctx.save();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1;
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  ctx.font = "11px sans-serif";
  ctx.fillStyle = "#ffffff";
  ctx.fillText(`zoom ${fit.inset.zoomFactor.toFixed(0)}x`, rect.x, isNorth ? rect.y - 3 : rect.y + rect.h + 11);
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
 *
 * `canvas.width`/`height` are the BACKING pixel resolution (CSS size x
 * devicePixelRatio, set by the caller - W2-X3 review finding 4, so labels
 * stay crisp on high-DPR phones); every layout/font-size number below is in
 * CSS px, via a single `ctx.scale(dpr, dpr)` up front.
 */
export function drawTracks(canvas, terrain, truePath = [], believedPath = [], offsetM = { x: 0, y: 0 }, dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const cssW = canvas.width / dpr;
  const cssH = canvas.height / dpr;
  ctx.save();
  ctx.scale(dpr, dpr);
  const fit = computeTrackFit(truePath, believedPath);
  const mainRect = { x: 0, y: 0, w: cssW, h: cssH };
  const toCanvas = drawViewport(ctx, terrain, truePath, believedPath, fit, mainRect);
  drawScaleBar(ctx, terrain, fit.extentPx, mainRect, fit.inset?.corner ?? null);
  if (fit.trueEnd && fit.believedEnd) drawOffsetLabel(ctx, toCanvas, fit, offsetM);
  if (fit.inset) drawInset(ctx, terrain, truePath, believedPath, fit, cssW, cssH, offsetM);
  ctx.restore();
}

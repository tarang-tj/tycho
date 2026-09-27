// F1 end-card map: the player's true route (white) over NASA's
// rover-reported Perseverance drive segments (orange), on the Jezero
// elevation background. Drawn ONLY by hud.js's showEndCard at mission end.
// The pure fit math is exported for the boot probe to re-derive pixels.
import { renderElevationBackground } from "./hud-tracks.js";

export const HISTORIC_COLOR = "#ff9d3c";
export const PLAYER_COLOR = "#ffffff";
const MIN_EXTENT_PX = 40;

/** Square view (crop pixels) covering the player path and the in-crop track, padded 10%. */
export function computeHistoricFit(playerPath, trackPoints) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of [...playerPath, ...trackPoints]) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX)) { minX = maxX = 512; minY = maxY = 512; }
  const extentPx = Math.max(maxX - minX, maxY - minY, MIN_EXTENT_PX) * 1.1;
  return { viewMinX: (minX + maxX) / 2 - extentPx / 2, viewMinY: (minY + maxY) / 2 - extentPx / 2, extentPx };
}

function strokePath(ctx, toCanvas, points, color, width) {
  if (points.length < 2) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  points.forEach((p, i) => {
    const [x, y] = toCanvas(p.x, p.y);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

/** Draw the reveal. `canvas.width` is the backing size (CSS size x dpr). */
export function drawHistoric(canvas, terrain, summary, playerPath, dpr = 1) {
  const ctx = canvas.getContext("2d");
  const cssW = canvas.width / dpr, cssH = canvas.height / dpr;
  ctx.save();
  ctx.scale(dpr, dpr);
  const view = computeHistoricFit(playerPath, summary.trackPoints);
  const rect = { x: 0, y: 0, w: cssW, h: cssH };
  renderElevationBackground(ctx, terrain, view.viewMinX, view.viewMinY, view.extentPx, rect);
  const toCanvas = (px, py) => [((px - view.viewMinX) / view.extentPx) * cssW, ((py - view.viewMinY) / view.extentPx) * cssH];
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  // Segments are drawn separately: gaps between NASA's segments stay gaps.
  for (const seg of summary.segments) strokePath(ctx, toCanvas, seg.points, HISTORIC_COLOR, 2);
  strokePath(ctx, toCanvas, playerPath, PLAYER_COLOR, 2);
  if (playerPath.length) {
    const [x, y] = toCanvas(playerPath[0].x, playerPath[0].y);
    ctx.fillStyle = PLAYER_COLOR;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  return view;
}

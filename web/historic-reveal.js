// F1 (plan-wave3.md): the Perseverance real-track reveal at Jezero mission
// end. Pure: no DOM, no three.js. Turns the committed NASA snapshot
// (assets/mars/m20-traverse.json, from
// https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_traverse.json) plus
// the player's true driven path into what the end card draws and says.
// Called ONLY from main.js's mission-end handler, never while driving
// (present-time rule: the comparison is a debrief, not a guide).
import { projectTrackSegments, routeMatchPercent } from "./historic-track.js";

export const MATCH_TOLERANCE_M = 100;
const RESAMPLE_STEP_M = 5; // player route resampled by distance so parked time is not over-counted

/** Points every `stepPx` along a polyline (keeps the first and last point). */
export function resampleByDistance(path, stepPx) {
  if (!path?.length) return [];
  const out = [{ x: path[0].x, y: path[0].y }];
  let carry = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len === 0) continue;
    let d = stepPx - carry;
    while (d <= len) {
      const t = d / len;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      d += stepPx;
    }
    carry = len - (d - stepPx);
  }
  const last = path[path.length - 1];
  const tail = out[out.length - 1];
  if (tail.x !== last.x || tail.y !== last.y) out.push({ x: last.x, y: last.y });
  return out;
}

function pathLengthPx(path) {
  let sum = 0;
  for (let i = 1; i < path.length; i++) sum += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
  return sum;
}

/**
 * @param {{projection:object, segments:Array}} snapshot m20-traverse.json contents
 * @param {{x:number,y:number}[]} playerPath the player's TRUE path, crop pixels
 * @param {{width:number, height:number, metersPerPixel:number}} terrain
 */
export function summarizeHistoric(snapshot, playerPath, terrain) {
  const { width, height, metersPerPixel: mpp } = terrain;
  const inside = (p) => p.x >= 0 && p.x < width && p.y >= 0 && p.y < height;
  const segments = projectTrackSegments(snapshot).filter((seg) => seg.points.some(inside));
  const trackPoints = [];
  for (const seg of segments) for (const p of seg.points) if (inside(p)) trackPoints.push(p);
  let solMin = Infinity, solMax = -Infinity;
  for (const seg of segments) {
    if (seg.sol < solMin) solMin = seg.sol;
    if (seg.sol > solMax) solMax = seg.sol;
  }
  const route = resampleByDistance(playerPath ?? [], RESAMPLE_STEP_M / mpp);
  const routeLengthM = pathLengthPx(playerPath ?? []) * mpp;
  const drove = routeLengthM >= 1;
  const matchPct = drove ? routeMatchPercent(route, trackPoints, { toleranceMeters: MATCH_TOLERANCE_M, metersPerPixel: mpp }) : null;
  const solText = segments.length ? `sols ${solMin}-${solMax}` : "no sols in this map";
  return {
    segments,
    trackPoints,
    solMin: segments.length ? solMin : null,
    solMax: segments.length ? solMax : null,
    matchPct,
    routeLengthM,
    sourceLabel: `NASA rover-reported drive segments, ${solText}`,
    matchLine: drove
      ? `${Math.round(matchPct)}% of your route within ${MATCH_TOLERANCE_M} m of Perseverance's.`
      : "TYCHO did not move this run, so there is no route to compare with Perseverance's.",
  };
}

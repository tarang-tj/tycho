// Pure co-pilot module: guardrails + local hazard avoidance on the DEM slope
// grid. Runs ON THE ROVER against the TRUE terrain and TRUE present position
// at the moment an uplinked sol plan is delivered - there is no light-time
// delay inside this module; the delay is applied by signal.js around it.
// No DOM/three.js dependency, deterministic, unit-testable in node.

export const DEFAULT_GUARDRAILS = {
  // Deliberately more conservative than rover-sim's own tip limit (32deg,
  // see terrain-data.js SLOPE_BASELINE_M): the co-pilot is meant to hold
  // well before the rover would actually tip, not right at the edge.
  maxSlopeDeg: 25,          // legs steeper than this are a hazard
  hazardMode: "reroute",    // "stop" (halt at the hazard) | "reroute" (try a local detour)
  maxAutonomousDistanceM: 300, // total plan distance cap before the co-pilot holds
  lookaheadRadiusM: 60,     // how far around a hazard the reroute search is allowed to look
};

const SAMPLE_STEP_M = 2; // spacing (meters) for slope sampling along a leg
const GRID_DIVISIONS = 10; // reroute search grid resolution across the lookahead radius
const MAX_SEARCH_ITER = 3000;
const NEIGHBORS8 = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

function pixelDist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** First point along a->b (pixel coords) whose slope exceeds the limit or has no orbital data, or null if the leg is safe. */
function findHazardOnSegment(a, b, terrain, maxSlopeDeg) {
  const distM = pixelDist(a, b) * terrain.metersPerPixel;
  const steps = Math.max(1, Math.ceil(distM / SAMPLE_STEP_M));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    if (terrain.noData?.(x, y)) return { x, y, slopeDeg: Infinity, noData: true };
    const slopeDeg = terrain.slopeDeg(x, y);
    if (slopeDeg > maxSlopeDeg) return { x, y, slopeDeg };
  }
  return null;
}

/**
 * Grid A* search for a safe detour from `from` to `to`, staying within
 * lookaheadRadiusM of the straight-line leg and never stepping onto a cell
 * steeper than maxSlopeDeg. Returns an ordered list of pixel-coordinate
 * waypoints (ending exactly at `to`), or null if no safe path was found
 * within the search bounds/iteration cap.
 */
function findSafePath(from, to, terrain, guardrails) {
  const lookaheadPx = guardrails.lookaheadRadiusM / terrain.metersPerPixel;
  const cell = Math.max(0.5, lookaheadPx / GRID_DIVISIONS);
  const minX = Math.min(from.x, to.x) - lookaheadPx;
  const maxX = Math.max(from.x, to.x) + lookaheadPx;
  const minY = Math.min(from.y, to.y) - lookaheadPx;
  const maxY = Math.max(from.y, to.y) + lookaheadPx;

  const keyOf = (x, y) => `${Math.round(x / cell)}:${Math.round(y / cell)}`;
  const goalKey = keyOf(to.x, to.y);

  const nodes = new Map(); // key -> { x, y, g, f, parentKey, closed }
  const startKey = keyOf(from.x, from.y);
  nodes.set(startKey, { x: from.x, y: from.y, g: 0, f: pixelDist(from, to), parentKey: null, closed: false });
  const openKeys = new Set([startKey]);

  let iterations = 0;
  while (openKeys.size && iterations++ < MAX_SEARCH_ITER) {
    let currentKey = null;
    let current = null;
    for (const k of openKeys) {
      const node = nodes.get(k);
      if (!current || node.f < current.f) { current = node; currentKey = k; }
    }
    openKeys.delete(currentKey);
    current.closed = true;

    if (currentKey === goalKey || pixelDist(current, to) < cell) {
      const points = [];
      let cursor = current;
      while (cursor) {
        points.unshift({ x: cursor.x, y: cursor.y });
        cursor = cursor.parentKey ? nodes.get(cursor.parentKey) : null;
      }
      points.shift(); // drop the start point (caller already has it)
      points.push({ x: to.x, y: to.y }); // land exactly on the requested waypoint
      return points;
    }

    for (const [dx, dy] of NEIGHBORS8) {
      const nx = current.x + dx * cell;
      const ny = current.y + dy * cell;
      if (nx < minX || nx > maxX || ny < minY || ny > maxY) continue;
      if (terrain.noData?.(nx, ny)) continue; // infinite cost: never step onto a no-data cell
      if (terrain.slopeDeg(nx, ny) > guardrails.maxSlopeDeg) continue;
      const nk = keyOf(nx, ny);
      const existing = nodes.get(nk);
      if (existing?.closed) continue;
      const g = current.g + pixelDist(current, { x: nx, y: ny });
      if (!existing || g < existing.g) {
        nodes.set(nk, { x: nx, y: ny, g, f: g + pixelDist({ x: nx, y: ny }, to), parentKey: currentKey, closed: false });
        openKeys.add(nk);
      }
    }
  }
  return null;
}

/** Plan one leg (from -> to). Returns { status: "OK"|"HOLD", points, reason? }. */
function planLeg(from, to, terrain, guardrails) {
  const hazard = findHazardOnSegment(from, to, terrain, guardrails.maxSlopeDeg);
  if (!hazard) return { status: "OK", points: [{ x: to.x, y: to.y }] };

  if (guardrails.hazardMode !== "reroute") {
    return {
      status: "HOLD",
      points: [],
      reason: hazard.noData
        ? "HOLD: no orbital data ahead"
        : `HOLD: slope ${hazard.slopeDeg.toFixed(0)}° exceeds the ${guardrails.maxSlopeDeg}° limit ahead`,
    };
  }
  const detour = findSafePath(from, to, terrain, guardrails);
  if (!detour) {
    return { status: "HOLD", points: [], reason: "HOLD: no safe path around the hazard within the lookahead radius" };
  }
  return { status: "OK", points: detour };
}

/**
 * Plan a full sol plan (an ordered list of pixel-coordinate waypoints) from
 * `start`. Evaluates every leg against the true terrain and stops at the
 * first hazard the guardrails can't clear (attempting a local reroute first
 * if hazardMode is "reroute"), and enforces the total autonomous-distance
 * cap. Returns { status: "OK"|"HOLD", path, distanceM, reason? } where
 * `path` is the flattened list of points the rover should drive through in
 * order (possibly shorter than the requested waypoints on a HOLD).
 */
export function planRoute(start, waypoints, terrain, guardrails = {}) {
  const g = { ...DEFAULT_GUARDRAILS, ...guardrails };
  let cursor = { x: start.x, y: start.y };
  const path = [];
  let distanceM = 0;

  for (const waypoint of waypoints ?? []) {
    const leg = planLeg(cursor, waypoint, terrain, g);
    for (const point of leg.points) {
      const legDistanceM = pixelDist(cursor, point) * terrain.metersPerPixel;
      if (distanceM + legDistanceM > g.maxAutonomousDistanceM) {
        return {
          status: "HOLD",
          path,
          distanceM,
          reason: `HOLD: plan exceeds the max autonomous distance (${g.maxAutonomousDistanceM} m)`,
        };
      }
      distanceM += legDistanceM;
      path.push(point);
      cursor = point;
    }
    if (leg.status === "HOLD") {
      return { status: "HOLD", path, distanceM, reason: leg.reason };
    }
  }
  return { status: "OK", path, distanceM, reason: null };
}

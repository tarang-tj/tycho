// Full-terrain grid A*, used only by the playability gate (tests/playability.test.mjs)
// to prove a body's real DEM has an actual spawn->goal route under a slope
// guardrail. This is intentionally NOT web/copilot.js's local reroute
// (which is bounded to a lookaheadRadiusM around a player-placed leg, by
// design - see copilot.js's header comment); this is a real global search,
// the honest way to answer "does a route exist at all".
//
// Grid-aligned (samples terrain.slopeDeg/noData every `stepPx` pixels), 8-
// connected, cost = Euclidean grid distance, blocked if slope exceeds
// maxSlopeDeg or the cell has no orbital data.
const NEIGHBORS8 = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

/**
 * `dilatePx` (default 0): require not just the cell itself but a
 * (2*dilatePx+1)^2 neighborhood around it to be passable. A plain grid A*
 * can find "knife-edge" routes that squeeze through a single passable cell
 * between two hazards - individually safe by the numbers, but not enough
 * margin for a real (or simulated, delayed-telemetry) controller to track
 * without clipping the hazard on either side. Dilation requires a real
 * safety buffer along the whole route.
 */
export function findGlobalPath(terrain, start, goal, maxSlopeDeg, stepPx = 2, maxIter = 500000, dilatePx = 0) {
  const gw = Math.floor(terrain.width / stepPx);
  const gh = Math.floor(terrain.height / stepPx);
  const key = (gx, gy) => gy * gw + gx;
  const passCache = new Map();
  const passable = (gx, gy) => {
    if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) return false;
    const ck = key(gx, gy);
    const cached = passCache.get(ck);
    if (cached !== undefined) return cached;
    const cx = gx * stepPx, cy = gy * stepPx;
    let ok = true;
    for (let dy = -dilatePx; dy <= dilatePx && ok; dy++) {
      for (let dx = -dilatePx; dx <= dilatePx && ok; dx++) {
        const x = cx + dx, y = cy + dy;
        if (terrain.noData?.(x, y) || terrain.slopeDeg(x, y) > maxSlopeDeg) ok = false;
      }
    }
    passCache.set(ck, ok);
    return ok;
  };
  const startG = { x: Math.round(start.x / stepPx), y: Math.round(start.y / stepPx) };
  const goalG = { x: Math.round(goal.x / stepPx), y: Math.round(goal.y / stepPx) };
  const goalKey = key(goalG.x, goalG.y);
  const h = (gx, gy) => Math.hypot(gx - goalG.x, gy - goalG.y);

  const g = new Map([[key(startG.x, startG.y), 0]]);
  const open = new Map([[key(startG.x, startG.y), h(startG.x, startG.y)]]);
  const cameFrom = new Map();
  const closed = new Set();

  let iter = 0;
  while (open.size && iter++ < maxIter) {
    let curKey = null, curF = Infinity;
    for (const [k, f] of open) if (f < curF) { curF = f; curKey = k; }
    open.delete(curKey);
    if (curKey === goalKey) {
      const path = [];
      let ck = curKey;
      while (ck !== undefined) {
        const cy = Math.floor(ck / gw), cx = ck % gw;
        path.unshift({ x: cx * stepPx, y: cy * stepPx });
        ck = cameFrom.get(ck);
      }
      return { path, iterations: iter };
    }
    closed.add(curKey);
    const cy = Math.floor(curKey / gw), cx = curKey % gw;
    for (const [dx, dy] of NEIGHBORS8) {
      const nx = cx + dx, ny = cy + dy;
      if (!passable(nx, ny)) continue;
      const nk = key(nx, ny);
      if (closed.has(nk)) continue;
      const tentativeG = g.get(curKey) + Math.hypot(dx, dy);
      if (!g.has(nk) || tentativeG < g.get(nk)) {
        g.set(nk, tentativeG);
        cameFrom.set(nk, curKey);
        open.set(nk, tentativeG + h(nx, ny));
      }
    }
  }
  return { path: null, iterations: iter };
}

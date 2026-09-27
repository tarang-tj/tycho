// Pure JS: projects NASA's Mars 2020 rover-reported drive traverse
// (assets/mars/m20-traverse.json) from lon/lat into the same 1024x1024
// Jezero crop pixel space assets/mars/meta.json's spawn/goal already use,
// and scores how closely a player's driven route matches the real rover's
// path. No DOM, no three.js, no game-state import -- wiring this into
// mission end (F1, plan-wave3.md L7) is a different lane's job.
//
// Source: https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_traverse.json
// (NASA MMGIS traverse layer; undocumented API, see the snapshot's own
// "source" field for the exact fetch date -- plan-wave3.md assumption A4).
// Projection constants (radius, standard parallel, landing lat/lon) are
// read from the snapshot's "projection" field, written by
// tools/fetch_m20_traverse.py from the CTX Jezero DEM's GeoTIFF header --
// never hardcoded here, so this module can't drift from what shipped.
//
// A3 (plan-wave3.md): the traverse's first vertex projects to crop pixel
// (512.70, 512.02), 0.70px / 0.02px from meta.json's spawn (512, 512).
// Verified in tools/test_m20_traverse.py's A3ProjectionTest.

/**
 * Projects one lon/lat vertex to the crop's pixel space using the
 * snapshot's own equirectangular params (spherical Equirectangular,
 * matching tools/georef.py's EquirectParams model): the crop's spawn
 * pixel is anchored on the landing site, so a vertex's pixel is the
 * spawn pixel plus its meters offset (via the standard-parallel scale)
 * divided by metersPerPixel.
 * @param {number} lon degrees
 * @param {number} lat degrees
 * @param {{radiusM:number, latTrueScaleDeg:number, metersPerPixel:number,
 *          landingLatDeg:number, landingLonDeg:number,
 *          spawnPixel:{x:number,y:number}}} projection
 * @returns {{x:number, y:number}} crop pixel (may fall outside the crop)
 */
export function projectLonLatToPixel(lon, lat, projection) {
  const { radiusM, latTrueScaleDeg, metersPerPixel, landingLatDeg, landingLonDeg, spawnPixel } = projection;
  const cosLatTrueScale = Math.cos((latTrueScaleDeg * Math.PI) / 180);
  const dxMeters = radiusM * (((lon - landingLonDeg) * Math.PI) / 180) * cosLatTrueScale;
  const dyMeters = radiusM * (((lat - landingLatDeg) * Math.PI) / 180);
  return {
    x: spawnPixel.x + dxMeters / metersPerPixel,
    y: spawnPixel.y - dyMeters / metersPerPixel,
  };
}

/**
 * Projects every drive segment's coordinates from the snapshot into crop
 * pixel space, keeping sol/fromRMC/toRMC/length alongside the projected
 * points.
 * @param {{projection: object, segments: Array}} snapshot m20-traverse.json contents
 * @returns {Array<{sol:number, fromRMC:string, toRMC:string, length:number, points:{x:number,y:number}[]}>}
 */
export function projectTrackSegments(snapshot) {
  const { projection, segments } = snapshot;
  return (segments || []).map((seg) => ({
    sol: seg.sol,
    fromRMC: seg.fromRMC,
    toRMC: seg.toRMC,
    length: seg.length,
    points: (seg.coords || []).map(([lon, lat]) => projectLonLatToPixel(lon, lat, projection)),
  }));
}

/** Flattens projected segments into one array of {x,y} pixel points. */
export function flattenTrackPoints(projectedSegments) {
  const out = [];
  for (const seg of projectedSegments) {
    for (const p of seg.points) out.push(p);
  }
  return out;
}

/** Keeps only points that fall inside the [0,width) x [0,height) crop. */
export function clipToCrop(points, width = 1024, height = 1024) {
  return points.filter((p) => p.x >= 0 && p.x < width && p.y >= 0 && p.y < height);
}

/**
 * Convenience pipeline: project the whole snapshot and clip to the crop,
 * returning both the per-segment breakdown (for drawing) and the flat,
 * clipped point list (for matching).
 */
export function projectAndClipTrack(snapshot, { width = 1024, height = 1024 } = {}) {
  const segments = projectTrackSegments(snapshot);
  const points = clipToCrop(flattenTrackPoints(segments), width, height);
  return { segments, points };
}

/**
 * Percent of `playerPoints` (pixel-space route samples) that fall within
 * `toleranceMeters` of any point in `trackPoints` (pixel-space, e.g. from
 * projectAndClipTrack). Uses a uniform spatial grid sized to the tolerance
 * so this stays fast even with thousands of track points: any point
 * within the tolerance radius of a given cell must lie in that cell or
 * one of its 8 neighbors, since the cell side equals the tolerance
 * radius.
 * @returns {number} 0-100; 0 for an empty player or track path
 */
export function routeMatchPercent(playerPoints, trackPoints, { toleranceMeters = 100, metersPerPixel = 20 } = {}) {
  if (!playerPoints || playerPoints.length === 0) return 0;
  if (!trackPoints || trackPoints.length === 0) return 0;
  const tolerancePx = toleranceMeters / metersPerPixel;
  const cell = tolerancePx > 0 ? tolerancePx : 1;
  const grid = new Map();
  for (const t of trackPoints) {
    const key = `${Math.floor(t.x / cell)},${Math.floor(t.y / cell)}`;
    let bucket = grid.get(key);
    if (!bucket) {
      bucket = [];
      grid.set(key, bucket);
    }
    bucket.push(t);
  }
  const toleranceSqPx = tolerancePx * tolerancePx;
  let withinCount = 0;
  for (const p of playerPoints) {
    const gx = Math.floor(p.x / cell);
    const gy = Math.floor(p.y / cell);
    let hit = false;
    for (let dx = -1; dx <= 1 && !hit; dx++) {
      for (let dy = -1; dy <= 1 && !hit; dy++) {
        const bucket = grid.get(`${gx + dx},${gy + dy}`);
        if (!bucket) continue;
        for (const t of bucket) {
          const ddx = p.x - t.x;
          const ddy = p.y - t.y;
          if (ddx * ddx + ddy * ddy <= toleranceSqPx) {
            hit = true;
            break;
          }
        }
      }
    }
    if (hit) withinCount++;
  }
  return (withinCount / playerPoints.length) * 100;
}

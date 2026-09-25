// Module Worker that runs a Flight Rules "Dry run" (ensemble.js's ensemble())
// off the main thread, so the render loop keeps rendering while N headless
// sols simulate. Runs on its own JS realm, so it cannot receive the main
// thread's `terrain` object across postMessage directly (it closes over
// functions, which structured-clone can't carry) - instead the caller
// (dry-run.js) sends the raw elevations/mask typed arrays plus meta that
// built the main thread's ALREADY-LOADED terrain, and this worker rebuilds
// the identical terrain interface from them via terrain-data.js's own
// buildTerrain(). This never re-fetches the asset files (a stale/offline
// fetch here used to silently fall back to synthetic terrain and return it
// as a real prediction - Flight Rules review finding 3) and never invents
// terrain of its own: any failure to build the real terrain is reported as
// an error, so dry-run.js can fall back to its own chunked run on the main
// thread's real terrain instead.
import { buildTerrain } from "./terrain-data.js";
import { ensemble } from "./ensemble.js";

self.onmessage = async (event) => {
  const { requestId, spawn, waypoints, guardrails, N, baseSeed, driftPct, terrain: terrainData } = event.data ?? {};
  try {
    if (!terrainData) throw new Error("dry run worker received no terrain data");
    const { width, height, metersPerPixel, synthetic, meta, elevations, mask } = terrainData;
    const terrain = buildTerrain({
      width,
      height,
      metersPerPixel,
      synthetic,
      meta,
      elevations: new Float32Array(elevations),
      mask: mask ? new Uint8Array(mask) : null,
    });
    const result = ensemble({ terrain, spawn, waypoints, guardrails, N, baseSeed, driftPct });
    self.postMessage({ requestId, ok: true, result });
  } catch (error) {
    self.postMessage({ requestId, ok: false, error: error?.message ?? String(error) });
  }
};

// Module Worker that runs a Flight Rules "Dry run" (ensemble.js's ensemble())
// off the main thread, so the render loop keeps rendering while N headless
// sols simulate. Runs on its own JS realm, so it cannot receive the main
// thread's `terrain` object across postMessage (it closes over functions,
// which structured-clone can't carry) - it independently re-fetches the
// same asset files main.js's terrain-data.js loadTerrain() already loaded,
// relative to ITS OWN module URL (same web/ directory), and parses them
// with the same pure parseTerrain()/createSyntheticTerrain() this repo
// already uses everywhere else. No terrain-building logic is duplicated
// here - only the fetch + fallback shape loadTerrain() also has.
import { parseTerrain, createSyntheticTerrain } from "./terrain-data.js";
import { ensemble } from "./ensemble.js";

async function loadTerrainForWorker(assetKey) {
  const base = `../assets/${assetKey}/`;
  try {
    const [metaRes, heightRes] = await Promise.all([fetch(`${base}meta.json`), fetch(`${base}height.bin`)]);
    if (!metaRes.ok || !heightRes.ok) throw new Error(`missing assets for ${assetKey}`);
    const meta = await metaRes.json();
    const heightBuffer = await heightRes.arrayBuffer();
    let maskBuffer = null;
    if (meta.maskFile) {
      const maskRes = await fetch(`${base}${meta.maskFile}`);
      if (maskRes.ok) maskBuffer = await maskRes.arrayBuffer();
    }
    return parseTerrain(heightBuffer, meta, maskBuffer);
  } catch {
    return createSyntheticTerrain({ seed: assetKey === "mars" ? 2 : 1 });
  }
}

self.onmessage = async (event) => {
  const { requestId, assetKey, spawn, waypoints, guardrails, N, baseSeed, driftPct } = event.data ?? {};
  try {
    const terrain = await loadTerrainForWorker(assetKey);
    const result = ensemble({ terrain, spawn, waypoints, guardrails, N, baseSeed, driftPct });
    self.postMessage({ requestId, ok: true, result });
  } catch (error) {
    self.postMessage({ requestId, ok: false, error: error?.message ?? String(error) });
  }
};

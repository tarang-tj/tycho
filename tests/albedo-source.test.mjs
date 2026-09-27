// G1: albedo-source.js picks the real LROC orthophoto only when its sidecar
// ships and the level has not opted out; otherwise the DEM hillshade.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pickAlbedo, ORTHO_STRENGTH } from "../web/albedo-source.js";
import { LEVELS, LEVEL_ORDER } from "../web/levels.js";

const ASSETS = fileURLToPath(new URL("../assets/", import.meta.url));

/** A fetch stand-in over the real assets directory on disk. */
function diskFetch(url) {
  const rel = url.replace(/^\.\.\/assets\//, "");
  const path = `${ASSETS}${rel}`;
  if (!existsSync(path)) return Promise.resolve({ ok: false, json: async () => null });
  return Promise.resolve({ ok: true, json: async () => JSON.parse(readFileSync(path, "utf8")) });
}

test("a level whose sidecar ships gets the ortho photo, with the hillshade as its load fallback", async () => {
  const pick = await pickAlbedo(LEVELS.apollo17, { synthetic: false }, diskFetch);
  assert.equal(pick.kind, "ortho");
  assert.equal(pick.url, "../assets/apollo17/albedo-ortho.jpg");
  assert.equal(pick.fallbackUrl, "../assets/apollo17/albedo.jpg");
  assert.equal(pick.strength, ORTHO_STRENGTH);
  assert.match(pick.sidecar.productUrl, /^https:\/\/.*NAC_DTM_APOLLO17/);
});

test("no sidecar (404) falls back to the hillshade", async () => {
  const pick = await pickAlbedo({ assetKey: "nosuchsite" }, { synthetic: false }, diskFetch);
  assert.deepEqual([pick.kind, pick.url, pick.fallbackUrl], ["hillshade", "../assets/nosuchsite/albedo.jpg", null]);
});

test("a fetch that throws, or a sidecar without a productUrl, falls back to the hillshade", async () => {
  const thrown = await pickAlbedo({ assetKey: "x" }, {}, () => Promise.reject(new Error("offline")));
  assert.equal(thrown.kind, "hillshade");
  const junk = await pickAlbedo({ assetKey: "x" }, {}, () => Promise.resolve({ ok: true, json: async () => ({}) }));
  assert.equal(junk.kind, "hillshade");
});

test("orthoAlbedo:false (the A2 kill) keeps the hillshade even when a sidecar ships", async () => {
  let fetched = false;
  const pick = await pickAlbedo({ assetKey: "apollo17", orthoAlbedo: false }, {}, (u) => { fetched = true; return diskFetch(u); });
  assert.equal(pick.kind, "hillshade");
  assert.equal(fetched, false);
});

test("synthetic terrain gets no albedo at all", async () => {
  const pick = await pickAlbedo(LEVELS.tycho, { synthetic: true }, diskFetch);
  assert.equal(pick.kind, "none");
  assert.equal(pick.url, null);
});

test("every Moon level resolves ortho exactly when its sidecar exists and it has not opted out", async () => {
  for (const key of LEVEL_ORDER) {
    const level = LEVELS[key];
    const pick = await pickAlbedo(level, { synthetic: false }, diskFetch);
    const sidecar = existsSync(`${ASSETS}${level.assetKey}/albedo-ortho.json`);
    const expected = sidecar && level.orthoAlbedo !== false ? "ortho" : "hillshade";
    assert.equal(pick.kind, expected, `${key}: expected ${expected}`);
  }
});

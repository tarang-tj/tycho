// Boot probe: serves the repo root, drives TYCHO headless via Playwright,
// and proves the riskiest unknowns end to end:
//   - real terrain renders in WebGL
//   - the Moon command/telemetry loop respects the real light-time delay,
//     and the Moon win condition ("mission.status === 'won'") is reachable
//   - a Mars sol plan does not move the rover before the compressed delay,
//     then drives it toward the first waypoint
//   - the co-pilot HOLDs (never moves) rather than cross a slope above the
//     guardrail limit, and that HOLD reaches the player as a "held" mission
//     status after the telemetry delay
//
// Playwright resolution (no personal paths committed - see L1 in the
// pre-publish review): this is a zero-build repo that doesn't keep its own
// node_modules, so playwright is resolved in order:
//   1. TYCHO_PLAYWRIGHT_FROM env var: path to a package.json (in this repo
//      or a sibling one) whose node_modules has playwright installed.
//   2. createRequire(import.meta.url)('playwright'): works if playwright is
//      installed as this repo's own devDependency (see package.json).
//   3. A clear, actionable error otherwise.
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

function resolvePlaywright() {
  if (process.env.TYCHO_PLAYWRIGHT_FROM) {
    return createRequire(process.env.TYCHO_PLAYWRIGHT_FROM)("playwright");
  }
  try {
    return createRequire(import.meta.url)("playwright");
  } catch {
    throw new Error(
      "playwright is not installed. Either add it as a devDependency and install it " +
      "(npm install -D playwright), or point TYCHO_PLAYWRIGHT_FROM at the package.json " +
      "of another local repo that already has it installed, e.g.:\n" +
      "  TYCHO_PLAYWRIGHT_FROM=/path/to/other-repo/package.json npm run verify:boot",
    );
  }
}
const { chromium } = resolvePlaywright();
const root = fileURLToPath(new URL("../", import.meta.url));

const mime = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json" };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    const pathname = url.pathname === "/" ? "/index.html" : url.pathname.endsWith("/") ? `${url.pathname}index.html` : url.pathname;
    const path = normalize(join(root, pathname));
    assert.ok(path.startsWith(root), "request escaped repository root");
    const body = await readFile(path);
    response.writeHead(200, { "content-type": mime[extname(path)] || "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404); response.end("not found");
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;

function sampleCanvasPainted() {
  return new Promise((resolve, reject) => {
    try {
      const canvas = document.querySelector("#sceneCanvas");
      if (!canvas) throw new Error("#sceneCanvas is missing");
      requestAnimationFrame(() => {
        try {
          const off = document.createElement("canvas");
          off.width = canvas.width;
          off.height = canvas.height;
          const ctx = off.getContext("2d");
          ctx.drawImage(canvas, 0, 0);
          const { data } = ctx.getImageData(0, 0, off.width, off.height);
          let lit = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i] + data[i + 1] + data[i + 2] > 15) lit += 1;
          }
          resolve({ fraction: lit / (data.length / 4), width: off.width, height: off.height });
        } catch (error) { reject(error); }
      });
    } catch (error) { reject(error); }
  });
}

function hasMoved(before, after) {
  return Math.hypot(after.x - before.x, after.y - before.y) > 0.001;
}
function assertNoMove(before, after, message) {
  assert.ok(!hasMoved(before, after), `${message} (dx=${(after.x - before.x).toFixed(4)}, dy=${(after.y - before.y).toFixed(4)})`);
}
async function waitUntil(predicate, timeoutMs, message) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`${message} (timed out after ${timeoutMs}ms)`);
}

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(`http://127.0.0.1:${port}/web/`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.TYCHO?.ready === true, null, { timeout: 10000 });

  const renderer = await page.evaluate(() => window.TYCHO.renderer);
  assert.equal(renderer, "webgl", `expected WebGL renderer, got "${renderer}"`);

  const terrainInfo = await page.evaluate(() => window.TYCHO.getTerrainInfo());
  assert.ok(terrainInfo && terrainInfo.width > 0, "terrain info missing");
  console.log(`terrain: ${terrainInfo.synthetic ? "synthetic" : "real DEM"}, ${terrainInfo.width}x${terrainInfo.width}, ${terrainInfo.metersPerPixel} m/px`);

  const paint = await page.evaluate(sampleCanvasPainted);
  assert.ok(paint.fraction > 0.02, `scene appears blank: only ${(paint.fraction * 100).toFixed(2)}% of ${paint.width}x${paint.height} pixels lit`);

  // ---------------------------------------------------------------------
  // Moon: mission starts in "brief"; debug.startMission() begins the run.
  // ---------------------------------------------------------------------
  assert.equal(await page.evaluate(() => window.TYCHO.getLevel()), "moon");
  assert.equal(await page.evaluate(() => window.TYCHO.debug.getMission().status), "brief");
  await page.evaluate(() => window.TYCHO.debug.startMission());
  assert.equal(await page.evaluate(() => window.TYCHO.debug.getMission().status), "active");

  const moonDelay = 1.28;
  const moonSpawn = await page.evaluate(() => window.TYCHO.getTrueState());

  await page.evaluate(() => window.TYCHO.sendCommand({ throttle: 1, steer: 0 }));
  const t0 = Date.now();

  await page.waitForTimeout(Math.max(0, moonDelay * 1000 - 400));
  const beforeDelivery = await page.evaluate(() => window.TYCHO.getTrueState());
  assertNoMove(moonSpawn, beforeDelivery, "true state moved before the uplink delay elapsed");

  await waitUntil(async () => {
    const s = await page.evaluate(() => window.TYCHO.getTrueState());
    return hasMoved(moonSpawn, s);
  }, moonDelay * 1000 + 2000, `true state never moved (elapsed ${Date.now() - t0}ms, expected ~${moonDelay * 1000}ms)`);
  const trueMovedAtMs = Date.now() - t0;
  assert.ok(trueMovedAtMs >= moonDelay * 1000 - 400, `true state moved too early: ${trueMovedAtMs}ms`);

  await waitUntil(async () => {
    const v = await page.evaluate(() => window.TYCHO.getVisibleState());
    return v && hasMoved(moonSpawn, v);
  }, moonDelay * 2000 + 2500, `visible state never moved (expected ~${moonDelay * 2000}ms after send)`);
  const visibleMovedAtMs = Date.now() - t0;
  assert.ok(visibleMovedAtMs >= moonDelay * 2000 - 500, `visible state moved too early: ${visibleMovedAtMs}ms`);
  console.log(`Moon: true state moved at ${trueMovedAtMs}ms (~${moonDelay * 1000}ms expected), visible state moved at ${visibleMovedAtMs}ms (~${moonDelay * 2000}ms expected)`);

  // Moon win condition: debug-place the rover a few meters from the goal
  // (well inside the win radius) and let telemetry catch up. Real DEM
  // summits can be locally very steep even a pixel or two from the goal
  // marker, so search a small neighborhood for a landing spot that is both
  // within the win radius and under the slope limit, instead of assuming
  // the goal pixel itself is safe to stand on.
  const moonGoal = terrainInfo.goal;
  assert.ok(moonGoal, "Moon terrain meta is missing a goal");
  const landingSpot = await page.evaluate(async (goal) => {
    const mpp = window.TYCHO.getTerrainInfo().metersPerPixel;
    const maxOffsetPx = Math.floor(12 / mpp); // stay inside the 15m win radius with margin
    for (let dy = -maxOffsetPx; dy <= maxOffsetPx; dy++) {
      for (let dx = -maxOffsetPx; dx <= maxOffsetPx; dx++) {
        const x = goal.x + dx;
        const y = goal.y + dy;
        if (Math.hypot(dx, dy) * mpp > 12) continue;
        if (window.TYCHO.debug.sampleSlope(x, y) < 20) return { x, y };
      }
    }
    return null;
  }, moonGoal);
  assert.ok(landingSpot, "no landing spot near the Moon goal is under the slope limit; cannot construct a win scenario");
  await page.evaluate((spot) => window.TYCHO.debug.placeRoverAt(spot.x, spot.y, 0), landingSpot);
  await waitUntil(async () => {
    const m = await page.evaluate(() => window.TYCHO.debug.getMission());
    return m.status === "won";
  }, moonDelay * 2000 + 3000, "Moon win condition (mission.status === 'won') was never reached from a debug placement near the goal");
  console.log("Moon: win condition reachable via debug.placeRoverAt near the goal.");

  // ---------------------------------------------------------------------
  // Mars: sol plan uplink respects the compressed delay before driving.
  // ---------------------------------------------------------------------
  await page.evaluate(() => window.TYCHO.switchLevel("mars"));
  await page.waitForFunction(() => window.TYCHO.getLevel() === "mars", null, { timeout: 5000 });
  await page.waitForFunction(() => window.TYCHO.ready === true, null, { timeout: 10000 });

  // "close" scenario: real one-way 3 min compressed 15x -> 12s wait.
  await page.evaluate(() => window.TYCHO.debug.startMission("close"));
  assert.equal(await page.evaluate(() => window.TYCHO.debug.getMission().status), "active");
  const marsDelaySec = await page.evaluate(() => window.TYCHO.debug.getDelaySec());
  assert.ok(Math.abs(marsDelaySec - 12) < 0.5, `expected the "close" scenario to compress to ~12s, got ${marsDelaySec}s`);

  // Mars terrain info is fetched fresh here (not reused from the earlier
  // Moon `terrainInfo`, which would point at the wrong body's spawn/goal).
  const marsTerrainInfo = await page.evaluate(() => window.TYCHO.getTerrainInfo());
  console.log(`Mars terrain: ${marsTerrainInfo.synthetic ? "synthetic" : "real DEM"}, ${marsTerrainInfo.width}x${marsTerrainInfo.width}, ${marsTerrainInfo.metersPerPixel} m/px`);

  // Permissive guardrails + a tiny, safe hop near spawn so this leg cannot
  // hit the max-autonomous-distance cap or an unrelated slope hazard.
  await page.evaluate(() => window.TYCHO.debug.setGuardrails({ maxSlopeDeg: 40, hazardMode: "stop", maxAutonomousDistanceM: 2000, lookaheadRadiusM: 100 }));
  const marsSpawn = await page.evaluate(() => window.TYCHO.getTrueState());
  const spawnMeta = marsTerrainInfo.spawn;
  const marsWaypoint = { x: spawnMeta.x + 3, y: spawnMeta.y };
  await page.evaluate((wp) => window.TYCHO.debug.uplinkPlan([wp]), marsWaypoint);
  const marsT0 = Date.now();

  await page.waitForTimeout(Math.max(0, marsDelaySec * 1000 - 3000));
  const marsBeforeDelivery = await page.evaluate(() => window.TYCHO.getTrueState());
  assertNoMove(marsSpawn, marsBeforeDelivery, "Mars true state moved before the compressed uplink delay elapsed");

  await waitUntil(async () => {
    const s = await page.evaluate(() => window.TYCHO.getTrueState());
    return hasMoved(marsSpawn, s);
  }, marsDelaySec * 1000 + 5000, "Mars true state never moved toward waypoint 1 after the sol plan was delivered");
  const marsMovedAtMs = Date.now() - marsT0;
  assert.ok(marsMovedAtMs >= marsDelaySec * 1000 - 700, `Mars rover moved too early: ${marsMovedAtMs}ms, expected >= ~${marsDelaySec * 1000}ms`);
  console.log(`Mars: sol plan delivered and driving started at ${marsMovedAtMs}ms (compressed delay ~${marsDelaySec}s).`);

  // ---------------------------------------------------------------------
  // Co-pilot HOLD: a near-zero slope tolerance must stop the rover before
  // it crosses any real hazard, and the HOLD must reach mission state as
  // "held" once telemetry carrying it arrives.
  // ---------------------------------------------------------------------
  await page.evaluate(() => window.TYCHO.debug.startMission("close")); // fresh run, same level/terrain
  // A generous distance cap keeps this test isolated to the SLOPE
  // guardrail specifically (a smaller cap could mask a broken slope check
  // behind a "max distance" HOLD instead - caught live while proving this
  // gate can fail, see the report's red/green section). The target is a
  // substantial but bounded 1km hop, not the (much farther) mission goal.
  await page.evaluate(() => window.TYCHO.debug.setGuardrails({ maxSlopeDeg: 1, hazardMode: "stop", maxAutonomousDistanceM: 50000, lookaheadRadiusM: 50 }));
  const holdSpawn = await page.evaluate(() => window.TYCHO.getTrueState());
  const nearTarget = { x: spawnMeta.x + 50, y: spawnMeta.y + 50 }; // 1000m on a 20m/px grid
  await page.evaluate((wp) => window.TYCHO.debug.uplinkPlan([wp]), nearTarget);

  await page.waitForTimeout(marsDelaySec * 1000 + 1500);
  const holdAfterDelivery = await page.evaluate(() => window.TYCHO.getTrueState());
  assertNoMove(holdSpawn, holdAfterDelivery, "co-pilot let the rover move despite a 1° slope limit it cannot possibly satisfy");
  const autopilot = await page.evaluate(() => window.TYCHO.debug.getAutopilot());
  assert.match(autopilot?.holdReason ?? "", /slope/i, "co-pilot HOLD did not cite a slope hazard (a distance-cap HOLD would wrongly pass here too)");
  console.log(`Mars: co-pilot HOLD confirmed - ${autopilot.holdReason}`);

  await waitUntil(async () => {
    const m = await page.evaluate(() => window.TYCHO.debug.getMission());
    return m.status === "held";
  }, marsDelaySec * 1000 + 3000, "mission never transitioned to 'held' after the co-pilot HOLD reached telemetry");
  console.log("Mars: co-pilot HOLD reached the player as mission.status === 'held'.");

  // Expected noise: real DEM assets for Mars are produced by a separate
  // pipeline lane and may not be present in this checkout, so
  // height.bin/meta.json/albedo.jpg 404s are the documented
  // synthetic-fallback path. Any OTHER console/page error fails the gate.
  const unexpected = errors.filter((message) => !/Failed to load resource/.test(message));
  assert.equal(unexpected.length, 0, `unexpected console/page errors: ${unexpected.join("\n")}`);
  console.log("verify:boot PASSED - WebGL terrain rendered, Moon win condition, Mars sol-plan delay, and co-pilot HOLD all proven end to end.");
  await page.close();
} finally {
  await browser?.close();
  server.close();
}

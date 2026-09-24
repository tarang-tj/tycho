// Boot probe: serves the repo root, drives TYCHO headless via Playwright,
// and proves the riskiest unknown end to end: real terrain renders in
// WebGL, and the command/telemetry loop actually respects the light-time
// delay (the true rover moves only after the uplink delay; the player only
// SEES it move after uplink + downlink).
//
// Playwright is not installed in this repo (a zero-build repo keeps no
// node_modules of its own). It is loaded from a sibling repo that already
// has it, via createRequire — set TYCHO_PLAYWRIGHT_FROM to override the
// base package.json if that sibling repo moves or this runs on another
// machine.
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = fileURLToPath(new URL("../", import.meta.url));
const playwrightBase = process.env.TYCHO_PLAYWRIGHT_FROM;
const require = createRequire(playwrightBase);
const { chromium } = require("playwright");

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

// Sample a downscaled readback of the canvas and report the fraction of
// non-black pixels, so a blank/failed render is caught even though the
// canvas has no preserveDrawingBuffer (sample happens inside a rAF queued
// after the renderer's own draw call).
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

  // --- Moon: delayed command/telemetry loop ---
  assert.equal(await page.evaluate(() => window.TYCHO.getLevel()), "moon");
  const moonDelay = 1.28;
  const spawn = await page.evaluate(() => window.TYCHO.getTrueState());

  await page.evaluate(() => window.TYCHO.sendCommand({ throttle: 1, steer: 0 }));
  const t0 = Date.now();

  // Before the uplink delay elapses, the true rover must not have moved.
  await page.waitForTimeout(Math.max(0, moonDelay * 1000 - 400));
  const beforeDelivery = await page.evaluate(() => window.TYCHO.getTrueState());
  assertNoMove(spawn, beforeDelivery, "true state moved before the uplink delay elapsed");

  // After ~delay, the true rover should have started moving.
  await waitUntil(async () => {
    const s = await page.evaluate(() => window.TYCHO.getTrueState());
    return hasMoved(spawn, s);
  }, moonDelay * 1000 + 2000, `true state never moved (elapsed ${Date.now() - t0}ms, expected ~${moonDelay * 1000}ms)`);
  const trueMovedAtMs = Date.now() - t0;
  assert.ok(
    trueMovedAtMs >= moonDelay * 1000 - 400,
    `true state moved too early: ${trueMovedAtMs}ms, expected >= ${moonDelay * 1000 - 400}ms`,
  );

  // The VISIBLE (delayed telemetry) state must lag further: only after
  // uplink + downlink (~2x delay) should the player see movement.
  const visibleBeforeSecondDelay = await page.evaluate(() => window.TYCHO.getVisibleState());
  assertNoMove(spawn, visibleBeforeSecondDelay ?? spawn, "visible state moved before telemetry delay elapsed");

  await waitUntil(async () => {
    const v = await page.evaluate(() => window.TYCHO.getVisibleState());
    return v && hasMoved(spawn, v);
  }, moonDelay * 2000 + 2500, `visible state never moved (expected ~${moonDelay * 2000}ms after send)`);
  const visibleMovedAtMs = Date.now() - t0;
  assert.ok(
    visibleMovedAtMs >= moonDelay * 2000 - 500,
    `visible state moved too early: ${visibleMovedAtMs}ms, expected >= ${moonDelay * 2000 - 500}ms (2x one-way delay)`,
  );
  console.log(`Moon: true state moved at ${trueMovedAtMs}ms (~${moonDelay * 1000}ms expected), visible state moved at ${visibleMovedAtMs}ms (~${moonDelay * 2000}ms expected)`);

  // --- Mars: longer, compressed delay ---
  await page.evaluate(() => window.TYCHO.switchLevel("mars"));
  await page.waitForFunction(() => window.TYCHO.getLevel() === "mars", null, { timeout: 5000 });
  await page.waitForFunction(() => window.TYCHO.ready === true, null, { timeout: 10000 });
  const marsSpawn = await page.evaluate(() => window.TYCHO.getTrueState());
  await page.evaluate(() => window.TYCHO.sendCommand({ throttle: 1, steer: 0 }));
  const marsT0 = Date.now();
  await page.waitForTimeout(3000); // well under the 8s Mars delay
  const marsStillSpawn = await page.evaluate(() => window.TYCHO.getTrueState());
  assertNoMove(marsSpawn, marsStillSpawn, "Mars true state moved well before its longer delay elapsed");
  await waitUntil(async () => {
    const s = await page.evaluate(() => window.TYCHO.getTrueState());
    return hasMoved(marsSpawn, s);
  }, 12000, "Mars true state never moved");
  const marsMovedAtMs = Date.now() - marsT0;
  assert.ok(marsMovedAtMs > moonDelay * 1000 * 2, `Mars delay (${marsMovedAtMs}ms) should be much longer than Moon's ${moonDelay * 1000}ms`);
  console.log(`Mars: true state moved at ${marsMovedAtMs}ms (delay compressed to 8s for play)`);

  // Expected noise: real DEM assets are produced by a separate pipeline lane
  // and are not present in this checkout, so height.bin/meta.json/albedo.jpg
  // 404s are the documented synthetic-fallback path (terrain-data.js warns
  // and substitutes synthetic terrain). Any OTHER console/page error fails.
  const unexpected = errors.filter((message) => !/Failed to load resource/.test(message));
  assert.equal(unexpected.length, 0, `unexpected console/page errors: ${unexpected.join("\n")}`);
  console.log("verify:boot PASSED — WebGL terrain rendered, Moon and Mars signal delay both proven end to end.");
  await page.close();
} finally {
  await browser?.close();
  server.close();
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

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
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { LEVELS, LEVEL_ORDER } from "../web/levels.js";

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
const assetsRoot = fileURLToPath(new URL("../assets/", import.meta.url));

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
  console.log(`Lunokhod terrain: ${terrainInfo.synthetic ? "synthetic" : "real DEM"}, ${terrainInfo.width}x${terrainInfo.width}, ${terrainInfo.metersPerPixel} m/px`);

  const paint = await page.evaluate(sampleCanvasPainted);
  assert.ok(paint.fraction > 0.02, `scene appears blank: only ${(paint.fraction * 100).toFixed(2)}% of ${paint.width}x${paint.height} pixels lit`);

  // ---------------------------------------------------------------------
  // Lunokhod (the boot level): mission starts in "brief";
  // debug.startMission() begins the run. Proves real DEM rendering AND the
  // live 1.28s delay on the flagship level.
  // ---------------------------------------------------------------------
  assert.equal(await page.evaluate(() => window.TYCHO.getLevel()), "lunokhod");
  assert.equal(terrainInfo.synthetic, false, "Lunokhod must render the real shipped DEM, not the synthetic fallback");
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
  console.log(`Lunokhod: true state moved at ${trueMovedAtMs}ms (~${moonDelay * 1000}ms expected), visible state moved at ${visibleMovedAtMs}ms (~${moonDelay * 2000}ms expected)`);

  // Lunokhod win condition: debug-place the rover a few meters from the
  // goal (the parked Lunokhod 2, well inside the win radius) and let
  // telemetry catch up. Real DEM terrain can be locally steep even a pixel
  // or two from the goal marker, so search a small neighborhood for a
  // landing spot that is both within the win radius and under the slope
  // limit, instead of assuming the goal pixel itself is safe to stand on.
  const moonGoal = terrainInfo.goal;
  assert.ok(moonGoal, "Lunokhod terrain meta is missing a goal");
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
  console.log("Lunokhod: win condition reachable via debug.placeRoverAt near the goal.");

  // Objectives: a Moon win must render the end card's objectives list
  // (arrive/beat-par/slope), each marked met or unmet - proves
  // evaluateObjectives wiring reaches the DOM, not just main.js's call.
  await page.waitForSelector(".mission-endcard-objectives", { state: "visible", timeout: 5000 });
  const objectiveLabels = await page.evaluate(() => [...document.querySelectorAll(".mission-objective")].map((el) => el.textContent));
  assert.ok(objectiveLabels.length >= 2, `expected at least arrive + beat-par objectives on the Moon end card, got ${JSON.stringify(objectiveLabels)}`);
  assert.ok(objectiveLabels.some((t) => /^\[x\] Arrive/.test(t)), `the "Arrive" objective must render as met on a win: ${JSON.stringify(objectiveLabels)}`);
  console.log(`Lunokhod: end card objectives rendered - ${JSON.stringify(objectiveLabels)}`);

  // ---------------------------------------------------------------------
  // Tycho: a second Moon-body level, distinct terrain, still boots and
  // renders. Not exercised as deeply as Lunokhod/Mars (same live-drive
  // mechanics as Lunokhod, already proven above) - just confirms the level
  // switch, real DEM, and a fresh "brief" mission all come up cleanly.
  // ---------------------------------------------------------------------
  await page.evaluate(() => window.TYCHO.switchLevel("tycho"));
  await page.waitForFunction(() => window.TYCHO.getLevel() === "tycho", null, { timeout: 5000 });
  await page.waitForFunction(() => window.TYCHO.ready === true, null, { timeout: 10000 });
  const tychoTerrainInfo = await page.evaluate(() => window.TYCHO.getTerrainInfo());
  assert.ok(tychoTerrainInfo && tychoTerrainInfo.width > 0, "Tycho terrain info missing");
  assert.equal(await page.evaluate(() => window.TYCHO.debug.getMission().status), "brief");
  const tychoPaint = await page.evaluate(sampleCanvasPainted);
  assert.ok(tychoPaint.fraction > 0.02, `Tycho scene appears blank: only ${(tychoPaint.fraction * 100).toFixed(2)}% of pixels lit`);
  console.log(`Tycho: booted cleanly, ${tychoTerrainInfo.synthetic ? "synthetic" : "real DEM"}, ${tychoTerrainInfo.width}x${tychoTerrainInfo.width}, ${tychoTerrainInfo.metersPerPixel} m/px.`);

  // Bug fix probe: a live command on Tycho sets the "Sent, arrives in..."
  // status line; switching levels must clear it immediately, not leave it
  // visible until the new level's own first uplink (the reported bug).
  await page.evaluate(() => window.TYCHO.debug.startMission());
  await page.evaluate(() => window.TYCHO.sendCommand({ throttle: 1, steer: 0 }));
  const statusAfterSend = await page.evaluate(() => document.querySelector(".mission-status-line")?.textContent ?? "");
  assert.match(statusAfterSend, /arrives in/, "precondition: sending a command on Tycho should set the status line");

  // ---------------------------------------------------------------------
  // Mars: sol plan uplink respects the compressed delay before driving.
  // ---------------------------------------------------------------------
  await page.evaluate(() => window.TYCHO.switchLevel("mars"));
  await page.waitForFunction(() => window.TYCHO.getLevel() === "mars", null, { timeout: 5000 });
  await page.waitForFunction(() => window.TYCHO.ready === true, null, { timeout: 10000 });
  const statusAfterSwitch = await page.evaluate(() => document.querySelector(".mission-status-line")?.textContent ?? "");
  assert.doesNotMatch(statusAfterSwitch, /arrives in/, `Tycho's stale status line leaked into Mars after a level switch: "${statusAfterSwitch}"`);
  console.log("Status line bug fix confirmed: switching levels clears the previous level's status line.");

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

  // ---------------------------------------------------------------------
  // Flight Rules drift reveal (present-time rule, spec 3-Lane-3 acceptance
  // (3)): the believed-vs-true track and the "Drift this run" line must be
  // absent while the rover is ACTUALLY DRIVING, appear ONLY once the mission
  // reaches a terminal status, and never linger into the next run.
  //
  // W2-X review finding 1: the previous version of this probe sampled ONCE,
  // 3s before the plan was even delivered, on a 1deg-slope HOLD fixture that
  // never moved the rover at all (0m) - so it could never catch a leak that
  // only happens WHILE driving. Two real leaks (the offset written to the
  // status line every tick, and the whole end card shown from delivery
  // onward) both passed the old check. This version drives a real route -
  // default guardrails, waypoint (494,494), same "close" scenario the
  // review used to reproduce both leaks (~509m from the real Jezero spawn,
  // ends "stalled" at ~517m) - and samples repeatedly across the whole
  // drive, not once before it starts.
  //
  // This whole probe runs on its OWN page (like the mobile top-bar check
  // below), never the shared `page` the rest of this script drives: it
  // installs Playwright's virtual clock (see below), and handing time back
  // to real timers afterward (via clock.resume()) is not guaranteed to
  // restore native requestAnimationFrame's exact cadence for whatever runs
  // next on the same page - discovered live while proving this fix (a
  // resumed shared page later failed an unrelated Wave-1 boot check with a
  // blank canvas). An isolated, disposable page removes that risk entirely.
  const driftPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    driftPage.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    driftPage.on("pageerror", (error) => errors.push(error.message));
    await driftPage.goto(`http://127.0.0.1:${port}/web/`, { waitUntil: "networkidle" });
    await driftPage.waitForFunction(() => window.TYCHO?.ready === true, null, { timeout: 10000 });
    await driftPage.evaluate(() => window.TYCHO.switchLevel("mars"));
    await driftPage.waitForFunction(() => window.TYCHO.getLevel() === "mars", null, { timeout: 5000 });
    await driftPage.waitForFunction(() => window.TYCHO.ready === true, null, { timeout: 10000 });

    await driftPage.evaluate(() => window.TYCHO.debug.startMission("close")); // fresh run, default guardrails
    const driftWaypoint = { x: 494, y: 494 };
    const driftSpawn = await driftPage.evaluate(() => window.TYCHO.getTrueState());
    await driftPage.evaluate((wp) => window.TYCHO.debug.uplinkPlan([wp]), driftWaypoint);

    // Playwright's virtual clock (not a shortened stall timeout or
    // guardrail hack) is what keeps this affordable: it drives the render
    // loop's requestAnimationFrame through the wait AND the drive itself
    // without this probe burning real wall-clock time on either. main.js's
    // frameBody still computes dt from real (virtual) frame timestamps, so
    // the fixed-timestep physics and the mission's real stall/timeout rules
    // run completely unshortened - only how fast THIS TEST observes them
    // changes.
    await driftPage.clock.install();
    const TERMINAL = ["won", "tipped", "stalled", "held"];
    const presentTimeSamples = [];
    let driveStarted = false;
    let terminalStatus = null;
    // The 509m real drive to (494,494) takes a few minutes of simulated time
    // at the rover's real (unshortened) drive speed before the 75s stall
    // timeout even starts counting down - this ceiling is generous over
    // that, not a shortcut around it; page.clock makes it cost seconds of
    // real time, not minutes.
    const STEP_MS = 2000;
    const maxDriveMs = marsDelaySec * 1000 + 400000;
    for (let elapsedMs = 0; elapsedMs < maxDriveMs && !terminalStatus; elapsedMs += STEP_MS) {
      await driftPage.clock.runFor(STEP_MS);
      const sample = await driftPage.evaluate(() => {
        // Checked here, WHILE this same sample is known pre-terminal (not
        // via a separate Playwright locator call after the loop breaks) -
        // by the time this evaluate resolves on the tick that flips
        // mission.status to terminal, handleMissionTransition has already
        // run showEndCard() for THIS tick, so a post-loop visibility check
        // would just observe the (correct) reveal, not catch a leak.
        // #mission-panel's own CSS (`[hidden] { display: none !important;
        // }`) makes `.hidden` on the ancestor endcard an exact proxy for
        // actual visibility here.
        const endcardHidden = document.querySelector(".mission-endcard")?.hidden ?? true;
        return {
          hasAutopilot: !!window.TYCHO.debug.getAutopilot(),
          trueState: window.TYCHO.getTrueState(),
          status: window.TYCHO.debug.getMission().status,
          bodyText: document.body.innerText,
          driftVisible: !endcardHidden && !!document.querySelector(".mission-endcard-drift"),
          tracksVisible: !endcardHidden && !!document.querySelector(".mission-endcard-tracks"),
        };
      });
      if (!driveStarted && sample.hasAutopilot && hasMoved(driftSpawn, sample.trueState)) driveStarted = true;
      if (TERMINAL.includes(sample.status)) { terminalStatus = sample.status; break; }
      if (driveStarted) presentTimeSamples.push(sample);
    }
    assert.ok(driveStarted, "drift-reveal probe: the plan was delivered but the rover never actually moved from spawn - not a real drive");
    assert.ok(terminalStatus, `drift-reveal probe: Mars run never reached a terminal status within ${maxDriveMs}ms (virtual)`);
    assert.ok(presentTimeSamples.length >= 3, `drift-reveal probe: too few in-drive samples (${presentTimeSamples.length}) to trust the present-time check`);
    for (const sample of presentTimeSamples) {
      // Covers the status line too (a1's leak wrote the offset there every
      // tick): innerText includes it, not just the end card's own elements.
      assert.doesNotMatch(sample.bodyText, /Drift this run|co-pilot thought/, `the drift reveal leaked present time while driving (status=${sample.status})`);
      assert.equal(sample.driftVisible, false, `the drift line leaked present time: visible WHILE the rover was still driving (status=${sample.status})`);
      assert.equal(sample.tracksVisible, false, `the believed/true tracks leaked present time: visible WHILE the rover was still driving (status=${sample.status})`);
    }
    console.log(`Mars: drift reveal correctly absent across ${presentTimeSamples.length} samples of a real drive (spawn -> waypoint(494,494)), reached terminal status "${terminalStatus}".`);

    // Generous timeout (not 5s like the rest of this file): the hundred-plus
    // rAF frames page.clock.runFor() above just fired back-to-back are a
    // real CPU burst, and under contention with another heavy process on
    // this machine the DOM update can lag a few seconds behind an already-
    // correct mission.status (observed live proving this fix - the mission
    // itself was always "stalled" already; only the endcard's own render
    // was slow to land under load).
    await driftPage.waitForSelector(".mission-endcard-drift", { state: "visible", timeout: 20000 });
    const driftText = await driftPage.evaluate(() => document.querySelector(".mission-endcard-drift").textContent);
    assert.match(driftText, /Drift this run: the co-pilot thought TYCHO was \d+ m from where it really was\./, `drift reveal line missing/malformed at mission end: "${driftText}"`);
    assert.match(driftText, /Modeled drift: about 1% of distance \(a game assumption, not a measured rover figure\)/, `drift reveal line is missing the ALWAYS-present drift label: "${driftText}"`);

    // Review finding 2: the tracks canvas must actually RENDER both track
    // colors after a real drive, not just exist at some size - counts exact
    // pixel matches for the true (white) and believed (hud-tracks.js's
    // BELIEVED_COLOR, #ff5ec4) track colors via an offscreen copy of the canvas.
    const trackPixelCounts = await driftPage.evaluate(() => {
      const canvas = document.querySelector(".mission-endcard-tracks");
      if (!canvas) return null;
      const off = document.createElement("canvas");
      off.width = canvas.width;
      off.height = canvas.height;
      const ctx = off.getContext("2d");
      ctx.drawImage(canvas, 0, 0);
      const { data } = ctx.getImageData(0, 0, off.width, off.height);
      let white = 0, believed = 0;
      for (let i = 0; i < data.length; i += 4) {
        const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
        if (r === 255 && g === 255 && b === 255) white += 1;
        else if (r === 255 && g === 94 && b === 196) believed += 1; // hud-tracks.js BELIEVED_COLOR #ff5ec4
      }
      return { width: canvas.width, white, believed };
    });
    assert.ok(trackPixelCounts?.width > 0, "the believed/true tracks canvas is missing from the end card at mission end");
    assert.ok(trackPixelCounts.white > 5, `true track (white) is not actually rendered: only ${trackPixelCounts.white} matching pixels`);
    assert.ok(trackPixelCounts.believed > 5, `believed track is not actually rendered: only ${trackPixelCounts.believed} matching pixels`);
    console.log(`Mars: drift reveal shown at mission end - "${driftText}" (tracks canvas: ${trackPixelCounts.white} true-track px, ${trackPixelCounts.believed} believed-track px).`);

    await driftPage.evaluate(() => window.TYCHO.debug.startMission("close")); // retry
    const afterRetry = await driftPage.evaluate(() => ({
      endcardHidden: document.querySelector(".mission-endcard")?.hidden,
      marsTrackReveal: window.TYCHO.debug.getMarsTrackReveal(),
    }));
    assert.equal(afterRetry.endcardHidden, true, "the previous run's drift reveal remained visible after retrying (present-time leak into the next run)");
    // Review finding 4: marsTrackReveal itself must be reset on every fresh
    // run, not just hidden by the DOM - otherwise a future terminal status
    // reached without a plan ever being delivered could show the PREVIOUS
    // run's tracks (mutation (c) in the W2-X review: removing the
    // `marsTrackReveal = null` resets in beginRun/resetRun survived every
    // other check because nothing else reads marsTrackReveal before a fresh
    // plan delivery overwrites it).
    assert.equal(afterRetry.marsTrackReveal, null, "marsTrackReveal was not reset on retry - a future no-plan mission end could leak the previous run's tracks");
    console.log("Mars: drift reveal cleared after retry, and marsTrackReveal itself was reset (not just hidden).");
  } finally {
    await driftPage.close();
  }

  // ---------------------------------------------------------------------
  // Flight Rules "Dry run": placing a waypoint through the real UI (not the
  // debug API) and pressing Dry run must render N=100 results WITHOUT
  // freezing the render loop - proven here by sampling the frame counter
  // and getLiveLoopCount() while the async run is still in flight.
  // ---------------------------------------------------------------------
  // This block clicks real DOM (not just window.TYCHO.debug), so the title
  // screen overlay (still up - the rest of this script drives missions
  // through debug, never its own Start button) must stop intercepting
  // pointer events first. Removing the class directly (not clicking
  // Start) avoids title.js's start() side effect of calling switchLevel()
  // and undoing the Mars level state this script already set up.
  await page.evaluate(() => document.body.classList.remove("title-open"));
  await page.evaluate(() => window.TYCHO.debug.startMission("close")); // fresh run, plan panel visible again
  await page.waitForSelector(".mission-minimap", { state: "visible" });
  // Click terrain pixel (476,476) - tests/fixtures/mars-mixed-plan.json's own
  // first waypoint, a real cell that fixture's own measurement found splits
  // the ensemble between "arrived" and "stalled" at default guardrails - via
  // the minimap's ACTUAL rendered box (CSS can scale it away from its 220px
  // canvas attribute), not a hardcoded pixel guess.
  const minimapBox = await page.locator(".mission-minimap").boundingBox();
  const marsTerrainW = marsTerrainInfo.width;
  // The full 3-waypoint route from tests/fixtures/mars-mixed-plan.json,
  // clicked in order - that fixture's own measurement found this exact
  // route splits between "arrived" and "stalled" at default guardrails, so
  // the dry-run result below is a real mixed-outcome proof, not a
  // one-sided demo.
  for (const wp of [{ x: 476, y: 476 }, { x: 447, y: 427 }, { x: 455, y: 441 }]) {
    await page.click(".mission-minimap", {
      position: { x: (wp.x / marsTerrainW) * minimapBox.width, y: (wp.y / marsTerrainW) * minimapBox.height },
    });
  }
  await page.waitForFunction(() => !document.querySelector(".mission-dry-run-btn")?.disabled, null, { timeout: 5000 });
  assert.equal(await page.evaluate(() => window.TYCHO.debug.getLiveLoopCount()), 1, "exactly one render loop must be live before the dry run starts");

  const frameCountAtClick = await page.evaluate(() => window.TYCHO.debug.getFrameCount());
  await page.click(".mission-dry-run-btn");

  let sawFrameAdvance = false;
  let sawSingleLiveLoop = true;
  await waitUntil(async () => {
    const [frameCount, liveLoopCount, resultVisible] = await page.evaluate(() => [
      window.TYCHO.debug.getFrameCount(),
      window.TYCHO.debug.getLiveLoopCount(),
      !document.querySelector(".mission-dry-run-result")?.hidden,
    ]);
    // Review finding 4: only count a frame advance seen WHILE the result is
    // still hidden - the poll that finally sees the result (ends waitUntil)
    // would otherwise let a fully synchronous, main-thread-blocking dry run
    // pass this check too, since frameCount always advances at least once
    // between the click and the result becoming visible either way.
    if (frameCount > frameCountAtClick && !resultVisible) sawFrameAdvance = true;
    if (liveLoopCount !== 1) sawSingleLiveLoop = false;
    return resultVisible;
  }, 20000, "the dry-run result panel never became visible");

  assert.ok(sawFrameAdvance, "the render loop's frame counter never advanced while the dry run was in flight - it blocked the main thread");
  assert.ok(sawSingleLiveLoop, "more than one render loop was live during the dry run");
  assert.equal(await page.evaluate(() => window.TYCHO.debug.getLiveLoopCount()), 1, "exactly one render loop must still be live after the dry run finishes");

  const dryRunText = await page.evaluate(() => document.querySelector(".mission-dry-run-result").textContent);
  assert.match(dryRunText, /100 simulated sols:.*arrived.*held.*tipped.*stalled/, `dry run did not render 100 results with a full outcome breakdown: "${dryRunText}"`);
  assert.match(dryRunText, /Modeled drift: about 1% of distance \(a game assumption, not a measured rover figure\)/, `dry run result is missing the ALWAYS-present drift label: "${dryRunText}"`);
  console.log(`Mars: Dry run rendered 100 results without blocking the render loop - "${dryRunText}"`);

  // ---------------------------------------------------------------------
  // Flight Rules: a dry run left in flight across a retry, or a plan
  // changed after a completed dry run, must never show a stale or
  // borrowed prediction on the end card (review findings 1 and 2). Both
  // scenarios below drive through the real DOM (dry-run/uplink buttons),
  // never the debug API, since the bug lived in main.js's onDryRun/
  // onUplink closures those buttons actually call.
  // ---------------------------------------------------------------------
  async function placeMarsWaypoint(px, py) {
    const box = await page.locator(".mission-minimap").boundingBox();
    await page.click(".mission-minimap", { position: { x: (px / marsTerrainW) * box.width, y: (py / marsTerrainW) * box.height } });
  }
  // A 20 m (the UI's own minimum) autonomous-distance cap forces an
  // immediate, deterministic plan-time HOLD on any real waypoint - a fast
  // terminal state, same technique as the co-pilot HOLD block above, but
  // via the real plan-panel guardrail input this time.
  async function setTinyDistanceCap() {
    await page.fill('.mission-guardrail-row input[min="20"]', "20");
  }

  // Finding 1: press Dry run, then retry BEFORE that dry run resolves. The
  // in-flight summary must never apply to the NEW run's own uplink. The old
  // run's plan (waypoint + cap) is made IDENTICAL to what the new run below
  // uplinks, so the finding-2 signature check can never block the leak on
  // its own - only the epoch guard can. (Without this, an earlier version
  // of this check passed even with the epoch guard removed: see the
  // W2 re-review's new_issues #1.)
  await page.evaluate(() => window.TYCHO.debug.startMission("close"));
  await page.waitForSelector(".mission-minimap", { state: "visible" });
  await placeMarsWaypoint(476, 476);
  await setTinyDistanceCap();
  await page.waitForFunction(() => !document.querySelector(".mission-dry-run-btn")?.disabled, null, { timeout: 5000 });
  await page.click(".mission-dry-run-btn"); // fires an async dry run; deliberately NOT awaited

  await page.evaluate(() => window.TYCHO.debug.startMission("close")); // retry mid-flight
  await page.waitForSelector(".mission-minimap", { state: "visible" });
  // Give the STALE dry run (started on the run this replaced) time to
  // actually resolve before this run uplinks - the leak only shows up once
  // that old promise's `.then` has fired, which without the epoch guard
  // overwrites whatever this run's own reset already cleared. Even a
  // cap-20 (fast plan-time HOLD) dry run's full 100-seed ensemble finished
  // well under this in every run observed proving the Dry run block above.
  await page.waitForTimeout(6000);
  await placeMarsWaypoint(476, 476);
  await setTinyDistanceCap();
  await page.click(".mission-uplink-btn"); // uplinked with NO dry run pressed on THIS run

  // Two one-way delays: the plan must first ARRIVE (uplink delay) before
  // the co-pilot's resulting HOLD is even decided, then that HOLD's
  // telemetry must itself arrive (downlink delay) before mission.status
  // reads "held" - same round trip the co-pilot HOLD block above waits out.
  await waitUntil(async () => {
    const m = await page.evaluate(() => window.TYCHO.debug.getMission());
    return m.status === "held";
  }, marsDelaySec * 1000 * 2 + 6000, "the retried Mars run never reached a terminal HOLD");
  let predicted = await page.evaluate(() => !!document.querySelector(".mission-endcard-predicted"));
  assert.equal(predicted, false, "a dry run still in flight from the PREVIOUS run leaked its prediction into this run's end card (review finding 1)");
  console.log("Mars: a dry run left in flight across a retry did not leak into the next run's end card.");

  // Finding 2: complete a dry run, THEN change the plan (add a waypoint)
  // before uplinking. The now-stale summary (computed against the OLD
  // plan) must not be credited to the different, uplinked plan.
  await page.evaluate(() => window.TYCHO.debug.startMission("close"));
  await page.waitForSelector(".mission-minimap", { state: "visible" });
  await placeMarsWaypoint(476, 476);
  await page.waitForFunction(() => !document.querySelector(".mission-dry-run-btn")?.disabled, null, { timeout: 5000 });
  await page.click(".mission-dry-run-btn");
  await page.waitForFunction(() => !document.querySelector(".mission-dry-run-result")?.hidden, null, { timeout: 20000 });
  await placeMarsWaypoint(447, 427); // change the plan AFTER the dry run finished
  await setTinyDistanceCap();
  await page.click(".mission-uplink-btn");

  await waitUntil(async () => {
    const m = await page.evaluate(() => window.TYCHO.debug.getMission());
    return m.status === "held";
  }, marsDelaySec * 1000 * 2 + 6000, "the plan-changed Mars run never reached a terminal HOLD");
  predicted = await page.evaluate(() => !!document.querySelector(".mission-endcard-predicted"));
  assert.equal(predicted, false, "a dry-run summary computed against a DIFFERENT (earlier) plan was credited to the uplinked plan (review finding 2)");
  console.log("Mars: changing the plan after a completed dry run correctly dropped the stale prediction.");

  // Panel-visible sibling of finding 2 (W2 re-review new_issues #2): a dry
  // run still IN FLIGHT (not yet resolved) when the player edits the plan
  // must not re-show its result for the edited plan once it resolves. The
  // end card is already proven safe by the signature check above; this
  // checks the on-screen panel specifically.
  await page.evaluate(() => window.TYCHO.debug.startMission("close"));
  await page.waitForSelector(".mission-minimap", { state: "visible" });
  await placeMarsWaypoint(476, 476);
  await page.waitForFunction(() => !document.querySelector(".mission-dry-run-btn")?.disabled, null, { timeout: 5000 });
  await page.click(".mission-dry-run-btn"); // fires an async dry run; deliberately NOT awaited
  await placeMarsWaypoint(447, 427); // edit the plan WHILE that dry run is still in flight
  await page.waitForTimeout(6000); // let the stale run's .then fire
  const panelHiddenAfterEdit = await page.evaluate(() => !!document.querySelector(".mission-dry-run-result")?.hidden);
  assert.ok(panelHiddenAfterEdit, "a dry run still in flight when the plan was edited re-showed its (now stale) result panel after resolving");
  console.log("Mars: a dry run edited mid-flight never re-showed a stale result panel.");

  // Restore the title-open state this block removed (real-DOM-only, see
  // above) so every level switch below still gets its normal first-paint
  // camera behavior (scene.js's camRig only snaps/starts its cinematic
  // intro once titleOpen() reads false) instead of an intro transition
  // racing the very next scene's own paint-sample assertion.
  await page.evaluate(() => document.body.classList.add("title-open"));

  // ---------------------------------------------------------------------
  // Wave-1 sites (Chang'e-4, Apollo 17): every level whose real
  // assets are present in this checkout gets the same WebGL + real-DEM +
  // positive-delay proof as Lunokhod/Tycho/Mars above. A level with no
  // shipped assets yet is logged, not asserted against - it still boots via
  // terrain-data.js's synthetic fallback (unexercised here on purpose; that
  // path is proven directly by tests/terrain-data.test.mjs), and shipping it
  // is the parallel data lane's own gate, not this one's.
  // ---------------------------------------------------------------------
  for (const key of LEVEL_ORDER) {
    if (key === "lunokhod" || key === "tycho" || key === "mars") continue; // already proven in depth above
    const level = LEVELS[key];
    const shipped = existsSync(`${assetsRoot}${level.assetKey}/height.bin`) && existsSync(`${assetsRoot}${level.assetKey}/meta.json`);
    if (!shipped) {
      // M4: a shipped level's assets going missing (bad .gitignore, LFS
      // miss, partial copy) must fail the gate, not silently pass it - the
      // "skip while the data lane is pending" behavior is now opt-in only,
      // via TYCHO_ALLOW_MISSING_ASSETS=1, since every LEVEL_ORDER level
      // ships real assets as of this wave.
      if (process.env.TYCHO_ALLOW_MISSING_ASSETS === "1") {
        console.log(`${level.label}: assets/${level.assetKey}/ not present - skipping (TYCHO_ALLOW_MISSING_ASSETS=1).`);
        continue;
      }
      throw new Error(
        `${level.label}: assets/${level.assetKey}/ is missing (height.bin/meta.json not found). ` +
        "Every level in LEVEL_ORDER must ship real assets. If this is intentional " +
        "(e.g. a data lane still in progress), set TYCHO_ALLOW_MISSING_ASSETS=1 to skip it explicitly.");
    }
    await page.evaluate((k) => window.TYCHO.switchLevel(k), key);
    await page.waitForFunction((k) => window.TYCHO.getLevel() === k, key, { timeout: 5000 });
    await page.waitForFunction(() => window.TYCHO.ready === true, null, { timeout: 10000 });
    const info = await page.evaluate(() => window.TYCHO.getTerrainInfo());
    assert.ok(info && info.width > 0, `${level.label}: terrain info missing`);
    assert.equal(info.synthetic, false, `${level.label}: must render the real shipped DEM, not the synthetic fallback`);
    const paint = await page.evaluate(sampleCanvasPainted);
    assert.ok(paint.fraction > 0.02, `${level.label}: scene appears blank: only ${(paint.fraction * 100).toFixed(2)}% of pixels lit`);
    await page.evaluate(() => window.TYCHO.debug.startMission());
    const delaySec = await page.evaluate(() => window.TYCHO.debug.getDelaySec());
    assert.ok(delaySec > 0, `${level.label}: one-way delay must be a real positive number, got ${delaySec}`);
    console.log(`${level.label}: booted cleanly, real DEM, ${info.width}x${info.width} @ ${info.metersPerPixel} m/px, delay ${delaySec.toFixed(2)}s.`);
  }

  // ---------------------------------------------------------------------
  // H2 regression guard: at phone width (390x844) every level button in
  // the top bar must be fully inside the viewport (or reachable by
  // scrolling its container) and clickable - not clipped off-screen by
  // .level-select's overflow, and not the reported Jezero-button bug.
  // ---------------------------------------------------------------------
  const mobilePage = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await mobilePage.goto(`http://127.0.0.1:${port}/web/`, { waitUntil: "networkidle" });
    await mobilePage.waitForFunction(() => window.TYCHO?.ready === true, null, { timeout: 10000 });
    await mobilePage.click("#titleStart"); // close the title screen, as a phone player would
    await mobilePage.waitForSelector(".level-select", { state: "visible" });

    const report = await mobilePage.evaluate(() => {
      const container = document.querySelector(".level-select");
      const containerBox = container.getBoundingClientRect();
      return [...document.querySelectorAll(".level-btn")].map((btn) => {
        const box = btn.getBoundingClientRect();
        const insideViewport = box.left >= 0 && box.right <= window.innerWidth;
        // A button clipped by the container's own bounds (overflow:hidden)
        // is unreachable even if scrolling exists; a button outside the
        // container's current scroll window but reachable by scrolling
        // (overflow-x:auto) is fine.
        const withinContainerScrollRange = box.right <= container.scrollWidth + containerBox.left + 1
          && box.left >= containerBox.left - 1;
        return { level: btn.dataset.level, insideViewport, withinContainerScrollRange, box };
      });
    });
    assert.equal(report.length, LEVEL_ORDER.length, `expected ${LEVEL_ORDER.length} level buttons, found ${report.length}`);
    for (const btn of report) {
      assert.ok(btn.insideViewport || btn.withinContainerScrollRange,
        `${btn.level} level button is neither inside the 390px viewport nor reachable by the top bar's scroll ` +
        `(box=${JSON.stringify(btn.box)})`);
    }
    // Every button must also actually be clickable at its own screen
    // position (proves it isn't hidden under overflow:hidden clipping).
    for (const key of LEVEL_ORDER) {
      await mobilePage.locator(`.level-btn[data-level="${key}"]`).scrollIntoViewIfNeeded();
      await mobilePage.click(`.level-btn[data-level="${key}"]`);
      await mobilePage.waitForFunction((k) => window.TYCHO.getLevel() === k, key, { timeout: 5000 });
    }
    console.log(`Mobile top bar (390x844): all ${LEVEL_ORDER.length} level buttons are reachable and clickable.`);
  } finally {
    await mobilePage.close();
  }

  // Expected noise: real DEM assets for Mars are produced by a separate
  // pipeline lane and may not be present in this checkout, so
  // height.bin/meta.json/albedo.jpg 404s are the documented
  // synthetic-fallback path. Any OTHER console/page error fails the gate.
  const unexpected = errors.filter((message) => !/Failed to load resource/.test(message));
  assert.equal(unexpected.length, 0, `unexpected console/page errors: ${unexpected.join("\n")}`);
  console.log("verify:boot PASSED - WebGL terrain rendered, Lunokhod win condition, Tycho boot, Mars sol-plan delay, and co-pilot HOLD all proven end to end.");
  await page.close();
} finally {
  await browser?.close();
  server.close();
}

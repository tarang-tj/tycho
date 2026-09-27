// Uncapped perf harness (plan-wave3.md lane L5).
//
// NOT part of `npm run gate` - this is a manual measurement tool, slow and
// machine-dependent, run on demand to (re)establish a perf baseline.
//
// A7 (plan assumption ledger): "Chromium --disable-gpu-vsync
// --disable-frame-rate-limit gives meaningful uncapped frame time headless
// on M3" is UNVERIFIED going in. This script checks it directly: it launches
// two headless Chromium instances, one with only the baseline GPU flags
// (--use-angle=metal --enable-gpu --ignore-gpu-blocklist, the flags the
// original W3 baseline measurement already used) and one adding
// --disable-gpu-vsync --disable-frame-rate-limit, and compares the actual
// rAF frame INTERVAL (bound by vsync/compositor pacing) between them. If the
// flagged run's interval isn't meaningfully lower, A7 is refuted for this
// machine and the script falls back to the method the plan names as the
// fallback: timing the synchronous JS/GPU-submission WORK inside each rAF
// callback (performance.now() wrapped around the callback itself), which is
// not bounded by vsync wait (that wait happens after the callback returns,
// in the compositor) even when the callback's own interval is capped.
// Both numbers are recorded either way so the choice is auditable.
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { LEVEL_ORDER } from "../web/levels.js";

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
      "  TYCHO_PLAYWRIGHT_FROM=/path/to/other-repo/package.json node scripts/measure_perf.mjs",
    );
  }
}

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
];
// Matches the flags the original W3 baseline capture already used, so
// "capped" here is directly comparable to that prior baseline-results.json.
const CAPPED_ARGS = ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"];
const UNCAPPED_ARGS = [...CAPPED_ARGS, "--disable-gpu-vsync", "--disable-frame-rate-limit"];
const WARMUP_MS = Number(process.env.TYCHO_PERF_WARMUP_MS ?? 1000);
const MEASURE_MS = Number(process.env.TYCHO_PERF_MEASURE_MS ?? 3000);
// A7 threshold: the flagged run's interval must beat the baseline-flags run
// by at least 10% (relative) or 2ms (absolute) to count as "meaningfully
// uncapped" - either shows headless Chromium actually skipped a vsync wait,
// not just measurement noise around the ~16.67ms 60Hz frame.
const A7_RELATIVE_DROP = 0.9;
const A7_ABSOLUTE_DROP_MS = 2;

// No literal home-directory paths below: built from os.homedir() so the
// personal-path scan stays clean.
const DEFAULT_OUTPUT = join(homedir(), "plans", "260923-2234-tycho-rover", "levelup-v4", "measurements", "uncapped-baseline.json");
const OUTPUT_PATH = process.env.TYCHO_PERF_OUTPUT ?? DEFAULT_OUTPUT;
const BASELINE_COMMIT = process.env.TYCHO_PERF_COMMIT ?? "b9a638f";

function round(n, digits) {
  return n == null ? null : Number(n.toFixed(digits));
}

function percentile(sortedAscending, p) {
  if (sortedAscending.length === 0) return null;
  const idx = Math.min(sortedAscending.length - 1, Math.max(0, Math.ceil(sortedAscending.length * p) - 1));
  return sortedAscending[idx];
}

function summarizeSamples(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const median = percentile(sorted, 0.5);
  return {
    medianMs: median,
    p95Ms: percentile(sorted, 0.95),
    fps: median ? 1000 / median : null,
    sampleCount: sorted.length,
  };
}

/** One level/viewport/mode measurement: returns { frameCount, interval, work }. */
async function measureLevel(browser, port, viewport, levelKey) {
  const page = await browser.newPage({ viewport });
  try {
    // Installed before any app script runs, so main.js's own
    // requestAnimationFrame(cb) render-loop registration goes through this
    // wrapper. Records both the interval between successive rAF callbacks
    // (vsync/compositor-paced) and the synchronous time spent INSIDE the
    // callback itself (JS work + GPU command submission, not vsync-bound).
    await page.addInitScript(() => {
      window.__perfProbe = { intervals: [], work: [], lastTs: null };
      const nativeRAF = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = function wrappedRAF(cb) {
        return nativeRAF((ts) => {
          const probe = window.__perfProbe;
          if (probe.lastTs != null) probe.intervals.push(ts - probe.lastTs);
          probe.lastTs = ts;
          const workStart = performance.now();
          cb(ts);
          probe.work.push(performance.now() - workStart);
        });
      };
    });

    // 60s (not Playwright's 30s default): observed live under
    // --disable-gpu-vsync --disable-frame-rate-limit plus shared-machine CPU
    // contention, a fresh page's first navigation occasionally needed well
    // over 30s to reach networkidle even though the level itself loaded
    // fine once it did (proving this fix: the identical run passed at 60s).
    await page.goto(`http://127.0.0.1:${port}/web/`, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForFunction(() => window.TYCHO?.ready === true, null, { timeout: 30000 });
    await page.evaluate((key) => window.TYCHO.switchLevel(key), levelKey);
    // Generous timeout: with vsync/frame-rate-limit disabled the render loop
    // can spin at 100+ fps on a single CPU core, which was observed live to
    // starve the same page's own asset-fetch microtasks long enough to blow
    // past a 10-15s timeout on an otherwise-successful level switch (proving
    // this fix: same run, same level, passed at 30s).
    await page.waitForFunction((key) => window.TYCHO.getLevel() === key, levelKey, { timeout: 30000 });
    await page.waitForFunction(() => window.TYCHO.ready === true, null, { timeout: 30000 });

    const resetProbe = () => page.evaluate(() => {
      window.__perfProbe.intervals = [];
      window.__perfProbe.work = [];
      window.__perfProbe.lastTs = null;
    });

    await resetProbe(); // drop the level-switch/load churn
    await page.waitForTimeout(WARMUP_MS);
    await resetProbe(); // drop warmup frames too, only steady-state counts
    await page.waitForTimeout(MEASURE_MS);
    const probe = await page.evaluate(() => window.__perfProbe);

    return {
      frameCount: probe.intervals.length,
      interval: summarizeSamples(probe.intervals),
      work: summarizeSamples(probe.work),
    };
  } finally {
    await page.close();
  }
}

function startStaticServer(root) {
  const mime = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".jpg": "image/jpeg", ".png": "image/png", ".bin": "application/octet-stream" };
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
      response.writeHead(404);
      response.end("not found");
    }
  });
  server.listen(0, "127.0.0.1");
  return server;
}

/** A7 verdict: does the flagged (uncapped) run's frame INTERVAL beat the baseline-flags run by a margin that isn't just noise? */
function evaluateA7(results) {
  const pairs = [];
  for (const capped of results.filter((r) => r.mode === "capped")) {
    const uncapped = results.find((r) => r.mode === "uncapped" && r.level === capped.level && r.viewport === capped.viewport);
    if (!uncapped?.interval?.medianMs || !capped.interval?.medianMs) continue;
    const cappedMs = capped.interval.medianMs;
    const uncappedMs = uncapped.interval.medianMs;
    const meaningfullyLower = uncappedMs < cappedMs * A7_RELATIVE_DROP || cappedMs - uncappedMs > A7_ABSOLUTE_DROP_MS;
    pairs.push({ level: capped.level, viewport: capped.viewport, cappedIntervalMedianMs: round(cappedMs, 2), uncappedIntervalMedianMs: round(uncappedMs, 2), meaningfullyLower });
  }
  const confirmed = pairs.length > 0 && pairs.filter((p) => p.meaningfullyLower).length >= Math.ceil(pairs.length / 2);
  return { confirmed, pairs };
}

async function main() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const { chromium } = resolvePlaywright();
  const server = startStaticServer(root);
  await once(server, "listening");
  const port = server.address().port;

  const results = [];
  try {
    for (const mode of ["capped", "uncapped"]) {
      const args = mode === "capped" ? CAPPED_ARGS : UNCAPPED_ARGS;
      console.log(`\n=== ${mode} (args: ${args.join(" ")}) ===`);
      const browser = await chromium.launch({ headless: true, args });
      try {
        for (const viewport of VIEWPORTS) {
          for (const levelKey of LEVEL_ORDER) {
            // One retry: a single transient nav/load timeout under shared-
            // machine CPU contention (observed live) shouldn't fail the
            // whole harness run.
            let measurement;
            try {
              measurement = await measureLevel(browser, port, { width: viewport.width, height: viewport.height }, levelKey);
            } catch (error) {
              console.warn(`${levelKey} @ ${viewport.name} (${mode}): first attempt failed (${error.message.split("\n")[0]}), retrying once...`);
              measurement = await measureLevel(browser, port, { width: viewport.width, height: viewport.height }, levelKey);
            }
            results.push({ level: levelKey, viewport: viewport.name, dimensions: `${viewport.width}x${viewport.height}`, mode, ...measurement });
            console.log(`${levelKey} @ ${viewport.name}: interval median ${measurement.interval.medianMs?.toFixed(2)}ms (fps ${measurement.interval.fps?.toFixed(1)}) | work median ${measurement.work.medianMs?.toFixed(2)}ms, n=${measurement.frameCount}`);
          }
        }
      } finally {
        await browser.close();
      }
    }
  } finally {
    server.close();
  }

  const a7 = evaluateA7(results);
  console.log(`\nA7 (GPU flags produce uncapped frame INTERVALS on this machine): ${a7.confirmed ? "CONFIRMED" : "REFUTED"}`);
  for (const pair of a7.pairs) {
    console.log(`  ${pair.level}/${pair.viewport}: capped=${pair.cappedIntervalMedianMs}ms uncapped=${pair.uncappedIntervalMedianMs}ms meaningfullyLower=${pair.meaningfullyLower}`);
  }
  if (!a7.confirmed) {
    console.log("Falling back to rAF-callback WORK-time instrumentation for the recorded 'uncapped' figure (see file header).");
  }

  const levels = LEVEL_ORDER.flatMap((level) => VIEWPORTS.map((viewport) => {
    const capped = results.find((r) => r.mode === "capped" && r.level === level && r.viewport === viewport.name);
    const uncapped = results.find((r) => r.mode === "uncapped" && r.level === level && r.viewport === viewport.name);
    const uncappedSource = a7.confirmed ? uncapped.interval : uncapped.work;
    return {
      level,
      viewport: viewport.name,
      dimensions: `${viewport.width}x${viewport.height}`,
      capped: {
        medianMs: round(capped.interval.medianMs, 2),
        p95Ms: round(capped.interval.p95Ms, 2),
        fps: round(capped.interval.fps, 1),
        frameCount: capped.frameCount,
        method: "frame interval (vsync-paced)",
      },
      uncapped: {
        medianMs: round(uncappedSource.medianMs, 2),
        p95Ms: round(uncappedSource.p95Ms, 2),
        fps: round(uncappedSource.fps, 1),
        frameCount: uncapped.frameCount,
        method: a7.confirmed
          ? "frame interval (GPU flags disabled vsync/frame-rate-limit)"
          : "rAF callback work time (fallback: A7 refuted on this machine, GPU flags did not uncap the frame interval)",
      },
    };
  }));

  const baseline = {
    baselineCommit: BASELINE_COMMIT,
    capturedAt: new Date().toISOString(),
    a7: { confirmed: a7.confirmed, cappedArgs: CAPPED_ARGS, uncappedArgs: UNCAPPED_ARGS, pairs: a7.pairs },
    warmupMs: WARMUP_MS,
    measureMs: MEASURE_MS,
    levels,
  };

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(baseline, null, 2));
  console.log(`\nWrote uncapped baseline to ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

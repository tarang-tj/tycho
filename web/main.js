// Wires terrain, signal link, rover sim, co-pilot, mission state, scoreboard,
// HUD, and the three.js scene together. Runs the "true present" simulation
// clock, applies delayed commands to the true rover, and renders only the
// delayed telemetry the player is allowed to see. Exposes window.TYCHO,
// including a `debug` surface used by the automated boot probe.
import { loadTerrain } from "./terrain-data.js";
import { createSignalLink } from "./signal.js";
import { createRover, stepRover } from "./rover-sim.js";
import { createScene } from "./scene.js";
import { DEFAULT_GUARDRAILS } from "./copilot.js";
import { createMission, startMission, updateMission, whatHappenedLine, averageDelaySec } from "./mission.js";
import { deriveCopilotDisplay, planVisibleToPlayer } from "./telemetry-view.js";
import { createGenerationGuard, createSingleLoop } from "./async-guards.js";
import { loadScoreboard, saveScoreboard, recordRun, aggregate } from "./scoreboard.js";
import { createHud } from "./hud.js";
import { LEVELS, resolveScenario, resolveDelaySec, resolveDelayLabel, getScenarios } from "./levels.js";
import { updateHudReadout } from "./hud-readout.js";
import { wireControls } from "./controls.js";
import { autopilotStep } from "./sol-sim.js";
import { createDriftModel, DRIFT_PCT } from "./drift.js";
import { runDryRun } from "./dry-run.js";
import { evaluateObjectives } from "./objectives.js";
import { createMarsAutopilot, finalizeMarsLegOutcomes, pickRealRunSeed, DRY_RUN_N, DRY_RUN_BASE_SEED } from "./mars-run.js";

const FIXED_DT = 1 / 60;
const PUBLISHED_URL = "https://tarang-tj.github.io/tycho/";
const TERMINAL_STATUSES = new Set(["won", "tipped", "stalled", "held"]);

const canvas = document.getElementById("sceneCanvas");
const el = {
  fallback: document.getElementById("sceneFallback"),
  terrainBanner: document.getElementById("terrainBanner"),
  noDataLegend: document.getElementById("noDataLegend"),
  delayNote: document.getElementById("delayNote"),
  body: document.getElementById("hudBody"),
  delay: document.getElementById("hudDelay"),
  inFlight: document.getElementById("hudInFlight"),
  telemetryAge: document.getElementById("hudTelemetryAge"),
  speed: document.getElementById("hudSpeed"),
  slope: document.getElementById("hudSlope"),
  goalDist: document.getElementById("hudGoalDist"),
};
const hud = createHud(document.querySelector(".hud"));

let terrain, scene, signal, trueState, visibleState = null;
let simTime = 0;
let currentControl = { throttle: 0, steer: 0 };
let controls = null; // set below by wireControls(); exposes resetIntent()
let currentLevelKey = "lunokhod";
let accumulator = 0;
let mission = createMission("lunokhod", LEVELS.lunokhod);
let lastMissionStatus = mission.status;
let guardrails = { ...DEFAULT_GUARDRAILS };
let autopilot = null; // { path: [{x,y}], index, holdReason } - TRUE (present) state, on the rover
let marsDriftModel = null; // seeded drift model for the REAL Mars run (mars-run.js's pickRealRunSeed), null off Mars
let plannedWaypoints = []; // the sol plan as uplinked, kept separate from the live autopilot path
let scoreboardData = loadScoreboard();
let runMaxSlopeDeg = 0; // this run's peak slope, for objectives.js's slope objective
let lastDryRunSummary = null; // ensemble.js-shaped summary from the plan panel's last "Dry run" press
let plannedPrediction = null; // { arrivalRate, wilson95 } snapshot taken at uplink time, or null if no dry run was done first
let frameCount = 0; // advances every render frame; boot-probed to prove the loop keeps running during an async dry run

// H1: what the player has actually SEEN of the co-pilot's decisions so far,
// tracked so a status-line/hazard-flash event fires exactly once, at the
// moment its telemetry becomes visible - never at the rover's true
// present-time moment (see telemetry-view.js).
let lastVisiblePlanActive = false;
let lastVisibleHoldReason = null;

// H4: a single render/physics loop, and a load-generation guard so a stale
// async terrain load can never apply after a newer level switch started.
const loadGuard = createGenerationGuard();
const runLoop = createSingleLoop(
  (cb) => requestAnimationFrame(cb),
  (id) => cancelAnimationFrame(id),
);

const api = {
  ready: false,
  renderer: "none",
  getTrueState: () => ({ ...trueState, simTime }),
  getVisibleState: () => (visibleState ? { ...visibleState.state, telemetryAge: signal.telemetryAge(simTime) } : null),
  sendCommand: (cmd) => sendCommand(cmd),
  getLevel: () => currentLevelKey,
  getTerrainInfo: () => (terrain ? { synthetic: terrain.synthetic, width: terrain.width, metersPerPixel: terrain.metersPerPixel, spawn: terrain.meta.spawn, goal: terrain.meta.goal } : null),
  switchLevel: (key, opts) => loadLevel(key, opts),
  debug: {
    placeRoverAt(x, y, heading = 0) {
      trueState = createRover({ x, y, heading });
      currentControl = { throttle: 0, steer: 0 }; // a debug teleport should leave the rover stationary
      autopilot = null;
    },
    setGuardrails(partial) { guardrails = { ...guardrails, ...partial }; },
    uplinkPlan(waypoints) { signal?.uplink({ type: "plan", waypoints }, simTime); },
    startMission(scenarioKey) { beginRun(scenarioKey); },
    getMission: () => mission,
    getGuardrails: () => guardrails,
    getAutopilot: () => autopilot,
    sampleSlope(x, y) { return terrain?.slopeDeg(x, y) ?? null; },
    getDelaySec: () => signal?.oneWayDelaySec ?? null,
    // H4: exposed so a Playwright/manual probe can confirm repeated fast
    // level switches never leave more than one active render loop.
    getLiveLoopCount: () => runLoop.getLiveCount(),
    // Flight Rules: exposed so a boot probe can confirm the render loop
    // keeps advancing while an async "Dry run" is in flight off-thread.
    getFrameCount: () => frameCount,
  },
};
window.TYCHO = api;

let pendingDownPulses = []; // sim-time thresholds at which a queued uplink's telemetry round-trip completes

/** Pulse the signal-in-flight visual up now, and queue the matching downlink pulse for when it actually arrives. */
function pulseUplink() {
  if (!signal) return;
  const delaySec = signal.oneWayDelaySec;
  scene?.pulseSignal?.("up", delaySec);
  pendingDownPulses.push(simTime + delaySec);
}

function sendCommand(cmd) {
  if (!signal || mission.status !== "active" || LEVELS[currentLevelKey].mode !== "live") return;
  signal.uplink(cmd, simTime);
  pulseUplink();
  // Micro-feedback so the live delay is FELT the instant a key is pressed,
  // not just visible later as a stale telemetry number: "sent" registers
  // immediately, the arrival time is the real one-way delay. This is
  // Earth-side knowledge (the player just sent it), not a present-time leak.
  hud.setStatusLine(`Sent, arrives in ${signal.oneWayDelaySec.toFixed(1)} s...`);
}

function handleMissionTransition() {
  if (mission.status === lastMissionStatus) return;
  lastMissionStatus = mission.status;
  if (!TERMINAL_STATUSES.has(mission.status)) return;

  const timeSec = (mission.endSimTime ?? simTime) - (mission.startSimTime ?? simTime);
  const copilotOn = LEVELS[currentLevelKey].mode === "plan" && guardrails.hazardMode === "reroute";
  const objectives = evaluateObjectives(currentLevelKey, {
    outcome: mission.outcome, timeSec, maxSlopeDeg: runMaxSlopeDeg, distanceM: mission.distanceTraveledM, copilotOn,
  });
  // Medals: the objective ids this run actually met, so the scoreboard's
  // saved history can show them later without re-deriving anything.
  const medals = objectives.filter((o) => o.met).map((o) => o.id);
  const legOutcomes = currentLevelKey === "mars" ? finalizeMarsLegOutcomes(autopilot, mission.outcome) : null;
  scoreboardData = recordRun(scoreboardData, currentLevelKey, {
    outcome: mission.outcome, timeSec, distanceM: mission.distanceTraveledM, copilotOn,
    predictedArrival: plannedPrediction?.arrivalRate, medals,
  });
  saveScoreboard(scoreboardData);
  hud.updateScoreboard(LEVELS[currentLevelKey].label, aggregate(scoreboardData, currentLevelKey));
  // The reveal: at mission end, show the TRUE (present) rover position
  // alongside whatever delayed telemetry the player was actually steering
  // by, so the gap between "what you saw" and "where it really was" is visible.
  scene?.setTrueRoverVisible?.(true);
  scene?.updateTrueState?.(trueState);
  hud.showEndCard({
    outcome: mission.outcome, timeSec, distanceM: mission.distanceTraveledM,
    whatHappened: whatHappenedLine(mission),
    onRetry: () => beginRun(activeScenarioKey),
    objectives, legOutcomes, predicted: plannedPrediction,
    share: {
      levelLabel: LEVELS[currentLevelKey].label, outcome: mission.outcome, timeSec,
      delaySec: averageDelaySec(mission) || signal?.oneWayDelaySec || null,
      copilotOn, url: PUBLISHED_URL,
    },
  });
}

function tickPhysics(dt) {
  if (!signal || !trueState) return; // no run started yet (still on the mission brief)
  const delivered = signal.pullDeliveredCommands(simTime);
  for (const cmd of delivered) {
    if (cmd.type === "plan") {
      // Flight Rules: the real run drives via sol-sim.js's autopilotStep
      // below, planned with the SAME per-leg planner the dry run uses
      // (mars-run.js), on a fresh seed the dry run never sampled.
      autopilot = createMarsAutopilot({ x: trueState.x, y: trueState.y }, cmd.waypoints, terrain, guardrails);
      marsDriftModel = createDriftModel({ seed: pickRealRunSeed(), driftPct: DRIFT_PCT });
      // No hud.setStatusLine/scene.flashHazard here: those are the rover's
      // own decision, and must reach the player only through telemetry once
      // it becomes visible (see the H1 block below) - firing them here at
      // true present time is exactly the leak the review flagged.
    } else {
      currentControl = cmd;
    }
  }

  // No maxSlopeDeg override on the manual-drive path: rover-sim's own
  // default (the real tip angle) is the physical limit; the co-pilot's
  // lower guardrail only gates autopilotStep's autonomous Mars driving.
  if (autopilot) {
    const step = autopilotStep({ trueState, autopilot, terrain, dt, driftModel: marsDriftModel });
    trueState = step.trueState;
    autopilot = step.autopilot;
  } else {
    trueState = stepRover(trueState, currentControl, terrain, dt);
  }
  runMaxSlopeDeg = Math.max(runMaxSlopeDeg, trueState.slopeDeg);
  scene?.updateTrueState?.(trueState);
  // copilotHold/planActive/autopilotPath ride the SAME delayed telemetry
  // channel as position (C1/H1): the player never learns any of them before
  // the one-way delay has actually elapsed.
  signal.telemetry({ ...trueState, copilotHold: autopilot?.holdReason ?? null, planActive: !!autopilot, autopilotPath: autopilot?.path ?? null }, simTime);
  const visible = signal.visibleTelemetry(simTime);
  if (visible) visibleState = visible;

  mission = updateMission(mission, { visibleTelemetry: visibleState, simTime, terrain, telemetryAgeSec: signal.telemetryAge(simTime) });
  handleMissionTransition();

  // H1: fire the "plan delivered"/HOLD status line and the hazard flash
  // exactly once, at the moment they become visible in telemetry - not at
  // the rover's true present-time delivery moment.
  if (visibleState) {
    const vState = visibleState.state;
    const planNowVisible = planVisibleToPlayer(vState);
    if (planNowVisible && !lastVisiblePlanActive) {
      hud.setStatusLine(vState.copilotHold ?? "Plan delivered; TYCHO is driving it.");
    }
    if (vState.copilotHold && vState.copilotHold !== lastVisibleHoldReason) {
      const mpp = terrain.metersPerPixel;
      scene?.flashHazard?.(vState.x * mpp, vState.y * mpp);
    }
    lastVisiblePlanActive = planNowVisible;
    lastVisibleHoldReason = vState.copilotHold ?? null;
  }

  simTime += dt;

  while (pendingDownPulses.length && pendingDownPulses[0] <= simTime) {
    pendingDownPulses.shift();
    scene?.pulseSignal?.("down", signal.oneWayDelaySec);
  }

  if (scene?.setCopilotState) {
    // "A command is in flight" is Earth-side knowledge, allowed on present
    // time; the hold reason/path are not (see deriveCopilotDisplay).
    const waitingOnSignal = signal.commandsInFlight(simTime) > 0;
    const display = deriveCopilotDisplay(visibleState?.state, waitingOnSignal);
    scene.setCopilotState(display, { units: "px" });
  }
}

function frameBody(nowMs) {
  frameCount += 1;
  if (lastFrameMs == null) lastFrameMs = nowMs;
  const dt = Math.min(0.1, (nowMs - lastFrameMs) / 1000);
  lastFrameMs = nowMs;
  accumulator += dt;
  while (accumulator >= FIXED_DT) {
    tickPhysics(FIXED_DT);
    accumulator -= FIXED_DT;
  }
  if (scene?.available) {
    scene.updateFromVisibleState(visibleState?.state ?? null);
    // Planned waypoints (the uplinked sol plan) and the live autopilot path
    // are shown separately: the plan doesn't disappear once driving starts.
    if (typeof scene.setWaypoints === "function") scene.setWaypoints(plannedWaypoints, { units: "px" });
    scene.render();
  }
  updateHudReadout(el, { level: LEVELS[currentLevelKey], terrain, signal, simTime, visibleState });
}

let lastFrameMs = null;

/** (Re)start the single render/physics loop. A render-loop exception is caught
 * so one bad frame can't freeze the game forever (L4); it's reported once via
 * a small toast and the loop keeps running. */
function startLoop() {
  lastFrameMs = null;
  runLoop.start((nowMs) => {
    try {
      frameBody(nowMs);
    } catch (error) {
      console.error("TYCHO render loop error:", error);
      showErrorToast(error?.message ?? String(error));
    }
  });
}

let toastEl = null;
let toastTimer = null;
function showErrorToast(message) {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.className = "tycho-toast";
    toastEl.setAttribute("role", "status");
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = `TYCHO hit a render error and recovered: ${message}`;
  toastEl.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("visible"), 5000);
}

function resizeCanvas() {
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;
  scene?.resize(rect.width, rect.height);
}

let activeScenarioKey = null;

/** U2: a run still "active" (never reached a real outcome) when the player
 * walks away from it - by switching levels or restarting mid-run - is
 * recorded as "abandoned" rather than silently dropped or counted as a
 * failure. Excluded from success rates (scoreboard.js's aggregate()). */
function recordAbandonedIfActive() {
  if (!mission || mission.status !== "active" || !terrain) return;
  const timeSec = simTime - (mission.startSimTime ?? simTime);
  const copilotOn = LEVELS[currentLevelKey].mode === "plan" && guardrails.hazardMode === "reroute";
  scoreboardData = recordRun(scoreboardData, currentLevelKey, {
    outcome: "abandoned", timeSec, distanceM: mission.distanceTraveledM, copilotOn,
  });
  saveScoreboard(scoreboardData);
  hud.updateScoreboard(LEVELS[currentLevelKey].label, aggregate(scoreboardData, currentLevelKey));
}

/** Begin (or restart) a run: reset physics/signal/mission state, keeping the already-loaded terrain/scene. */
function beginRun(scenarioKey) {
  recordAbandonedIfActive(); // a mid-run restart abandons whatever was active
  const level = LEVELS[currentLevelKey];
  activeScenarioKey = scenarioKey ?? null;
  const delaySec = resolveDelaySec(level, terrain.meta, scenarioKey);

  hud.hideBrief();
  hud.hideEndCard();
  hud.setStatusLine(""); // bug fix: a stale "Sent, arrives in..." line from the PREVIOUS run/level must not linger until a new uplink

  const spawn = terrain.meta.spawn ?? { x: terrain.width / 2, y: terrain.height / 2 };
  trueState = createRover({ x: spawn.x, y: spawn.y, heading: 0 });
  currentControl = { throttle: 0, steer: 0 };
  controls?.resetIntent();
  visibleState = null;
  simTime = 0;
  autopilot = null;
  marsDriftModel = null;
  runMaxSlopeDeg = 0;
  lastDryRunSummary = null;
  plannedPrediction = null;
  plannedWaypoints = [];
  pendingDownPulses = [];
  lastVisiblePlanActive = false;
  lastVisibleHoldReason = null;
  signal = createSignalLink(delaySec);
  guardrails = { ...DEFAULT_GUARDRAILS };
  mission = startMission(createMission(currentLevelKey, level), 0);
  lastMissionStatus = mission.status;
  scene?.setTrueRoverVisible?.(false); // hide the previous run's end-of-mission reveal ghost
  scene?.setWaypoints?.([], { units: "px" });
  scene?.setCopilotState?.({ mode: "", path: [], holdReason: null }, { units: "px" });

  if (level.mode === "plan") {
    const scenario = resolveScenario(scenarioKey);
    el.delayNote.hidden = false;
    el.delayNote.textContent = `Real one-way delay: ${scenario.realMinutes} min. Compressed ${scenario.compression}x for play.`;
    hud.showPlanning({
      terrain, guardrails, delayLabel: el.delayNote.textContent,
      // Flight Rules dry run: N=100 seeded headless sols of the CURRENT
      // plan/guardrails (mars-run.js's DRY_RUN_N; see its header for why),
      // off the main thread when possible (dry-run.js). Re-running after
      // changing a guardrail shows the trade-off, since each press reads
      // the plan panel's live values.
      onDryRun: (waypoints, guardrailValues) => runDryRun({
        terrain, assetKey: level.assetKey, spawn, waypoints, guardrails: guardrailValues,
        N: DRY_RUN_N, baseSeed: DRY_RUN_BASE_SEED, driftPct: DRIFT_PCT,
      }).then((summary) => { lastDryRunSummary = summary; return summary; }),
      onUplink: (waypoints, guardrailValues) => {
        guardrails = guardrailValues;
        plannedWaypoints = waypoints;
        // Snapshot whatever the LAST dry run (against these same guardrails)
        // showed, at the moment the plan actually ships - not re-fetched
        // later, so the end card's predicted-vs-actual line always reflects
        // what the player actually saw before committing.
        plannedPrediction = lastDryRunSummary ? { arrivalRate: lastDryRunSummary.arrivalRate, wilson95: lastDryRunSummary.wilson95 } : null;
        signal.uplink({ type: "plan", waypoints }, simTime);
        pulseUplink();
        if (typeof scene?.setWaypoints === "function") scene.setWaypoints(waypoints, { units: "px" });
        hud.setStatusLine("Plan uplinked. Waiting for the signal to arrive...");
      },
    });
  } else {
    hud.hidePlanning();
    hud.setStatusLine("Drive live: WASD or arrow keys.");
    const relayLabel = resolveDelayLabel(level, terrain.meta);
    if (relayLabel) {
      el.delayNote.hidden = false;
      el.delayNote.textContent = `Relay path: ${relayLabel}. About ${delaySec.toFixed(2)} s one way (approximate model).`;
    } else {
      el.delayNote.hidden = true;
    }
  }
}

/** Fully end/reset whatever run is active for the CURRENT level (M1): called
 * before loading a different level so no stale rover/signal/mission state
 * from the old body can keep ticking against the new terrain. */
function resetRun() {
  trueState = null;
  signal = null;
  visibleState = null;
  autopilot = null;
  marsDriftModel = null;
  plannedWaypoints = [];
  pendingDownPulses = [];
}

async function loadLevel(key, opts = {}) {
  const level = LEVELS[key];
  if (!level) throw new Error(`unknown level "${key}"`);
  if (key !== currentLevelKey) recordAbandonedIfActive(); // U2: leaving a level mid-run abandons it, attributed to the OLD level

  if (key === currentLevelKey && terrain) {
    // Same level already loaded: skip the reload race (and the GPU
    // churn) entirely, just (re)start the run if asked (H4).
    if (opts.autoStart) {
      const scenarios = getScenarios(level);
      beginRun(scenarios?.length ? scenarios[0].key : undefined);
    }
    return;
  }

  // H4: a load-generation token. If a newer loadLevel() call starts before
  // this one's await resolves, this one must drop its result instead of
  // applying it (stale scene/terrain pairing) or touching the render loop.
  const gen = loadGuard.next();
  hud.hidePlanning();
  hud.hideEndCard();
  hud.setStatusLine(""); // bug fix: a switch straight to another level's BRIEF (no run started yet) must not leave the OLD level's "Sent, arrives in..." line up

  const nextTerrain = await loadTerrain(level.assetKey);
  if (!loadGuard.isCurrent(gen)) return; // superseded by a newer level switch meanwhile

  currentLevelKey = key;
  terrain = nextTerrain;
  resetRun(); // M1: end whatever run was active on the previous level/asset
  el.terrainBanner.hidden = !terrain.synthetic;
  el.noDataLegend.hidden = !terrain.hasMask;
  el.delayNote.hidden = true;

  scene?.dispose?.(); // dispose the OLD scene (GPU memory, textures, listeners) before creating a new one
  scene = createScene(canvas, terrain, {
    exaggeration: 1.0,
    albedoUrl: terrain.synthetic ? null : `../assets/${level.assetKey}/albedo.jpg`,
    planet: level.planet,
    landmarkKind: level.landmarkKind,
  });
  el.fallback.hidden = scene.available;
  api.renderer = scene.available ? "webgl" : "none";
  resizeCanvas();

  mission = createMission(key, level);
  lastMissionStatus = mission.status;
  // The mission brief doubles as a persistent objective/scenario overlay: on
  // the title screen's single-step Start, the mission begins immediately
  // (default scenario for plan-mode levels) instead of gating on a second
  // click here; the panel stays up so the player can still read the
  // objective or, on a plan-mode level, restart with a different scenario.
  hud.showBrief(level.briefLines, {
    scenarios: getScenarios(level),
    onStart: (scenarioKey) => beginRun(scenarioKey),
  });
  hud.updateScoreboard(level.label, aggregate(scoreboardData, key));

  for (const btn of document.querySelectorAll(".level-btn")) {
    btn.setAttribute("aria-pressed", String(btn.dataset.level === key));
  }

  api.ready = true;
  startLoop(); // H4: single-loop guaranteed even if this races another loadLevel/visibilitychange resume

  if (opts.autoStart) {
    const scenarios = getScenarios(level);
    beginRun(scenarios?.length ? scenarios[0].key : undefined);
  }
}

controls = wireControls({
  sendCommand,
  loadLevel,
  resizeCanvas,
  isReady: () => api.ready,
  startLoop,
  stopLoop: () => runLoop.stop(),
});

loadLevel("lunokhod").catch((error) => {
  console.error("TYCHO failed to boot:", error);
  el.fallback.hidden = false;
  el.fallback.textContent = `TYCHO failed to start: ${error.message}`;
});

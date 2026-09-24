// Wires terrain, signal link, rover sim, co-pilot, mission state, scoreboard,
// HUD, and the three.js scene together. Runs the "true present" simulation
// clock, applies delayed commands to the true rover, and renders only the
// delayed telemetry the player is allowed to see. Exposes window.TYCHO,
// including a `debug` surface used by the automated boot probe.
import { loadTerrain } from "./terrain-data.js";
import { createSignalLink } from "./signal.js";
import { createRover, stepRover, steerTowardPoint } from "./rover-sim.js";
import { createScene } from "./scene.js";
import { planRoute, DEFAULT_GUARDRAILS } from "./copilot.js";
import { createMission, startMission, updateMission, markPlanUplinked, whatHappenedLine } from "./mission.js";
import { loadScoreboard, saveScoreboard, recordRun, aggregate } from "./scoreboard.js";
import { createHud } from "./hud.js";
import { LEVELS, resolveScenario } from "./levels.js";
import { updateHudReadout } from "./hud-readout.js";
import { wireControls } from "./controls.js";

const FIXED_DT = 1 / 60;
const WAYPOINT_ARRIVE_RADIUS_M = 6;
const TERMINAL_STATUSES = new Set(["won", "tipped", "stalled", "held"]);

const canvas = document.getElementById("sceneCanvas");
const el = {
  fallback: document.getElementById("sceneFallback"),
  terrainBanner: document.getElementById("terrainBanner"),
  noDataLegend: document.getElementById("noDataLegend"),
  marsNote: document.getElementById("marsDelayNote"),
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
let currentLevelKey = "moon";
let rafId = null;
let lastFrameMs = null;
let accumulator = 0;
let mission = createMission("moon");
let lastMissionStatus = mission.status;
let guardrails = { ...DEFAULT_GUARDRAILS };
let autopilot = null; // { path: [{x,y}], index, holdReason }
let plannedWaypoints = []; // the sol plan as uplinked, kept separate from the live autopilot path
let scoreboardData = loadScoreboard();

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
  // immediately, the arrival time is the real one-way delay.
  hud.setStatusLine(`Sent, arrives in ${signal.oneWayDelaySec.toFixed(1)} s...`);
}

function handleMissionTransition() {
  if (mission.status === lastMissionStatus) return;
  lastMissionStatus = mission.status;
  if (!TERMINAL_STATUSES.has(mission.status)) return;

  const timeSec = (mission.endSimTime ?? simTime) - (mission.startSimTime ?? simTime);
  const copilotOn = LEVELS[currentLevelKey].mode === "plan" && guardrails.hazardMode === "reroute";
  scoreboardData = recordRun(scoreboardData, currentLevelKey, {
    outcome: mission.outcome, timeSec, distanceM: mission.distanceTraveledM, copilotOn,
  });
  saveScoreboard(scoreboardData);
  hud.updateScoreboard(currentLevelKey, aggregate(scoreboardData, currentLevelKey));
  // The reveal: at mission end, show the TRUE (present) rover position
  // alongside whatever delayed telemetry the player was actually steering
  // by, so the gap between "what you saw" and "where it really was" is visible.
  scene?.setTrueRoverVisible?.(true);
  scene?.updateTrueState?.(trueState);
  hud.showEndCard({
    outcome: mission.outcome, timeSec, distanceM: mission.distanceTraveledM,
    whatHappened: whatHappenedLine(mission),
    onRetry: () => beginRun(activeScenarioKey),
  });
}

function tickPhysics(dt) {
  if (!signal || !trueState) return; // no run started yet (still on the mission brief)
  const delivered = signal.pullDeliveredCommands(simTime);
  for (const cmd of delivered) {
    if (cmd.type === "plan") {
      const result = planRoute({ x: trueState.x, y: trueState.y }, cmd.waypoints, terrain, guardrails);
      const wasHeld = !!autopilot?.holdReason;
      autopilot = { path: result.path, index: 0, holdReason: result.status === "HOLD" ? result.reason : null };
      mission = markPlanUplinked(mission);
      hud.setStatusLine(result.status === "HOLD" ? result.reason : "Plan delivered; TYCHO is driving it.");
      if (autopilot.holdReason && !wasHeld) {
        const mpp = terrain.metersPerPixel;
        scene?.flashHazard?.(trueState.x * mpp, trueState.y * mpp);
      }
    } else {
      currentControl = cmd;
    }
  }

  let control = currentControl;
  if (autopilot) {
    const target = autopilot.path[autopilot.index];
    if (target) {
      control = steerTowardPoint(trueState, target);
      const distM = Math.hypot(target.x - trueState.x, target.y - trueState.y) * terrain.metersPerPixel;
      if (distM < WAYPOINT_ARRIVE_RADIUS_M) autopilot.index += 1;
    } else {
      control = { throttle: 0, steer: 0 };
    }
  }

  // No maxSlopeDeg override here: rover-sim's own default (a real tip
  // angle measured over a rover-scale baseline, see terrain-data.js) is the
  // physical limit. The co-pilot's guardrail (DEFAULT_GUARDRAILS.maxSlopeDeg,
  // lower) is a separate, more conservative "hold before you'd actually tip"
  // threshold applied only to autonomous Mars driving, not to this physics step.
  trueState = stepRover(trueState, control, terrain, dt);
  scene?.updateTrueState?.(trueState);
  signal.telemetry({ ...trueState, copilotHold: autopilot?.holdReason ?? null }, simTime);
  const visible = signal.visibleTelemetry(simTime);
  if (visible) visibleState = visible;

  mission = updateMission(mission, { visibleTelemetry: visibleState, simTime, terrain, telemetryAgeSec: signal.telemetryAge(simTime) });
  handleMissionTransition();

  simTime += dt;

  while (pendingDownPulses.length && pendingDownPulses[0] <= simTime) {
    pendingDownPulses.shift();
    scene?.pulseSignal?.("down", signal.oneWayDelaySec);
  }

  if (scene?.setCopilotState) {
    const waitingOnSignal = signal.commandsInFlight(simTime) > 0;
    const mode = autopilot?.holdReason ? "hold" : waitingOnSignal ? "waiting" : "";
    scene.setCopilotState({ mode, path: autopilot?.path ?? [], holdReason: autopilot?.holdReason ?? null }, { units: "px" });
  }
}

function frame(nowMs) {
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
  rafId = requestAnimationFrame(frame);
}

function resizeCanvas() {
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;
  scene?.resize(rect.width, rect.height);
}

let activeScenarioKey = null;

/** Begin (or restart) a run: reset physics/signal/mission state, keeping the already-loaded terrain/scene. */
function beginRun(scenarioKey) {
  const level = LEVELS[currentLevelKey];
  activeScenarioKey = scenarioKey ?? null;
  const delaySec = level.mode === "plan"
    ? resolveScenario(level, scenarioKey).realMinutes * 60 / resolveScenario(level, scenarioKey).compression
    : level.delaySec;

  hud.hideBrief();
  hud.hideEndCard();

  const spawn = terrain.meta.spawn ?? { x: terrain.width / 2, y: terrain.height / 2 };
  trueState = createRover({ x: spawn.x, y: spawn.y, heading: 0 });
  currentControl = { throttle: 0, steer: 0 };
  controls?.resetIntent();
  visibleState = null;
  simTime = 0;
  autopilot = null;
  plannedWaypoints = [];
  pendingDownPulses = [];
  signal = createSignalLink(delaySec);
  guardrails = { ...DEFAULT_GUARDRAILS };
  mission = startMission(createMission(currentLevelKey), 0);
  lastMissionStatus = mission.status;
  scene?.setTrueRoverVisible?.(false); // hide the previous run's end-of-mission reveal ghost
  scene?.setWaypoints?.([], { units: "px" });
  scene?.setCopilotState?.({ mode: "", path: [], holdReason: null }, { units: "px" });

  if (level.mode === "plan") {
    const scenario = resolveScenario(level, scenarioKey);
    el.marsNote.hidden = false;
    el.marsNote.textContent = `Real one-way delay: ${scenario.realMinutes} min. Compressed ${scenario.compression}x for play.`;
    hud.showPlanning({
      terrain, guardrails, delayLabel: el.marsNote.textContent,
      onUplink: (waypoints, guardrailValues) => {
        guardrails = guardrailValues;
        plannedWaypoints = waypoints;
        signal.uplink({ type: "plan", waypoints }, simTime);
        pulseUplink();
        if (typeof scene?.setWaypoints === "function") scene.setWaypoints(waypoints, { units: "px" });
        hud.setStatusLine("Plan uplinked. Waiting for the signal to arrive...");
      },
    });
  } else {
    el.marsNote.hidden = true;
    hud.hidePlanning();
    hud.setStatusLine("Drive live: WASD or arrow keys.");
  }
}

async function loadLevel(key, opts = {}) {
  const level = LEVELS[key];
  if (!level) throw new Error(`unknown level "${key}"`);
  currentLevelKey = key;
  cancelAnimationFrame(rafId);
  scene?.dispose?.();
  hud.hidePlanning();
  hud.hideEndCard();

  terrain = await loadTerrain(level.body);
  el.terrainBanner.hidden = !terrain.synthetic;
  el.noDataLegend.hidden = !terrain.hasMask;
  el.marsNote.hidden = true;

  scene = createScene(canvas, terrain, {
    exaggeration: 1.0,
    albedoUrl: terrain.synthetic ? null : `../assets/${level.body}/albedo.jpg`,
    body: level.body,
  });
  el.fallback.hidden = scene.available;
  api.renderer = scene.available ? "webgl" : "none";
  resizeCanvas();

  mission = createMission(key);
  lastMissionStatus = mission.status;
  // The mission brief doubles as a persistent objective/scenario overlay: on
  // the title screen's single-step Start, the mission begins immediately
  // (default scenario for Mars) instead of gating on a second click here;
  // the panel stays up so the player can still read the objective or, on
  // Mars, restart with a different delay scenario.
  hud.showBrief(level.briefLines, {
    scenarios: level.scenarios,
    onStart: (scenarioKey) => beginRun(scenarioKey),
  });
  hud.updateScoreboard(key, aggregate(scoreboardData, key));

  for (const btn of document.querySelectorAll(".level-btn")) {
    btn.setAttribute("aria-pressed", String(btn.dataset.level === key));
  }

  api.ready = true;
  rafId = requestAnimationFrame(frame);

  if (opts.autoStart) {
    const defaultScenario = level.scenarios?.length ? level.scenarios[0].key : undefined;
    beginRun(defaultScenario);
  }
}

controls = wireControls({
  sendCommand,
  loadLevel,
  resizeCanvas,
  frame,
  isReady: () => api.ready,
  getRafId: () => rafId,
  setRafId: (id) => { rafId = id; },
  resetFrameClock: () => { lastFrameMs = null; },
});

loadLevel("moon").catch((error) => {
  console.error("TYCHO failed to boot:", error);
  el.fallback.hidden = false;
  el.fallback.textContent = `TYCHO failed to start: ${error.message}`;
});

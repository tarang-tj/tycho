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

const FIXED_DT = 1 / 60;
const MAX_SLOPE_DEG = 25;
const WAYPOINT_ARRIVE_RADIUS_M = 6;
const TERMINAL_STATUSES = new Set(["won", "tipped", "stalled", "held"]);

const canvas = document.getElementById("sceneCanvas");
const el = {
  fallback: document.getElementById("sceneFallback"),
  terrainBanner: document.getElementById("terrainBanner"),
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
let lastSentControl = { throttle: 0, steer: 0 };
let currentLevelKey = "moon";
let rafId = null;
let lastFrameMs = null;
let accumulator = 0;
let mission = createMission("moon");
let lastMissionStatus = mission.status;
let guardrails = { ...DEFAULT_GUARDRAILS };
let autopilot = null; // { path: [{x,y}], index, holdReason }
let scoreboardData = loadScoreboard();

const api = {
  ready: false,
  renderer: "none",
  getTrueState: () => ({ ...trueState, simTime }),
  getVisibleState: () => (visibleState ? { ...visibleState.state, telemetryAge: signal.telemetryAge(simTime) } : null),
  sendCommand: (cmd) => sendCommand(cmd),
  getLevel: () => currentLevelKey,
  getTerrainInfo: () => (terrain ? { synthetic: terrain.synthetic, width: terrain.width, metersPerPixel: terrain.metersPerPixel, spawn: terrain.meta.spawn, goal: terrain.meta.goal } : null),
  switchLevel: (key) => loadLevel(key),
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

function sendCommand(cmd) {
  if (!signal || mission.status !== "active" || LEVELS[currentLevelKey].mode !== "live") return;
  signal.uplink(cmd, simTime);
}

function distanceToGoal() {
  const goal = terrain?.meta?.goal;
  if (!goal || !visibleState) return null;
  const dx = (visibleState.state.x - goal.x) * terrain.metersPerPixel;
  const dy = (visibleState.state.y - goal.y) * terrain.metersPerPixel;
  return Math.hypot(dx, dy);
}

function updateHud() {
  const level = LEVELS[currentLevelKey];
  el.body.textContent = level.label;
  el.delay.textContent = signal ? `${signal.oneWayDelaySec.toFixed(2)} s` : "--";
  el.inFlight.textContent = String(signal ? signal.commandsInFlight(simTime) : 0);
  const age = signal ? signal.telemetryAge(simTime) : null;
  el.telemetryAge.textContent = age == null ? "no signal yet" : `${age.toFixed(1)} s ago`;
  const vs = visibleState?.state;
  el.speed.textContent = vs ? `${vs.speed.toFixed(2)} m/s` : "--";
  el.slope.textContent = vs ? `${vs.slopeDeg.toFixed(1)}°` : "--";
  const dist = distanceToGoal();
  el.goalDist.textContent = dist == null ? "--" : `${dist.toFixed(0)} m`;
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
      autopilot = { path: result.path, index: 0, holdReason: result.status === "HOLD" ? result.reason : null };
      mission = markPlanUplinked(mission);
      hud.setStatusLine(result.status === "HOLD" ? result.reason : "Plan delivered; TYCHO is driving it.");
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

  trueState = stepRover(trueState, control, terrain, dt, { maxSlopeDeg: MAX_SLOPE_DEG });
  signal.telemetry({ ...trueState, copilotHold: autopilot?.holdReason ?? null }, simTime);
  const visible = signal.visibleTelemetry(simTime);
  if (visible) visibleState = visible;

  mission = updateMission(mission, { visibleTelemetry: visibleState, simTime, terrain, telemetryAgeSec: signal.telemetryAge(simTime) });
  handleMissionTransition();
  simTime += dt;
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
    if (typeof scene.setWaypoints === "function") scene.setWaypoints(autopilot?.path ?? []);
    scene.render();
  }
  updateHud();
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
  lastSentControl = { throttle: 0, steer: 0 };
  visibleState = null;
  simTime = 0;
  autopilot = null;
  signal = createSignalLink(delaySec);
  guardrails = { ...DEFAULT_GUARDRAILS };
  mission = startMission(createMission(currentLevelKey), 0);
  lastMissionStatus = mission.status;

  if (level.mode === "plan") {
    const scenario = resolveScenario(level, scenarioKey);
    el.marsNote.hidden = false;
    el.marsNote.textContent = `Real one-way delay: ${scenario.realMinutes} min. Compressed ${scenario.compression}x for play.`;
    hud.showPlanning({
      terrain, guardrails, delayLabel: el.marsNote.textContent,
      onUplink: (waypoints, guardrailValues) => {
        guardrails = guardrailValues;
        signal.uplink({ type: "plan", waypoints }, simTime);
        if (typeof scene?.setWaypoints === "function") scene.setWaypoints(waypoints);
        hud.setStatusLine("Plan uplinked. Waiting for the signal to arrive...");
      },
    });
  } else {
    el.marsNote.hidden = true;
    hud.hidePlanning();
    hud.setStatusLine("Drive live: WASD or arrow keys.");
  }
}

async function loadLevel(key) {
  const level = LEVELS[key];
  if (!level) throw new Error(`unknown level "${key}"`);
  currentLevelKey = key;
  cancelAnimationFrame(rafId);
  scene?.dispose?.();
  hud.hidePlanning();
  hud.hideEndCard();

  terrain = await loadTerrain(level.body);
  el.terrainBanner.hidden = !terrain.synthetic;
  el.marsNote.hidden = true;

  scene = createScene(canvas, terrain, { exaggeration: 1.0, albedoUrl: terrain.synthetic ? null : `../assets/${level.body}/albedo.jpg` });
  el.fallback.hidden = scene.available;
  api.renderer = scene.available ? "webgl" : "none";
  resizeCanvas();

  mission = createMission(key);
  lastMissionStatus = mission.status;
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
}

// --- Keyboard controls (edge-triggered: a command is sent only when intent changes) ---
const held = new Set();
const KEY_MAP = { w: "forward", arrowup: "forward", s: "back", arrowdown: "back", a: "left", arrowleft: "left", d: "right", arrowright: "right" };

function intentFromHeld() {
  const throttle = (held.has("forward") ? 1 : 0) - (held.has("back") ? 1 : 0);
  const steer = (held.has("right") ? 1 : 0) - (held.has("left") ? 1 : 0);
  return { throttle, steer };
}

function applyIntentChange() {
  const next = intentFromHeld();
  if (next.throttle !== lastSentControl.throttle || next.steer !== lastSentControl.steer) {
    lastSentControl = next;
    sendCommand(next);
  }
}

window.addEventListener("keydown", (event) => {
  const control = KEY_MAP[event.key.toLowerCase()];
  if (!control) return;
  held.add(control);
  applyIntentChange();
});
window.addEventListener("keyup", (event) => {
  const control = KEY_MAP[event.key.toLowerCase()];
  if (!control) return;
  held.delete(control);
  applyIntentChange();
});

// --- Touch pad ---
for (const btn of document.querySelectorAll(".pad-btn")) {
  const control = btn.dataset.control;
  btn.addEventListener("pointerdown", () => { held.add(control); applyIntentChange(); });
  const release = () => { held.delete(control); applyIntentChange(); };
  btn.addEventListener("pointerup", release);
  btn.addEventListener("pointerleave", release);
}

// --- Level select ---
for (const btn of document.querySelectorAll(".level-btn")) {
  btn.addEventListener("click", () => loadLevel(btn.dataset.level));
}

// --- Lifecycle: pause the loop when the tab is hidden ---
window.addEventListener("resize", resizeCanvas);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    cancelAnimationFrame(rafId);
    rafId = null;
  } else if (api.ready && rafId == null) {
    lastFrameMs = null;
    rafId = requestAnimationFrame(frame);
  }
});

loadLevel("moon").catch((error) => {
  console.error("TYCHO failed to boot:", error);
  el.fallback.hidden = false;
  el.fallback.textContent = `TYCHO failed to start: ${error.message}`;
});

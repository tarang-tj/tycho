// Wires terrain, signal link, rover sim, and the three.js scene together.
// Runs the "true present" simulation clock, applies delayed commands to the
// true rover, and renders only the delayed telemetry the player is allowed
// to see. Exposes window.TYCHO for the Playwright boot probe.
import { loadTerrain } from "./terrain-data.js";
import { createSignalLink } from "./signal.js";
import { createRover, stepRover } from "./rover-sim.js";
import { createScene } from "./scene.js";

const FIXED_DT = 1 / 60;
const MAX_SLOPE_DEG = 25;

const LEVELS = {
  moon: { body: "moon", label: "Moon", delaySec: 1.28, exaggeration: 1.0, compressedNote: null },
  mars: {
    body: "mars", label: "Mars", delaySec: 8, exaggeration: 1.0,
    compressedNote: "Mars delay compressed for play; real one-way: 3 to 22 minutes.",
  },
};

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

let terrain, scene, signal, trueState, visibleState = null;
let simTime = 0;
let currentControl = { throttle: 0, steer: 0 };
let lastSentControl = { throttle: 0, steer: 0 };
let currentLevelKey = "moon";
let rafId = null;
let lastFrameMs = null;
let accumulator = 0;

const api = {
  ready: false,
  renderer: "none",
  getTrueState: () => ({ ...trueState, simTime }),
  getVisibleState: () => (visibleState ? { ...visibleState.state, telemetryAge: signal.telemetryAge(simTime) } : null),
  sendCommand: (cmd) => sendCommand(cmd),
  getLevel: () => currentLevelKey,
  getTerrainInfo: () => (terrain ? { synthetic: terrain.synthetic, width: terrain.width, metersPerPixel: terrain.metersPerPixel } : null),
  switchLevel: (key) => loadLevel(key),
};
window.TYCHO = api;

function sendCommand(cmd) {
  if (!signal) return;
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
  el.delay.textContent = `${level.delaySec.toFixed(2)} s`;
  el.inFlight.textContent = String(signal ? signal.commandsInFlight(simTime) : 0);
  const age = signal ? signal.telemetryAge(simTime) : null;
  el.telemetryAge.textContent = age == null ? "no signal yet" : `${age.toFixed(1)} s ago`;
  const vs = visibleState?.state;
  el.speed.textContent = vs ? `${vs.speed.toFixed(2)} m/s` : "—";
  el.slope.textContent = vs ? `${vs.slopeDeg.toFixed(1)}°` : "—";
  const dist = distanceToGoal();
  el.goalDist.textContent = dist == null ? "—" : `${dist.toFixed(0)} m`;
}

function tickPhysics(dt) {
  const delivered = signal.pullDeliveredCommands(simTime);
  if (delivered.length) currentControl = delivered[delivered.length - 1];
  trueState = stepRover(trueState, currentControl, terrain, dt, { maxSlopeDeg: MAX_SLOPE_DEG });
  signal.telemetry({ ...trueState }, simTime);
  const visible = signal.visibleTelemetry(simTime);
  if (visible) visibleState = visible;
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

async function loadLevel(key) {
  const level = LEVELS[key];
  if (!level) throw new Error(`unknown level "${key}"`);
  currentLevelKey = key;
  cancelAnimationFrame(rafId);
  scene?.dispose?.();

  terrain = await loadTerrain(level.body);
  el.terrainBanner.hidden = !terrain.synthetic;
  el.marsNote.hidden = !level.compressedNote;
  if (level.compressedNote) el.marsNote.textContent = level.compressedNote;

  const albedoUrl = terrain.synthetic ? null : `../assets/${level.body}/albedo.jpg`;
  scene = createScene(canvas, terrain, { exaggeration: level.exaggeration, albedoUrl });
  el.fallback.hidden = scene.available;
  api.renderer = scene.available ? "webgl" : "none";
  resizeCanvas();

  const spawn = terrain.meta.spawn ?? { x: terrain.width / 2, y: terrain.height / 2 };
  trueState = createRover({ x: spawn.x, y: spawn.y, heading: 0 });
  currentControl = { throttle: 0, steer: 0 };
  lastSentControl = { throttle: 0, steer: 0 };
  visibleState = null;
  simTime = 0;
  lastFrameMs = null;
  accumulator = 0;
  signal = createSignalLink(level.delaySec);

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

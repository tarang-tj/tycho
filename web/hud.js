// Mission HUD: builds and owns a single #mission-panel container appended
// into the existing side panel. All class names below are the public
// styling contract for the visuals lane:
//   .mission-brief, .mission-brief-lines, .mission-start-btn
//   .mission-plan, .mission-minimap (canvas), .mission-plan-controls
//   .mission-guardrails, .mission-guardrail-row
//   .mission-status-line
//   .mission-endcard, .mission-endcard-outcome, .mission-endcard-line, .mission-retry-btn
//   .mission-scoreboard, .mission-scoreboard-row
// No three.js/DOM-outside-mission-panel dependency; this module never
// touches web/index.html or web/scene.js.
import { drawMinimap, buildGuardrailControls } from "./hud-minimap.js";

const MAX_WAYPOINTS = 5;

/** Create the mission panel DOM inside `hostEl` (the existing .hud side panel). Returns a handle with render functions. */
export function createHud(hostEl) {
  const root = document.createElement("div");
  root.id = "mission-panel";
  hostEl.appendChild(root);

  const brief = document.createElement("div");
  brief.className = "mission-brief";
  brief.hidden = true;
  root.appendChild(brief);

  const plan = document.createElement("div");
  plan.className = "mission-plan";
  plan.hidden = true;
  root.appendChild(plan);

  const statusLine = document.createElement("p");
  statusLine.className = "mission-status-line";
  root.appendChild(statusLine);

  const endcard = document.createElement("div");
  endcard.className = "mission-endcard";
  endcard.hidden = true;
  root.appendChild(endcard);

  const scoreboard = document.createElement("div");
  scoreboard.className = "mission-scoreboard";
  root.appendChild(scoreboard);

  /**
   * Show the pre-mission brief. `opts.scenarios`, if given (Mars), renders
   * one start button per delay scenario instead of a single "Start
   * mission" button; `opts.onStart(scenarioKey | undefined)` fires on click.
   */
  function showBrief(lines, opts) {
    const { onStart, scenarios } = opts;
    endcard.hidden = true;
    plan.hidden = true;
    brief.hidden = false;
    brief.innerHTML = "";
    const linesEl = document.createElement("div");
    linesEl.className = "mission-brief-lines";
    for (const line of lines) {
      const p = document.createElement("p");
      p.textContent = line;
      linesEl.appendChild(p);
    }
    brief.appendChild(linesEl);

    if (scenarios?.length) {
      for (const scenario of scenarios) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "mission-start-btn";
        btn.textContent = `${scenario.label} (real one-way: ${scenario.realMinutes} min)`;
        btn.addEventListener("click", () => onStart(scenario.key));
        brief.appendChild(btn);
      }
    } else {
      const startBtn = document.createElement("button");
      startBtn.type = "button";
      startBtn.className = "mission-start-btn";
      startBtn.textContent = "Start mission";
      startBtn.addEventListener("click", () => onStart());
      brief.appendChild(startBtn);
    }
  }

  function hideBrief() {
    brief.hidden = true;
  }

  /**
   * Render the Mars sol-plan UI: a click-to-place minimap (drawn directly
   * from the terrain elevation grid, independent of the 3D scene) plus
   * guardrail controls and an uplink button.
   */
  function showPlanning(opts) {
    const { terrain, delayLabel, onUplink } = opts;
    plan.hidden = false;
    plan.innerHTML = "";

    if (delayLabel) {
      const note = document.createElement("p");
      note.className = "mission-delay-note";
      note.textContent = delayLabel;
      plan.appendChild(note);
    }

    const canvas = document.createElement("canvas");
    canvas.className = "mission-minimap";
    canvas.width = 220;
    canvas.height = 220;
    plan.appendChild(canvas);
    drawMinimap(canvas, terrain);

    const waypoints = [];
    const help = document.createElement("p");
    help.className = "mission-plan-help";
    help.textContent = `Click the map to place up to ${MAX_WAYPOINTS} waypoints for this sol plan.`;
    plan.appendChild(help);

    canvas.addEventListener("click", (event) => {
      if (waypoints.length >= MAX_WAYPOINTS) return;
      const rect = canvas.getBoundingClientRect();
      const px = ((event.clientX - rect.left) / rect.width) * terrain.width;
      const py = ((event.clientY - rect.top) / rect.height) * terrain.height;
      waypoints.push({ x: px, y: py });
      drawMinimap(canvas, terrain, waypoints);
      help.textContent = `${waypoints.length}/${MAX_WAYPOINTS} waypoints placed.`;
      uplinkBtn.disabled = waypoints.length === 0;
    });

    const controls = document.createElement("div");
    controls.className = "mission-plan-controls";
    plan.appendChild(controls);

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.textContent = "Clear";
    clearBtn.addEventListener("click", () => {
      waypoints.length = 0;
      drawMinimap(canvas, terrain);
      help.textContent = `Click the map to place up to ${MAX_WAYPOINTS} waypoints for this sol plan.`;
      uplinkBtn.disabled = true;
    });
    controls.appendChild(clearBtn);

    const guardrails = document.createElement("div");
    guardrails.className = "mission-guardrails";
    plan.appendChild(guardrails);
    const guardrailValues = buildGuardrailControls(guardrails, opts.guardrails);

    const uplinkBtn = document.createElement("button");
    uplinkBtn.type = "button";
    uplinkBtn.className = "mission-uplink-btn";
    uplinkBtn.textContent = "Uplink plan";
    uplinkBtn.disabled = true;
    uplinkBtn.addEventListener("click", () => {
      if (!waypoints.length) return;
      onUplink([...waypoints], guardrailValues.read());
      uplinkBtn.disabled = true;
      clearBtn.disabled = true;
      canvas.style.pointerEvents = "none";
    });
    controls.appendChild(uplinkBtn);
  }

  function hidePlanning() {
    plan.hidden = true;
  }

  function setStatusLine(text) {
    statusLine.textContent = text ?? "";
  }

  function showEndCard({ outcome, timeSec, distanceM, whatHappened, onRetry }) {
    plan.hidden = true;
    endcard.hidden = false;
    endcard.innerHTML = "";
    const title = document.createElement("p");
    title.className = "mission-endcard-outcome";
    title.textContent = outcomeLabel(outcome);
    endcard.appendChild(title);

    const stats = document.createElement("p");
    stats.className = "mission-endcard-line";
    stats.textContent = `Time ${timeSec.toFixed(1)} s · distance ${distanceM.toFixed(0)} m`;
    endcard.appendChild(stats);

    const honest = document.createElement("p");
    honest.className = "mission-endcard-line";
    honest.textContent = whatHappened;
    endcard.appendChild(honest);

    const retryBtn = document.createElement("button");
    retryBtn.type = "button";
    retryBtn.className = "mission-retry-btn";
    retryBtn.textContent = "Retry";
    retryBtn.addEventListener("click", () => onRetry());
    endcard.appendChild(retryBtn);
  }

  function hideEndCard() {
    endcard.hidden = true;
  }

  function updateScoreboard(levelKey, stats) {
    scoreboard.innerHTML = "";
    const title = document.createElement("p");
    title.className = "mission-scoreboard-title";
    title.textContent = `${levelKey} runs (${sampleNote(stats.n)})`;
    scoreboard.appendChild(title);
    for (const [label, rate, n] of [
      ["overall", stats.successRateAll, stats.n],
      ["with co-pilot", stats.successRateWith, stats.nWith],
      ["without co-pilot", stats.successRateWithout, stats.nWithout],
    ]) {
      const row = document.createElement("p");
      row.className = "mission-scoreboard-row";
      row.textContent = `${label}: ${formatRate(rate)} (n=${n})`;
      scoreboard.appendChild(row);
    }
  }

  return { showBrief, hideBrief, showPlanning, hidePlanning, setStatusLine, showEndCard, hideEndCard, updateScoreboard };
}

function outcomeLabel(outcome) {
  switch (outcome) {
    case "arrived": return "MISSION COMPLETE - arrived";
    case "tipped": return "MISSION FAILED - tipped";
    case "stalled": return "MISSION FAILED - stalled";
    case "held": return "MISSION HELD - co-pilot stopped the rover";
    default: return "MISSION ENDED";
  }
}

function formatRate(rate) {
  return rate == null ? "--" : `${Math.round(rate * 100)}%`;
}

function sampleNote(n) {
  return n < 5 ? `n=${n}, too few runs to trust this rate` : `n=${n}`;
}

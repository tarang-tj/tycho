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
import { renderPlanningPanel } from "./hud-planning.js";
import { copyResultText } from "./hud-clipboard.js";
import { formatShareResult, formatLegGrid } from "./share-result.js";
import { formatPredictedLine, driftLabel } from "./mars-run.js";

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
   * guardrail controls and an uplink button. DOM wiring lives in
   * hud-planning.js (U4: file-size split).
   */
  function showPlanning(opts) {
    plan.hidden = false;
    renderPlanningPanel(plan, opts);
  }

  function hidePlanning() {
    plan.hidden = true;
  }

  function setStatusLine(text) {
    statusLine.textContent = text ?? "";
  }

  function showEndCard({ outcome, timeSec, distanceM, whatHappened, onRetry, share, objectives, legOutcomes, predicted }) {
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

    if (objectives?.length) {
      const list = document.createElement("ul");
      list.className = "mission-endcard-objectives";
      for (const objective of objectives) {
        const item = document.createElement("li");
        item.className = `mission-objective ${objective.met ? "met" : "unmet"}`;
        item.textContent = `${objective.met ? "[x]" : "[ ]"} ${objective.label}`;
        list.appendChild(item);
      }
      endcard.appendChild(list);
    }

    // Flight Rules: the predicted-vs-actual line only exists on Mars, and
    // only when a dry run was done before this plan was uplinked.
    const predictedLine = formatPredictedLine(predicted, outcome);
    if (predictedLine) {
      const p = document.createElement("p");
      p.className = "mission-endcard-predicted";
      p.textContent = predictedLine;
      endcard.appendChild(p);
    }

    const actions = document.createElement("div");
    actions.className = "mission-endcard-actions";
    endcard.appendChild(actions);

    const retryBtn = document.createElement("button");
    retryBtn.type = "button";
    retryBtn.className = "mission-retry-btn";
    retryBtn.textContent = "Retry";
    retryBtn.addEventListener("click", () => onRetry());
    actions.appendChild(retryBtn);

    if (share) {
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "mission-copy-btn";
      copyBtn.textContent = "Copy result";
      // formatShareResult's own output stays byte-identical for existing
      // inputs (regression contract); the leg grid, when present, is
      // appended here by the caller, not baked into that function.
      const grid = legOutcomes?.length ? ` ${formatLegGrid(legOutcomes)}` : "";
      const line = formatShareResult(share) + grid;
      copyBtn.addEventListener("click", () => copyResultText(line, copyBtn));
      actions.appendChild(copyBtn);
    }
  }

  function hideEndCard() {
    endcard.hidden = true;
  }

  /** `levelLabel` is the level's display label (e.g. "Chang'e-4"), not its raw key - L2 fix. */
  function updateScoreboard(levelLabel, stats) {
    scoreboard.innerHTML = "";
    const title = document.createElement("p");
    title.className = "mission-scoreboard-title";
    title.textContent = `${levelLabel} runs (${sampleNote(stats.n, stats.abandonedCount)})`;
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

    // Flight Rules calibration: predicted (dry-run) vs actual arrival rate,
    // over the runs that carried a dry-run prediction at uplink time. Only
    // ever populated on Mars (the only level with a dry run), so this row
    // stays absent on every other level.
    const cal = stats.calibration;
    if (cal?.nPredicted > 0) {
      const row = document.createElement("p");
      row.className = "mission-scoreboard-calibration";
      // Review finding 5: this row is a product of the drift model too, so
      // it carries the same ALWAYS-present drift label the dry-run panel
      // and the end card's predicted line do (mars-run.js's driftLabel, one
      // source of the text).
      row.textContent = `Flight Rules calibration: predicted ${formatRate(cal.meanPredicted)}, actual ${formatRate(cal.actualRate)} (${cal.note}). ${driftLabel()}`;
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

function sampleNote(n, abandonedCount = 0) {
  const abandonedNote = abandonedCount > 0 ? `, ${abandonedCount} abandoned (excluded)` : "";
  return (n < 5 ? `n=${n}, too few runs to trust this rate` : `n=${n}`) + abandonedNote;
}

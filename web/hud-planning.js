// Mars sol-plan UI wiring, split out of hud.js (U4: keep files under ~250
// lines): a click-to-place minimap (drawn directly from the terrain
// elevation grid, independent of the 3D scene) plus guardrail controls, a
// Flight Rules "Dry run" button, and an uplink button, with H5's
// keyboard-playable minimap (arrow keys move a cursor, Enter/Space places,
// Backspace removes, U uplinks).
import { drawMinimap, buildGuardrailControls, snapToGoal } from "./hud-minimap.js";
import { formatDryRunSummary } from "./mars-run.js";

const MAX_WAYPOINTS = 5;
const GOAL_SNAP_PX = 10; // CSS px radius that snaps a click/cursor exactly onto the goal (H3)

/** Render the sol-plan UI into `plan` (an existing, already-visible container element). */
export function renderPlanningPanel(plan, opts) {
  const { terrain, delayLabel, onUplink, onDryRun } = opts;
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
  // Keyboard-playable (H5): the minimap is focusable, and arrow keys move
  // a cursor that Enter/Space places a waypoint at.
  canvas.tabIndex = 0;
  canvas.setAttribute("role", "application");
  canvas.setAttribute("aria-label", "Sol plan minimap. Click to place a waypoint, or focus and use arrow keys to move the cursor, Enter or Space to place, Backspace to remove the last, U to uplink.");
  plan.appendChild(canvas);

  const waypoints = [];
  let dryRunBusy = false; // true while a "Dry run" press is in flight - blocks a second overlapping run, never the render loop
  let cursor = { x: terrain.meta?.spawn?.x ?? terrain.width / 2, y: terrain.meta?.spawn?.y ?? terrain.height / 2 };
  const CURSOR_STEP_PX = terrain.width / 48; // one minimap grid cell per keypress

  const HELP_DEFAULT = `Click the map, or focus it and use arrow keys + Enter/Space to place, Backspace to remove the last, U to uplink. Up to ${MAX_WAYPOINTS} waypoints.`;
  const help = document.createElement("p");
  help.className = "mission-plan-help";
  help.textContent = HELP_DEFAULT;
  plan.appendChild(help);

  function redraw() {
    drawMinimap(canvas, terrain, waypoints, cursor);
  }
  redraw();

  /** Uplink is gated on >=1 waypoint; dry run is gated the same way, PLUS a run already in flight (dryRunBusy). */
  function syncButtons() {
    uplinkBtn.disabled = waypoints.length === 0;
    dryRunBtn.disabled = waypoints.length === 0 || dryRunBusy;
  }

  function placeWaypoint(px, py) {
    if (waypoints.length >= MAX_WAYPOINTS) return;
    const snapped = snapToGoal(px, py, terrain.meta?.goal, terrain, canvas.clientWidth || canvas.width, canvas.clientHeight || canvas.height, GOAL_SNAP_PX);
    waypoints.push(snapped);
    cursor = { ...snapped };
    redraw();
    help.textContent = `${waypoints.length}/${MAX_WAYPOINTS} waypoints placed.`;
    syncButtons();
  }

  canvas.addEventListener("click", (event) => {
    const rect = canvas.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * terrain.width;
    const py = ((event.clientY - rect.top) / rect.height) * terrain.height;
    placeWaypoint(px, py);
  });

  const ARROW_STEP = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
  canvas.addEventListener("keydown", (event) => {
    const step = ARROW_STEP[event.key];
    if (step) {
      event.preventDefault();
      cursor = {
        x: Math.min(terrain.width - 1, Math.max(0, cursor.x + step[0] * CURSOR_STEP_PX)),
        y: Math.min(terrain.height - 1, Math.max(0, cursor.y + step[1] * CURSOR_STEP_PX)),
      };
      redraw();
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      placeWaypoint(cursor.x, cursor.y);
      return;
    }
    if (event.key === "Backspace") {
      event.preventDefault();
      waypoints.pop();
      redraw();
      help.textContent = waypoints.length ? `${waypoints.length}/${MAX_WAYPOINTS} waypoints placed.` : HELP_DEFAULT;
      syncButtons();
      return;
    }
    if (event.key.toLowerCase() === "u" && !uplinkBtn.disabled) {
      event.preventDefault();
      uplinkBtn.click();
    }
  });

  const controls = document.createElement("div");
  controls.className = "mission-plan-controls";
  plan.appendChild(controls);

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.textContent = "Clear";
  clearBtn.addEventListener("click", () => {
    waypoints.length = 0;
    redraw();
    help.textContent = HELP_DEFAULT;
    syncButtons();
  });
  controls.appendChild(clearBtn);

  const guardrails = document.createElement("div");
  guardrails.className = "mission-guardrails";
  plan.appendChild(guardrails);
  const guardrailValues = buildGuardrailControls(guardrails, opts.guardrails);

  // Flight Rules "Dry run": N seeded headless sols of the CURRENT plan +
  // guardrails, read live at press time so re-running after changing a
  // guardrail shows the trade-off (see main.js's onDryRun/dry-run.js).
  const dryRunBtn = document.createElement("button");
  dryRunBtn.type = "button";
  dryRunBtn.className = "mission-dry-run-btn";
  dryRunBtn.textContent = "Dry run";
  dryRunBtn.disabled = true;
  const dryRunResult = document.createElement("div");
  dryRunResult.className = "mission-dry-run-result";
  dryRunResult.hidden = true;
  dryRunBtn.addEventListener("click", () => {
    if (!waypoints.length || dryRunBusy) return;
    dryRunBusy = true;
    syncButtons();
    dryRunBtn.textContent = "Running dry run...";
    onDryRun([...waypoints], guardrailValues.read())
      .then((summary) => {
        const { resultLine, driftLine } = formatDryRunSummary(summary);
        dryRunResult.hidden = false;
        dryRunResult.innerHTML = "";
        for (const line of [resultLine, driftLine]) {
          const p = document.createElement("p");
          p.textContent = line;
          dryRunResult.appendChild(p);
        }
      })
      .catch(() => {
        dryRunResult.hidden = false;
        dryRunResult.textContent = "Dry run failed to complete; try again.";
      })
      .finally(() => {
        dryRunBusy = false;
        dryRunBtn.textContent = "Dry run";
        syncButtons();
      });
  });
  controls.appendChild(dryRunBtn);
  plan.appendChild(dryRunResult);

  const uplinkBtn = document.createElement("button");
  uplinkBtn.type = "button";
  uplinkBtn.className = "mission-uplink-btn";
  uplinkBtn.textContent = "Uplink plan";
  uplinkBtn.disabled = true;
  uplinkBtn.addEventListener("click", () => {
    if (!waypoints.length) return;
    onUplink([...waypoints], guardrailValues.read());
    uplinkBtn.disabled = true;
    dryRunBtn.disabled = true;
    clearBtn.disabled = true;
    canvas.style.pointerEvents = "none";
    canvas.tabIndex = -1;
  });
  controls.appendChild(uplinkBtn);
}

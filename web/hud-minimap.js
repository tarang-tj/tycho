// Canvas-2D top-down minimap + guardrail form controls used by hud.js's
// Mars sol-plan panel. Split out of hud.js purely to keep files under the
// project's ~200-line guideline; still part of the HUD/gameplay lane (no
// three.js dependency, draws directly from the terrain elevation grid so
// waypoint placement never depends on the 3D scene or a raycast hook).

/** Draw a coarse top-down grayscale elevation map with spawn/goal/waypoint markers, and an optional keyboard cursor. */
export function drawMinimap(canvas, terrain, waypoints = [], cursor = null) {
  const ctx = canvas.getContext("2d");
  const grid = 48;
  const img = ctx.createImageData(grid, grid);
  let min = Infinity, max = -Infinity;
  const samples = new Float32Array(grid * grid);
  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      const tx = (gx / (grid - 1)) * (terrain.width - 1);
      const ty = (gy / (grid - 1)) * (terrain.height - 1);
      const e = terrain.elev(tx, ty);
      samples[gy * grid + gx] = e;
      if (e < min) min = e;
      if (e > max) max = e;
    }
  }
  const range = max - min || 1;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.round(((samples[i] - min) / range) * 255);
    img.data[i * 4] = v * 0.75;
    img.data[i * 4 + 1] = v * 0.8;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  const off = document.createElement("canvas");
  off.width = grid;
  off.height = grid;
  off.getContext("2d").putImageData(img, 0, 0);

  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(off, 0, 0, canvas.width, canvas.height);

  const toCanvas = (px, py) => [(px / terrain.width) * canvas.width, (py / terrain.height) * canvas.height];
  drawMarker(ctx, toCanvas(terrain.meta?.spawn?.x ?? 0, terrain.meta?.spawn?.y ?? 0), "#4fa8ff", "S");

  // Goal marker: larger, with an outer ring, so it reads clearly as the
  // target distinct from spawn/waypoints (H3).
  if (terrain.meta?.goal) {
    const goalPos = toCanvas(terrain.meta.goal.x, terrain.meta.goal.y);
    ctx.strokeStyle = "#6fdc7a";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(goalPos[0], goalPos[1], 7, 0, Math.PI * 2);
    ctx.stroke();
    drawMarker(ctx, goalPos, "#6fdc7a", "G");
  }

  ctx.strokeStyle = "#f4c06a";
  ctx.fillStyle = "#f4c06a";
  ctx.beginPath();
  waypoints.forEach((wp, i) => {
    const [x, y] = toCanvas(wp.x, wp.y);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  waypoints.forEach((wp) => {
    const [x, y] = toCanvas(wp.x, wp.y);
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  });

  // Keyboard cursor (H5): a small white crosshair, drawn last so it's
  // always visible over the terrain/markers.
  if (cursor) {
    const [cx, cy] = toCanvas(cursor.x, cursor.y);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - 6, cy);
    ctx.lineTo(cx + 6, cy);
    ctx.moveTo(cx, cy - 6);
    ctx.lineTo(cx, cy + 6);
    ctx.stroke();
  }
}

function drawMarker(ctx, [x, y], color, label) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = "9px sans-serif";
  ctx.fillText(label, x + 5, y - 5);
}

/**
 * If (px, py) in TERRAIN pixel coordinates is within `snapPx` CSS pixels of
 * the goal on a canvas of size canvasWidth x canvasHeight, snap to the
 * goal's exact terrain coordinates instead. Fixes sub-pixel goal misses on
 * coarse minimaps (H3): at typical panel widths one CSS pixel can be tens
 * of meters, so without this a precise click can still land outside the
 * win radius.
 */
export function snapToGoal(px, py, goal, terrain, canvasWidth, canvasHeight, snapPx = 10) {
  if (!goal) return { x: px, y: py };
  const scaleX = canvasWidth / terrain.width;
  const scaleY = canvasHeight / terrain.height;
  const dx = (px - goal.x) * scaleX;
  const dy = (py - goal.y) * scaleY;
  if (Math.hypot(dx, dy) <= snapPx) return { x: goal.x, y: goal.y };
  return { x: px, y: py };
}

/** Build guardrail number/checkbox inputs inside `container`. Returns { read() -> guardrails object }. */
export function buildGuardrailControls(container, defaults = {}) {
  const rows = [
    { key: "maxSlopeDeg", label: "Max slope (°)", value: defaults.maxSlopeDeg ?? 25, min: 5, max: 45 },
    // Max distance: default and range raised so a realistic Mars sol plan
    // (goal ~1.82km from spawn, longer via a routed path) doesn't HOLD on
    // the default (H2); the input's max is also raised so a player can
    // still plan a longer excursion, or lower it for the HOLD demo.
    { key: "maxAutonomousDistanceM", label: "Max autonomous distance (m)", value: defaults.maxAutonomousDistanceM ?? 3000, min: 20, max: 5000 },
    { key: "lookaheadRadiusM", label: "Reroute lookahead (m)", value: defaults.lookaheadRadiusM ?? 60, min: 10, max: 300 },
  ];
  const inputs = {};
  for (const row of rows) {
    const wrap = document.createElement("label");
    wrap.className = "mission-guardrail-row";
    const span = document.createElement("span");
    span.textContent = row.label;
    wrap.appendChild(span);
    const input = document.createElement("input");
    input.type = "number";
    input.min = String(row.min);
    input.max = String(row.max);
    input.value = String(row.value);
    wrap.appendChild(input);
    container.appendChild(wrap);
    inputs[row.key] = input;
  }

  const copilotWrap = document.createElement("label");
  copilotWrap.className = "mission-guardrail-row";
  const copilotSpan = document.createElement("span");
  copilotSpan.textContent = "Co-pilot reroute assist";
  copilotWrap.appendChild(copilotSpan);
  const copilotCheckbox = document.createElement("input");
  copilotCheckbox.type = "checkbox";
  copilotCheckbox.checked = (defaults.hazardMode ?? "reroute") === "reroute";
  copilotWrap.appendChild(copilotCheckbox);
  container.appendChild(copilotWrap);

  /** Clamp a row's value to its documented [min, max] range, falling back to
   * `fallback` if the raw input isn't a finite number (M5), and reflect the
   * clamped value back into the input so the player sees what actually took
   * effect. */
  function clampedValue(row, fallback) {
    let v = Number(inputs[row.key].value);
    if (!Number.isFinite(v)) v = fallback;
    v = Math.min(row.max, Math.max(row.min, v));
    inputs[row.key].value = String(v);
    return v;
  }

  return {
    read: () => ({
      maxSlopeDeg: clampedValue(rows[0], 25),
      maxAutonomousDistanceM: clampedValue(rows[1], 3000),
      lookaheadRadiusM: clampedValue(rows[2], 60),
      hazardMode: copilotCheckbox.checked ? "reroute" : "stop",
    }),
  };
}

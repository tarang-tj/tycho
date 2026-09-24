// Canvas-2D top-down minimap + guardrail form controls used by hud.js's
// Mars sol-plan panel. Split out of hud.js purely to keep files under the
// project's ~200-line guideline; still part of the HUD/gameplay lane (no
// three.js dependency, draws directly from the terrain elevation grid so
// waypoint placement never depends on the 3D scene or a raycast hook).

/** Draw a coarse top-down grayscale elevation map with spawn/goal/waypoint markers. */
export function drawMinimap(canvas, terrain, waypoints = []) {
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
  if (terrain.meta?.goal) drawMarker(ctx, toCanvas(terrain.meta.goal.x, terrain.meta.goal.y), "#6fdc7a", "G");

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
}

function drawMarker(ctx, [x, y], color, label) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = "9px sans-serif";
  ctx.fillText(label, x + 5, y - 5);
}

/** Build guardrail number/checkbox inputs inside `container`. Returns { read() -> guardrails object }. */
export function buildGuardrailControls(container, defaults = {}) {
  const rows = [
    { key: "maxSlopeDeg", label: "Max slope (°)", value: defaults.maxSlopeDeg ?? 25, min: 5, max: 45 },
    { key: "maxAutonomousDistanceM", label: "Max autonomous distance (m)", value: defaults.maxAutonomousDistanceM ?? 300, min: 20, max: 2000 },
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

  return {
    read: () => ({
      maxSlopeDeg: Number(inputs.maxSlopeDeg.value) || 25,
      maxAutonomousDistanceM: Number(inputs.maxAutonomousDistanceM.value) || 300,
      lookaheadRadiusM: Number(inputs.lookaheadRadiusM.value) || 60,
      hazardMode: copilotCheckbox.checked ? "reroute" : "stop",
    }),
  };
}

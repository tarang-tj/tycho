// Procedural textures generated in code (no downloaded images): rover
// paint/foil/solar, lettering, Earth, and soft sprites. Every generator is
// deterministic for a given seed. Regolith detail normal maps live in
// texture-detail.js, and the DataTexture/CanvasTexture/canvas helpers in
// texture-canvas.js (U4: split to keep this file under ~250 lines);
// `makeRegolithDetail` is re-exported here so existing imports keep working.
import { fbm, rng } from "./noise.js";
import { canvasTexture, dataTexture, makeCanvas } from "./texture-canvas.js";

export { makeRegolithDetail } from "./texture-detail.js";

/** White thermal-paint panels: seams, rivets, a little regolith grime low down. */
export function makePanelTexture() {
  const [c, g] = makeCanvas(512, 512);
  const rand = rng(3);
  g.fillStyle = "#e7e4dc";
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 2400; i++) {
    g.fillStyle = `rgba(${rand() > 0.5 ? "255,255,255" : "120,112,100"},${0.03 + rand() * 0.05})`;
    g.fillRect(rand() * 512, rand() * 512, 1 + rand() * 3, 1 + rand() * 3);
  }
  g.strokeStyle = "rgba(90,86,80,0.55)";
  g.lineWidth = 2;
  for (const x of [0, 170, 342, 511]) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 512); g.stroke(); }
  for (const y of [0, 256, 511]) { g.beginPath(); g.moveTo(0, y); g.lineTo(512, y); g.stroke(); }
  g.fillStyle = "rgba(70,66,60,0.6)";
  for (const x of [8, 162, 178, 334, 350, 503]) {
    for (let y = 10; y < 512; y += 24) { g.beginPath(); g.arc(x, y, 1.6, 0, Math.PI * 2); g.fill(); }
  }
  const grime = g.createLinearGradient(0, 300, 0, 512);
  grime.addColorStop(0, "rgba(110,100,88,0)");
  grime.addColorStop(1, "rgba(110,100,88,0.35)");
  g.fillStyle = grime;
  g.fillRect(0, 0, 512, 512);
  return canvasTexture(c);
}

/** Crinkled multi-layer insulation: faceted normal map + gold colour variation. */
export function makeFoilTextures(size = 256) {
  const rand = rng(21);
  const cells = Array.from({ length: 90 }, () => ({
    x: rand() * size, y: rand() * size,
    nx: (rand() - 0.5) * 0.9, ny: (rand() - 0.5) * 0.9, b: 0.75 + rand() * 0.35,
  }));
  const normal = new Uint8Array(size * size * 4);
  const color = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let best = null;
      let bestD = Infinity;
      for (const c of cells) {
        let dx = Math.abs(c.x - x); dx = Math.min(dx, size - dx);
        let dy = Math.abs(c.y - y); dy = Math.min(dy, size - dy);
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = c; }
      }
      const len = Math.hypot(best.nx, best.ny, 1);
      const i = (y * size + x) * 4;
      normal[i] = (best.nx / len * 0.5 + 0.5) * 255;
      normal[i + 1] = (best.ny / len * 0.5 + 0.5) * 255;
      normal[i + 2] = (1 / len * 0.5 + 0.5) * 255;
      normal[i + 3] = 255;
      color[i] = Math.min(255, 222 * best.b);
      color[i + 1] = Math.min(255, 168 * best.b);
      color[i + 2] = Math.min(255, 72 * best.b);
      color[i + 3] = 255;
    }
  }
  return { normal: dataTexture(normal, size), color: dataTexture(color, size, { srgb: true }) };
}

/** Solar array: cells with silver fingers and busbars. */
export function makeSolarTexture() {
  const [c, g] = makeCanvas(512, 512);
  g.fillStyle = "#1b1f27";
  g.fillRect(0, 0, 512, 512);
  const n = 6;
  const cell = 512 / n;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = i * cell + 3;
      const y = j * cell + 3;
      const grad = g.createLinearGradient(x, y, x + cell, y + cell);
      grad.addColorStop(0, "#0f2248");
      grad.addColorStop(1, "#0a1631");
      g.fillStyle = grad;
      g.fillRect(x, y, cell - 6, cell - 6);
      g.fillStyle = "rgba(190,200,215,0.35)";
      for (let k = 6; k < cell - 6; k += 7) g.fillRect(x, y + k, cell - 6, 0.8);
      g.fillStyle = "rgba(210,215,225,0.75)";
      g.fillRect(x + cell * 0.3, y, 2, cell - 6);
      g.fillRect(x + cell * 0.66, y, 2, cell - 6);
    }
  }
  return canvasTexture(c);
}

/** Stencilled lettering on a transparent background. */
export function makeLetteringTexture(text, { color = "#17191d", sub = "" } = {}) {
  const [c, g] = makeCanvas(1024, 256);
  g.clearRect(0, 0, 1024, 256);
  g.fillStyle = color;
  g.textBaseline = "middle";
  g.font = '700 150px "Helvetica Neue", Helvetica, Arial, sans-serif';
  if ("letterSpacing" in g) g.letterSpacing = "26px";
  g.fillText(text, 40, sub ? 110 : 128);
  if (sub) {
    g.font = '500 44px "Helvetica Neue", Helvetica, Arial, sans-serif';
    if ("letterSpacing" in g) g.letterSpacing = "8px";
    g.fillText(sub, 46, 214);
  }
  return canvasTexture(c);
}

/** Earth as seen from the Moon: oceans, cloud bands, polar ice (illustrative, not real geography). */
export function makeEarthTexture() {
  const w = 512;
  const h = 256;
  const [c, g] = makeCanvas(w, h);
  const img = g.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const lat = (y / h - 0.5) * Math.PI;
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const land = fbm(u * 6, (y / h) * 3, { octaves: 5, seed: 41, period: 6 });
      const cloud = fbm(u * 10 + Math.sin(lat * 3) * 0.6, (y / h) * 9, { octaves: 5, seed: 77, period: 10 });
      let r = 14, gg = 42, b = 92;
      if (land > 0.12) { r = 96 + land * 90; gg = 92 + land * 40; b = 60; }
      const polar = Math.abs(lat) > 1.18 ? 1 : 0;
      const cl = Math.max(polar, Math.min(1, Math.max(0, (cloud + Math.cos(lat * 2.2) * 0.18 - 0.05) * 2.4)));
      r = r + (238 - r) * cl; gg = gg + (242 - gg) * cl; b = b + (248 - b) * cl;
      const i = (y * w + x) * 4;
      img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = b; img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return canvasTexture(c);
}

/** Soft round sprite (glows, dust). */
export function makeSoftSprite() {
  const [c, g] = makeCanvas(128, 128);
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.18, "rgba(255,255,255,0.55)");
  grad.addColorStop(0.5, "rgba(255,255,255,0.12)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return canvasTexture(c, { srgb: false });
}

/** Wheel-track imprint: grouser chevrons with soft edges (alpha), tiles along v. */
export function makeTrackTexture() {
  const [c, g] = makeCanvas(64, 128);
  g.clearRect(0, 0, 64, 128);
  const edge = g.createLinearGradient(0, 0, 64, 0);
  edge.addColorStop(0, "rgba(255,255,255,0)");
  edge.addColorStop(0.2, "rgba(255,255,255,0.5)");
  edge.addColorStop(0.8, "rgba(255,255,255,0.5)");
  edge.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = edge;
  g.fillRect(0, 0, 64, 128);
  g.strokeStyle = "rgba(255,255,255,0.95)";
  g.lineWidth = 5;
  for (let y = -16; y < 144; y += 16) {
    g.beginPath(); g.moveTo(6, y + 8); g.lineTo(32, y); g.lineTo(58, y + 8); g.stroke();
  }
  return canvasTexture(c, { srgb: false, repeat: true });
}

/** Speckled rock albedo (grain, small vesicles, lighter veins). */
export function makeRockTexture(body = "moon") {
  const [c, g] = makeCanvas(256, 256);
  const rand = rng(body === "mars" ? 61 : 60);
  g.fillStyle = "#d6d6d6";
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 5000; i++) {
    const v = Math.floor(150 + rand() * 105);
    g.fillStyle = `rgba(${v},${v},${v},${0.25 + rand() * 0.35})`;
    g.fillRect(rand() * 256, rand() * 256, 1 + rand() * 2.5, 1 + rand() * 2.5);
  }
  for (let i = 0; i < 70; i++) {
    g.fillStyle = `rgba(90,90,90,${0.3 + rand() * 0.4})`;
    g.beginPath();
    g.arc(rand() * 256, rand() * 256, 0.8 + rand() * 2, 0, Math.PI * 2);
    g.fill();
  }
  const tex = canvasTexture(c, { repeat: true });
  return tex;
}

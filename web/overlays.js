// In-world overlays: the light-time signal (pulses between the sky and the
// rover's dish), waypoint beacons, the co-pilot's planned path draped on
// the ground, and hazard flashes. All additive, thin, and quiet.
import * as THREE from "three";

const RIBBON_FRAG = /* glsl */ `
uniform vec3 uColor; uniform float uTime; uniform float uOpacity; uniform float uDash; varying vec2 vUv;
void main() {
  float edge = smoothstep(0.0, 0.3, vUv.x) * smoothstep(1.0, 0.7, vUv.x);
  float dash = uDash > 0.0 ? step(0.45, fract(vUv.y / uDash - uTime * 0.7)) : 1.0;
  gl_FragColor = vec4(uColor * uOpacity * edge * mix(0.3, 1.0, dash), 1.0);
}`;
const PILLAR_FRAG = /* glsl */ `
uniform vec3 uColor; uniform float uOpacity; varying vec2 vUv;
void main() { gl_FragColor = vec4(uColor * uOpacity * pow(1.0 - vUv.y, 1.6), 1.0); }`;
const UV_VERT = "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }";

function additive(frag, color, extra = {}) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uTime: { value: 0 }, uOpacity: { value: 1 }, uDash: { value: 0 }, ...extra },
    vertexShader: UV_VERT, fragmentShader: frag,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false,
  });
}

function ribbonGeometry(points, width, groundAt, lift) {
  const dense = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.8));
    for (let k = 0; k < steps; k++) dense.push({ x: a.x + (b.x - a.x) * (k / steps), z: a.z + (b.z - a.z) * (k / steps) });
  }
  if (points.length) dense.push(points[points.length - 1]);
  const pos = [], uv = [], idx = [];
  let d = 0;
  dense.forEach((p, i) => {
    const prev = dense[Math.max(0, i - 1)], next = dense[Math.min(dense.length - 1, i + 1)];
    let dx = next.x - prev.x, dz = next.z - prev.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    if (i > 0) d += Math.hypot(p.x - prev.x, p.z - prev.z);
    const ox = -dz * width / 2, oz = dx * width / 2;
    pos.push(p.x + ox, groundAt(p.x + ox, p.z + oz) + lift, p.z + oz, p.x - ox, groundAt(p.x - ox, p.z - oz) + lift, p.z - oz);
    uv.push(0, d, 1, d);
    if (i < dense.length - 1) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 2, a + 3, a + 1); }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return geo;
}

export function createOverlays({ groundAt, toWorld, accent, sprite }) {
  const group = new THREE.Group();
  const accentColor = new THREE.Color(accent);
  let time = 0;

  // --- Signal ---
  const BEAM_LEN = 900;
  const beamGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, BEAM_LEN, 0)]);
  beamGeo.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 0, 1], 2));
  const beamMat = additive("uniform vec3 uColor; uniform float uOpacity; varying vec2 vUv; void main() { gl_FragColor = vec4(uColor * uOpacity * pow(1.0 - vUv.y, 3.0), 1.0); }", accent);
  beamMat.uniforms.uOpacity.value = 0;
  const beam = new THREE.Line(beamGeo, beamMat);
  beam.frustumCulled = false;
  group.add(beam);
  const pulses = [];
  const spritePool = [];
  function pulseSprite(color) {
    const s = spritePool.pop() || new THREE.Sprite(new THREE.SpriteMaterial({ map: sprite, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false }));
    s.material.color.set(color);
    s.visible = true;
    group.add(s);
    return s;
  }

  // --- Waypoints, path, hazards ---
  const waypointGroup = new THREE.Group();
  const pathMat = additive(RIBBON_FRAG, accent);
  pathMat.uniforms.uDash.value = 1.2;
  pathMat.uniforms.uOpacity.value = 0.42;
  let pathMesh = null;
  const hazards = [];
  group.add(waypointGroup);

  function setWaypoints(points = []) {
    for (const c of [...waypointGroup.children]) { c.geometry.dispose(); c.material.dispose(); waypointGroup.remove(c); }
    const world = points.map((p) => toWorld(p.x, p.y));
    world.forEach((w, i) => {
      const y = groundAt(w.x, w.z);
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.52, 48), additive(PILLAR_FRAG.replace("pow(1.0 - vUv.y, 1.6)", "0.9"), accent));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(w.x, y + 0.05, w.z);
      const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 4, 8, 1, true), additive(PILLAR_FRAG, accent));
      pillar.position.set(w.x, y + 2, w.z);
      pillar.material.uniforms.uOpacity.value = i === 0 ? 1 : 0.55;
      waypointGroup.add(ring, pillar);
    });
    if (world.length > 1) {
      const line = new THREE.Mesh(ribbonGeometry(world, 0.08, groundAt, 0.04), additive(RIBBON_FRAG, accent));
      line.material.uniforms.uOpacity.value = 0.45;
      waypointGroup.add(line);
    }
  }

  function setPath(points = [], mode = "") {
    if (pathMesh) { pathMesh.geometry.dispose(); group.remove(pathMesh); pathMesh = null; }
    if (points.length < 2) return;
    pathMesh = new THREE.Mesh(ribbonGeometry(points.map((p) => toWorld(p.x, p.y)), 0.16, groundAt, 0.04), pathMat);
    pathMat.uniforms.uColor.value.set(mode === "hold" ? 0xff5a4a : accent);
    group.add(pathMesh);
  }

  function flashHazard(xm, ym) {
    const w = toWorld(xm, ym);
    const y = groundAt(w.x, w.z);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 64), additive(PILLAR_FRAG.replace("pow(1.0 - vUv.y, 1.6)", "1.0"), 0xff4a3a));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(w.x, y + 0.08, w.z);
    group.add(ring);
    hazards.push({ ring, t: 0 });
  }

  /** frame: { dishPos (Vector3), skyDir (Vector3), dt } */
  function update(dt, frame) {
    time += dt;
    pathMat.uniforms.uTime.value = time;
    for (const c of waypointGroup.children) if (c.material.uniforms) c.material.uniforms.uTime.value = time;

    beam.position.copy(frame.dishPos);
    beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), frame.skyDir);
    const active = pulses.length > 0;
    beamMat.uniforms.uOpacity.value += ((active ? 0.5 : 0) - beamMat.uniforms.uOpacity.value) * (1 - Math.exp(-4 * dt));
    for (let i = pulses.length - 1; i >= 0; i--) {
      const p = pulses[i];
      p.t += dt;
      const u = Math.min(1, p.t / p.dur);
      const dist = p.dir === "up" ? BEAM_LEN * (1 - u) ** 2.2 : BEAM_LEN * u ** 2.2;
      p.sprite.position.copy(frame.dishPos).addScaledVector(frame.skyDir, dist);
      const arrive = p.dir === "up" && u > 0.97 ? 2.2 : 1;
      p.sprite.scale.setScalar(Math.min(2.2, 0.35 + dist * 0.004) * arrive);
      p.sprite.material.opacity = (p.dir === "up" ? 0.95 : 0.5) * (1 - 0.7 * Math.min(1, dist / BEAM_LEN));
      if (u >= 1) { p.sprite.visible = false; group.remove(p.sprite); spritePool.push(p.sprite); pulses.splice(i, 1); }
    }
    for (let i = hazards.length - 1; i >= 0; i--) {
      const h = hazards[i];
      h.t += dt;
      const u = h.t / 1.4;
      h.ring.scale.setScalar(0.4 + u * 3);
      h.ring.material.uniforms.uOpacity.value = Math.max(0, 1 - u) * (0.6 + 0.4 * Math.sin(h.t * 20));
      if (u >= 1) { h.ring.geometry.dispose(); h.ring.material.dispose(); group.remove(h.ring); hazards.splice(i, 1); }
    }
  }

  // Goal beacon: a faint vertical light column with a glow at the top, so the
  // summit marker reads from hundreds of meters away without a HUD arrow.
  let goal = null;
  function setGoal(xm, ym) {
    if (goal) { group.remove(goal); goal.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); }); goal = null; }
    if (xm == null) return;
    const w = toWorld(xm, ym);
    const y = groundAt(w.x, w.z);
    goal = new THREE.Group();
    const colGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 60, 0)]);
    colGeo.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 0, 1], 2));
    const column = new THREE.Line(colGeo, additive(PILLAR_FRAG, accent));
    column.material.uniforms.uOpacity.value = 0.9;
    const ring = new THREE.Mesh(new THREE.RingGeometry(2.6, 3, 64), additive(PILLAR_FRAG.replace("pow(1.0 - vUv.y, 1.6)", "0.8"), accent));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.1;
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: sprite, color: accentColor, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    glow.scale.setScalar(4);
    glow.position.y = 3;
    goal.add(column, ring, glow);
    goal.position.set(w.x, y, w.z);
    group.add(goal);
  }

  return {
    group, update, setWaypoints, setPath, flashHazard, setGoal,
    pulse(dir, durationSec) {
      pulses.push({ dir: dir === "down" ? "down" : "up", t: 0, dur: Math.max(0.2, durationSec), sprite: pulseSprite(dir === "down" ? 0xdfe8f2 : accentColor) });
    },
    uplinkInFlight: () => pulses.some((p) => p.dir === "up"),
    dispose() { beamGeo.dispose(); beamMat.dispose(); pathMat.dispose(); setWaypoints([]); },
  };
}

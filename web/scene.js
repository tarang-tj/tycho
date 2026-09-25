// three.js renderer for TYCHO. Imported only by main.js.
//
// API returned by createScene(canvas, terrain, { exaggeration, albedoUrl, planet, landmarkKind }):
//   available, rendererType, camera, body
//   updateFromVisibleState(visibleState, trueState?)  last-known telemetry (what the player sees)
//   updateTrueState(trueState)                        feeds the debug/reveal ghost only
//   resize(w, h), render(), dispose()
//   setWaypoints(points)            points: [{x, y}] in meters, DEM frame (x = pixelX * metersPerPixel)
//   setCopilotState({ mode, path, holdReason })   path: [{x, y}] meters; mode "hold" or a holdReason turns the light red
//   flashHazard(xMeters, yMeters)
//   setTrueRoverVisible(bool)       translucent ghost at the TRUE (present) position
//   pulseSignal("up" | "down", durationSec)   uplink command / downlink telemetry pulse
//   skipIntro(), setCameraView("chase" | "peak" | "closeup" | "wide")
// The status light is green (nominal), amber while an uplink pulse is in flight
// or mode is "waiting", red on hold or when telemetry says tipped.
import * as THREE from "three";
import { createSurfaceUniforms, injectSurface } from "./shading.js";
import { createTerrainField } from "./terrain-field.js";
import { bakeSunMask, buildDemGeometry, buildDemNormalTexture, buildRingGeometry, buildSkirtGeometry } from "./terrain-mesh.js";
import { createNearField } from "./near-field.js";
import { createSky, makeEnvironment } from "./sky.js";
import { createRoverModel } from "./rover-model.js";
import { createLandmark, resolveLandmarkHeadingDeg } from "./landmarks.js";
import { createRoverRig } from "./rover-rig.js";
import { createTracks, createDust } from "./ground-fx.js";
import { createOverlays } from "./overlays.js";
import { createCameraRig } from "./camera-rig.js";
import { makeRegolithDetail, makeSoftSprite } from "./textures.js";

const LOOK = {
  moon: {
    ground: 0x8b8a88, rock: 0x8e8c86, track: 0x5c5b59, dust: 0xa09e9a, accent: 0x9fd8ff,
    sunColor: 0xfffaf3, sunI: 3.6, ambient: 0.02, envI: 1, exposure: 1.0, fog: 0,
    detail: 0.75, detailAlbedo: 0.45, hs: 0.18, spread: 0.7, curvR: 1737400,
  },
  mars: {
    ground: 0xb47e58, rock: 0x7d5a45, track: 0x7a5038, dust: 0xc9a07a, accent: 0xffb27a,
    sunColor: 0xffe9d2, sunI: 2.7, ambient: 0, envI: 1.1, exposure: 1.0, fog: 0.00006,
    detail: 1.0, detailAlbedo: 0.5, hs: 0.25, spread: 2.4, curvR: 3389500,
  },
};

// `opts.planet` ("moon" | "mars") is the ONLY thing that drives the
// lighting/material/terrain-shaping look below (LOOK, terrain-field.js,
// textures.js): every level, real site or not, shares that look with its
// planet. Which real-site model (if any) gets placed at the goal is a
// SEPARATE, explicit `opts.landmarkKind` (see web/landmarks.js) - rendering
// never infers either one from the level key or asset directory name.
function resolveBody(opts) {
  return opts.planet === "mars" ? "mars" : "moon";
}

export function createScene(canvas, terrain, opts = {}) {
  const { exaggeration = 1.0, albedoUrl = null } = opts;
  let renderer;
  try {
    // main.js recreates the scene on the same canvas per level; the reused GL
    // context keeps the last texture upload's FLIP_Y state, which makes
    // three's startup texImage3D calls warn. Reset it first.
    const prevGl = canvas.__tychoGl;
    if (prevGl) {
      prevGl.pixelStorei(prevGl.UNPACK_FLIP_Y_WEBGL, false);
      prevGl.pixelStorei(prevGl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    }
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    canvas.__tychoGl = renderer.getContext();
  } catch {
    return { available: false, rendererType: "none" };
  }
  if (!renderer) return { available: false, rendererType: "none" };

  const body = resolveBody(opts);
  const look = LOOK[body];
  const maxPr = Math.min(1.25, window.devicePixelRatio || 1); // ~1080p worth of pixels on a Retina Air
  let pr = maxPr;
  renderer.setPixelRatio(pr);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = look.exposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  const sky = createSky(body);
  scene.add(sky.group);
  if (sky.fogColor) {
    scene.fog = new THREE.FogExp2(sky.fogColor, look.fog);
    scene.background = sky.fogColor.clone();
  }
  const env = makeEnvironment(renderer, body, sky.sunDir);
  scene.environment = env.texture;
  scene.environmentIntensity = look.envI;

  // --- Terrain ---
  const field = createTerrainField(terrain, body, exaggeration);
  const U = createSurfaceUniforms();
  U.uDemOrigin.value.set(field.x0 - field.cell / 2, field.z0 - field.cell / 2);
  U.uDemSize.value.set(field.W * field.cell, field.H * field.cell);
  const detailA = makeRegolithDetail({ body, scale: "fine" });
  const detailB = makeRegolithDetail({ body, scale: "coarse" });
  const detailC = makeRegolithDetail({ body, scale: "mid" });
  U.uDetailC.value = detailC;
  U.uTileC.value = detailC.userData.tileMeters;
  U.uDetailA.value = detailA;
  U.uDetailB.value = detailB;
  U.uTileA.value = detailA.userData.tileMeters;
  U.uTileB.value = detailB.userData.tileMeters;
  U.uDetailStrength.value = look.detail;
  U.uDetailAlbedo.value = look.detailAlbedo;
  U.uHsStrength.value = look.hs;
  U.uCurvR.value = look.curvR;
  const fillData = new Uint8Array(field.fill.length);
  for (let i = 0; i < fillData.length; i++) fillData[i] = field.fill[i] ? 255 : 0;
  const fillTex = new THREE.DataTexture(fillData, field.W, field.H, THREE.RedFormat, THREE.UnsignedByteType);
  fillTex.magFilter = fillTex.minFilter = THREE.LinearFilter;
  fillTex.needsUpdate = true;
  U.uFillMask.value = fillTex;
  // The real no-data mask (from the data pipeline, assets/<body>/mask.bin)
  // is a SEPARATE signal from the render-only "fill" heuristic above: fill
  // suppresses hillshade to avoid stripe artifacts on re-filled DEM edges
  // (terrain that IS real data, just smoothed at the seam); the real mask
  // instead marks terrain that was NEVER measured at all, and must always
  // read as visibly "no orbital data" - see FRAG_ALBEDO in shading.js.
  const realMaskData = new Uint8Array(fillData.length);
  const realMaskTex = new THREE.DataTexture(realMaskData, field.W, field.H, THREE.RedFormat, THREE.UnsignedByteType);
  realMaskTex.magFilter = realMaskTex.minFilter = THREE.LinearFilter;
  realMaskTex.needsUpdate = true;
  U.uRealMask.value = realMaskTex;
  if (albedoUrl && terrain.meta?.maskFile) {
    fetch(albedoUrl.replace(/[^/]+$/, terrain.meta.maskFile)).then((r) => (r.ok ? r.arrayBuffer() : null)).then((buf) => {
      if (!buf || buf.byteLength < realMaskData.length) return;
      const m = new Uint8Array(buf);
      for (let i = 0; i < realMaskData.length; i++) if (m[i]) realMaskData[i] = 255;
      realMaskTex.needsUpdate = true;
    }).catch(() => { /* optional asset */ });
  }
  const sunMask = bakeSunMask(renderer, field, sky.sunDir, look.spread);
  U.uSunMask.value = sunMask.texture;
  U.uHasSunMask.value = 1;
  const demNormalTex = buildDemNormalTexture(field);
  U.uDemNormal.value = demNormalTex;

  const farMat = injectSurface(new THREE.MeshStandardMaterial({ color: look.ground, roughness: 0.97, metalness: 0 }), U, { terrain: true, curve: true, hole: true, demNormal: true });
  const skirtMat = injectSurface(new THREE.MeshStandardMaterial({ color: look.ground, roughness: 1, side: THREE.DoubleSide }), U, { terrain: true, curve: true });
  const far = new THREE.Group();
  const demStep = field.W > 600 ? 2 : 1;
  far.add(new THREE.Mesh(buildDemGeometry(field, demStep), farMat), new THREE.Mesh(buildSkirtGeometry(field, 40, demStep), skirtMat));
  const s1 = Math.max(demStep * 2, Math.round(40 / field.cell));
  const k1 = Math.ceil(6000 / (s1 * field.cell));
  far.add(new THREE.Mesh(buildRingGeometry(field, {
    spacingPx: s1, extentPx: s1 * k1, holeMinX: 0, holeMaxX: field.W - 1, holeMinY: 0, holeMaxY: field.H - 1, innerStepPx: demStep,
  }), farMat));
  const s2 = Math.max(s1 * 4, Math.round(420 / field.cell / s1) * s1);
  far.add(new THREE.Mesh(buildRingGeometry(field, {
    spacingPx: s2, extentPx: Math.ceil(70000 / (s2 * field.cell)) * s2,
    holeMinX: -s1 * k1, holeMaxX: field.W - 1 + s1 * k1, holeMinY: -s1 * k1, holeMaxY: field.H - 1 + s1 * k1, innerStepPx: s1,
  }), farMat));
  for (const m of far.children) m.frustumCulled = false;
  scene.add(far);
  if (albedoUrl) {
    new THREE.TextureLoader().load(albedoUrl, (tex) => {
      tex.colorSpace = THREE.NoColorSpace;
      tex.anisotropy = 8;
      try {
        const c = document.createElement("canvas");
        c.width = c.height = 64;
        const g = c.getContext("2d");
        g.drawImage(tex.image, 0, 0, 64, 64);
        const px = g.getImageData(0, 0, 64, 64).data;
        let sum = 0;
        for (let i = 0; i < px.length; i += 4) sum += px[i + 1];
        U.uHsMean.value = Math.max(0.05, sum / (px.length / 4) / 255);
      } catch { /* keep default mean */ }
      U.uDemAlbedo.value = tex;
      U.uHasDemAlbedo.value = 1;
    }, undefined, () => { /* no albedo asset: detail + lighting carry the look */ });
  }

  const near = createNearField({ field, body, uniforms: U, groundColor: look.ground, rockColor: look.rock });
  const spawnPx = terrain.meta?.spawn ?? { x: terrain.width / 2, y: terrain.height / 2 };
  const spawnW = field.pxToWorld(spawnPx.x, spawnPx.y);
  near.addExclusion(spawnW.x, spawnW.z, 10);
  near.follow(spawnW.x, spawnW.z, true);
  scene.add(near.group);

  // --- Light ---
  const sun = new THREE.DirectionalLight(look.sunColor, look.sunI);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  Object.assign(sun.shadow.camera, { left: -108, right: 108, top: 108, bottom: -108, near: 1, far: 1400 });
  sun.shadow.bias = -0.0002;
  sun.shadow.normalBias = 0.07;
  scene.add(sun, sun.target, new THREE.AmbientLight(0xffffff, look.ambient));

  // --- Rover, ghost, ground effects, overlays ---
  const model = createRoverModel({ uniforms: U });
  const rig = createRoverRig(model);
  const ghost = createRoverModel({ ghost: true });
  const ghostRig = createRoverRig(ghost);
  ghost.root.visible = false;
  scene.add(model.root, ghost.root);
  const sprite = makeSoftSprite();
  const tracks = createTracks({ uniforms: U, color: look.track });
  const dust = createDust({ body, sprite, color: look.dust });
  const mpp = terrain.metersPerPixel;
  const overlays = createOverlays({
    groundAt: near.groundAt, accent: look.accent, sprite,
    toWorld: (xm, ym) => field.pxToWorld(xm / mpp, ym / mpp),
  });
  scene.add(tracks.group, dust.points, overlays.group);
  const goalPx = terrain.meta?.goal;
  if (goalPx) overlays.setGoal(goalPx.x * mpp, goalPx.y * mpp);

  // U1: on levels with a real, still-parked landmark at the goal (Lunokhod,
  // Chang'e-4, Apollo 17 - see opts.landmarkKind/web/levels.js),
  // render an illustrative model there so it's visible on approach, not just
  // a HUD marker (see web/landmarks.js), and a floating label naming it
  // (goalLabel from the asset's own meta.json, never invented here).
  let landmark = null;
  let goalLabelSprite = null;
  if (opts.landmarkKind && goalPx) {
    landmark = createLandmark(opts.landmarkKind);
    const gw = field.pxToWorld(goalPx.x, goalPx.y);
    const groundY = near.groundAt(gw.x, gw.z);
    landmark.root.position.set(gw.x, groundY, gw.z);
    const headingDeg = resolveLandmarkHeadingDeg(terrain.meta);
    landmark.root.rotation.y = (headingDeg * Math.PI) / 180;
    scene.add(landmark.root);

    const labelText = terrain.meta?.goalLabel;
    if (labelText) {
      // Canvas is sized to the MEASURED text width first (a fixed-width
      // canvas clipped the label on an earlier pass - the full string is
      // wider than a naive fixed guess at this font size).
      const measureCanvas = document.createElement("canvas");
      const mg = measureCanvas.getContext("2d");
      mg.font = "600 40px 'IBM Plex Sans Condensed', sans-serif";
      const textW = Math.ceil(mg.measureText(labelText).width);
      const c = document.createElement("canvas");
      c.width = textW + 80; c.height = 96;
      const g = c.getContext("2d");
      g.font = "600 40px 'IBM Plex Sans Condensed', sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillStyle = "rgba(5,6,10,0.6)";
      g.fillRect(10, 14, c.width - 20, 68);
      g.fillStyle = "#e9f4ff";
      g.fillText(labelText, c.width / 2, c.height / 2);
      const labelTex = new THREE.CanvasTexture(c);
      goalLabelSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTex, transparent: true, depthWrite: false }));
      const aspect = c.width / c.height;
      goalLabelSprite.scale.set(1.15 * aspect, 1.15, 1);
      goalLabelSprite.position.set(gw.x, groundY + 4.5, gw.z);
      scene.add(goalLabelSprite);
    }
  }

  const camera = new THREE.PerspectiveCamera(50, canvas.clientWidth / Math.max(1, canvas.clientHeight), 0.08, 160000);
  const camRig = createCameraRig(camera, canvas, { groundAt: near.groundAt, openingDir: body === "moon" ? sky.earthDir : sky.sunDir, body });

  let visible = null;
  let trueState = null;
  let showTrue = false;
  let copilot = { mode: "", path: [], holdReason: "" };
  let lastTime = null;
  let introPending = true;
  let cssW = canvas.clientWidth || 1, cssH = canvas.clientHeight || 1;
  const perf = { frames: 0, sum: 0, lastChange: 0 };
  const v = new THREE.Vector3();
  const roverTarget = new THREE.Vector3();
  const titleOpen = () => document.body.classList.contains("title-open");
  let waypointKey = "";
  let pathKey = "";
  // Points arrive in meters (DEM frame) by contract; { units: "px" } accepts terrain pixels.
  const toMeters = (points, units) => (units === "px" ? points.map((p) => ({ x: p.x * mpp, y: p.y * mpp })) : points);
  function signature(points, units) {
    let sum = 0;
    for (let i = 0; i < points.length; i++) sum += points[i].x * (i + 1) + points[i].y * (i + 7);
    return `${units || "m"}:${points.length}:${sum.toFixed(3)}`;
  }
  const deg = (d) => (d * Math.PI) / 180;

  function status() {
    if (copilot.holdReason || copilot.mode === "hold" || visible?.tipped) return "hold";
    if (overlays.uplinkInFlight() || copilot.mode === "waiting") return "waiting";
    return "nominal";
  }

  const bornAt = performance.now();
  function adaptResolution(dt) {
    if (performance.now() - bornAt < 6000 || titleOpen()) return; // skip shader-compile and terrain-build hitches
    perf.frames += 1;
    perf.sum += dt;
    if (perf.frames < 120) return;
    const avg = perf.sum / perf.frames;
    perf.frames = 0;
    perf.sum = 0;
    perf.slow = avg > 0.021 ? (perf.slow || 0) + 1 : 0;
    if (perf.slow >= 2 && pr > 0.75) {
      perf.slow = 0;
      pr = Math.max(0.75, pr - 0.25);
      renderer.setPixelRatio(pr);
      resize(cssW, cssH);
    }
  }

  function render() {
    if (document.hidden) { lastTime = null; return; }
    const now = performance.now();
    const dt = lastTime == null ? 1 / 60 : Math.min(0.1, (now - lastTime) / 1000);
    lastTime = now;
    adaptResolution(dt);

    const s = visible ?? { x: spawnPx.x, y: spawnPx.y, heading: 0, speed: 0 };
    const w = field.pxToWorld(s.x, s.y);
    if (near.follow(w.x, w.z)) tracks.redrape(near.groundAt);
    const heading = deg(s.heading || 0);
    const speed = s.speed || 0;
    rig.update(dt, { x: w.x, z: w.z, heading, speed, groundAt: near.groundAt, earthDir: sky.earthDir, status: status() });
    roverTarget.set(w.x, model.root.position.y, w.z);

    ghost.root.visible = showTrue && !!trueState;
    if (ghost.root.visible) {
      const tw = field.pxToWorld(trueState.x, trueState.y);
      ghostRig.update(dt, { x: tw.x, z: tw.z, heading: deg(trueState.heading || 0), speed: trueState.speed || 0, groundAt: near.groundAt, earthDir: sky.earthDir });
    }

    if (Math.abs(speed) > 0.01) {
      model.root.updateMatrixWorld();
      const contacts = model.sides.map((side) => { side.wheels[0].wheel.getWorldPosition(v); return { x: v.x, z: v.z }; });
      tracks.add(contacts, near.groundAt);
      for (const side of model.sides) {
        side.wheels[2].wheel.getWorldPosition(v);
        dust.emit(v.x, near.groundAt(v.x, v.z), v.z, heading, speed, dt);
      }
    }
    dust.update(dt, near.groundAt);

    // The shadow box tracks the near-field patch (not the rover) so its edge
    // always lies outside the micro-relief region and never shows as a line.
    const pc = near.center();
    sun.target.position.set(pc.x, roverTarget.y, pc.z);
    sun.position.copy(sun.target.position).addScaledVector(sky.sunDir, 650);

    if (introPending && !titleOpen()) { camRig.snapTo(roverTarget, heading); camRig.startIntro(roverTarget, heading); }
    introPending = false;
    camRig.update(dt, { target: roverTarget, heading, speed, attract: titleOpen() });
    sky.update(camera);
    model.hgaEl.getWorldPosition(v);
    overlays.update(dt, { dishPos: v, skyDir: sky.earthDir });
    renderer.render(scene, camera);
  }

  function resize(width, height) {
    cssW = width; cssH = height;
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
    dust.setViewportHeight(height * pr);
    sky.setPixelRatio(pr);
  }

  function setCameraView(name) {
    // Mars's coarser 20 m/px terrain reads emptier at the same distance, so
    // its chase/closeup views sit closer and lower to keep the rover large.
    const isMars = body === "mars";
    const views = {
      chase: { yawOff: 0, pitch: isMars ? 0.1 : 0.13, dist: isMars ? 4.4 : 5.8 },
      closeup: { yawOff: 2.4, pitch: 0.1, dist: isMars ? 2.3 : 2.9 },
      wide: { yawOff: 0.6, pitch: 0.42, dist: 38 },
      peak: { yawOff: 0, pitch: 0.06, dist: 6.5 },
    };
    if (name === "earth") {
      // Low behind the rover, looking up past its dish at the Earth.
      const e = sky.earthDir;
      const hz = new THREE.Vector3(e.x, 0, e.z).normalize();
      const side = new THREE.Vector3(-hz.z, 0, hz.x);
      camRig.setPose((t) => {
        const px = t.x - hz.x * 6.5 + side.x * 1.6, pz = t.z - hz.z * 6.5 + side.z * 1.6;
        const position = new THREE.Vector3(px, Math.max(t.y + 0.5, near.groundAt(px, pz) + 0.45), pz);
        // Frame from the geometry: the rover near the bottom edge, the Earth
        // (elevation from earthDir) near the top, whatever the local slope.
        const dist = Math.hypot(t.x - px, t.z - pz);
        const roverEl = Math.atan2(t.y + 0.5 - position.y, dist);
        const earthEl = Math.asin(e.y);
        const pad = THREE.MathUtils.degToRad(5);
        const pitch = (roverEl + earthEl) / 2;
        const fov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(earthEl - roverEl + 2 * pad), 50, 95);
        const look = position.clone().addScaledVector(hz, 10 * Math.cos(pitch)).add(new THREE.Vector3(0, 10 * Math.sin(pitch), 0));
        return { position, look, fov };
      });
      return;
    }
    const view = views[name] ?? views.chase;
    if (name === "peak") {
      const hd = deg(visible?.heading || 0);
      const aimAt = goalPx ? field.pxToWorld(goalPx.x, goalPx.y) : field.peak;
      const toPeak = Math.atan2(aimAt.x - roverTarget.x, aimAt.z - roverTarget.z);
      view.yawOff = toPeak - hd;
    }
    camRig.setView(view);
  }

  function dispose() {
    camRig.dispose();
    scene.traverse((o) => {
      o.geometry?.dispose?.();
      const list = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of list) { m.map?.dispose?.(); m.normalMap?.dispose?.(); m.dispose(); }
    });
    for (const t of [detailA, detailB, detailC, fillTex, realMaskTex, demNormalTex, sprite, U.uDemAlbedo.value]) t?.dispose?.();
    landmark?.dispose?.();
    goalLabelSprite?.material?.map?.dispose?.();
    goalLabelSprite?.material?.dispose?.();
    sunMask.dispose();
    env.dispose();
    sky.dispose();
    renderer.dispose();
    if (window.TYCHO_SCENE === api) window.TYCHO_SCENE = null;
  }

  const api = {
    available: true,
    rendererType: "webgl",
    body,
    camera,
    updateFromVisibleState(state, truth) { if (state) visible = state; if (truth) trueState = truth; },
    updateTrueState(state) { trueState = state; },
    resize,
    render,
    dispose,
    setWaypoints(points = [], options = {}) {
      const key = signature(points, options.units);
      if (key === waypointKey) return; // main.js may call this every frame
      waypointKey = key;
      overlays.setWaypoints(toMeters(points, options.units));
    },
    setCopilotState(next = {}, options = {}) {
      const mode = next.holdReason ? "hold" : next.mode || "";
      copilot = { mode: next.mode || "", path: next.path || [], holdReason: next.holdReason || "" };
      const key = signature(copilot.path, options.units) + mode;
      if (key === pathKey) return;
      pathKey = key;
      overlays.setPath(toMeters(copilot.path, options.units), mode);
    },
    flashHazard: (xm, ym) => overlays.flashHazard(xm, ym),
    setTrueRoverVisible(on) { showTrue = !!on; },
    pulseSignal: (dir, durationSec) => overlays.pulse(dir, durationSec),
    skipIntro: () => camRig.skipIntro(),
    setCameraView,
    debugInternals: () => ({ scene, far, near, model, sun, renderer, tracks, dust, overlays, sky, uniforms: U, camRig, field }),
    getStats: () => ({ pixelRatio: pr, body, filledFraction: field.filledFraction, triangles: renderer.info.render.triangles, calls: renderer.info.render.calls }),
  };
  window.TYCHO_SCENE = api;
  return api;
}

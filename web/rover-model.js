// TYCHO, the rover: six wheels on a rocker-bogie, a mast with a two-lens
// face, a status light, a high-gain dish, a solar deck and a finned RTG tail.
// All materials are PBR with procedural textures. Geometry only; the
// articulation lives in rover-rig.js. Units are meters; +z is forward.
import * as THREE from "three";
import { makeLetteringTexture, makeSoftSprite } from "./textures.js";
import { injectSurface } from "./shading.js";
import { DIM, RoundedBoxGeometry, buildMaterials, buildWheel, tube } from "./rover-model-parts.js";

export { DIM };

/** Build TYCHO. Returns the object graph the rig animates. */
export function createRoverModel({ ghost = false, uniforms = null } = {}) {
  const mats = buildMaterials(ghost);
  if (!ghost && uniforms) for (const m of Object.values(mats)) if (m?.isMeshStandardMaterial) injectSurface(m, uniforms, {});
  const root = new THREE.Group();
  root.rotation.order = "YXZ";
  const body = new THREE.Group();
  root.add(body);
  const V = (x, y, z) => new THREE.Vector3(x, y, z);

  // Chassis: white warm-electronics box on a gold MLI skirt, solar deck on top.
  const chassis = new THREE.Mesh(new RoundedBoxGeometry(0.82, 0.3, 1.12, 3, 0.035), mats.paint);
  chassis.position.set(0, 0.66, 0);
  const skirt = new THREE.Mesh(new RoundedBoxGeometry(0.76, 0.12, 1.04, 2, 0.02), mats.foil);
  skirt.position.set(0, 0.5, 0);
  const deckFrame = new THREE.Mesh(new THREE.BoxGeometry(0.98, 0.03, 1.22), [mats.dark, mats.dark, mats.solar, mats.dark, mats.dark, mats.dark]);
  deckFrame.position.set(0, 0.835, -0.02);
  body.add(chassis, skirt, deckFrame);
  for (const x of [-0.3, 0.3]) for (const z of [-0.45, 0.4]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.05, 8), mats.dark);
    post.position.set(x, 0.815, z);
    body.add(post);
  }

  // Hazard cameras on the nose.
  for (const x of [-0.13, 0.13]) {
    const cam = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, 0.03, 16), mats.dark);
    cam.rotation.x = Math.PI / 2;
    cam.position.set(x, 0.57, 0.565);
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.016, 16), mats.glass);
    lens.position.set(x, 0.57, 0.581);
    body.add(cam, lens);
  }

  // RTG tail: slim finned cylinder angled up and back off the rear corner.
  const rtg = new THREE.Group();
  rtg.position.set(0.27, 0.74, -0.68);
  rtg.rotation.set(-0.75, 0, -0.18);
  rtg.add(new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.048, 0.26, 18), mats.dark));
  for (let i = 0; i < 8; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.22, 0.05), mats.dark);
    const a = (i / 8) * Math.PI * 2;
    fin.position.set(Math.cos(a) * 0.07, 0, Math.sin(a) * 0.07);
    fin.rotation.y = -a;
    rtg.add(fin);
  }
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.052, 0.02, 18), mats.alu);
  cap.position.y = 0.14;
  rtg.add(cap);
  const rtgMount = tube(V(0.25, 0.62, -0.55), V(0.27, 0.72, -0.66), 0.018, mats.dark);
  body.add(rtg, rtgMount);

  // Low-gain antenna whip.
  body.add(tube(V(0.3, 0.85, -0.48), V(0.3, 1.18, -0.48), 0.007, mats.alu));
  const lga = new THREE.Mesh(new THREE.SphereGeometry(0.02, 12, 8), mats.paint);
  lga.position.set(0.3, 1.19, -0.48);
  body.add(lga);

  // High-gain dish on a two-axis gimbal; the rig points it at Earth.
  const hgaBase = new THREE.Group();
  hgaBase.position.set(-0.27, 0.85, -0.36);
  hgaBase.add(tube(V(0, 0, 0), V(0, 0.16, 0), 0.02, mats.dark));
  const hgaAz = new THREE.Group();
  hgaAz.position.y = 0.17;
  const hgaEl = new THREE.Group();
  hgaAz.add(hgaEl);
  const pts = [];
  for (let i = 0; i <= 12; i++) { const x = (i / 12) * 0.18; pts.push(new THREE.Vector2(x, (x * x) / 0.4)); }
  const dishMat = ghost ? mats.paint : mats.paint.clone();
  dishMat.side = THREE.DoubleSide;
  if (!ghost && uniforms) injectSurface(dishMat, uniforms, {});
  const dish = new THREE.Mesh(new THREE.LatheGeometry(pts, 36), dishMat);
  dish.rotation.x = Math.PI / 2;
  dish.position.z = 0.02;
  hgaEl.add(dish, tube(V(0, 0, 0.02), V(0, 0, 0.14), 0.008, mats.dark));
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    hgaEl.add(tube(V(Math.cos(a) * 0.17, Math.sin(a) * 0.17, 0.1), V(0, 0, 0.15), 0.004, mats.dark));
  }
  hgaEl.add(tube(V(0, -0.02, 0), V(0, 0.02, 0), 0.03, mats.dark));
  hgaBase.add(hgaAz);
  body.add(hgaBase);

  // Mast and the two-lens face.
  body.add(tube(V(0.22, 0.85, 0.38), V(0.22, 1.36, 0.38), 0.028, mats.paint));
  for (const y of [0.95, 1.2]) {
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.03, 16), mats.dark);
    collar.position.set(0.22, y, 0.38);
    body.add(collar);
  }
  const headYaw = new THREE.Group();
  headYaw.position.set(0.22, 1.38, 0.38);
  const headPitch = new THREE.Group();
  headYaw.add(headPitch);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.045, 0.05, 16), mats.dark);
  const head = new THREE.Mesh(new RoundedBoxGeometry(0.36, 0.15, 0.15, 3, 0.035), mats.paint);
  head.position.y = 0.09;
  headPitch.add(neck, head);
  for (let i = 0; i < 5; i++) {
    const rib = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.008, 0.012), mats.dark);
    rib.position.set(0, 0.05 + i * 0.019, -0.078);
    headPitch.add(rib);
  }
  for (const side of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.02, 18), mats.dark);
    ear.rotation.z = Math.PI / 2;
    ear.position.set(side * 0.19, 0.09, 0);
    headPitch.add(ear);
  }
  const irises = [];
  const brows = [];
  for (const side of [-1, 1]) {
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.062, 0.07, 28), mats.dark);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(side * 0.092, 0.09, 0.09);
    const glass = new THREE.Mesh(new THREE.CircleGeometry(0.05, 28), mats.glass);
    glass.position.set(side * 0.092, 0.09, 0.1255);
    const iris = new THREE.Mesh(new THREE.RingGeometry(0.014, 0.024, 28), mats.lens);
    iris.position.set(side * 0.092, 0.09, 0.127);
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.012, 0.02), mats.dark);
    brow.position.set(side * 0.092, 0.168, 0.11);
    headPitch.add(barrel, glass, iris, brow);
    irises.push(iris);
    brows.push({ mesh: brow, side });
  }
  const statusLight = new THREE.Mesh(new THREE.SphereGeometry(0.02, 16, 10), ghost ? mats.paint : new THREE.MeshBasicMaterial({ color: 0x3dff7a, toneMapped: false }));
  statusLight.position.set(-0.12, 0.175, -0.03);
  headPitch.add(statusLight);
  let statusGlow = null;
  if (!ghost) {
    statusGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeSoftSprite(), color: 0x3dff7a, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    statusGlow.scale.setScalar(0.22);
    statusGlow.position.copy(statusLight.position);
    headPitch.add(statusGlow);
  }
  body.add(headYaw);

  // Lettering on both flanks and the rear (the chase camera sees the rear most).
  if (!ghost) {
    const letters = makeLetteringTexture("TYCHO");
    const letterMat = new THREE.MeshStandardMaterial({ map: letters, transparent: true, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2 });
    if (uniforms) injectSurface(letterMat, uniforms, {});
    const place = (x, z, ry, w) => {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(w, w / 4), letterMat);
      p.position.set(x, 0.66, z);
      p.rotation.y = ry;
      body.add(p);
    };
    place(0.4115, 0.02, Math.PI / 2, 0.66);
    place(-0.4115, 0.02, -Math.PI / 2, 0.66);
    place(-0.06, -0.5615, Math.PI, 0.44);
  }

  // Rocker-bogie, one per side. Rocker pivots on the body; bogie on the rocker.
  const { wheelR: r, xw, zF, zM, zR, bogieRise, pivotZ, pivotY, armX } = DIM;
  const zB = (zM + zR) / 2;
  const sides = [];
  for (const s of [1, -1]) {
    const rocker = new THREE.Group();
    rocker.position.set(s * armX, pivotY, pivotZ);
    body.add(rocker);
    const P = V(0, 0, 0);
    const kneeF = V(0, 0.44 - pivotY, zF - pivotZ);
    const Bp = V(0, r + bogieRise - pivotY, zB - pivotZ);
    rocker.add(tube(P, kneeF, 0.024, mats.dark), tube(P, Bp, 0.024, mats.dark));
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.06, 16), mats.alu);
    hub.rotation.z = Math.PI / 2;
    rocker.add(hub);
    const axle = tube(V(-s * (armX - 0.41), 0, 0), V(0, 0, 0), 0.018, mats.dark);
    rocker.add(axle);

    const makeCorner = (parent, kneeLocal, hubLocal, steerable) => {
      const steer = new THREE.Group();
      steer.position.copy(kneeLocal);
      parent.add(steer);
      const down = hubLocal.clone().sub(kneeLocal);
      steer.add(tube(V(0, 0, 0), V(s * (xw - armX) * 0.6, down.y * 0.5, 0), 0.018, mats.dark));
      steer.add(tube(V(s * (xw - armX) * 0.6, down.y * 0.5, 0), V(s * (xw - armX - DIM.wheelW / 2 - 0.01), down.y, 0), 0.018, mats.dark));
      if (steerable) {
        const act = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.05, 16), mats.paint);
        steer.add(act);
      }
      const wheel = buildWheel(mats);
      const wheelMount = new THREE.Group();
      wheelMount.position.set(s * (xw - armX), down.y, 0);
      if (s < 0) wheelMount.rotation.y = Math.PI;
      wheelMount.add(wheel);
      steer.add(wheelMount);
      return { steer, wheel };
    };
    const front = makeCorner(rocker, kneeF, V(0, r - pivotY, zF - pivotZ), true);

    const bogie = new THREE.Group();
    bogie.position.copy(Bp);
    rocker.add(bogie);
    const kneeM = V(0, 0.36 - (r + bogieRise), zM - zB);
    const kneeR = V(0, 0.42 - (r + bogieRise), zR - zB);
    bogie.add(tube(V(0, 0, 0), kneeM, 0.022, mats.dark), tube(V(0, 0, 0), kneeR, 0.022, mats.dark));
    const mid = makeCorner(bogie, kneeM, V(0, r - (r + bogieRise), zM - zB), false);
    const rear = makeCorner(bogie, kneeR, V(0, r - (r + bogieRise), zR - zB), true);
    sides.push({ s, rocker, bogie, wheels: [front, mid, rear] });
  }

  root.traverse((o) => {
    if (o.isMesh) { o.castShadow = !ghost; o.receiveShadow = !ghost; }
  });

  return {
    root, body, sides, headYaw, headPitch, irises, brows, statusLight, statusGlow, hgaAz, hgaEl, ghost,
    dispose() {
      root.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        const list = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
        for (const m of list) { m.map?.dispose(); m.normalMap?.dispose(); m.dispose(); }
      });
    },
  };
}

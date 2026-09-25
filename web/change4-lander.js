// An illustrative, period-accurate SILHOUETTE of the Chang'e-4 lander: an
// octagonal body on four landing legs, with two solar panels and a small
// antenna mast. Not animated, not the player's TYCHO rover (see
// rover-model.js) - no claim of survey-grade accuracy; see README "What's
// real".
import * as THREE from "three";

const LEG_LEN = 0.62;
const BODY_R = 0.55;
const BODY_H = 0.5;

function buildLeg(mat, angle) {
  const group = new THREE.Group();
  const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, LEG_LEN, 6), mat);
  strut.rotation.z = Math.PI / 5; // splayed outward from the body
  strut.position.y = -LEG_LEN * 0.42;
  group.add(strut);
  const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.04, 10), mat);
  foot.position.y = -LEG_LEN * 0.82;
  group.add(foot);
  group.position.set(Math.cos(angle) * BODY_R * 0.75, BODY_H * 0.15, Math.sin(angle) * BODY_R * 0.75);
  group.rotation.y = -angle;
  return group;
}

/**
 * Build the parked Chang'e-4 lander model. Returns { root, dispose() }.
 * `root`'s local +z is the direction the lander faces; the caller
 * (scene.js/landmarks.js) applies the world-frame heading.
 */
export function createChange4Lander() {
  const gold = new THREE.MeshStandardMaterial({ color: 0xc9a24a, metalness: 0.4, roughness: 0.5 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2b2c30, metalness: 0.5, roughness: 0.55 });
  const panelMat = new THREE.MeshStandardMaterial({ color: 0x18202c, metalness: 0.6, roughness: 0.35 });

  const root = new THREE.Group();

  // Octagonal body (an 8-sided drum), gold-foil colored.
  const body = new THREE.Mesh(new THREE.CylinderGeometry(BODY_R, BODY_R, BODY_H, 8), gold);
  body.position.y = BODY_H / 2 + LEG_LEN * 0.82;
  root.add(body);

  // Four splayed landing legs (Chang'e-4/Chang'e-3 heritage design has four).
  for (let i = 0; i < 4; i++) {
    const leg = buildLeg(dark, (i / 4) * Math.PI * 2 + Math.PI / 4);
    leg.position.y += LEG_LEN * 0.82;
    root.add(leg);
  }

  // Two solar panels, angled outward from opposite sides.
  for (const side of [-1, 1]) {
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.02, 0.5), panelMat);
    panel.position.set(side * (BODY_R + 0.42), BODY_H + LEG_LEN * 0.82, 0);
    panel.rotation.z = side * 0.15;
    root.add(panel);
  }

  // Antenna mast (relay link to the Queqiao satellite).
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.5, 6), dark);
  mast.position.set(0, BODY_H * 1.5 + LEG_LEN * 0.82, 0.2);
  root.add(mast);
  const dish = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2), dark);
  dish.position.set(0, BODY_H * 1.5 + LEG_LEN * 0.82 + 0.25, 0.2);
  dish.rotation.x = Math.PI;
  root.add(dish);

  root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  return {
    root,
    dispose() {
      root.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose?.();
      });
    },
  };
}

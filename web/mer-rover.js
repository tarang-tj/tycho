// An illustrative SILHOUETTE of a MER-class rover (Spirit/Opportunity):
// a boxy warm-electronics box on six wheels (rocker-bogie suspension,
// simplified), a fold-out solar "wing" array, and a mast with the
// panoramic-camera head and high-gain antenna. Not animated, not the
// player's TYCHO rover (see rover-model.js) - no claim of survey-grade
// accuracy; see README "What's real".
import * as THREE from "three";

const WHEEL_R = 0.13;
const WHEEL_W = 0.09;
const BODY_W = 0.62;
const BODY_H = 0.34;
const BODY_D = 0.5;

function buildWheel(mat) {
  const geo = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, WHEEL_W, 16);
  geo.rotateZ(Math.PI / 2);
  return new THREE.Mesh(geo, mat);
}

/**
 * Build a MER-class rover model (used for Opportunity). Returns
 * { root, dispose() }. `root`'s local +z is the direction the rover faces;
 * the caller (scene.js/landmarks.js) applies the world-frame heading.
 */
export function createMerRover() {
  const dark = new THREE.MeshStandardMaterial({ color: 0x2b2c30, metalness: 0.5, roughness: 0.55 });
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xcfa15a, metalness: 0.15, roughness: 0.7 });
  const panelMat = new THREE.MeshStandardMaterial({ color: 0x18202c, metalness: 0.6, roughness: 0.35 });

  const root = new THREE.Group();
  const deckY = WHEEL_R * 1.6;

  const body = new THREE.Mesh(new THREE.BoxGeometry(BODY_W, BODY_H, BODY_D), bodyMat);
  body.position.y = deckY + BODY_H / 2;
  root.add(body);

  // Fold-out solar "wing" array, tilted outward from either side of the deck.
  for (const side of [-1, 1]) {
    const wing = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.02, 0.42), panelMat);
    wing.position.set(side * (BODY_W / 2 + 0.26), deckY + BODY_H + 0.02, 0);
    wing.rotation.z = side * 0.08;
    root.add(wing);
  }

  // Six wheels, three per side (rocker-bogie geometry simplified to fixed offsets).
  const wheelZ = [BODY_D / 2 - 0.02, 0, -(BODY_D / 2 - 0.02)];
  for (const side of [-1, 1]) {
    for (const z of wheelZ) {
      const wheel = buildWheel(dark);
      wheel.position.set(side * (BODY_W / 2 + 0.05), WHEEL_R, z);
      root.add(wheel);
    }
  }

  // Mast: pancam head + high-gain dish antenna.
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.55, 8), dark);
  mast.position.set(0, deckY + BODY_H + 0.28, 0.1);
  root.add(mast);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.1, 0.16), dark);
  head.position.set(0, deckY + BODY_H + 0.58, 0.1);
  root.add(head);
  const dish = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.02, 16), dark);
  dish.position.set(0.2, deckY + BODY_H + 0.15, -0.1);
  dish.rotation.x = Math.PI / 2.4;
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

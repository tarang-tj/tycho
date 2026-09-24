// A static, illustrative model of the real Lunokhod 2 rover, parked at its
// real surveyed position (25.830N, 30.914E, Le Monnier crater) since 1973.
// Not animated, not the player's TYCHO rover (see rover-model.js) - this is
// period-accurate SILHOUETTE only: a tub-shaped body on eight independently
// sprung wheels, a flat lid raised open on its hinge, and a whip antenna.
// No claim of survey-grade accuracy is made; see README "What's real".
import * as THREE from "three";

const WHEEL_R = 0.17;
const WHEEL_W = 0.1;

function buildWheel(mat) {
  const geo = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, WHEEL_W, 20);
  geo.rotateZ(Math.PI / 2);
  return new THREE.Mesh(geo, mat);
}

/**
 * Build the parked Lunokhod 2 model. Returns { root, dispose() }. `root`'s
 * local +z is the direction the historic rover faces (southeast); the
 * caller (scene.js) is responsible for the world-frame heading rotation.
 */
export function createParkedLunokhod() {
  const dark = new THREE.MeshStandardMaterial({ color: 0x2b2c30, metalness: 0.5, roughness: 0.55 });
  const tubMat = new THREE.MeshStandardMaterial({ color: 0xb7b2a4, metalness: 0.15, roughness: 0.75 });
  const lidMat = new THREE.MeshStandardMaterial({ color: 0x8f8a7c, metalness: 0.2, roughness: 0.6, side: THREE.DoubleSide });

  const root = new THREE.Group();

  // Tub-shaped magnesium body (a shallow drum, wider than tall) on eight wheels.
  const tub = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.6, 0.42, 16), tubMat);
  tub.position.y = 0.42;
  root.add(tub);

  // Lid, hinged at the rear edge and left open (LROC post 699: "parked with
  // the lid still open") - the solar-cell-lined underside would face up.
  const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.58, 0.58, 0.03, 16, 1, false, 0, Math.PI), lidMat);
  const hinge = new THREE.Group();
  hinge.position.set(0, 0.63, -0.55);
  hinge.rotation.x = -Math.PI * 0.62; // raised open, leaning back
  lid.rotation.x = Math.PI / 2;
  lid.position.z = 0.58;
  hinge.add(lid);
  root.add(hinge);

  // Eight wheels, four per side, on stub axles.
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const z = 0.42 - i * 0.28;
      const wheel = buildWheel(dark);
      wheel.position.set(side * 0.62, WHEEL_R, z);
      root.add(wheel);
      const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.14, 8), dark);
      axle.rotation.z = Math.PI / 2;
      axle.position.set(side * 0.55, WHEEL_R + 0.03, z);
      root.add(axle);
    }
  }

  // Whip antenna off the front-left of the tub.
  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.85, 6), dark);
  antenna.position.set(-0.3, 0.95, 0.35);
  antenna.rotation.z = 0.12;
  root.add(antenna);

  // Small mast-mounted camera housing, roughly where Lunokhod 2's own
  // panoramic telephotometers sat.
  const cam = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.16), dark);
  cam.position.set(0.18, 0.72, 0.3);
  root.add(cam);

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

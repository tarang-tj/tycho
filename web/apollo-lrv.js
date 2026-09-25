// An illustrative SILHOUETTE of the Apollo Lunar Roving Vehicle: an open
// tubular frame on four mesh-wire wheels, two seats, and a high-gain dish
// antenna on an umbrella mount. Not animated, not the player's TYCHO rover
// (see rover-model.js) - no claim of survey-grade accuracy; see README
// "What's real".
import * as THREE from "three";

const WHEEL_R = 0.2;
const WHEEL_W = 0.14;
const AXLE_TRACK = 0.9;
const WHEELBASE = 0.82;

function buildMeshWheel(mat) {
  const group = new THREE.Group();
  const rim = new THREE.Mesh(new THREE.TorusGeometry(WHEEL_R, 0.02, 6, 16), mat);
  rim.rotation.y = Math.PI / 2;
  group.add(rim);
  // A few spokes stand in for the wire-mesh tread.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const spoke = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, WHEEL_R * 1.9, 4), mat);
    spoke.rotation.z = a;
    group.add(spoke);
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(WHEEL_W / 2, WHEEL_W / 2, 0.04, 8), mat);
  hub.rotation.z = Math.PI / 2;
  group.add(hub);
  return group;
}

/**
 * Build the parked Apollo LRV model. Returns { root, dispose() }. `root`'s
 * local +z is the direction the LRV faces; the caller (scene.js/landmarks.js)
 * applies the world-frame heading.
 */
export function createApolloLrv() {
  const frameMat = new THREE.MeshStandardMaterial({ color: 0xd8d5cc, metalness: 0.3, roughness: 0.6 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2b2c30, metalness: 0.5, roughness: 0.55 });
  const dishMat = new THREE.MeshStandardMaterial({ color: 0xb7b2a4, metalness: 0.2, roughness: 0.5, side: THREE.DoubleSide });

  const root = new THREE.Group();
  const deckY = WHEEL_R + 0.06;

  // Open tubular chassis frame.
  const chassis = new THREE.Mesh(new THREE.BoxGeometry(AXLE_TRACK - 0.1, 0.04, WHEELBASE + 0.1), frameMat);
  chassis.position.y = deckY;
  root.add(chassis);

  // Two seats, side by side, each a simple low box on a stalk.
  for (const side of [-1, 1]) {
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.06, 0.32), frameMat);
    seat.position.set(side * 0.2, deckY + 0.22, 0.1);
    root.add(seat);
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.3, 0.04), frameMat);
    back.position.set(side * 0.2, deckY + 0.4, -0.06);
    back.rotation.x = -0.25;
    root.add(back);
  }

  // Four wire-mesh wheels.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const wheel = buildMeshWheel(dark);
      wheel.position.set(sx * AXLE_TRACK / 2, WHEEL_R, sz * WHEELBASE / 2);
      root.add(wheel);
    }
  }

  // High-gain dish antenna on its umbrella mount, front-mounted.
  const mount = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.4, 6), dark);
  mount.position.set(-0.25, deckY + 0.4, WHEELBASE / 2 + 0.05);
  root.add(mount);
  const dish = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2.2), dishMat);
  dish.position.set(-0.25, deckY + 0.62, WHEELBASE / 2 + 0.05);
  dish.rotation.x = Math.PI * 0.85;
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

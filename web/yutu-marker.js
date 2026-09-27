// A plain MARKER (not a rover model) for the Yutu rover's surveyed final
// position on the Chang'e 3 level: a small box on the ground plus a thin
// pole with a bright cap so it can be spotted from the lander. Placed by
// scene.js from assets/change3/meta.json's yutuPixel1024, which
// tools/sites/change3.py projected from LROC post 938's Yutu coordinate
// (44.1208N 340.4878E, 12.9 m uncertainty; https://lroc.im-ldi.com/images/938).
// Its shape claims nothing about what Yutu looks like.
import * as THREE from "three";

/** Build the Yutu position marker. Returns { root, dispose() }. */
export function createYutuMarker() {
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xbfae78, metalness: 0.3, roughness: 0.6 });
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x2b2c30, metalness: 0.4, roughness: 0.6 });
  const capMat = new THREE.MeshStandardMaterial({ color: 0xffc36b, emissive: 0x6a4a10, roughness: 0.5 });
  const root = new THREE.Group();

  const box = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.5, 1.2), bodyMat);
  box.position.y = 0.45;
  root.add(box);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 2.4, 6), poleMat);
  pole.position.y = 1.9;
  root.add(pole);
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), capMat);
  cap.position.y = 3.15;
  root.add(cap);

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

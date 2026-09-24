// Small reusable geometry/material builders for TYCHO's rover model, split
// out of rover-model.js (U4: keep files under ~250 lines): a generic tube
// mesh between two points, the rocker-bogie dimension constants, the
// per-material set (real vs. translucent "ghost"), and the wheel builder.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { makeFoilTextures, makePanelTexture, makeSolarTexture } from "./textures.js";
import { injectSurface } from "./shading.js";

export const DIM = {
  wheelR: 0.2, wheelW: 0.16, xw: 0.6,
  zF: 0.6, zM: 0.0, zR: -0.56,
  bogieRise: 0.17, pivotZ: 0.1, pivotY: 0.58, armX: 0.5,
};

export function tube(a, b, radius, mat) {
  const len = a.distanceTo(b);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, 10), mat);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  return m;
}

export function buildMaterials(ghost) {
  if (ghost) {
    const g = new THREE.MeshBasicMaterial({ color: 0xa8e6ff, transparent: true, opacity: 0.2, depthWrite: false });
    return { paint: g, foil: g, dark: g, alu: g, solar: g, glass: g, lens: g, ghost: true };
  }
  const foil = makeFoilTextures();
  return {
    paint: new THREE.MeshStandardMaterial({ map: makePanelTexture(), roughness: 0.55, metalness: 0.05 }),
    foil: new THREE.MeshStandardMaterial({ map: foil.color, normalMap: foil.normal, normalScale: new THREE.Vector2(0.7, 0.7), metalness: 1, roughness: 0.28 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x2e3238, metalness: 0.75, roughness: 0.38 }),
    alu: new THREE.MeshStandardMaterial({ color: 0xb9bdc2, metalness: 0.55, roughness: 0.42 }),
    solar: new THREE.MeshPhysicalMaterial({ map: makeSolarTexture(), metalness: 0.3, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.08 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x05070b, metalness: 0.2, roughness: 0.05, clearcoat: 1, clearcoatRoughness: 0.02 }),
    lens: new THREE.MeshBasicMaterial({ color: 0x6cc8ff, toneMapped: false }),
    ghost: false,
  };
}

export function buildWheel(mats) {
  const { wheelR: r, wheelW: w } = DIM;
  const parts = [];
  const tire = new THREE.CylinderGeometry(r, r, w, 44, 1, true);
  tire.rotateZ(Math.PI / 2);
  parts.push(tire);
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    for (const side of [-1, 1]) {
      const g = new THREE.BoxGeometry(w * 0.5, 0.022, 0.012);
      g.rotateY(side * 0.35);
      g.translate(side * w * 0.24, r + 0.008, 0);
      g.rotateX(a);
      parts.push(g);
    }
  }
  const face = [];
  const disc = new THREE.CylinderGeometry(r * 0.96, r * 0.96, 0.008, 36);
  disc.rotateZ(Math.PI / 2);
  disc.translate(w * 0.32, 0, 0);
  parts.push(disc);
  for (let i = 0; i < 6; i++) {
    const g = new THREE.BoxGeometry(0.018, r * 0.82, 0.03);
    g.translate(0, r * 0.45, 0.02);
    g.rotateZ(0);
    g.rotateX((i / 6) * Math.PI * 2);
    g.translate(w * 0.36, 0, 0);
    face.push(g);
  }
  const hub = new THREE.CylinderGeometry(0.055, 0.055, w * 0.9, 20);
  hub.rotateZ(Math.PI / 2);
  face.push(hub);
  const spin = new THREE.Group();
  spin.add(new THREE.Mesh(mergeGeometries(parts), mats.alu), new THREE.Mesh(mergeGeometries(face), mats.dark));
  return spin;
}

// Re-exported so rover-model.js's single `RoundedBoxGeometry` import site
// doesn't need to know this moved.
export { RoundedBoxGeometry };

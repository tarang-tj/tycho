// Shared texture-construction helpers (DataTexture/CanvasTexture wrapping,
// 2D canvas creation), split out of textures.js so texture-detail.js can
// use the same `dataTexture()` wrapper without duplicating it (U4).
import * as THREE from "three";

export function dataTexture(data, size, { srgb = false, repeat = true } = {}) {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export function canvasTexture(canvas, { srgb = true, repeat = false } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = 8;
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

export function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")];
}

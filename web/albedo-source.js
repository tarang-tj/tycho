// G1 (plan-wave3.md): pick the terrain albedo texture for a level.
//
// A real LROC NAC orthophoto (assets/<site>/albedo-ortho.jpg) is used only
// when its sidecar (albedo-ortho.json, written by tools/ortho_albedo.py with
// the product URL, label bounds and alignment check) ships next to it AND
// the level has not opted out (level.orthoAlbedo === false, the A2 kill
// criterion: the photo's baked shadows fight the dynamic sun there).
// Otherwise the DEM hillshade albedo.jpg is used, as before this wave.
// Pure apart from the injected `fetchFn`, so node tests can drive it.

// Blend strength for the photo. The hillshade uses the planet's LOOK.hs
// (0.18 on the Moon) because it only re-states the DEM's own relief; the
// photo carries real albedo (ejecta rays, dark mare patches, crater rims)
// the DEM cannot, so it is blended at full strength (the shader still
// normalizes it by its own mean and clamps it to 0.55-1.6x, so it modulates
// the lit ground rather than replacing the lighting). 1280x800 A/B, wave 3:
// at 0.55 the photo changed the frame by only 1-6 gray levels on average
// (no visible gain); at 1.0 it changed it by 9-11 in the aerial view with
// no doubled crater shadows on Lunokhod, Chang'e-4 or Apollo 17. Tycho is
// the A2 kill (levels.js orthoAlbedo:false).
export const ORTHO_STRENGTH = 1.0;

/**
 * @param {{assetKey:string, orthoAlbedo?:boolean}} level
 * @param {{synthetic?:boolean}} terrain
 * @param {(url:string)=>Promise<{ok:boolean, json:()=>Promise<any>}>} fetchFn
 * @param {string} [base] URL prefix of the assets directory
 * @returns {Promise<{url:string|null, fallbackUrl:string|null, kind:"ortho"|"hillshade"|"none", strength:number|null, sidecar:object|null}>}
 */
export async function pickAlbedo(level, terrain, fetchFn, base = "../assets/") {
  if (terrain?.synthetic) return { url: null, fallbackUrl: null, kind: "none", strength: null, sidecar: null };
  const dir = `${base}${level.assetKey}/`;
  const hillshade = { url: `${dir}albedo.jpg`, fallbackUrl: null, kind: "hillshade", strength: null, sidecar: null };
  if (level.orthoAlbedo === false) return hillshade;
  try {
    const res = await fetchFn(`${dir}albedo-ortho.json`);
    if (!res?.ok) return hillshade;
    const sidecar = await res.json();
    if (!sidecar || typeof sidecar.productUrl !== "string") return hillshade; // not a real sidecar
    return { url: `${dir}albedo-ortho.jpg`, fallbackUrl: `${dir}albedo.jpg`, kind: "ortho", strength: ORTHO_STRENGTH, sidecar };
  } catch {
    return hillshade;
  }
}

// Registry of illustrative real-site landmark models, placed at a level's
// goal when the level defines a `landmarkKind` (see web/levels.js). Each
// builder returns { root, dispose() }; `root`'s local +z is the direction
// the real object faces - the caller (scene.js) applies the world-frame
// heading via resolveLandmarkHeadingDeg() below.
import { createParkedLunokhod } from "./lunokhod-parked.js";
import { createChange4Lander } from "./change4-lander.js";
import { createMerRover } from "./mer-rover.js";
import { createApolloLrv } from "./apollo-lrv.js";

const BUILDERS = {
  lunokhod2: createParkedLunokhod,
  change4: createChange4Lander,
  mer: createMerRover,
  lrv: createApolloLrv,
};

/** Build the landmark model for `kind`, or null if `kind` is unknown/omitted. */
export function createLandmark(kind) {
  const build = BUILDERS[kind];
  return build ? build() : null;
}

// t (radians) turns a landmark's local +z toward world (sin t, cos t); world
// +x is east and +z is south (pxToWorld maps map rows to z), so t=0 faces
// south and t increases clockwise through east. Verified against LROC post
// 699's "facing southeast" for the parked Lunokhod 2 = t = 45deg.
const COMPASS_HEADING_DEG = {
  south: 0, southeast: 45, east: 90, northeast: 135,
  north: 180, northwest: 225, west: 270, southwest: 315,
};

/**
 * Resolve a landmark's facing heading in degrees (the t above) from the
 * loaded terrain's meta.json: a numeric `landmarkHeadingDeg`, a compass
 * string `landmarkHeadingCompass`, or (Lunokhod's original field name, kept
 * for back-compat with the shipped asset) `lunokhod2Heading`. Defaults to 0
 * (south) if meta names no heading at all - never invented beyond that.
 */
export function resolveLandmarkHeadingDeg(meta) {
  if (typeof meta?.landmarkHeadingDeg === "number") return meta.landmarkHeadingDeg;
  const compass = meta?.landmarkHeadingCompass ?? meta?.lunokhod2Heading;
  return COMPASS_HEADING_DEG[compass] ?? 0;
}

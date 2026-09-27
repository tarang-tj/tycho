// Registry of illustrative real-site landmark models, placed at a level's
// goal when the level defines a `landmarkKind` (see web/levels.js). Each
// builder returns { root, dispose() }; `root`'s local +z is the direction
// the real object faces - the caller (scene.js) applies the world-frame
// heading via resolveLandmarkHeadingDeg() below.
import { createParkedLunokhod } from "./lunokhod-parked.js";
import { createChange4Lander } from "./change4-lander.js";
import { createApolloLrv } from "./apollo-lrv.js";
import { createYutuMarker } from "./yutu-marker.js";

const BUILDERS = {
  lunokhod2: createParkedLunokhod,
  change4: createChange4Lander,
  // Chang'e 3 reuses the Chang'e-4 lander mesh as a visual stand-in only
  // (plan-wave3.md A6); levels.js's landmarkNote puts "model approximated"
  // on screen for it.
  change3: createChange4Lander,
  lrv: createApolloLrv,
};

// Secondary real objects near a goal, each placed from a pixel the data
// pipeline wrote into meta.json (never computed or invented here). Today
// that is only Yutu, from assets/change3/meta.json's yutuPixel1024 (its
// LROC post 938 coordinate projected by tools/sites/change3.py).
const SECONDARY = [
  { metaKey: "yutuPixel1024", kind: "yutu", build: createYutuMarker },
];

/**
 * Secondary markers the loaded meta.json places: [{ kind, px: {x, y}, build }].
 * Empty when meta names none.
 */
export function resolveSecondaryMarkers(meta) {
  const out = [];
  for (const s of SECONDARY) {
    const px = meta?.[s.metaKey];
    if (px && Number.isFinite(px.x) && Number.isFinite(px.y)) out.push({ kind: s.kind, px, build: s.build });
  }
  return out;
}

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

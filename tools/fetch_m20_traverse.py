"""Fetches NASA's Mars 2020 rover-reported drive traverse (MMGIS layer) and
writes a decimated, honesty-cited snapshot to assets/mars/m20-traverse.json
for the F1 "real track reveal" feature (web/historic-track.js).

Sources fetched this session (2026-09-26):
- Traverse: https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_traverse.json
  (HTTP 200, 1,719,158 bytes; GeoJSON FeatureCollection, CRS OGC:CRS84
  lon/lat, 556 LineString features = drive segments, sols 14-1980,
  36,583 raw vertices). This is an undocumented MMGIS layer, not a
  versioned API (assumption A4 in plan-wave3.md) -- hence the snapshot
  below records the exact URL and fetch date rather than re-fetching live.
- DEM georeference: same GeoTIFF tools/sites/mars.py downloads
  (https://planetarymaps.usgs.gov/mosaic/mars2020_trn/CTX/
  ScienceInvestigationMaps_JPL/M20_JezeroCrater_CTXDEM_20m.tif), but here
  only the first 300,000 bytes are pulled via an HTTP range request (curl
  -r 0-299999) -- ample for tiff_ifd.read_header's TIFF/GeoTIFF tag parse,
  and avoids re-downloading the full ~90 MB raster this lane does not own.
  Read this session: full raster 4456x5067 px, pixel_scale 20.0 m,
  GeoTIFF geokeys: ProjCoordTrans=17 (Equirectangular), CenterLong=0.0,
  CenterLat=0.0, StdParallel1=18.4663 deg, SemiMajorAxis=3396190.0 m
  (Mars 2000 sphere). Landing site 18.4447N 77.4508E (assets/mars/meta.json
  source.landingSite) projects to full-raster pixel (col,row) =
  (1274.46, 2505.80) -> rounds to (1274, 2506), matching
  tools/sites/mars.py's own land_row/land_col rounding. The 1024x1024 crop
  in assets/mars/{height.bin,albedo.jpg} is centered on that pixel with no
  clamping (meta.json's spawn is exactly (512,512), and
  2506-512=1994 <= 5067-1024=4043 / 1274-512=762 <= 4456-1024=3432 confirms
  neither axis clamped), so cropOffset = (row=1994, col=762).

A3 verified this session: projecting the traverse's first vertex
(lon=77.45088573, lat=18.44462715) through the params above lands at crop
pixel (col=512.70, row=512.02) -- 0.70 px / 0.02 px from the meta.json
spawn (512, 512), i.e. within 1 px on both axes.
"""
from __future__ import annotations

import json
import math
import os
import subprocess
from datetime import date, timezone

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_DIR = os.path.join(REPO_ROOT, ".cache")
OUT_PATH = os.path.join(REPO_ROOT, "assets", "mars", "m20-traverse.json")

TRAVERSE_URL = "https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_traverse.json"
DEM_URL = ("https://planetarymaps.usgs.gov/mosaic/mars2020_trn/CTX/"
           "ScienceInvestigationMaps_JPL/M20_JezeroCrater_CTXDEM_20m.tif")
DEM_HEADER_BYTES = 300_000

# GeoTIFF georeference read from the DEM header this session (see module
# docstring). Kept as constants here rather than re-parsed every run since
# this lane only needs the header once to build the static snapshot; the
# runtime JS module (web/historic-track.js) receives the same numbers via
# the snapshot's "projection" object, so nothing is duplicated silently.
RADIUS_M = 3396190.0
LAT_TRUE_SCALE_DEG = 18.4663
NATIVE_MPP = 20.0
# Landing site (assets/mars/meta.json source.landingSite) sits exactly at
# the Jezero crop's spawn pixel (512, 512), with the crop centered on it
# and no edge-clamping (full-raster landing pixel (1274, 2506) in a
# 4456x5067 raster leaves >1024/2 px of margin on every side -- verified
# this session, see module docstring). So a vertex's crop pixel is just
# the spawn pixel plus its equirectangular offset (meters/mpp) from the
# landing lat/lon; no raster tiepoint needed.
LANDING_LAT_DEG = 18.4447
LANDING_LON_DEG = 77.4508
SPAWN_PIXEL = {"x": 512, "y": 512}

MAX_OUTPUT_BYTES = 300_000
MIN_SPACING_M = 5.0  # decimation floor: well under the 100 m match tolerance


def _curl_to_file(url: str, dest: str, *, byte_range: str | None = None) -> None:
    cmd = ["curl", "-sL", "--fail", "-o", dest]
    if byte_range is not None:
        cmd += ["-r", byte_range]
    cmd.append(url)
    result = subprocess.run(cmd, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"curl failed ({result.returncode}) fetching {url}")


def fetch_traverse_geojson(cache_dir: str = CACHE_DIR) -> dict:
    os.makedirs(cache_dir, exist_ok=True)
    dest = os.path.join(cache_dir, "m20_traverse_raw.json")
    _curl_to_file(TRAVERSE_URL, dest)
    with open(dest, "r", encoding="utf-8") as f:
        return json.load(f)


def _haversine_like_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    """Flat-Mars distance in meters between two nearby lon/lat points, using
    the same equirectangular approximation as the projection below (fine at
    this scale: consecutive traverse vertices are meters apart)."""
    lat_mid = math.radians((lat1 + lat2) / 2.0)
    dlat_m = math.radians(lat2 - lat1) * RADIUS_M
    dlon_m = math.radians(lon2 - lon1) * RADIUS_M * math.cos(lat_mid)
    return math.hypot(dlat_m, dlon_m)


def decimate_coords(coords: list[list[float]], min_spacing_m: float = MIN_SPACING_M) -> list[list[float]]:
    """Keeps the first and last vertex of a segment always; drops any
    interior vertex closer than min_spacing_m to the last kept vertex.
    Drops the z (elevation) component -- not needed for a 2D route match."""
    if not coords:
        return []
    kept = [[coords[0][0], coords[0][1]]]
    for c in coords[1:]:
        lon, lat = c[0], c[1]
        if _haversine_like_m(kept[-1][0], kept[-1][1], lon, lat) >= min_spacing_m:
            kept.append([lon, lat])
    last = [coords[-1][0], coords[-1][1]]
    if kept[-1] != last:
        kept.append(last)
    return [[round(lon, 6), round(lat, 6)] for lon, lat in kept]


def build_snapshot(geojson: dict, *, fetch_date: str, min_spacing_m: float = MIN_SPACING_M) -> dict:
    segments = []
    for feat in geojson.get("features", []):
        props = feat.get("properties", {})
        geom = feat.get("geometry", {})
        coords = geom.get("coordinates", [])
        segments.append({
            "sol": props.get("sol"),
            "fromRMC": props.get("fromRMC"),
            "toRMC": props.get("toRMC"),
            "length": props.get("length"),
            "coords": decimate_coords(coords, min_spacing_m),
        })
    return {
        "source": {
            "url": TRAVERSE_URL,
            "fetchedAt": fetch_date,
            "citedFrom": ("NASA MMGIS M20 traverse layer; undocumented, may change "
                          "without notice (see plan-wave3.md assumption A4)."),
            "rawFeatureCount": len(geojson.get("features", [])),
            "decimation": {"minSpacingMeters": min_spacing_m,
                           "note": "z (elevation) dropped; lon/lat rounded to 1e-6 deg"},
        },
        "projection": {
            "note": ("Equirectangular params read from the CTX Jezero DEM GeoTIFF "
                      "header this session; see tools/fetch_m20_traverse.py module "
                      "docstring for the exact fetch and byte range."),
            "demUrl": DEM_URL,
            "radiusM": RADIUS_M,
            "latTrueScaleDeg": LAT_TRUE_SCALE_DEG,
            "metersPerPixel": NATIVE_MPP,
            "landingLatDeg": LANDING_LAT_DEG,
            "landingLonDeg": LANDING_LON_DEG,
            "spawnPixel": SPAWN_PIXEL,
        },
        "segments": segments,
    }


def fetch_and_write(out_path: str = OUT_PATH, cache_dir: str = CACHE_DIR) -> dict:
    geojson = fetch_traverse_geojson(cache_dir)
    fetch_date = date.today().isoformat()
    snapshot = build_snapshot(geojson, fetch_date=fetch_date)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    text = json.dumps(snapshot, separators=(",", ":"))
    size = len(text.encode("utf-8"))
    if size > MAX_OUTPUT_BYTES:
        raise ValueError(f"m20-traverse.json snapshot is {size} bytes, over the "
                          f"{MAX_OUTPUT_BYTES} byte cap; lower MIN_SPACING_M")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"  wrote {out_path} ({size} bytes, {len(snapshot['segments'])} segments)")
    return snapshot


if __name__ == "__main__":
    fetch_and_write()

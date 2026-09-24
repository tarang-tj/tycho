#!/usr/bin/env python3
"""TYCHO terrain pipeline: download real DEMs, process to the data contract.

Usage: python3 tools/build_terrain.py moon|mars|all

For each body: downloads the source GeoTIFF to .cache/ (gitignored,
resumable), reads it with PIL, crops/resamples with numpy, writes
assets/<body>/{height.bin,meta.json,albedo.jpg,preview.png}, then deletes
the raw download. Never keeps more than one raw file on disk at once.
"""
from __future__ import annotations

import os
import sys

import numpy as np
from PIL import Image
from scipy.ndimage import map_coordinates

from downloader import download
from georef import EquirectParams
from meta_schema import build_meta, validate_meta
from outputs import ensure_dir, write_albedo_jpg, write_height_bin, write_mask_bin, write_meta_json, write_preview_png
from raster_ops import area_resample, compute_mask_1024, fill_nodata, nodata_mask, normalize_to_uint16
from shading import hillshade, slope_deg
from site_picker import (ensure_clear_of_mask, find_best_square_crop, find_peak, pick_directional_point,
                          pick_mars_goal, pick_moon_spawn)
from tiff_ifd import read_header

MIN_CLEAR_OF_MASK_PX = 20

Image.MAX_IMAGE_PIXELS = None  # these are legitimate large scientific rasters

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_DIR = os.path.join(REPO_ROOT, ".cache")
ASSETS_DIR = os.path.join(REPO_ROOT, "assets")

MOON_URL = ("http://lroc.sese.asu.edu/data/LRO-L-LROC-5-RDR-V1.0/LROLRC_2001/"
            "DATA/SDP/NAC_DTM/TYCHOPK01/NAC_DTM_TYCHOPK01.TIF")
MOON_SIZE = 212_486_239
# 1200px = 2.4km square @ native 2m/px. Centering purely on the peak leaves
# ~14% nodata (the peak sits near the edge of this diagonal stereo swath);
# find_best_square_crop instead searches nearby placements for the one with
# least nodata while still containing the peak (cut it to ~7.5% here).
MOON_CROP_PX = 1200

MARS_URL = ("https://planetarymaps.usgs.gov/mosaic/mars2020_trn/CTX/"
            "ScienceInvestigationMaps_JPL/M20_JezeroCrater_CTXDEM_20m.tif")
MARS_SIZE = 90_345_300
MARS_CROP_PX = 1024  # native 20 m/px = 20.48 km square, no resample needed

# Octavia E. Butler Landing: 18.4447N 77.4508E, Mars 2000 sphere (planetocentric,
# identical to planetographic for a sphere). Cross-checked this session:
# Wikidata Q105824100 (18d26'40.6"N 77d27'3.2"E = 18.4446, 77.4509, citing
# NASA mars.nasa.gov/maps/location/?mission=M20) and Wikipedia "Octavia E.
# Butler Landing" (18.44, 77.45, citing NASA GISS "Mars Lander Missions").
LANDING_LAT = 18.4447
LANDING_LON = 77.4508

LUNOKHOD_URL = ("http://lroc.sese.asu.edu/data/LRO-L-LROC-5-RDR-V1.0/LROLRC_2001/"
                 "DATA/SDP/NAC_DTM/LUNOKHOD2/NAC_DTM_LUNOKHOD2.TIF")
LUNOKHOD_SIZE = 187_143_471
LUNOKHOD_CROP_PX = 1024  # native 5 m/px = 5.12km square, no resample needed (like Mars)

# Facts sourced from LROC post 699 "Lunokhod 2 Revisited" (fetched 2026-09-24,
# https://lroc.im-ldi.com/posts/699 -- lroc.sese.asu.edu/posts/699 301-redirects
# there): "The Lunokhod 2 rover is still parked on the floor of the crater Le
# Monnier (25.830N, 30.914E)." "Lunokhod 2 rover parked facing southeast with
# the lid still open." "Rover tracks extend north to the final parking
# place." -- the rover's recorded approach came from the south, so the
# in-game spawn is placed south of the parked rover to recreate the final
# leg of that real drive (see pick_directional_point call below).
LUNOKHOD_GOAL_LAT = 25.830
LUNOKHOD_GOAL_LON = 30.914
LUNOKHOD_HEADING = "southeast"
LUNOKHOD_LID = "open"
LUNA21_LAT = 26.005
LUNA21_LON = 30.406
LUNA21_ELEV_CITED_M = -2769.0  # LROC post 699: "elevation of -2769 m"


def _line_slope_stats(slope_native: np.ndarray, p0_rc: tuple[float, float],
                       p1_rc: tuple[float, float], n: int = 400) -> tuple[float, float]:
    """Samples a per-pixel slope grid along the straight line from p0 to p1
    (native-resolution row/col coordinates) and returns (max, mean) degrees."""
    rows = np.linspace(p0_rc[0], p1_rc[0], n)
    cols = np.linspace(p0_rc[1], p1_rc[1], n)
    vals = map_coordinates(slope_native, [rows, cols], order=1, mode="nearest")
    return float(vals.max()), float(vals.mean())


def _shade_and_slope_1024(filled_native: np.ndarray, native_mpp: float,
                           az: float, alt: float) -> tuple[np.ndarray, np.ndarray]:
    """Computes hillshade + slope at native resolution, then downsamples
    (does NOT compute shading on already-resampled elevation: that lets a
    non-integer BOX-resize ratio beat against np.gradient's differencing
    and produces a visible checkerboard moire, confirmed visually here)."""
    shade_native = hillshade(filled_native, native_mpp, az, alt).astype(np.float32)
    slope_native = slope_deg(filled_native, native_mpp).astype(np.float32)
    shade_1024 = np.clip(np.round(area_resample(shade_native, 1024, 1024)), 0, 255).astype(np.uint8)
    slope_1024 = area_resample(slope_native, 1024, 1024)
    return shade_1024, slope_1024


def _enforce_clearance(resized: np.ndarray, mask_1024: np.ndarray, slope_1024: np.ndarray,
                        spawn: dict, goal: dict) -> tuple[dict, dict, str]:
    """Re-checks spawn/goal are >= MIN_CLEAR_OF_MASK_PX from any masked
    (nodata-filled) cell; relocates whichever fails to the best nearby real
    cell (goal: highest elevation; spawn: lowest slope) and returns a note
    describing any change (empty string if nothing moved)."""
    notes = []
    goal_rc, goal_changed = ensure_clear_of_mask(
        (goal["y"], goal["x"]), resized, mask_1024, MIN_CLEAR_OF_MASK_PX, mode="max_elev")
    if goal_changed:
        notes.append(f"goal relocated from ({goal['x']},{goal['y']}) to "
                      f"({goal_rc[1]},{goal_rc[0]}) -- original was within "
                      f"{MIN_CLEAR_OF_MASK_PX}px of a nodata-filled cell; picked the "
                      "highest real-data cell satisfying the clearance instead.")
        goal = {"x": int(goal_rc[1]), "y": int(goal_rc[0])}
    spawn_rc, spawn_changed = ensure_clear_of_mask(
        (spawn["y"], spawn["x"]), resized, mask_1024, MIN_CLEAR_OF_MASK_PX, mode="min_slope", slope=slope_1024)
    if spawn_changed:
        notes.append(f"spawn relocated from ({spawn['x']},{spawn['y']}) to "
                      f"({spawn_rc[1]},{spawn_rc[0]}) -- original was within "
                      f"{MIN_CLEAR_OF_MASK_PX}px of a nodata-filled cell; picked the "
                      "lowest-slope real-data cell satisfying the clearance instead.")
        spawn = {"x": int(spawn_rc[1]), "y": int(spawn_rc[0])}
    return spawn, goal, " ".join(notes)


def process_moon() -> None:
    print("== MOON: Tycho central peak ==")
    raw = os.path.join(CACHE_DIR, "moon_raw.tif")
    download(MOON_URL, raw, MOON_SIZE)
    header = read_header(raw)
    arr = np.asarray(Image.open(raw), dtype=np.float32)
    mask = nodata_mask(arr, header["nodata"])
    native_mpp = header["pixel_scale"][0]
    peak_rc = find_peak(arr, mask, cellsize_m=native_mpp, margin_m=60.0)

    r0, c0 = find_best_square_crop(mask, MOON_CROP_PX, peak_rc)
    sub = arr[r0:r0 + MOON_CROP_PX, c0:c0 + MOON_CROP_PX]
    submask = mask[r0:r0 + MOON_CROP_PX, c0:c0 + MOON_CROP_PX]
    filled, frac = fill_nodata(sub, submask)
    peak_local = (peak_rc[0] - r0, peak_rc[1] - c0)
    spawn_local = pick_moon_spawn(filled, peak_local, native_mpp, nodata_mask=submask)
    shade_1024, slope_1024 = _shade_and_slope_1024(filled, native_mpp, 315.0, 45.0)
    resized = area_resample(filled, 1024, 1024)

    mpp = native_mpp * (MOON_CROP_PX / 1024)
    scale = 1024 / MOON_CROP_PX
    goal = {"x": int(round(peak_local[1] * scale)), "y": int(round(peak_local[0] * scale))}
    spawn = {"x": int(round(spawn_local[1] * scale)), "y": int(round(spawn_local[0] * scale))}

    mask_1024 = compute_mask_1024(submask, 1024, 1024)
    spawn, goal, clearance_note = _enforce_clearance(resized, mask_1024, slope_1024, spawn, goal)

    min_e, max_e = float(resized.min()), float(resized.max())
    notes = ("Shaded rendering of real LRO NAC DTM elevation (not a photo). "
             f"Crop is a {MOON_CROP_PX * native_mpp / 1000:.1f}km square placed to "
             "minimize nodata while containing the DTM's highest well-supported "
             "pixel (>=60m from any stereo-correlation gap), resampled to "
             "1024x1024. Spawn is the lowest-slope point within 300-1000m of "
             "the summit. mask.bin marks nodata-filled cells (rendered as a "
             "hatched no-data texture in albedo.jpg/preview.png); spawn and "
             f"goal are kept >= {MIN_CLEAR_OF_MASK_PX}px clear of them.")
    if clearance_note:
        notes += " " + clearance_note
    write_body(
        "moon", resized, shade_1024, slope_1024, mask_1024, min_e, max_e, mpp,
        spawn=spawn, goal=goal,
        source={"product": "NAC_DTM_TYCHOPK01",
                "url": "https://data.lroc.im-ldi.com/lroc/view_rdr/NAC_DTM_TYCHOPK01",
                "download": MOON_URL},
        license_text=("LROC Reduced Data Record (RDR) products available through "
                       "the NASA Planetary Data System (PDS) are in the public domain."),
        credit="NASA/GSFC/Arizona State University",
        nodata_filled_fraction=frac,
        notes=notes,
    )
    print(f"  min/max elev: {min_e:.1f} / {max_e:.1f} m  relief: {max_e - min_e:.1f} m")
    print(f"  m/px: {mpp:.3f}  nodata filled: {frac:.3%}")
    print(f"  goal (summit) elev: {resized[goal['y'], goal['x']]:.1f} m  "
          f"spawn elev: {resized[spawn['y'], spawn['x']]:.1f} m")
    os.remove(raw)
    print(f"  deleted {raw}")


def process_mars() -> None:
    print("== MARS: Jezero / Octavia E. Butler Landing ==")
    raw = os.path.join(CACHE_DIR, "mars_raw.tif")
    download(MARS_URL, raw, MARS_SIZE)
    header = read_header(raw)
    arr = np.asarray(Image.open(raw), dtype=np.float32)
    mask = nodata_mask(arr, header["nodata"])
    geo = EquirectParams.from_header(header)
    land_i, land_j = geo.latlon_to_pixel(LANDING_LAT, LANDING_LON)
    land_row, land_col = round(land_j), round(land_i)
    print(f"  landing site pixel (row,col): {land_row}, {land_col}  "
          f"(raster {header['width']}x{header['height']})")

    h, w = arr.shape
    r0 = min(max(land_row - MARS_CROP_PX // 2, 0), h - MARS_CROP_PX)
    c0 = min(max(land_col - MARS_CROP_PX // 2, 0), w - MARS_CROP_PX)
    sub = arr[r0:r0 + MARS_CROP_PX, c0:c0 + MARS_CROP_PX]
    submask = mask[r0:r0 + MARS_CROP_PX, c0:c0 + MARS_CROP_PX]
    filled, frac = fill_nodata(sub, submask)
    native_mpp = header["pixel_scale"][0]
    spawn_rc = (land_row - r0, land_col - c0)
    goal_rc = pick_mars_goal(filled, spawn_rc, native_mpp, nodata_mask=submask)
    shade_1024, slope_1024 = _shade_and_slope_1024(filled, native_mpp, 270.0, 35.0)
    resized = area_resample(filled, 1024, 1024)  # crop already 1024^2; identity resample

    spawn = {"x": int(spawn_rc[1]), "y": int(spawn_rc[0])}
    goal = {"x": int(goal_rc[1]), "y": int(goal_rc[0])}

    mask_1024 = compute_mask_1024(submask, 1024, 1024)
    spawn, goal, clearance_note = _enforce_clearance(resized, mask_1024, slope_1024, spawn, goal)

    min_e, max_e = float(resized.min()), float(resized.max())
    notes = ("Shaded rendering of real CTX DEM elevation (not a photo). Crop is "
              "a native-resolution (20 m/px) 1024x1024 window centered on the "
              "Octavia E. Butler landing pixel, computed from the GeoTIFF's "
              "spherical-Equirectangular georeferencing (verified against the "
              "source's documented 17.58-19.29N/76.99-78.58E extent). Goal is "
              "the highest local terrain-roughness point 2-4km from spawn, a "
              "data-driven proxy for the delta scarp -- not a surveyed named "
              "feature; confirm visually against preview.png. mask.bin marks "
              "nodata-filled cells (rendered as a hatched no-data texture in "
              "albedo.jpg/preview.png); spawn and goal are kept "
              f">= {MIN_CLEAR_OF_MASK_PX}px clear of them.")
    if clearance_note:
        notes += " " + clearance_note
    write_body(
        "mars", resized, shade_1024, slope_1024, mask_1024, min_e, max_e, native_mpp,
        spawn=spawn, goal=goal,
        source={"product": "M20_JezeroCrater_CTXDEM_20m",
                "url": ("https://planetarymaps.usgs.gov/mosaic/mars2020_trn/CTX/"
                        "ScienceInvestigationMaps_JPL/"),
                "download": MARS_URL,
                "landingSite": {"lat": LANDING_LAT, "lon": LANDING_LON,
                                 "citedFrom": "Wikidata Q105824100 / mars.nasa.gov maps (mission=M20)"}},
        license_text=("NASA data policy: data from a NASA-led mission is licensed "
                       "as Creative Commons Zero (CC0); public domain, no usage restrictions."),
        credit="NASA/JPL-Caltech/MSSS/USGS",
        nodata_filled_fraction=frac,
        notes=notes,
    )
    print(f"  min/max elev: {min_e:.1f} / {max_e:.1f} m  relief: {max_e - min_e:.1f} m")
    print(f"  m/px: {native_mpp:.3f}  nodata filled: {frac:.3%}")
    print(f"  spawn (landing) elev: {resized[spawn['y'], spawn['x']]:.1f} m  "
          f"goal elev: {resized[goal['y'], goal['x']]:.1f} m")
    os.remove(raw)
    print(f"  deleted {raw}")


def process_lunokhod() -> None:
    print("== LUNOKHOD: Le Monnier crater, Lunokhod 2 site ==")
    raw = os.path.join(CACHE_DIR, "lunokhod_raw.tif")
    download(LUNOKHOD_URL, raw, LUNOKHOD_SIZE)
    header = read_header(raw)
    arr = np.asarray(Image.open(raw), dtype=np.float32)
    mask = nodata_mask(arr, header["nodata"])
    geo = EquirectParams.from_header(header)
    native_mpp = header["pixel_scale"][0]

    corners = [geo.pixel_to_latlon(i, j) for i, j in
               ((0, 0), (header["width"] - 1, 0), (0, header["height"] - 1),
                (header["width"] - 1, header["height"] - 1))]
    lat_lo, lat_hi = min(c[0] for c in corners), max(c[0] for c in corners)
    lon_lo, lon_hi = min(c[1] for c in corners), max(c[1] for c in corners)
    print(f"  computed corner extent: {lat_lo:.4f}-{lat_hi:.4f}N, {lon_lo:.4f}-{lon_hi:.4f}E "
          "(product page: 24.86-26.68N, 30.32-31.09E)")

    goal_i, goal_j = geo.latlon_to_pixel(LUNOKHOD_GOAL_LAT, LUNOKHOD_GOAL_LON)
    goal_row, goal_col = round(goal_j), round(goal_i)
    luna21_i, luna21_j = geo.latlon_to_pixel(LUNA21_LAT, LUNA21_LON)
    luna21_row, luna21_col = round(luna21_j), round(luna21_i)
    luna21_elev = float(arr[luna21_row, luna21_col])
    print(f"  Luna 21 pixel (row,col) {luna21_row},{luna21_col}  elev {luna21_elev:.1f} m "
          f"(LROC post 699 cites {LUNA21_ELEV_CITED_M:.0f} m)")

    half = LUNOKHOD_CROP_PX // 2
    r0 = min(max(goal_row - half, 0), arr.shape[0] - LUNOKHOD_CROP_PX)
    c0 = min(max(goal_col - half, 0), arr.shape[1] - LUNOKHOD_CROP_PX)
    sub = arr[r0:r0 + LUNOKHOD_CROP_PX, c0:c0 + LUNOKHOD_CROP_PX]
    submask = mask[r0:r0 + LUNOKHOD_CROP_PX, c0:c0 + LUNOKHOD_CROP_PX]
    filled, frac = fill_nodata(sub, submask)
    goal_local = (goal_row - r0, goal_col - c0)
    luna21_in_crop = r0 <= luna21_row < r0 + LUNOKHOD_CROP_PX and c0 <= luna21_col < c0 + LUNOKHOD_CROP_PX
    luna21_local = (luna21_row - r0, luna21_col - c0) if luna21_in_crop else None

    # Spawn: lowest-slope point 1.5-3km south of the parked rover (real
    # driving-approach direction per LROC post 699, see module-level note).
    spawn_local = pick_directional_point(
        filled, goal_local, native_mpp, r_min_m=1500.0, r_max_m=3000.0,
        bearing_deg=180.0, bearing_width_deg=70.0, nodata_mask=submask, edge_margin_px=40)

    shade_1024, slope_1024 = _shade_and_slope_1024(filled, native_mpp, 315.0, 45.0)
    resized = area_resample(filled, 1024, 1024)  # crop already 1024^2; identity resample

    scale = 1024 / LUNOKHOD_CROP_PX  # == 1.0
    goal = {"x": int(round(goal_local[1] * scale)), "y": int(round(goal_local[0] * scale))}
    spawn = {"x": int(round(spawn_local[1] * scale)), "y": int(round(spawn_local[0] * scale))}
    mpp = native_mpp * (LUNOKHOD_CROP_PX / 1024)

    mask_1024 = compute_mask_1024(submask, 1024, 1024)
    spawn, goal, clearance_note = _enforce_clearance(resized, mask_1024, slope_1024, spawn, goal)

    # Rover-scale slope sanity along the straight spawn->goal line. The
    # brief asks for a 3m baseline; this DTM's native resolution is 5m/px
    # (coarser than 3m), so a literal 3m baseline isn't resolvable from this
    # data -- reporting native-grid (5m) per-pixel slope instead rather than
    # fabricating sub-pixel precision.
    slope_native = slope_deg(filled, native_mpp)
    max_slope, mean_slope = _line_slope_stats(
        slope_native, (spawn["y"] / scale, spawn["x"] / scale), (goal["y"] / scale, goal["x"] / scale))
    dist_m = ((goal["y"] - spawn["y"]) ** 2 + (goal["x"] - spawn["x"]) ** 2) ** 0.5 * mpp
    print(f"  spawn->goal distance: {dist_m:.1f} m")
    print(f"  line slope (native 5m/px grid, 3m baseline not resolvable at this resolution): "
          f"max {max_slope:.2f} deg  mean {mean_slope:.2f} deg  "
          "(tip limit 32deg, co-pilot guardrail 25deg)")

    min_e, max_e = float(resized.min()), float(resized.max())
    notes = ("Shaded rendering of real LRO NAC DTM elevation (not a photo). Crop is a "
             f"{LUNOKHOD_CROP_PX * native_mpp / 1000:.2f}km square at native 5 m/px, "
             "centered on the pixel of Lunokhod 2's parked position (a surveyed "
             "coordinate from LROC post 699, not a proxy). Goal is the parked rover "
             "(\"Lunokhod 2 (parked since 1973)\"); spawn is the lowest-slope point "
             "1.5-3km south of it, chosen along the rover's real recorded approach "
             "direction (post 699: \"Rover tracks extend north to the final parking "
             "place\", i.e. the historic drive came from the south). Luna 21's "
             "landing site (26.005N, 30.406E) is ~39km away (the real driving "
             "distance Lunokhod 2 covered) and falls outside this crop; its pixel "
             f"in the full raster has DTM elevation {luna21_elev:.1f}m vs LROC post "
             f"699's cited {LUNA21_ELEV_CITED_M:.0f}m. mask.bin marks nodata-filled "
             "cells (rendered as a hatched no-data texture in albedo.jpg/preview.png); "
             f"spawn and goal are kept >= {MIN_CLEAR_OF_MASK_PX}px clear of them. The "
             "rover model in-engine is an illustrative period-accurate silhouette, "
             "not a survey model.")
    if clearance_note:
        notes += " " + clearance_note

    spawn_lat, spawn_lon = geo.pixel_to_latlon(c0 + spawn["x"] / scale, r0 + spawn["y"] / scale)
    extra_meta = {
        "siteName": "Le Monnier crater, Lunokhod 2 site",
        "goalLabel": "Lunokhod 2 (parked since 1973)",
        "goalLatLon": {"lat": LUNOKHOD_GOAL_LAT, "lon": LUNOKHOD_GOAL_LON},
        "spawnLatLon": {"lat": round(spawn_lat, 5), "lon": round(spawn_lon, 5)},
        "lunokhod2Heading": LUNOKHOD_HEADING,
        "lunokhod2Lid": LUNOKHOD_LID,
        "luna21LatLon": {"lat": LUNA21_LAT, "lon": LUNA21_LON},
        "luna21Pixel": ({"x": luna21_local[1], "y": luna21_local[0]} if luna21_local else None),
        "luna21ElevM": round(luna21_elev, 1),
        "spawnGoalDistanceM": round(dist_m, 1),
        "lineSlopeDegMax": round(max_slope, 2),
        "lineSlopeDegMean": round(mean_slope, 2),
    }

    write_body(
        "lunokhod", resized, shade_1024, slope_1024, mask_1024, min_e, max_e, mpp,
        spawn=spawn, goal=goal,
        source={"product": "NAC_DTM_LUNOKHOD2",
                "url": "https://data.lroc.im-ldi.com/lroc/view_rdr/NAC_DTM_LUNOKHOD2",
                "download": LUNOKHOD_URL,
                "factsSource": ("LROC post 699 \"Lunokhod 2 Revisited\", "
                                "https://lroc.im-ldi.com/posts/699")},
        license_text=("LROC Reduced Data Record (RDR) products available through "
                       "the NASA Planetary Data System (PDS) are in the public domain."),
        credit="NASA/GSFC/Arizona State University",
        nodata_filled_fraction=frac,
        notes=notes,
        palette="moon",
        extra_meta=extra_meta,
    )
    print(f"  min/max elev: {min_e:.1f} / {max_e:.1f} m  relief: {max_e - min_e:.1f} m")
    print(f"  m/px: {mpp:.3f}  nodata filled: {frac:.3%}")
    print(f"  goal (parked rover) elev: {resized[goal['y'], goal['x']]:.1f} m  "
          f"spawn elev: {resized[spawn['y'], spawn['x']]:.1f} m")
    os.remove(raw)
    print(f"  deleted {raw}")


def write_body(body: str, elev_1024: np.ndarray, shade_1024: np.ndarray, slope_1024: np.ndarray,
               mask_1024: np.ndarray, min_e: float, max_e: float, mpp: float, *, spawn: dict, goal: dict,
               source: dict, license_text: str, credit: str, nodata_filled_fraction: float, notes: str,
               palette: str | None = None, extra_meta: dict | None = None) -> None:
    body_dir = os.path.join(ASSETS_DIR, body)
    ensure_dir(body_dir)
    h16 = normalize_to_uint16(elev_1024, min_e, max_e)
    write_height_bin(os.path.join(body_dir, "height.bin"), h16)
    write_mask_bin(os.path.join(body_dir, "mask.bin"), mask_1024)
    meta = build_meta(
        width=1024, height=1024, meters_per_pixel=mpp, min_elev=min_e, max_elev=max_e,
        size_km=round(1024 * mpp / 1000.0, 3), spawn=spawn, goal=goal, source=source,
        license_text=license_text, credit=credit, nodata_filled_fraction=round(nodata_filled_fraction, 5),
        notes=notes,
    )
    if extra_meta:
        meta.update(extra_meta)
    errors = validate_meta(meta)
    if errors:
        raise ValueError(f"{body} meta.json failed validation: {errors}")
    write_meta_json(os.path.join(body_dir, "meta.json"), meta)
    write_albedo_jpg(os.path.join(body_dir, "albedo.jpg"), elev_1024, shade_1024, slope_1024, mask_1024,
                      palette or body)
    write_preview_png(os.path.join(body_dir, "preview.png"), shade_1024, mask_1024, spawn, goal)
    print(f"  wrote assets/{body}/{{height.bin,mask.bin,meta.json,albedo.jpg,preview.png}}")


def main() -> None:
    if len(sys.argv) != 2 or sys.argv[1] not in ("moon", "mars", "lunokhod", "all"):
        print(__doc__)
        sys.exit(1)
    ensure_dir(CACHE_DIR)
    ensure_dir(ASSETS_DIR)
    target = sys.argv[1]
    if target in ("moon", "all"):
        process_moon()
    if target in ("mars", "all"):
        process_mars()
    if target == "lunokhod":
        process_lunokhod()


if __name__ == "__main__":
    main()

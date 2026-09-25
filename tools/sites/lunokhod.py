"""Lunokhod 2: Le Monnier crater parked-rover site (NAC_DTM_LUNOKHOD2)."""
from __future__ import annotations

import os

import numpy as np
from PIL import Image

from downloader import download
from georef import EquirectParams
from raster_ops import compute_mask_1024, fill_nodata, nodata_mask, area_resample
from shading import slope_deg
from site_picker import pick_directional_point
from tiff_ifd import read_header

from .common import (CACHE_DIR, MIN_CLEAR_OF_MASK_PX, enforce_clearance, line_slope_stats,
                      shade_and_slope_1024, write_body)

Image.MAX_IMAGE_PIXELS = None

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

    shade_1024, slope_1024 = shade_and_slope_1024(filled, native_mpp, 315.0, 45.0)
    resized = area_resample(filled, 1024, 1024)  # crop already 1024^2; identity resample

    scale = 1024 / LUNOKHOD_CROP_PX  # == 1.0
    goal = {"x": int(round(goal_local[1] * scale)), "y": int(round(goal_local[0] * scale))}
    spawn = {"x": int(round(spawn_local[1] * scale)), "y": int(round(spawn_local[0] * scale))}
    mpp = native_mpp * (LUNOKHOD_CROP_PX / 1024)

    mask_1024 = compute_mask_1024(submask, 1024, 1024)
    spawn, goal, clearance_note = enforce_clearance(resized, mask_1024, slope_1024, spawn, goal)

    # Rover-scale slope sanity along the straight spawn->goal line. The
    # brief asks for a 3m baseline; this DTM's native resolution is 5m/px
    # (coarser than 3m), so a literal 3m baseline isn't resolvable from this
    # data -- reporting native-grid (5m) per-pixel slope instead rather than
    # fabricating sub-pixel precision.
    slope_native = slope_deg(filled, native_mpp)
    max_slope, mean_slope = line_slope_stats(
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

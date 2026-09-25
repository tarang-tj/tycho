"""Apollo17: Taurus-Littrow valley, Apollo 17 LRV final parking site
(NAC_DTM_APOLLO17).

Goal coordinate sourced this session: LROC post "Spacecraft Related
Coordinates - 2016 Update" (25 November 2016),
https://lroc.im-ldi.com/images/938 -- crewed-missions coordinates table,
row "Apollo 17 LRV | 20.1896 | 30.7769 | -2628 | 3.2" (mean observed
lat/lon in degrees, elevation in meters, uncertainty in meters; mean
Earth/polar axis (ME) frame, GLD100 shape model). Apollo 17 landed 11
December 1972 and its final surface EVA (during which the rover was left
parked) was 13 December 1972 (mission dates are common knowledge, not
independently re-sourced this session beyond the LROC post's own framing
of the mission as historical).
"""
from __future__ import annotations

import os

import numpy as np
from PIL import Image

from downloader import download
from georef import EquirectParams
from raster_ops import compute_mask_1024, fill_nodata, nodata_mask, area_resample
from shading import slope_deg
from tiff_ifd import read_header

from .common import (CACHE_DIR, MIN_CLEAR_OF_MASK_PX, enforce_clearance, line_slope_stats,
                      pick_best_spawn, shade_and_slope_1024, write_body)

Image.MAX_IMAGE_PIXELS = None

APOLLO17_URL = ("http://lroc.sese.asu.edu/data/LRO-L-LROC-5-RDR-V1.0/LROLRC_2001/"
                 "DATA/SDP/NAC_DTM/APOLLO17/NAC_DTM_APOLLO17.TIF")
APOLLO17_SIZE = 463_397_471
APOLLO17_CROP_PX = 1024  # native 5 m/px = 5.12km square, no resample needed

GOAL_LAT = 20.1896
GOAL_LON = 30.7769
GOAL_ELEV_CITED_M = -2628.0  # LROC post 938
GOAL_UNCERTAINTY_M = 3.2  # LROC post 938


def process_apollo17() -> None:
    print("== APOLLO17: Taurus-Littrow valley, Apollo 17 LRV parking site ==")
    raw = os.path.join(CACHE_DIR, "apollo17_raw.tif")
    download(APOLLO17_URL, raw, APOLLO17_SIZE)
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
          "(product page: 19.39-21.30N, 29.91-31.66E)")

    goal_i, goal_j = geo.latlon_to_pixel(GOAL_LAT, GOAL_LON)
    goal_row, goal_col = round(goal_j), round(goal_i)
    goal_elev = float(arr[goal_row, goal_col])
    print(f"  LRV pixel (row,col) {goal_row},{goal_col}  DTM elev {goal_elev:.1f} m "
          f"(LROC post 938 cites {GOAL_ELEV_CITED_M:.0f} m +/- {GOAL_UNCERTAINTY_M} m)")

    half = APOLLO17_CROP_PX // 2
    r0 = min(max(goal_row - half, 0), arr.shape[0] - APOLLO17_CROP_PX)
    c0 = min(max(goal_col - half, 0), arr.shape[1] - APOLLO17_CROP_PX)
    sub = arr[r0:r0 + APOLLO17_CROP_PX, c0:c0 + APOLLO17_CROP_PX]
    submask = mask[r0:r0 + APOLLO17_CROP_PX, c0:c0 + APOLLO17_CROP_PX]
    filled, frac = fill_nodata(sub, submask)
    goal_local = (goal_row - r0, goal_col - c0)

    # No sourced approach-direction for the LRV's final short hop back to
    # park near the SEP transmitter; search every compass bearing and keep
    # the one with the lowest spawn->goal line slope instead of fabricating one.
    spawn_local, _, _ = pick_best_spawn(filled, goal_local, native_mpp, submask)

    shade_1024, slope_1024 = shade_and_slope_1024(filled, native_mpp, 315.0, 45.0)
    resized = area_resample(filled, 1024, 1024)  # crop already 1024^2; identity resample

    scale = 1024 / APOLLO17_CROP_PX  # == 1.0
    goal = {"x": int(round(goal_local[1] * scale)), "y": int(round(goal_local[0] * scale))}
    spawn = {"x": int(round(spawn_local[1] * scale)), "y": int(round(spawn_local[0] * scale))}
    mpp = native_mpp * (APOLLO17_CROP_PX / 1024)

    mask_1024 = compute_mask_1024(submask, 1024, 1024)
    spawn, goal, clearance_note = enforce_clearance(resized, mask_1024, slope_1024, spawn, goal)

    slope_native = slope_deg(filled, native_mpp)
    max_slope, mean_slope = line_slope_stats(
        slope_native, (spawn["y"] / scale, spawn["x"] / scale), (goal["y"] / scale, goal["x"] / scale))
    dist_m = ((goal["y"] - spawn["y"]) ** 2 + (goal["x"] - spawn["x"]) ** 2) ** 0.5 * mpp
    print(f"  spawn->goal distance: {dist_m:.1f} m")
    print(f"  line slope (native 5m/px grid): max {max_slope:.2f} deg  mean {mean_slope:.2f} deg  "
          "(tip limit 32deg, co-pilot guardrail 25deg)")

    min_e, max_e = float(resized.min()), float(resized.max())
    notes = ("Shaded rendering of real LRO NAC DTM elevation (not a photo). Crop is a "
             f"{APOLLO17_CROP_PX * native_mpp / 1000:.2f}km square at native 5 m/px, "
             "centered on the pixel of the Apollo 17 Lunar Roving Vehicle's final "
             "parked position (a surveyed coordinate from LROC post \"Spacecraft "
             "Related Coordinates - 2016 Update\", not a proxy). Goal is the parked "
             "rover (\"Apollo 17 rover (parked 1972)\"); spawn is the point 1.5-3km "
             "away whose straight drivable line to the rover has the lowest max "
             "slope, searched across all compass bearings (no sourced approach "
             "direction for the LRV's final short hop back to the parking spot, "
             "so a bearing is not fabricated -- the algorithmically best-drivable "
             "direction is used instead). "
             "mask.bin marks nodata-filled cells (rendered as a hatched no-data "
             "texture in albedo.jpg/preview.png); spawn and goal are kept "
             f">= {MIN_CLEAR_OF_MASK_PX}px clear of them. The rover model in-engine "
             "is an illustrative period-accurate silhouette, not a survey model.")
    if clearance_note:
        notes += " " + clearance_note

    spawn_lat, spawn_lon = geo.pixel_to_latlon(c0 + spawn["x"] / scale, r0 + spawn["y"] / scale)
    extra_meta = {
        "siteName": "Taurus-Littrow valley, Apollo 17 site",
        "goalLabel": "Apollo 17 rover (parked 1972)",
        "goalLatLon": {"lat": GOAL_LAT, "lon": GOAL_LON},
        "spawnLatLon": {"lat": round(spawn_lat, 5), "lon": round(spawn_lon, 5)},
        "lrvElevCitedM": GOAL_ELEV_CITED_M,
        "lrvUncertaintyM": GOAL_UNCERTAINTY_M,
        "spawnGoalDistanceM": round(dist_m, 1),
        "lineSlopeDegMax": round(max_slope, 2),
        "lineSlopeDegMean": round(mean_slope, 2),
    }

    write_body(
        "apollo17", resized, shade_1024, slope_1024, mask_1024, min_e, max_e, mpp,
        spawn=spawn, goal=goal,
        source={"product": "NAC_DTM_APOLLO17",
                "url": "https://data.lroc.im-ldi.com/lroc/view_rdr/NAC_DTM_APOLLO17",
                "download": APOLLO17_URL,
                "factsSource": ("LROC post \"Spacecraft Related Coordinates - 2016 Update\", "
                                "https://lroc.im-ldi.com/images/938")},
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
    print(f"  goal (LRV) elev: {resized[goal['y'], goal['x']]:.1f} m  "
          f"spawn elev: {resized[spawn['y'], spawn['x']]:.1f} m")
    os.remove(raw)
    print(f"  deleted {raw}")

"""Change3: Mare Imbrium, Chang'e 3 lander + Yutu rover site
(NAC_DTM_CHANGE3).

Facts sourced this session from LROC post "Spacecraft Related Coordinates
- 2016 Update" (25 November 2016), https://lroc.im-ldi.com/images/938 --
crewed/robotic-missions coordinates table, rows:
  "Chang'e 3 | 44.1214 | 340.4883 | -2630 | 9.1"
  "Yutu Rover | 44.1208 | 340.4878 | -2630 | 12.9"
(lat/lon in degrees, elevation in meters, uncertainty in meters; mean
Earth/polar axis (ME) frame, GLD100 shape model, same table apollo17.py and
change4.py's cross-check both cite). Chang'e 3 landed on Mare Imbrium's
near side on 14 December 2013 and deployed the Yutu rover the same day
(mission dates are common knowledge, not independently re-sourced this
session beyond the LROC post's own framing of the mission as historical).

The DTM product page (https://data.lroc.im-ldi.com/lroc/view_rdr/
NAC_DTM_CHANGE3, fetched this session) lists Pixel Scale 5 m/px and
extent 43.10-45.63N, 340.21-341.03E -- both figures reused below.

Chang'e 3 is a near-side, direct-line-of-sight lander (unlike the far-side
Chang'e-4/Lunokhod 2 sites, which need relay.py's Earth->Queqiao model);
no relayModel is recorded here, matching apollo17.py's direct-delay
treatment.

Goal is the lander (the fixed platform); Yutu's separately surveyed
position and uncertainty are recorded in meta only (yutuLatLon,
yutuUncertaintyM) for L7 integration to use as a second landmark, per this
lane's scope (tools/sites/change3.py, tools/test_change3.py,
assets/change3/**  only -- registering either object into a live level is
out of this lane's file ownership).
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

CHANGE3_URL = ("http://lroc.sese.asu.edu/data/LRO-L-LROC-5-RDR-V1.0/LROLRC_2001/"
               "DATA/SDP/NAC_DTM/CHANGE3/NAC_DTM_CHANGE3.TIF")
CHANGE3_SIZE = 219_266_687
CHANGE3_CROP_PX = 1024  # native 5 m/px = 5.12km square, no resample needed

GOAL_LAT = 44.1214
GOAL_LON = 340.4883
GOAL_ELEV_CITED_M = -2630.0  # LROC post 938
GOAL_UNCERTAINTY_M = 9.1  # LROC post 938

YUTU_LAT = 44.1208
YUTU_LON = 340.4878
YUTU_ELEV_CITED_M = -2630.0  # LROC post 938
YUTU_UNCERTAINTY_M = 12.9  # LROC post 938

LANDING_DATE = "14 December 2013"  # LROC post 938 framing of the mission as historical


def process_change3() -> None:
    print("== CHANGE3: Mare Imbrium, Chang'e 3 lander + Yutu rover site ==")
    raw = os.path.join(CACHE_DIR, "change3_raw.tif")
    download(CHANGE3_URL, raw, CHANGE3_SIZE)
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
          "(product page: 43.10-45.63N, 340.21-341.03E)")

    goal_i, goal_j = geo.latlon_to_pixel(GOAL_LAT, GOAL_LON)
    goal_row, goal_col = round(goal_j), round(goal_i)
    goal_elev = float(arr[goal_row, goal_col])
    print(f"  lander pixel (row,col) {goal_row},{goal_col}  DTM elev {goal_elev:.1f} m "
          f"(LROC post 938 cites {GOAL_ELEV_CITED_M:.0f} m +/- {GOAL_UNCERTAINTY_M} m)")

    yutu_i, yutu_j = geo.latlon_to_pixel(YUTU_LAT, YUTU_LON)
    yutu_row, yutu_col = round(yutu_j), round(yutu_i)
    print(f"  Yutu rover pixel (row,col) {yutu_row},{yutu_col}  "
          f"(LROC post 938 cites {YUTU_ELEV_CITED_M:.0f} m +/- {YUTU_UNCERTAINTY_M} m)")

    half = CHANGE3_CROP_PX // 2
    r0 = min(max(goal_row - half, 0), arr.shape[0] - CHANGE3_CROP_PX)
    c0 = min(max(goal_col - half, 0), arr.shape[1] - CHANGE3_CROP_PX)
    sub = arr[r0:r0 + CHANGE3_CROP_PX, c0:c0 + CHANGE3_CROP_PX]
    submask = mask[r0:r0 + CHANGE3_CROP_PX, c0:c0 + CHANGE3_CROP_PX]
    filled, frac = fill_nodata(sub, submask)
    goal_local = (goal_row - r0, goal_col - c0)
    yutu_local = (yutu_row - r0, yutu_col - c0)
    edge_margin_px = min(goal_local[0], goal_local[1], CHANGE3_CROP_PX - 1 - goal_local[0],
                          CHANGE3_CROP_PX - 1 - goal_local[1])
    print(f"  lander is {edge_margin_px * native_mpp:.0f} m inside the crop edge")

    # No sourced approach-direction for the lander (unlike Lunokhod 2's
    # LROC post 699); search every compass bearing and keep the one with
    # the lowest max line slope, same unweighted search apollo17.py uses
    # (change4.py's tightened/tortuosity-weighted search was a fix for a
    # specific playthrough-length problem found there, not evidence that
    # applies here).
    spawn_local, _, _ = pick_best_spawn(filled, goal_local, native_mpp, submask)

    shade_1024, slope_1024 = shade_and_slope_1024(filled, native_mpp, 315.0, 45.0)
    resized = area_resample(filled, 1024, 1024)  # crop already 1024^2; identity resample

    scale = 1024 / CHANGE3_CROP_PX  # == 1.0
    goal = {"x": int(round(goal_local[1] * scale)), "y": int(round(goal_local[0] * scale))}
    spawn = {"x": int(round(spawn_local[1] * scale)), "y": int(round(spawn_local[0] * scale))}
    yutu_1024 = {"x": int(round(yutu_local[1] * scale)), "y": int(round(yutu_local[0] * scale))}
    mpp = native_mpp * (CHANGE3_CROP_PX / 1024)

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
             f"{CHANGE3_CROP_PX * native_mpp / 1000:.2f}km square at native 5 m/px, "
             "centered on the pixel of the Chang'e 3 lander (a surveyed coordinate, "
             "not a proxy). Goal is the lander (\"Chang'e 3 lander (landed 2013)\"); "
             "spawn is the point 1.5-3km away whose straight drivable line to the "
             "lander has the lowest max slope, searched across all compass bearings "
             "(no sourced approach direction for this landing, so a bearing is not "
             "fabricated -- the algorithmically best-drivable direction is used "
             "instead). Yutu rover's separately surveyed final position (LROC post "
             "938) is recorded in yutuLatLon/yutuUncertaintyM for reference; it is "
             "not the goal and is not placed as an object by this pipeline step. "
             "mask.bin marks nodata-filled cells (rendered as a hatched no-data "
             "texture in albedo.jpg/preview.png); spawn and goal are kept "
             f">= {MIN_CLEAR_OF_MASK_PX}px clear of them. Chang'e 3 is a near-side, "
             "direct-line-of-sight lander, so no relay delay model is recorded here "
             "(unlike the far-side Chang'e-4/Lunokhod 2 sites).")
    if clearance_note:
        notes += " " + clearance_note

    spawn_lat, spawn_lon = geo.pixel_to_latlon(c0 + spawn["x"] / scale, r0 + spawn["y"] / scale)
    extra_meta = {
        "siteName": "Mare Imbrium, Chang'e 3 lander site",
        "goalLabel": "Chang'e 3 lander (landed 2013)",
        "goalLatLon": {"lat": GOAL_LAT, "lon": GOAL_LON},
        "spawnLatLon": {"lat": round(spawn_lat, 5), "lon": round(spawn_lon, 5)},
        "landingDate": LANDING_DATE,
        "landerElevCitedM": GOAL_ELEV_CITED_M,
        "landerUncertaintyM": GOAL_UNCERTAINTY_M,
        "yutuLatLon": {"lat": YUTU_LAT, "lon": YUTU_LON},
        "yutuElevCitedM": YUTU_ELEV_CITED_M,
        "yutuUncertaintyM": YUTU_UNCERTAINTY_M,
        "yutuPixel1024": yutu_1024,
        "spawnGoalDistanceM": round(dist_m, 1),
        "lineSlopeDegMax": round(max_slope, 2),
        "lineSlopeDegMean": round(mean_slope, 2),
    }

    write_body(
        "change3", resized, shade_1024, slope_1024, mask_1024, min_e, max_e, mpp,
        spawn=spawn, goal=goal,
        source={"product": "NAC_DTM_CHANGE3",
                "url": "https://data.lroc.im-ldi.com/lroc/view_rdr/NAC_DTM_CHANGE3",
                "download": CHANGE3_URL,
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
    print(f"  goal (lander) elev: {resized[goal['y'], goal['x']]:.1f} m  "
          f"spawn elev: {resized[spawn['y'], spawn['x']]:.1f} m")
    os.remove(raw)
    print(f"  deleted {raw}")

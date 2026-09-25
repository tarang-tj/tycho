"""Change4: Von Karman crater, Chang'e-4 lander site (NAC_DTM_CHANGE4).

Goal coordinate frame fix (H1, corrected this session): the terrain product
shipped here (NAC_DTM_CHANGE4) is an LRO-frame DTM. Liu, B. et al. 2019,
"Descent trajectory reconstruction and landing site positioning of
Chang'E-4 on the lunar farside", Nature Communications 10:4229
(PMC6760200), gives the lander's position as "177.5991 deg E, 45.4446 deg
S" -- but that headline figure is in the CE2TMap2015 (Chang'e-2) frame, not
the LRO frame, and the same paper states the deviation directly: "Compared
with the positioning results of the landing site based on LRO terrain data
(177.5885 deg E, 45.4561 deg S, -5927 m) ... The total positional deviation
is 415 m." Placing the CE2TMap2015 coordinate on this LRO-frame DTM would
put the goal about 415 m from where the real lander sits in the terrain
the player drives.

The goal below instead uses LROC's own LRO-frame position, from LROC post
1087, "Chang'e 4 Lander Coordinates" (https://lroc.im-ldi.com/posts/1087):
"The Chang'e 4 spacecraft set down between the two arrows at 45.457 S,
177.589 E, plus or minus 20 meters." LROC's value is preferred as the goal
because it shares this DTM product's own lineage (both are LROC/LRO-frame
products); Liu et al.'s LRO-frame value above (177.5885E, 45.4561S) is
cited alongside it and agrees within about 20 m, well inside LROC's stated
uncertainty. The landing date (3 January 2019) still comes from Liu et al.
2019: "The Chang'E-4 (CE-4) spacecraft successfully landed on the lunar
farside on January 3, 2019."
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
from .relay import RELAY_PATH_LABEL, relay_light_time_sec

Image.MAX_IMAGE_PIXELS = None

CHANGE4_URL = ("http://lroc.sese.asu.edu/data/LRO-L-LROC-5-RDR-V1.0/LROLRC_2001/"
               "DATA/SDP/NAC_DTM/CHANGE4/NAC_DTM_CHANGE4.TIF")
CHANGE4_SIZE = 48_057_695
CHANGE4_CROP_PX = 1024  # native 5 m/px = 5.12km square, no resample needed

# LRO-frame goal (H1 fix): LROC post 1087, "Chang'e 4 Lander Coordinates",
# https://lroc.im-ldi.com/posts/1087 -- "45.457 S, 177.589 E, plus or minus
# 20 meters." Preferred over Liu et al.'s CE2TMap2015-frame figure because
# it matches this DTM's own (LRO) frame; see module docstring.
GOAL_LAT = -45.457
GOAL_LON = 177.589
GOAL_ELEV_CITED_M = -5927.0  # Liu et al. 2019, LRO-frame figure (see docstring)

# Liu et al. 2019's own LRO-frame value, cited for cross-check only (not
# used to place the goal): agrees with LROC post 1087 within ~20 m.
GOAL_LAT_LIU_LRO_FRAME = -45.4561
GOAL_LON_LIU_LRO_FRAME = 177.5885

# Liu et al. 2019's CE2TMap2015-frame headline figure, NOT used as the goal
# (see H1 in the docstring): placing it on this LRO-frame DTM would put the
# goal ~415 m from the real lander.
GOAL_LAT_LIU_CE2TMAP_FRAME = -45.4446
GOAL_LON_LIU_CE2TMAP_FRAME = 177.5991

LANDING_DATE = "3 January 2019"  # Liu et al. 2019


def process_change4() -> None:
    print("== CHANGE4: Von Karman crater, Chang'e-4 landing site ==")
    raw = os.path.join(CACHE_DIR, "change4_raw.tif")
    download(CHANGE4_URL, raw, CHANGE4_SIZE)
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
          "(product page: -46.22 to -45.31N, 177.29 to 177.80E)")

    goal_i, goal_j = geo.latlon_to_pixel(GOAL_LAT, GOAL_LON)
    goal_row, goal_col = round(goal_j), round(goal_i)
    goal_elev = float(arr[goal_row, goal_col])
    print(f"  lander pixel (row,col) {goal_row},{goal_col}  DTM elev {goal_elev:.1f} m "
          f"(Liu et al. 2019 cites {GOAL_ELEV_CITED_M:.0f} m)")

    # The DTM's north edge (least-negative latitude, row 0) sits only ~0.13
    # deg (~15 km) north of the lander; a naive centered crop is still well
    # clear of that edge at this crop size, but clamp defensively the same
    # way lunokhod/mars do so an off-center crop is used automatically if
    # the lander is ever close enough to the edge to require it.
    half = CHANGE4_CROP_PX // 2
    r0 = min(max(goal_row - half, 0), arr.shape[0] - CHANGE4_CROP_PX)
    c0 = min(max(goal_col - half, 0), arr.shape[1] - CHANGE4_CROP_PX)
    sub = arr[r0:r0 + CHANGE4_CROP_PX, c0:c0 + CHANGE4_CROP_PX]
    submask = mask[r0:r0 + CHANGE4_CROP_PX, c0:c0 + CHANGE4_CROP_PX]
    filled, frac = fill_nodata(sub, submask)
    goal_local = (goal_row - r0, goal_col - c0)
    edge_margin_px = min(goal_local[0], goal_local[1], CHANGE4_CROP_PX - 1 - goal_local[0],
                          CHANGE4_CROP_PX - 1 - goal_local[1])
    print(f"  lander is {edge_margin_px * native_mpp:.0f} m inside the crop edge "
          f"(>= 500 m required)")

    # No sourced approach-direction for the lander (unlike Lunokhod 2's LROC
    # post 699); search every compass bearing and keep the one with the
    # lowest spawn->goal line slope instead of fabricating a bearing.
    spawn_local, _, _ = pick_best_spawn(filled, goal_local, native_mpp, submask)

    shade_1024, slope_1024 = shade_and_slope_1024(filled, native_mpp, 315.0, 45.0)
    resized = area_resample(filled, 1024, 1024)  # crop already 1024^2; identity resample

    scale = 1024 / CHANGE4_CROP_PX  # == 1.0
    goal = {"x": int(round(goal_local[1] * scale)), "y": int(round(goal_local[0] * scale))}
    spawn = {"x": int(round(spawn_local[1] * scale)), "y": int(round(spawn_local[0] * scale))}
    mpp = native_mpp * (CHANGE4_CROP_PX / 1024)

    mask_1024 = compute_mask_1024(submask, 1024, 1024)
    spawn, goal, clearance_note = enforce_clearance(resized, mask_1024, slope_1024, spawn, goal)

    slope_native = slope_deg(filled, native_mpp)
    max_slope, mean_slope = line_slope_stats(
        slope_native, (spawn["y"] / scale, spawn["x"] / scale), (goal["y"] / scale, goal["x"] / scale))
    dist_m = ((goal["y"] - spawn["y"]) ** 2 + (goal["x"] - spawn["x"]) ** 2) ** 0.5 * mpp
    print(f"  spawn->goal distance: {dist_m:.1f} m")
    print(f"  line slope (native 5m/px grid): max {max_slope:.2f} deg  mean {mean_slope:.2f} deg  "
          "(tip limit 32deg, co-pilot guardrail 25deg)")

    one_way_sec, legs_km = relay_light_time_sec()
    print(f"  relay one-way light time Earth->Queqiao->farside: {one_way_sec:.2f} s "
          f"(legs {legs_km[0]:.0f} km + {legs_km[1]:.0f} km)")

    min_e, max_e = float(resized.min()), float(resized.max())
    notes = ("Shaded rendering of real LRO NAC DTM elevation (not a photo). Crop is a "
             f"{CHANGE4_CROP_PX * native_mpp / 1000:.2f}km square at native 5 m/px, "
             "centered on the pixel of the Chang'e-4 lander (a surveyed coordinate, "
             "not a proxy). Goal uses LROC post 1087's LRO-frame coordinate "
             f"({-GOAL_LAT:.3f} S, {GOAL_LON:.3f} E, +/-20 m), which matches this DTM's "
             "own frame; Liu et al. 2019 Nature Communications report an LRO-frame "
             f"value ({-GOAL_LAT_LIU_LRO_FRAME:.4f} S, {GOAL_LON_LIU_LRO_FRAME:.4f} E) that "
             "agrees within ~20 m. Liu et al.'s other (CE2TMap2015-frame) coordinate "
             f"({-GOAL_LAT_LIU_CE2TMAP_FRAME:.4f} S, {GOAL_LON_LIU_CE2TMAP_FRAME:.4f} E) is "
             "a different frame and is deliberately not used here: it would place the "
             "goal about 415 m from the real lander in this LRO-frame DTM. Goal is the "
             "lander (\"Chang'e-4 lander (landed 2019)\"); spawn is the point "
             "1.5-3km away whose straight drivable line to the lander has the "
             "lowest max slope, searched across all compass bearings (no sourced "
             "approach direction exists for this landing, unlike Lunokhod 2, so a "
             "bearing is not fabricated -- the algorithmically best-drivable "
             "direction is used instead). "
             "mask.bin marks nodata-filled cells (rendered as a hatched no-data "
             "texture in albedo.jpg/preview.png); spawn and goal are kept "
             f">= {MIN_CLEAR_OF_MASK_PX}px clear of them. delayModel gives an "
             "honest but simplified one-way relay light-time estimate for the "
             "Earth->Queqiao->farside link (see tools/sites/relay.py for the "
             "sourced inputs and stated approximation).")
    if clearance_note:
        notes += " " + clearance_note

    spawn_lat, spawn_lon = geo.pixel_to_latlon(c0 + spawn["x"] / scale, r0 + spawn["y"] / scale)
    extra_meta = {
        "siteName": "Von Karman crater, Chang'e-4 landing site",
        "goalLabel": "Chang'e-4 lander (landed 2019)",
        "goalLatLon": {"lat": GOAL_LAT, "lon": GOAL_LON},
        "goalLatLonNote": ("LRO frame, LROC post 1087 (https://lroc.im-ldi.com/posts/1087), "
                            "+/-20 m; agrees within ~20 m with Liu et al. 2019's own LRO-frame "
                            f"value ({GOAL_LAT_LIU_LRO_FRAME}, {GOAL_LON_LIU_LRO_FRAME}). Liu et "
                            f"al.'s CE2TMap2015-frame value ({GOAL_LAT_LIU_CE2TMAP_FRAME}, "
                            f"{GOAL_LON_LIU_CE2TMAP_FRAME}) is a different frame, not used as "
                            "the goal here: it would misplace the goal ~415 m in this LRO-frame "
                            "DTM (Liu et al. state the 415 m deviation directly)."),
        "spawnLatLon": {"lat": round(spawn_lat, 5), "lon": round(spawn_lon, 5)},
        "landingDate": LANDING_DATE,
        "landerElevCitedM": GOAL_ELEV_CITED_M,
        "spawnGoalDistanceM": round(dist_m, 1),
        "lineSlopeDegMax": round(max_slope, 2),
        "lineSlopeDegMean": round(mean_slope, 2),
        "delayModel": {
            "type": "relay",
            "oneWaySec": round(one_way_sec, 2),
            "pathLabel": RELAY_PATH_LABEL,
            "legsKm": [round(legs_km[0], 0), round(legs_km[1], 0)],
            "sources": [
                "NASA Moon Fact Sheet (Earth-Moon 384400 km, Moon radius 1737.4 km), "
                "https://nssdc.gsfc.nasa.gov/planetary/factsheet/moonfact.html",
                "The Planetary Society, \"How China's lunar relay satellite arrived "
                "in its final orbit\" (Queqiao ~65000 km beyond the Moon at L2), "
                "https://www.planetary.org/articles/20180615-queqiao-orbit-explainer",
                "\"Development and Prospect of Chinese Lunar Relay Communication "
                "Satellite\", Space: Science & Technology 2021 (Queqiao's halo-orbit "
                "Z-amplitude ~13000 km, distance to the Moon 47000-79000 km), "
                "https://spj.science.org/doi/10.34133/2021/3471608",
            ],
            "caveat": ("Simplified collinear model, not a precise ephemeris; "
                       "Queqiao's real halo orbit varies roughly 47000-79000 km "
                       "from the Moon (Space: Science & Technology 2021), and the "
                       "lander is not exactly at the sub-L2 point (about 1400 km away, "
                       "~2 ms effect on the delay). See tools/sites/relay.py docstring."),
        },
    }

    write_body(
        "change4", resized, shade_1024, slope_1024, mask_1024, min_e, max_e, mpp,
        spawn=spawn, goal=goal,
        source={"product": "NAC_DTM_CHANGE4",
                "url": "https://data.lroc.im-ldi.com/lroc/view_rdr/NAC_DTM_CHANGE4",
                "download": CHANGE4_URL,
                "factsSource": ("LROC post 1087, \"Chang'e 4 Lander Coordinates\" (lander "
                                "position, LRO frame), https://lroc.im-ldi.com/posts/1087; "
                                "Liu, B. et al. 2019, \"Descent trajectory reconstruction and "
                                "landing site positioning of Chang'E-4 on the lunar farside\" "
                                "(landing date and cross-check position), Nature Communications "
                                "10:4229, https://pmc.ncbi.nlm.nih.gov/articles/PMC6760200/")},
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

"""Apollo15: Hadley-Apennine valley, Apollo 15 LRV final parking site
(NAC_DTM_APOLLO15).

Goal coordinate sourced this session: LROC post "Spacecraft Related
Coordinates - 2016 Update" (25 November 2016),
https://lroc.im-ldi.com/images/938 -- crewed-missions coordinates table,
row "Apollo 15 LRV | 26.13174 | 3.63803 | -1928 | 0.5" (mean observed
lat/lon in degrees, elevation in meters, uncertainty in meters; mean
Earth/polar axis (ME) frame, GLD100 shape model). Apollo 15 landed 30 July
1971 and was the first mission to use the Lunar Roving Vehicle (NSSDC
1971-063A, https://nssdc.gsfc.nasa.gov/nmc/spacecraft/display.action?id=1971-063A).

DTM product confirmed this session: data.lroc.im-ldi.com/lroc/view_rdr/
NAC_DTM_APOLLO15 -- 2 m/px, footprint 25.59-26.54N 3.50-3.69E, TIF
146,373,579 bytes at lroc.sese.asu.edu/data/LRO-L-LROC-5-RDR-V1.0/
LROLRC_2001/DATA/SDP/NAC_DTM/APOLLO15/NAC_DTM_APOLLO15.TIF (HTTP 200, size
matches the product page exactly). Header read this session: 2555x14311
px at 2.0 m/px (a narrow N-S strip, 5.11km wide x 28.62km tall), GeoTIFF
Equirectangular on the Moon ellipsoid (radius 1737400 m), std parallel
26.0N, center lon 180.0 -- corner lat/lon computed from these tags
(26.5361N/25.5923N, 3.5026E/3.6901E) match the product page's stated
extent. The LRV coordinate projects to pixel (row 6131, col 1845), 709 px
(1.42 km) from the strip's east edge -- confirms plan assumption A5's
"~1.4km from east edge" estimate. A 1024x1024 crop centered on that pixel
(2.05km square, native 2 m/px, no resample) stays fully inside the strip
(r0=5619, c0=1333, both within [0, height-1024]/[0, width-1024]) and reads
0.0% nodata pixels in the crop (measured directly against the downloaded
TIF this session), well under the A5 5% clearance threshold. The DTM's own
elevation at the goal pixel is -1925.3 m, within 3 m of LROC post 938's
cited -1928 m (same kind of small cross-model offset apollo17.py's cited
-2628 m shows against its own DTM elevation).
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

APOLLO15_URL = ("http://lroc.sese.asu.edu/data/LRO-L-LROC-5-RDR-V1.0/LROLRC_2001/"
                 "DATA/SDP/NAC_DTM/APOLLO15/NAC_DTM_APOLLO15.TIF")
APOLLO15_SIZE = 146_373_579
APOLLO15_CROP_PX = 1024  # native 2 m/px = 2.05km square, no resample needed

GOAL_LAT = 26.13174
GOAL_LON = 3.63803
GOAL_ELEV_CITED_M = -1928.0  # LROC post 938
GOAL_UNCERTAINTY_M = 0.5  # LROC post 938


def crop_origin(goal_row: int, goal_col: int, height: int, width: int,
                 crop_px: int = APOLLO15_CROP_PX) -> tuple[int, int]:
    """Top-left (r0, c0) of the crop_px square crop centered on
    (goal_row, goal_col), clamped so the crop stays fully inside a
    (height, width) raster. Pure function so A5 (crop fits inside the
    strip) can be unit-tested without downloading the DTM."""
    half = crop_px // 2
    r0 = min(max(goal_row - half, 0), height - crop_px)
    c0 = min(max(goal_col - half, 0), width - crop_px)
    return r0, c0


def process_apollo15() -> None:
    print("== APOLLO15: Hadley-Apennine valley, Apollo 15 LRV parking site ==")
    raw = os.path.join(CACHE_DIR, "apollo15_raw.tif")
    download(APOLLO15_URL, raw, APOLLO15_SIZE)
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
          "(product page: 25.59-26.54N, 3.50-3.69E)")

    goal_i, goal_j = geo.latlon_to_pixel(GOAL_LAT, GOAL_LON)
    goal_row, goal_col = round(goal_j), round(goal_i)
    goal_elev = float(arr[goal_row, goal_col])
    print(f"  LRV pixel (row,col) {goal_row},{goal_col}  DTM elev {goal_elev:.1f} m "
          f"(LROC post 938 cites {GOAL_ELEV_CITED_M:.0f} m +/- {GOAL_UNCERTAINTY_M} m)")

    r0, c0 = crop_origin(goal_row, goal_col, arr.shape[0], arr.shape[1])
    sub = arr[r0:r0 + APOLLO15_CROP_PX, c0:c0 + APOLLO15_CROP_PX]
    submask = mask[r0:r0 + APOLLO15_CROP_PX, c0:c0 + APOLLO15_CROP_PX]
    filled, frac = fill_nodata(sub, submask)
    goal_local = (goal_row - r0, goal_col - c0)
    print(f"  crop nodata fraction: {frac:.3%} (A5 threshold: <= 5%)")

    # No sourced approach-direction for the LRV's final short hop back to
    # park near the SEP transmitter/ALSEP site; search every compass
    # bearing and keep the one with the lowest spawn->goal line slope
    # instead of fabricating one (same approach as apollo17.py). The
    # default 1500-3000m search radius (tuned for apollo17's 5.12km crop
    # at 5 m/px) does not fit inside this crop: at native 2 m/px, a 1024px
    # crop is only 2.05km square, so the goal-to-edge distance here is
    # ~1024m max, well under 1500m -- pick_best_spawn raises "no drivable
    # spawn candidate" with the default radius (confirmed this session).
    # 400-900m keeps the search inside the crop and matches this lane's
    # accept range (spawn-goal distance 400m-2km).
    spawn_local, _, _ = pick_best_spawn(filled, goal_local, native_mpp, submask,
                                         r_min_m=400.0, r_max_m=900.0)

    shade_1024, slope_1024 = shade_and_slope_1024(filled, native_mpp, 315.0, 45.0)
    resized = area_resample(filled, 1024, 1024)  # crop already 1024^2; identity resample

    scale = 1024 / APOLLO15_CROP_PX  # == 1.0
    goal = {"x": int(round(goal_local[1] * scale)), "y": int(round(goal_local[0] * scale))}
    spawn = {"x": int(round(spawn_local[1] * scale)), "y": int(round(spawn_local[0] * scale))}
    mpp = native_mpp * (APOLLO15_CROP_PX / 1024)

    mask_1024 = compute_mask_1024(submask, 1024, 1024)
    spawn, goal, clearance_note = enforce_clearance(resized, mask_1024, slope_1024, spawn, goal)

    slope_native = slope_deg(filled, native_mpp)
    max_slope, mean_slope = line_slope_stats(
        slope_native, (spawn["y"] / scale, spawn["x"] / scale), (goal["y"] / scale, goal["x"] / scale))
    dist_m = ((goal["y"] - spawn["y"]) ** 2 + (goal["x"] - spawn["x"]) ** 2) ** 0.5 * mpp
    print(f"  spawn->goal distance: {dist_m:.1f} m")
    print(f"  line slope (native 2m/px grid): max {max_slope:.2f} deg  mean {mean_slope:.2f} deg  "
          "(tip limit 32deg, co-pilot guardrail 25deg)")

    min_e, max_e = float(resized.min()), float(resized.max())
    notes = ("Shaded rendering of real LRO NAC DTM elevation (not a photo). Crop is a "
             f"{APOLLO15_CROP_PX * native_mpp / 1000:.2f}km square at native 2 m/px, "
             "centered on the pixel of the Apollo 15 Lunar Roving Vehicle's final "
             "parked position (a surveyed coordinate from LROC post \"Spacecraft "
             "Related Coordinates - 2016 Update\", not a proxy). Goal is the parked "
             "rover (\"Apollo 15 rover (parked 1971)\"); spawn is the point 400-900m "
             "away (a smaller search radius than apollo17's 1.5-3km: this crop is "
             "only 2.05km square at native 2 m/px, so a 1.5km+ radius does not fit) "
             "whose straight drivable line to the rover has the lowest max "
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
        "siteName": "Hadley-Apennine valley, Apollo 15 site",
        "goalLabel": "Apollo 15 rover (parked 1971)",
        "goalLatLon": {"lat": GOAL_LAT, "lon": GOAL_LON},
        "spawnLatLon": {"lat": round(spawn_lat, 5), "lon": round(spawn_lon, 5)},
        "lrvElevCitedM": GOAL_ELEV_CITED_M,
        "lrvUncertaintyM": GOAL_UNCERTAINTY_M,
        "spawnGoalDistanceM": round(dist_m, 1),
        "lineSlopeDegMax": round(max_slope, 2),
        "lineSlopeDegMean": round(mean_slope, 2),
    }

    write_body(
        "apollo15", resized, shade_1024, slope_1024, mask_1024, min_e, max_e, mpp,
        spawn=spawn, goal=goal,
        source={"product": "NAC_DTM_APOLLO15",
                "url": "https://data.lroc.im-ldi.com/lroc/view_rdr/NAC_DTM_APOLLO15",
                "download": APOLLO15_URL,
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

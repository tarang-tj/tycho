"""Moon: Tycho central peak (NAC_DTM_TYCHOPK01)."""
from __future__ import annotations

import os

import numpy as np
from PIL import Image

from downloader import download
from raster_ops import compute_mask_1024, fill_nodata, nodata_mask, area_resample
from site_picker import find_best_square_crop, find_peak, pick_moon_spawn
from tiff_ifd import read_header

from .common import CACHE_DIR, MIN_CLEAR_OF_MASK_PX, enforce_clearance, shade_and_slope_1024, write_body

Image.MAX_IMAGE_PIXELS = None  # these are legitimate large scientific rasters

MOON_URL = ("http://lroc.sese.asu.edu/data/LRO-L-LROC-5-RDR-V1.0/LROLRC_2001/"
            "DATA/SDP/NAC_DTM/TYCHOPK01/NAC_DTM_TYCHOPK01.TIF")
MOON_SIZE = 212_486_239
# 1200px = 2.4km square @ native 2m/px. Centering purely on the peak leaves
# ~14% nodata (the peak sits near the edge of this diagonal stereo swath);
# find_best_square_crop instead searches nearby placements for the one with
# least nodata while still containing the peak (cut it to ~7.5% here).
MOON_CROP_PX = 1200


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
    shade_1024, slope_1024 = shade_and_slope_1024(filled, native_mpp, 315.0, 45.0)
    resized = area_resample(filled, 1024, 1024)

    mpp = native_mpp * (MOON_CROP_PX / 1024)
    scale = 1024 / MOON_CROP_PX
    goal = {"x": int(round(peak_local[1] * scale)), "y": int(round(peak_local[0] * scale))}
    spawn = {"x": int(round(spawn_local[1] * scale)), "y": int(round(spawn_local[0] * scale))}

    mask_1024 = compute_mask_1024(submask, 1024, 1024)
    spawn, goal, clearance_note = enforce_clearance(resized, mask_1024, slope_1024, spawn, goal)

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

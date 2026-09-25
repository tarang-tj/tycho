"""Mars: Jezero crater / Octavia E. Butler Landing (CTX DEM)."""
from __future__ import annotations

import os

import numpy as np
from PIL import Image

from downloader import download
from georef import EquirectParams
from raster_ops import compute_mask_1024, fill_nodata, nodata_mask, area_resample
from site_picker import pick_mars_goal
from tiff_ifd import read_header

from .common import CACHE_DIR, MIN_CLEAR_OF_MASK_PX, enforce_clearance, shade_and_slope_1024, write_body

Image.MAX_IMAGE_PIXELS = None

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
    shade_1024, slope_1024 = shade_and_slope_1024(filled, native_mpp, 270.0, 35.0)
    resized = area_resample(filled, 1024, 1024)  # crop already 1024^2; identity resample

    spawn = {"x": int(spawn_rc[1]), "y": int(spawn_rc[0])}
    goal = {"x": int(goal_rc[1]), "y": int(goal_rc[0])}

    mask_1024 = compute_mask_1024(submask, 1024, 1024)
    spawn, goal, clearance_note = enforce_clearance(resized, mask_1024, slope_1024, spawn, goal)

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

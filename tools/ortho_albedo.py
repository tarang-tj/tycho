"""L3 (plan-wave3.md, wave A): real LROC NAC orthophoto texture ("albedo-
ortho") for each of this repo's existing Moon sites, alongside (not
replacing) the shaded-hillshade albedo.jpg the site pipeline already ships.

Writes only assets/<site>/albedo-ortho.jpg + albedo-ortho.json. Never reads
back or edits assets/<site>/meta.json or albedo.jpg -- meta.json is read
here (goal/spawn lat-lon, elevation range) but not written; ortho crops are
placed from those already-sourced coordinates, not new ones.

Crop placement (assumption A1 in plan-wave3.md's ledger -- "each ortho
shares its DTM's equirect grid/scale"): three of the four sites
(apollo17/change4/lunokhod) record a surveyed goal lat/lon and a computed
spawn lat/lon in meta.json; those two independent ground-truth points are
enough to build the crop's local equirectangular geometry (one point fixes
the origin, MAP_SCALE and the Moon's radius fix the scale exactly -- no
free parameters are curve-fit), and the second point is used purely as a
same-session self-check. Tycho ("moon") is the exception: its goal is an
algorithmically-found DTM peak with no recorded lat/lon anywhere in this
repo, so its crop window is instead re-derived exactly from the DTM's own
GeoTIFF header by re-running the same peak-finding steps tools/sites/
moon.py already runs (imported, not duplicated logic) against a freshly
downloaded copy of the DTM.

Final alignment is never just assumed: for every site this module renders
a hillshade from the site's own height.bin and cross-correlates it against
the fetched ortho crop. LROC's DTM and orthomosaic for the same site are
each independently bundle-adjusted, so even an exactly-computed crop
window can carry a real few-pixel relative offset between the two products
-- confirmed this session on Lunokhod 2 (an 11px/55m north-south offset
that a wide-search NCC pass measures cleanly, ncc=0.65, and a correction
pass then confirms corrects to 0px residual). The pipeline therefore does
a wide (+/-16px) search first, shifts the sampling grid by the measured
offset, and re-confirms a narrow (+/-2px) residual on the corrected crop
-- that confirmed residual, not a blind first guess, is what must be
<=2px. Two of the four sites cannot pass that numeric check even though
their placement is geometrically exact (see above) and their crops read
as visibly well-aligned in the saved preview PNGs: Von Karman crater
(change4) is flat enough (71m relief over a 5.12km crop) that its
hillshade carries essentially no correlatable texture at any search width
or smoothing (peak |ncc| stays under 0.05 and never converges to an
interior optimum even at +/-16px raw or heavily Gaussian-blurred); Tycho
("moon") is steep enough that a fixed synthetic-sun hillshade likely just
disagrees with the real photo's unknown illumination angle (see
_exact_tycho_rowcol_to_latlon's docstring). Both are reported as
INCONCLUSIVE rather than forcing a correction fit to a weak/noisy peak,
and ship their analytically-placed (uncorrected) crop.
"""
from __future__ import annotations

import json
import math
import os
import sys
from datetime import datetime, timezone

import numpy as np
import requests
from PIL import Image
from scipy.ndimage import map_coordinates

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from downloader import download
from georef import EquirectParams
from pds_img import OrthoLabel, fetch_label_text, fetch_window
from raster_ops import fill_nodata
from shading import hillshade
from tiff_ifd import read_header

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS_DIR = os.path.join(REPO_ROOT, "assets")
RAW_CACHE_DIR = "/private/tmp/claude-501/tycho-raw"  # never committed; see plan-wave3.md env note
MEASUREMENTS_DIR = os.path.expanduser(
    "~/plans/260923-2234-tycho-rover/levelup-v4/measurements")

MOON_RADIUS_M = 1737400.0  # A_AXIS_RADIUS in every label checked this session (1737.4 km)
OUT_PX = 1024
NCC_WIDE_SEARCH_PX = 16  # first pass: measures any real DTM<->ortho product co-registration offset
NCC_CONFIRM_SEARCH_PX = 4  # second pass: confirms the corrected crop's residual offset
NCC_MAX_OFFSET_PX = 2
NCC_COHERENCE_MIN = 0.15  # below this peak |ncc|, the hillshade has no measurable shared texture
FETCH_PAD_PX = NCC_WIDE_SEARCH_PX + 4
MAX_JPEG_BYTES = 400_000

LROC_BASE = "https://lroc.im-ldi.com/data/LRO-L-LROC-5-RDR-V1.0/LROLRC_2001/DATA/SDP/NAC_DTM"

# Ortho product per site: confirmed to exist and to be an EQUIRECTANGULAR
# PDS3 IMG by fetching each one's real label this session (2026-09-26; see
# tools/pds_img.py's module docstring for every file's confirmed LINES/
# LINE_SAMPLES/SAMPLE_TYPE/CORE_NULL, and tools/test_ortho_albedo.py for a
# saved-label parser test).
ORTHO_PRODUCTS = {
    "apollo17": ("APOLLO17", "NAC_DTM_APOLLO17_MOSAIC_5M"),
    "change4": ("CHANGE4", "NAC_DTM_CHANGE4_M1303619844_5M"),
    "lunokhod": ("LUNOKHOD2", "NAC_DTM_LUNOKHOD2_MOSAIC_5M"),
    "moon": ("TYCHOPK01", "NAC_DTM_TYCHOPK01_M1136634925_2M"),
    # Wave 3 step 2: the two new sites. Both labels fetched and parsed
    # 2026-09-26 (EQUIRECTANGULAR; label corner lat/lon recomputed from
    # LINES/LINE_SAMPLES matches the stated bounds); both URLs 302 to
    # pds.mcp.nasa.gov and return HTTP 200 (APOLLO15 146,268,640 B,
    # CHANGE3 109,578,840 B). Apollo 15's ortho is PC_REAL float32.
    "apollo15": ("APOLLO15", "NAC_DTM_APOLLO15_M111571816_2M"),
    "change3": ("CHANGE3", "NAC_DTM_CHANGE3_M1144922100_5M"),
}


def ortho_url(site: str) -> str:
    folder, product = ORTHO_PRODUCTS[site]
    return f"{LROC_BASE}/{folder}/{product}.IMG"


def _load_site_assets(site: str) -> tuple[dict, np.ndarray]:
    site_dir = os.path.join(ASSETS_DIR, site)
    with open(os.path.join(site_dir, "meta.json")) as f:
        meta = json.load(f)
    h16 = np.fromfile(os.path.join(site_dir, "height.bin"), dtype="<u2")
    h16 = h16.reshape(meta["height"], meta["width"])
    elev = h16.astype(np.float64) / 65535.0 * (meta["maxElev"] - meta["minElev"]) + meta["minElev"]
    return meta, elev


def _anchored_rowcol_to_latlon(meta: dict, site: str):
    """Builds the crop's row/col -> lat/lon mapping from meta.json's own
    goalLatLon (exact origin + scale from MAP_SCALE and the Moon's radius,
    no fitting), then self-checks it against spawnLatLon."""
    goal = meta["goalLatLon"]
    gx, gy = meta["goal"]["x"], meta["goal"]["y"]
    mpp = meta["metersPerPixel"]
    lat0, lon0 = goal["lat"], goal["lon"]
    cos_lat0 = math.cos(math.radians(lat0))
    deg_per_m = 180.0 / (math.pi * MOON_RADIUS_M)

    def rowcol_to_latlon(row, col):
        lat = lat0 - (row - gy) * mpp * deg_per_m
        lon = lon0 + (col - gx) * mpp * deg_per_m / cos_lat0
        return lat, lon

    if "spawnLatLon" in meta:
        sx, sy = meta["spawn"]["x"], meta["spawn"]["y"]
        lat, lon = rowcol_to_latlon(sy, sx)
        exp = meta["spawnLatLon"]
        dlat_m = abs(lat - exp["lat"]) / deg_per_m
        dlon_m = abs(lon - exp["lon"]) * cos_lat0 / deg_per_m
        tol_m = mpp * 3  # 3px worth of ground distance
        if dlat_m > tol_m or dlon_m > tol_m:
            raise ValueError(
                f"{site}: anchored crop geometry failed self-check against spawnLatLon "
                f"(dlat={dlat_m:.1f}m dlon={dlon_m:.1f}m, tol={tol_m:.1f}m)")
    return rowcol_to_latlon


def _exact_tycho_rowcol_to_latlon(meta: dict) -> tuple:
    """Tycho has no lat/lon anchor in meta.json (its goal is the DTM's
    highest valid pixel, found algorithmically). Re-derives the exact crop
    window by re-running tools/sites/moon.py's own peak-finding steps
    (imported, not reimplemented) against a freshly downloaded copy of the
    DTM, then reads lat/lon straight from that DTM's own GeoTIFF header --
    no approximation, unlike the other three sites.

    Also returns a hillshade computed at native (2 m/px) resolution and
    then downsampled, matching how tools/sites/common.py's
    shade_and_slope_1024 builds every site's shipped albedo.jpg (imported,
    not reimplemented). Tycho's crop is 1200px native resampled to 1024
    (a non-integer ratio); hillshading the already-resampled height.bin
    instead beats a BOX-resize ratio against np.gradient's differencing
    into a visible moire (the exact artifact shade_and_slope_1024's own
    docstring warns about), confirmed here this session by eye (the
    moire's crosshatch pattern is visible in the height.bin-based
    hillshade and absent once this native-then-downsample fix is applied).
    The NCC coherence check still comes back INCONCLUSIVE for Tycho even
    after this fix, most likely because this is genuinely steep terrain (a
    crater central peak) where a fixed synthetic 315deg/45deg sun hillshade
    can disagree sharply with the real photo's actual (unknown, unsourced)
    illumination geometry -- side-by-side comparison of the two crops in
    the saved preview PNG shows the same ridge and boulder-field features
    in both at the same position, i.e. this reads as a shading-model
    mismatch, not a misplaced crop, but NCC cannot confirm that
    numerically, so it is honestly reported as inconclusive rather than
    forcing a correction fit to a weak/noisy peak (same treatment as
    change4; see module docstring)."""
    from raster_ops import fill_nodata, nodata_mask
    from site_picker import find_best_square_crop, find_peak
    from sites.common import shade_and_slope_1024
    from sites.moon import MOON_CROP_PX, MOON_SIZE, MOON_URL

    os.makedirs(RAW_CACHE_DIR, exist_ok=True)
    raw = os.path.join(RAW_CACHE_DIR, "moon_dtm_for_ortho_l3.tif")
    download(MOON_URL, raw, MOON_SIZE)
    header = read_header(raw)
    arr = np.asarray(Image.open(raw), dtype=np.float32)
    mask = nodata_mask(arr, header["nodata"])
    geo = EquirectParams.from_header(header)
    native_mpp = header["pixel_scale"][0]
    peak_rc = find_peak(arr, mask, cellsize_m=native_mpp, margin_m=60.0)
    r0, c0 = find_best_square_crop(mask, MOON_CROP_PX, peak_rc)
    sub = arr[r0:r0 + MOON_CROP_PX, c0:c0 + MOON_CROP_PX]
    submask = mask[r0:r0 + MOON_CROP_PX, c0:c0 + MOON_CROP_PX]
    filled, _ = fill_nodata(sub, submask)
    shade_1024, _slope_1024 = shade_and_slope_1024(filled, native_mpp, 315.0, 45.0)
    os.remove(raw)
    scale = MOON_CROP_PX / OUT_PX  # native px per 1024-grid px

    def rowcol_to_latlon(row, col):
        # geo.pixel_to_latlon (georef.py) is scalar-only (uses math.*, not
        # np.*); vectorized here from the same public formula so this works
        # for both scalar calls and the full 1024x1024 meshgrid.
        native_col = c0 + col * scale
        native_row = r0 + row * scale
        x = geo.x0 + (native_col - geo.i0) * geo.sx
        y = geo.y0 - (native_row - geo.j0) * geo.sy
        lat = geo.lat0 + np.degrees(y / geo.radius_m)
        lon = geo.lon0 + np.degrees(x / (geo.radius_m * np.cos(np.radians(geo.lat_ts))))
        return lat, lon

    return rowcol_to_latlon, shade_1024


def _fetch_ortho_crop(site: str, rowcol_to_latlon, shade_1024: np.ndarray,
                       session: requests.Session) -> tuple[np.ndarray, dict]:
    """Fetches the label and the smallest ortho-pixel window covering the
    site's 1024x1024 crop (+ FETCH_PAD_PX margin), fills any nodata in that
    window, samples the crop at its analytically-placed coordinates, then
    (see module docstring) runs a wide NCC search against shade_1024 and
    -- unless the hillshade has no measurable texture (change4) -- shifts
    the sampling grid by the measured offset and re-samples, confirming
    the corrected residual is within NCC_MAX_OFFSET_PX. Returns
    (final_crop_values, alignment_and_label_meta)."""
    url = ortho_url(site)
    label_text = fetch_label_text(url, session=session)
    label = OrthoLabel.from_text(label_text)

    rows = np.arange(OUT_PX)
    cols = np.arange(OUT_PX)
    rr, cc = np.meshgrid(rows, cols, indexing="ij")
    lat, lon = rowcol_to_latlon(rr, cc)
    line, sample = label.latlon_to_rowcol(lat, lon)  # 0-based row/col in the ortho, nominal placement

    row0 = int(math.floor(line.min())) - FETCH_PAD_PX
    row1 = int(math.ceil(line.max())) + FETCH_PAD_PX
    col0 = int(math.floor(sample.min())) - FETCH_PAD_PX
    col1 = int(math.ceil(sample.max())) + FETCH_PAD_PX
    out_of_bounds = ((line < 0) | (line >= label.lines) | (sample < 0) | (sample >= label.samples))
    if out_of_bounds.any():
        raise ValueError(f"{site}: crop extends outside the ortho raster "
                         f"({int(out_of_bounds.sum())} of {OUT_PX * OUT_PX} pixels)")

    window = fetch_window(url, label, row0, row1, col0, col1, session=session)
    win_row0, win_col0 = max(0, row0), max(0, col0)
    win_mask = label.nodata_mask(window)
    filled, nodata_frac = fill_nodata(window, win_mask) if win_mask.any() else (window, 0.0)

    local_line = line - win_row0
    local_sample = sample - win_col0
    nominal = map_coordinates(filled, [local_line, local_sample], order=1, mode="nearest")

    wide_dy, wide_dx, wide_ncc = _best_ncc_offset(shade_1024, nominal, NCC_WIDE_SEARCH_PX)
    coherent = abs(wide_ncc) >= NCC_COHERENCE_MIN and max(abs(wide_dy), abs(wide_dx)) < NCC_WIDE_SEARCH_PX
    print(f"  wide-search NCC: dy={wide_dy} dx={wide_dx} ncc={wide_ncc:.3f} "
          f"({'coherent, correcting' if coherent else 'INCONCLUSIVE (no measurable texture), shipping uncorrected'})")

    if coherent:
        corrected = map_coordinates(filled, [local_line - wide_dy, local_sample - wide_dx],
                                     order=1, mode="nearest")
        confirm_dy, confirm_dx, confirm_ncc = _best_ncc_offset(shade_1024, corrected, NCC_CONFIRM_SEARCH_PX)
        if max(abs(confirm_dy), abs(confirm_dx)) > NCC_MAX_OFFSET_PX:
            raise ValueError(f"{site}: corrected NCC residual {max(abs(confirm_dy), abs(confirm_dx))}px "
                              f"exceeds {NCC_MAX_OFFSET_PX}px accept threshold "
                              f"(pre-correction dy={wide_dy},dx={wide_dx}; residual dy={confirm_dy},dx={confirm_dx})")
        final = corrected
        alignment = {
            "coherent": True,
            "rawOffsetPx": {"dy": wide_dy, "dx": wide_dx},
            "rawNcc": round(wide_ncc, 4),
            "appliedCorrectionPx": {"dy": -wide_dy, "dx": -wide_dx},
            "confirmedResidualOffsetPx": {"dy": confirm_dy, "dx": confirm_dx},
            "confirmedResidualNcc": round(confirm_ncc, 4),
        }
        print(f"  confirmed residual after correction: dy={confirm_dy} dx={confirm_dx} "
              f"(ncc={confirm_ncc:.3f}); accept <= {NCC_MAX_OFFSET_PX}px")
    else:
        final = nominal
        alignment = {
            "coherent": False,
            "reason": "hillshade has insufficient relief texture to measure a reliable offset "
                      "(peak |ncc| < NCC_COHERENCE_MIN, or best offset never converged inside the "
                      "search window); shipped at the analytically-computed placement, uncorrected",
            "rawOffsetPx": {"dy": wide_dy, "dx": wide_dx},
            "rawNcc": round(wide_ncc, 4),
        }

    label_meta = {
        "productId": label.product_id,
        "labelBoundsDeg": {
            "minLat": label.min_lat, "maxLat": label.max_lat,
            "westLon": label.west_lon, "eastLon": label.east_lon,
        },
        "mapScaleMetersPerPixel": label.map_scale,
        "nodataFilledFractionInFetchWindow": round(float(nodata_frac), 5),
        "alignment": alignment,
    }
    return final, label_meta


def _best_ncc_offset(a: np.ndarray, b: np.ndarray, search_px: int) -> tuple[int, int, float]:
    """Returns (dy, dx, peak_ncc) maximizing normalized cross-correlation
    between a and b over integer shifts of b within +/-search_px."""
    a = a.astype(np.float64)
    a = (a - a.mean()) / (a.std() + 1e-9)
    best = (0, 0, -2.0)
    h, w = a.shape
    for dy in range(-search_px, search_px + 1):
        for dx in range(-search_px, search_px + 1):
            r0, r1 = max(0, dy), h + min(0, dy)
            c0, c1 = max(0, dx), w + min(0, dx)
            br0, br1 = max(0, -dy), h + min(0, -dy)
            bc0, bc1 = max(0, -dx), w + min(0, -dx)
            a_sub = a[r0:r1, c0:c1]
            b_sub = b[br0:br1, bc0:bc1].astype(np.float64)
            if a_sub.size == 0:
                continue
            b_sub = (b_sub - b_sub.mean()) / (b_sub.std() + 1e-9)
            ncc = float((a_sub * b_sub).mean())
            if ncc > best[2]:
                best = (dy, dx, ncc)
    return best


def _to_uint8_stretch(arr: np.ndarray, lo_pct: float = 1.0, hi_pct: float = 99.0) -> np.ndarray:
    lo, hi = np.percentile(arr, [lo_pct, hi_pct])
    if hi <= lo:
        hi = lo + 1.0
    stretched = np.clip((arr - lo) / (hi - lo), 0.0, 1.0)
    return np.round(stretched * 255.0).astype(np.uint8)


def _save_jpeg_under(path: str, gray_u8: np.ndarray, max_bytes: int) -> int:
    rgb = np.repeat(gray_u8[..., None], 3, axis=-1)
    img = Image.fromarray(rgb, mode="RGB")
    for quality in (85, 75, 65, 55, 45, 35):
        img.save(path, format="JPEG", quality=quality)
        size = os.path.getsize(path)
        if size <= max_bytes:
            return size
    return size  # smallest quality tried; caller checks the size


def process_site(site: str) -> dict:
    print(f"== L3 ortho-albedo: {site} ==")
    meta, elev = _load_site_assets(site)
    mpp = meta["metersPerPixel"]
    if site == "moon":
        # Tycho's crop is a non-1:1 (1200->1024) resample; hillshading
        # height.bin directly would moire (see _exact_tycho_rowcol_to_latlon's
        # docstring), so that function also returns a native-resolution
        # hillshade computed the same way the shipped albedo.jpg's was.
        rowcol_to_latlon, shade_1024 = _exact_tycho_rowcol_to_latlon(meta)
    else:
        rowcol_to_latlon = _anchored_rowcol_to_latlon(meta, site)
        shade_1024 = hillshade(elev, mpp, 315.0, 45.0)

    with requests.Session() as session:
        ortho_vals, label_meta = _fetch_ortho_crop(site, rowcol_to_latlon, shade_1024, session)
    alignment = label_meta["alignment"]

    gray_u8 = _to_uint8_stretch(ortho_vals)
    site_dir = os.path.join(ASSETS_DIR, site)
    jpg_path = os.path.join(site_dir, "albedo-ortho.jpg")
    jpg_size = _save_jpeg_under(jpg_path, gray_u8, MAX_JPEG_BYTES)
    if jpg_size > MAX_JPEG_BYTES:
        raise ValueError(f"{site}: albedo-ortho.jpg is {jpg_size}B, over the {MAX_JPEG_BYTES}B cap "
                          "even at the lowest tried JPEG quality")
    print(f"  wrote {jpg_path} ({jpg_size} bytes)")

    fetch_date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    sidecar = {
        "site": site,
        "product": label_meta["productId"],
        "productUrl": ortho_url(site),
        "productPageUrl": f"https://data.lroc.im-ldi.com/lroc/view_rdr/NAC_DTM_{ORTHO_PRODUCTS[site][0]}",
        "labelBoundsDeg": label_meta["labelBoundsDeg"],
        "mapScaleMetersPerPixel": label_meta["mapScaleMetersPerPixel"],
        "fetchDate": fetch_date,
        "cropWidthPx": OUT_PX,
        "cropHeightPx": OUT_PX,
        "cropMetersPerPixel": mpp,
        "alignmentCheck": {
            "method": "normalized cross-correlation vs a hillshade rendered from this site's own "
                      "height.bin; wide (+/-16px) search measures any real DTM<->ortho product "
                      "offset, then (if coherent) the crop is shifted and a narrow (+/-2px) "
                      "confirm search checks the corrected residual",
            "acceptMaxOffsetPx": NCC_MAX_OFFSET_PX,
            **alignment,
        },
        "nodataFilledFractionInFetchWindow": label_meta["nodataFilledFractionInFetchWindow"],
        "renderNote": ("Raw DN linearly stretched (1st-99th percentile) to 8-bit for display; "
                       "not radiometrically calibrated to I/F reflectance (the label's "
                       "SCALING_FACTOR/OFFSET do that, but a display texture doesn't need it)."),
        "license": meta.get("license"),
        "credit": meta.get("credit"),
    }
    json_path = os.path.join(site_dir, "albedo-ortho.json")
    with open(json_path, "w") as f:
        json.dump(sidecar, f, indent=2)
        f.write("\n")
    print(f"  wrote {json_path}")

    _save_preview(site, shade_1024, gray_u8, alignment)
    return sidecar


def _save_preview(site: str, shade_1024: np.ndarray, ortho_u8: np.ndarray, alignment: dict) -> str:
    os.makedirs(MEASUREMENTS_DIR, exist_ok=True)
    left = Image.fromarray(np.repeat(shade_1024.astype(np.uint8)[..., None], 3, axis=-1), mode="RGB")
    right = Image.fromarray(np.repeat(ortho_u8[..., None], 3, axis=-1), mode="RGB")
    gap = 8
    combo = Image.new("RGB", (left.width + right.width + gap, left.height), (20, 20, 20))
    combo.paste(left, (0, 0))
    combo.paste(right, (left.width + gap, 0))
    path = os.path.join(MEASUREMENTS_DIR, f"ortho-albedo-preview-{site}.png")
    combo.save(path, format="PNG")
    print(f"  wrote {path} (left=DTM hillshade, right=real LROC ortho; alignment={alignment})")
    return path


if __name__ == "__main__":
    sites = sys.argv[1:] or list(ORTHO_PRODUCTS.keys())
    for s in sites:
        process_site(s)

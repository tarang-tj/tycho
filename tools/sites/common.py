"""Shared helpers used by every per-body processor in tools/sites/."""
from __future__ import annotations

import os

import numpy as np
from scipy.ndimage import map_coordinates

from meta_schema import build_meta, validate_meta
from outputs import ensure_dir, write_albedo_jpg, write_height_bin, write_mask_bin, write_meta_json, write_preview_png
from raster_ops import area_resample, normalize_to_uint16
from shading import hillshade, slope_deg

MIN_CLEAR_OF_MASK_PX = 20

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CACHE_DIR = os.path.join(REPO_ROOT, ".cache")
ASSETS_DIR = os.path.join(REPO_ROOT, "assets")


def line_slope_stats(slope_native: np.ndarray, p0_rc: tuple[float, float],
                      p1_rc: tuple[float, float], n: int = 400) -> tuple[float, float]:
    """Samples a per-pixel slope grid along the straight line from p0 to p1
    (native-resolution row/col coordinates) and returns (max, mean) degrees."""
    rows = np.linspace(p0_rc[0], p1_rc[0], n)
    cols = np.linspace(p0_rc[1], p1_rc[1], n)
    vals = map_coordinates(slope_native, [rows, cols], order=1, mode="nearest")
    return float(vals.max()), float(vals.mean())


def shade_and_slope_1024(filled_native: np.ndarray, native_mpp: float,
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


def pick_best_spawn(filled: np.ndarray, goal_local: tuple[int, int], native_mpp: float,
                     submask: np.ndarray, r_min_m: float = 1500.0, r_max_m: float = 3000.0,
                     ) -> tuple[tuple[int, int], float, float]:
    """No sourced approach bearing exists for change4/apollo17 (unlike
    Lunokhod 2's LROC post 699), so instead of fabricating one, this tries
    every 30 degrees of compass bearing (via pick_directional_point's
    lowest-local-slope-in-sector search), scores each candidate by the
    straight-line max slope actually crossed between it and the goal (a
    single low-slope point can still sit across a ridge from the goal), and
    keeps whichever bearing gives the lowest line-max-slope. Returns
    (spawn_rc, line_max_slope_deg, line_mean_slope_deg)."""
    from site_picker import pick_directional_point  # local import: avoids a cycle with sites/*

    slope_native = slope_deg(filled, native_mpp)
    best_rc, best_max, best_mean = None, None, None
    for bearing in range(0, 360, 30):
        try:
            candidate_rc = pick_directional_point(
                filled, goal_local, native_mpp, r_min_m=r_min_m, r_max_m=r_max_m,
                bearing_deg=float(bearing), bearing_width_deg=40.0,
                nodata_mask=submask, edge_margin_px=40)
        except ValueError:
            continue
        max_slope, mean_slope = line_slope_stats(slope_native, candidate_rc, goal_local)
        if best_max is None or max_slope < best_max:
            best_rc, best_max, best_mean = candidate_rc, max_slope, mean_slope
    if best_rc is None:
        raise ValueError("no drivable spawn candidate found in any bearing sector")
    return best_rc, best_max, best_mean


def enforce_clearance(resized: np.ndarray, mask_1024: np.ndarray, slope_1024: np.ndarray,
                       spawn: dict, goal: dict) -> tuple[dict, dict, str]:
    """Re-checks spawn/goal are >= MIN_CLEAR_OF_MASK_PX from any masked
    (nodata-filled) cell; relocates whichever fails to the best nearby real
    cell (goal: highest elevation; spawn: lowest slope) and returns a note
    describing any change (empty string if nothing moved)."""
    from site_picker import ensure_clear_of_mask  # local import: avoids a cycle with sites/*

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

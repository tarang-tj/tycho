"""Shared helpers used by every per-body processor in tools/sites/."""
from __future__ import annotations

import os

import numpy as np
from scipy.ndimage import binary_erosion, map_coordinates
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra

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


def _grid_path_length_m(passable: np.ndarray, start_rc: tuple[int, int], goal_rc: tuple[int, int],
                         cellsize_m: float, window_margin_px: int = 150) -> float | None:
    """Shortest 8-connected grid path length (meters) from start_rc to
    goal_rc through `passable` cells only, via scipy's sparse Dijkstra.
    Restricted to a local bounding-box window (padded by window_margin_px)
    around the two points to keep the graph small -- spawn candidates here
    are always a few hundred to ~2km from the goal, well inside one crop.
    Returns None if either endpoint is not passable or no path exists."""
    r0 = max(0, min(start_rc[0], goal_rc[0]) - window_margin_px)
    r1 = min(passable.shape[0], max(start_rc[0], goal_rc[0]) + window_margin_px + 1)
    c0 = max(0, min(start_rc[1], goal_rc[1]) - window_margin_px)
    c1 = min(passable.shape[1], max(start_rc[1], goal_rc[1]) + window_margin_px + 1)
    sub = passable[r0:r1, c0:c1]
    h, w = sub.shape
    sr, sc = start_rc[0] - r0, start_rc[1] - c0
    gr, gc = goal_rc[0] - r0, goal_rc[1] - c0
    if not (0 <= sr < h and 0 <= sc < w and 0 <= gr < h and 0 <= gc < w):
        return None
    if not (sub[sr, sc] and sub[gr, gc]):
        return None

    idx = -np.ones((h, w), dtype=np.int64)
    idx[sub] = np.arange(int(sub.sum()))
    n = int(sub.sum())

    rows, cols, weights = [], [], []
    for dr, dc, cost in ((-1, 0, 1.0), (1, 0, 1.0), (0, -1, 1.0), (0, 1, 1.0),
                         (-1, -1, 2 ** 0.5), (-1, 1, 2 ** 0.5), (1, -1, 2 ** 0.5), (1, 1, 2 ** 0.5)):
        rr0, rr1 = max(0, -dr), h - max(0, dr)
        cc0, cc1 = max(0, -dc), w - max(0, dc)
        if rr0 >= rr1 or cc0 >= cc1:
            continue
        src = idx[rr0:rr1, cc0:cc1]
        dst = idx[rr0 + dr:rr1 + dr, cc0 + dc:cc1 + dc]
        ok = (src >= 0) & (dst >= 0)
        if ok.any():
            rows.append(src[ok])
            cols.append(dst[ok])
            weights.append(np.full(int(ok.sum()), cost * cellsize_m))
    if not rows:
        return None
    graph = csr_matrix((np.concatenate(weights), (np.concatenate(rows), np.concatenate(cols))), shape=(n, n))
    dist = dijkstra(graph, directed=False, indices=int(idx[sr, sc]))
    d = float(dist[int(idx[gr, gc])])
    return d if np.isfinite(d) else None


def pick_best_spawn(filled: np.ndarray, goal_local: tuple[int, int], native_mpp: float,
                     submask: np.ndarray, r_min_m: float = 1500.0, r_max_m: float = 3000.0,
                     prefer_straight_path: bool = False, max_path_slope_deg: float = 25.0,
                     tortuosity_weight_deg: float = 8.0, bearing_step_deg: float = 30.0,
                     heading_align_weight_deg: float = 8.0,
                     ) -> tuple[tuple[int, int], float, float]:
    """No sourced approach bearing exists for change4/apollo17 (unlike
    Lunokhod 2's LROC post 699), so instead of fabricating one, this tries
    every bearing_step_deg of compass bearing (via pick_directional_point's
    lowest-local-slope-in-sector search), scores each candidate by the
    straight-line max slope actually crossed between it and the goal (a
    single low-slope point can still sit across a ridge from the goal), and
    keeps whichever bearing gives the lowest line-max-slope. Returns
    (spawn_rc, line_max_slope_deg, line_mean_slope_deg). bearing_step_deg
    defaults to 30 (apollo17's call, and change4's pre-levelup-v3 behavior,
    is unchanged); change4 passes a finer step to find the best candidate
    below.

    prefer_straight_path (default False): adds two more terms to the score,
    both gated behind this flag so apollo17's call is untouched:

    1. Route tortuosity: a grid Dijkstra search restricted to cells under
       max_path_slope_deg and clear of nodata (path_length /
       straight_line_distance -- 1.0 is a perfectly straight shot). Catches
       what the pure line-slope score misses: the 400-sample straight-line
       probe can step over a narrow no-data gap or slope spike that a real
       route has to detour around.
    2. Initial-heading alignment: tests/playability.test.mjs's live bot (the
       same shape a delayed-telemetry human playthrough follows) always
       spawns facing heading 0 (createRover's default, matching
       rover-sim.js's steerTowardPoint convention: heading 0 = +row).
       Debugging change4's original ~4700s playthrough (and this range fix's
       still-too-slow ~2400s first pass, see tools/sites/change4.py) found
       that candidates whose straight-line bearing to the goal starts far
       from that heading force an initial hard turn under delayed,
       infrequently-refreshed telemetry -- and THAT, not raw path
       tortuosity or line slope, is what drove the delayed-telemetry bot
       into a sustained steering oscillation (confirmed by direct
       simulation: two candidates with identical line slope and identical
       raw path-length ratio took 1696s and 2391s purely because their
       initial heading offset was 3deg vs 87deg). Penalized the same way
       steerTowardPoint itself scales steer authority (diff/45).

    Candidates with no reachable path under max_path_slope_deg are skipped
    outright. The final score is line_max_slope_deg + tortuosity_weight_deg
    * max(0, path_ratio - 1) + heading_align_weight_deg * (abs(heading_diff_deg) / 45),
    so a candidate that starts facing badly wrong, or whose real route
    detours materially, can lose to one with a slightly higher raw line
    slope; a candidate tied on both extra terms is still decided by slope
    as before."""
    from site_picker import pick_directional_point  # local import: avoids a cycle with sites/*

    slope_native = slope_deg(filled, native_mpp)
    passable = None
    if prefer_straight_path:
        raw_passable = (slope_native <= max_path_slope_deg) & ~submask
        # Erode by one cell (3x3 all-clear) so this mirrors the actual
        # in-game planner (tests/playability.test.mjs's findGlobalPath with
        # dilatePx=1): a route squeezing through a single-cell gap between
        # hazards scores as if it were blocked here too, since that's not a
        # real margin-buffered route a delayed-telemetry playthrough can
        # follow either.
        passable = binary_erosion(raw_passable, structure=np.ones((3, 3), dtype=bool))
    best_rc, best_max, best_mean, best_score = None, None, None, None
    bearing = 0.0
    while bearing < 360.0:
        try:
            candidate_rc = pick_directional_point(
                filled, goal_local, native_mpp, r_min_m=r_min_m, r_max_m=r_max_m,
                bearing_deg=bearing, bearing_width_deg=40.0,
                nodata_mask=submask, edge_margin_px=40)
        except ValueError:
            bearing += bearing_step_deg
            continue
        max_slope, mean_slope = line_slope_stats(slope_native, candidate_rc, goal_local)
        if prefer_straight_path:
            straight_m = ((candidate_rc[0] - goal_local[0]) ** 2
                          + (candidate_rc[1] - goal_local[1]) ** 2) ** 0.5 * native_mpp
            path_m = _grid_path_length_m(passable, candidate_rc, goal_local, native_mpp)
            if path_m is None or straight_m <= 0:
                bearing += bearing_step_deg
                continue  # no connected drivable route to the goal under the path-slope guardrail
            ratio = path_m / straight_m
            # Same convention as rover-sim.js's steerTowardPoint: dx=col
            # delta, dy=row delta, heading 0 = +row (dr, no dc).
            dy = goal_local[0] - candidate_rc[0]
            dx = goal_local[1] - candidate_rc[1]
            desired_heading_deg = float(np.degrees(np.arctan2(dx, dy)))
            heading_diff_deg = abs(((desired_heading_deg + 180.0) % 360.0) - 180.0)
            score = (max_slope + tortuosity_weight_deg * max(0.0, ratio - 1.0)
                     + heading_align_weight_deg * (heading_diff_deg / 45.0))
        else:
            score = max_slope
        if best_score is None or score < best_score:
            best_rc, best_max, best_mean, best_score = candidate_rc, max_slope, mean_slope, score
        bearing += bearing_step_deg
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

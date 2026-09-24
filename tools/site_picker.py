"""Pick spawn/goal pixel locations from a processed elevation grid.

Moon: spawn is a drivable spot (local slope < 15 deg) near the peak's base;
goal is the summit. Mars: spawn is the landing-site pixel; goal is a nearby
(2-4 km) point of high terrain roughness, a data-driven proxy for the delta
scarp visible in the DEM (not a surveyed named-feature coordinate -- flagged
as approximate in meta.notes by the caller).
"""
from __future__ import annotations

import numpy as np
from scipy.ndimage import distance_transform_edt, uniform_filter

from shading import slope_deg


def find_peak(elev: np.ndarray, mask: np.ndarray, cellsize_m: float = 1.0,
              margin_m: float = 0.0) -> tuple[int, int]:
    """Returns (row, col) of max elevation among valid (non-nodata) pixels.

    Photogrammetric DTMs often fail to correlate stereo pairs on steeply
    shadowed slopes, leaving a nodata hole right at a true summit; the
    highest *valid* pixel right on that hole's edge is then a boundary
    artifact, not a reliable summit. margin_m requires the chosen pixel to
    be at least that far (by nodata) from any nodata hole, so it lands on
    solid, well-supported terrain (verified against NAC_DTM_TYCHOPK01:
    margin 0-80px shifts the pick by <15m elevation, confirming it's a
    real summit shoulder rather than an isolated artifact)."""
    valid = ~mask
    if margin_m > 0 and valid.any() and not valid.all():
        dist_px = distance_transform_edt(valid)
        valid = valid & (dist_px > margin_m / cellsize_m)
        if not valid.any():
            valid = ~mask  # margin ate everything; fall back to unrestricted
    masked = np.where(valid, elev, -np.inf)
    idx = int(np.argmax(masked))
    row, col = np.unravel_index(idx, elev.shape)
    return int(row), int(col)


def find_best_square_crop(mask: np.ndarray, size: int, contains_rc: tuple[int, int],
                           margin_frac: float = 0.125) -> tuple[int, int]:
    """Finds the top-left (r0, c0) of a size x size window that contains
    contains_rc (with at least margin_frac*size px of clearance from every
    edge) and minimizes nodata fraction. Diagonal/rotated DTM swaths put a
    lot of nodata in a naively-centered square; searching nearby offsets
    materially reduces it (verified: 14% -> 7.5% on the Tycho peak crop).
    Search is restricted to a local window around contains_rc to bound
    memory on very large source rasters."""
    h, w = mask.shape
    pr, pc = contains_rc
    margin = int(round(size * margin_frac))
    r_lo, r_hi = max(0, pr - size + margin), min(h - size, pr - margin)
    c_lo, c_hi = max(0, pc - size + margin), min(w - size, pc - margin)
    if r_lo > r_hi or c_lo > c_hi:
        # margin infeasible (point too close to raster edge); fall back to centered, clamped
        r0 = min(max(pr - size // 2, 0), max(h - size, 0))
        c0 = min(max(pc - size // 2, 0), max(w - size, 0))
        return r0, c0

    pad = size  # local window radius around the search region, generous but bounded
    wr0, wr1 = max(0, r_lo - pad), min(h, r_hi + size + pad)
    wc0, wc1 = max(0, c_lo - pad), min(w, c_hi + size + pad)
    local = mask[wr0:wr1, wc0:wc1].astype(np.int32)
    integral = np.pad(np.cumsum(np.cumsum(local, axis=0), axis=1), ((1, 0), (1, 0)))

    rs = np.arange(r_lo, r_hi + 1) - wr0
    cs = np.arange(c_lo, c_hi + 1) - wc0
    R0, C0 = np.meshgrid(rs, cs, indexing="ij")
    sums = (integral[R0 + size, C0 + size] - integral[R0, C0 + size]
            - integral[R0 + size, C0] + integral[R0, C0])
    best = int(np.argmin(sums))
    r0 = int(R0.flat[best]) + wr0
    c0 = int(C0.flat[best]) + wc0
    return r0, c0


def ensure_clear_of_mask(point_rc: tuple[int, int], elev: np.ndarray, mask: np.ndarray, min_px: float,
                          mode: str, radius_px: float = 150.0, slope: np.ndarray | None = None
                          ) -> tuple[tuple[int, int], bool]:
    """If point_rc is within min_px of a filled/masked cell, relocates it to
    the best nearby cell (within radius_px) that is at least min_px clear of
    every masked cell -- mode="max_elev" for a summit/goal, "min_slope" for
    a drivable spawn. Returns (new_point, changed). Falls back to the
    global best clear cell if nothing qualifies within radius_px, and
    returns the original point unchanged (changed=False) if no clear cell
    exists at all."""
    if not mask.any():
        return point_rc, False
    dist_to_mask = distance_transform_edt(mask == 0)
    row, col = point_rc
    if dist_to_mask[row, col] >= min_px:
        return point_rc, False

    rows, cols = np.indices(elev.shape)
    rdist = np.sqrt((rows - row) ** 2 + (cols - col) ** 2)
    clear = dist_to_mask >= min_px
    candidates = clear & (rdist <= radius_px)
    if not candidates.any():
        candidates = clear
    if not candidates.any():
        return point_rc, False

    if mode == "max_elev":
        score = np.where(candidates, elev, -np.inf)
        idx = int(np.argmax(score))
    elif mode == "min_slope":
        if slope is None:
            raise ValueError("min_slope mode requires slope")
        score = np.where(candidates, slope, np.inf)
        idx = int(np.argmin(score))
    else:
        raise ValueError(f"unknown mode '{mode}'")
    new_row, new_col = np.unravel_index(idx, elev.shape)
    return (int(new_row), int(new_col)), True


def _annulus_mask(shape: tuple[int, int], center_rc: tuple[int, int], r_min_px: float, r_max_px: float) -> np.ndarray:
    rows, cols = np.indices(shape)
    dist = np.sqrt((rows - center_rc[0]) ** 2 + (cols - center_rc[1]) ** 2)
    return (dist >= r_min_px) & (dist <= r_max_px)


def pick_moon_spawn(elev: np.ndarray, peak_rc: tuple[int, int], cellsize_m: float,
                     r_min_m: float = 300.0, r_max_m: float = 1000.0, max_slope_deg: float = 15.0,
                     nodata_mask: np.ndarray | None = None) -> tuple[int, int]:
    """Find the lowest-slope point in an annulus around the peak (the peak's
    base) with local slope under max_slope_deg. Falls back to the globally
    lowest-slope point in the annulus if nothing clears the threshold.
    nodata_mask (pre-fill) pixels are excluded: nearest-fill can leave
    artificially flat/low-slope patches that are not real drivable terrain."""
    slope = slope_deg(elev, cellsize_m)
    ring = _annulus_mask(elev.shape, peak_rc, r_min_m / cellsize_m, r_max_m / cellsize_m)
    if nodata_mask is not None:
        ring = ring & ~nodata_mask
    if not ring.any():
        ring = _annulus_mask(elev.shape, peak_rc, r_min_m / cellsize_m, r_max_m / cellsize_m)
    if not ring.any():
        raise ValueError("annulus is empty; peak too close to grid edge")
    candidate_slope = np.where(ring, slope, np.inf)
    ok = ring & (slope < max_slope_deg)
    pool = candidate_slope if not ok.any() else np.where(ok, slope, np.inf)
    idx = int(np.argmin(pool))
    row, col = np.unravel_index(idx, elev.shape)
    return int(row), int(col)


def pick_mars_goal(elev: np.ndarray, spawn_rc: tuple[int, int], cellsize_m: float,
                    r_min_m: float = 2000.0, r_max_m: float = 4000.0,
                    nodata_mask: np.ndarray | None = None) -> tuple[int, int]:
    """Find the point of highest local terrain roughness (std-dev of
    elevation in a small window) within 2-4 km of spawn -- a proxy for a
    rocky/scarped feature such as the delta front, grounded in the actual
    DEM rather than an assumed direction. nodata_mask (pre-fill) pixels are
    excluded so the goal never lands on fabricated fill terrain."""
    win = max(3, int(round(60.0 / cellsize_m)) | 1)  # ~60m window, odd size
    mean = uniform_filter(elev.astype(np.float64), size=win)
    mean_sq = uniform_filter(elev.astype(np.float64) ** 2, size=win)
    roughness = np.sqrt(np.clip(mean_sq - mean ** 2, 0, None))
    ring = _annulus_mask(elev.shape, spawn_rc, r_min_m / cellsize_m, r_max_m / cellsize_m)
    if nodata_mask is not None:
        ring = ring & ~nodata_mask
    if not ring.any():
        ring = _annulus_mask(elev.shape, spawn_rc, r_min_m / cellsize_m, r_max_m / cellsize_m)
    if not ring.any():
        raise ValueError("annulus is empty; spawn too close to grid edge")
    pool = np.where(ring, roughness, -np.inf)
    idx = int(np.argmax(pool))
    row, col = np.unravel_index(idx, elev.shape)
    return int(row), int(col)

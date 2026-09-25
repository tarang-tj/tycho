"""Unit tests for tools/sites/common.py's pick_best_spawn (bearing search
that picks the spawn candidate minimizing straight-line max slope to goal,
used by change4/apollo17 which have no sourced approach direction)."""
from __future__ import annotations

import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sites.common import pick_best_spawn


def _ramp_with_wall(size: int = 200) -> np.ndarray:
    """A gentle 1 deg/px-ish ramp with a steep wall directly east of center
    (so the east bearing must lose to some other bearing)."""
    elev = np.fromfunction(lambda r, c: (r + c) * 0.05, (size, size), dtype=np.float64)
    center = size // 2
    elev[:, center + 20:center + 24] += 400.0  # a steep ridge just east of center
    return elev.astype(np.float32)


class PickBestSpawnTests(unittest.TestCase):
    def test_avoids_steep_wall_between_candidate_and_goal(self):
        elev = _ramp_with_wall()
        goal_local = (100, 100)
        submask = np.zeros_like(elev, dtype=bool)
        spawn_rc, max_slope, mean_slope = pick_best_spawn(
            elev, goal_local, native_mpp=5.0, submask=submask, r_min_m=100.0, r_max_m=200.0)
        # The wall sits due east; a spawn chosen due east would cross it and
        # have a much higher line-max-slope than the best available bearing.
        east_wall_max_slope, _ = _line_slope_to((100, 124), goal_local, elev, 5.0)
        self.assertLess(max_slope, east_wall_max_slope)

    def test_returns_point_within_requested_annulus(self):
        elev = _ramp_with_wall()
        goal_local = (100, 100)
        submask = np.zeros_like(elev, dtype=bool)
        spawn_rc, _, _ = pick_best_spawn(elev, goal_local, native_mpp=5.0, submask=submask,
                                          r_min_m=100.0, r_max_m=200.0)
        dist_px = ((spawn_rc[0] - goal_local[0]) ** 2 + (spawn_rc[1] - goal_local[1]) ** 2) ** 0.5
        dist_m = dist_px * 5.0
        self.assertGreaterEqual(dist_m, 90.0)  # small slack for pixel snapping
        self.assertLessEqual(dist_m, 210.0)

    def test_raises_when_annulus_is_entirely_masked(self):
        elev = _ramp_with_wall()
        goal_local = (100, 100)
        submask = np.ones_like(elev, dtype=bool)
        with self.assertRaises(ValueError):
            pick_best_spawn(elev, goal_local, native_mpp=5.0, submask=submask,
                             r_min_m=100.0, r_max_m=200.0)


class PreferStraightPathTests(unittest.TestCase):
    """change4's levelup-v3 fix: prefer_straight_path scores candidates by
    real route tortuosity (Dijkstra path length / straight-line distance),
    not just line slope, catching a no-data gap the 400-sample straight-
    line slope probe steps over entirely."""

    def _flat_with_north_gap(self, size: int = 200) -> tuple[np.ndarray, np.ndarray]:
        elev = np.zeros((size, size), dtype=np.float32)  # slope 0 everywhere
        submask = np.zeros((size, size), dtype=bool)
        goal_col = size // 2
        # A no-data wall a few rows north of the goal, wide enough to block
        # every straight shot from due north (bearing 0) at r_min-r_max, but
        # nowhere near south/east/west.
        submask[95:98, goal_col - 60:goal_col + 60] = True
        return elev, submask

    def test_default_ignores_the_gap_and_still_picks_the_tied_bearing(self):
        elev, submask = self._flat_with_north_gap()
        goal_local = (100, 100)
        spawn_rc, max_slope, _ = pick_best_spawn(
            elev, goal_local, native_mpp=5.0, submask=submask, r_min_m=100.0, r_max_m=140.0)
        # Slope is 0 everywhere, so the line-slope-only score ties every
        # bearing at 0; the first bearing tried (0 = due north) wins,
        # despite its straight line being severed by the no-data wall.
        self.assertEqual(max_slope, 0.0)
        self.assertLess(spawn_rc[0], goal_local[0])  # north of goal (lower row)

    def test_prefer_straight_path_avoids_the_gap_bearing(self):
        elev, submask = self._flat_with_north_gap()
        goal_local = (100, 100)
        spawn_rc, _, _ = pick_best_spawn(
            elev, goal_local, native_mpp=5.0, submask=submask, r_min_m=100.0, r_max_m=140.0,
            prefer_straight_path=True, max_path_slope_deg=45.0)
        # The due-north candidate's real drivable route must now detour
        # around the wall (ratio >> 1), so some other bearing wins instead.
        self.assertGreaterEqual(spawn_rc[0], goal_local[0])

    def test_prefer_straight_path_prefers_small_initial_heading_offset(self):
        # Flat, unmasked terrain: line slope and path ratio are identical
        # (0 and ~1.0) for every bearing, so only the heading-alignment term
        # can break the tie. steerTowardPoint's/createRover's convention is
        # heading 0 = +row (south); a candidate due south of the goal (so
        # the straight shot back to the goal is due north, a 180deg initial
        # turn) must lose to one due north of the goal (straight shot is
        # ~0deg, no initial turn) -- this is the change4 "too long to be
        # fun" fix's empirically-confirmed driver (see common.py docstring).
        elev = np.zeros((240, 240), dtype=np.float32)
        submask = np.zeros((240, 240), dtype=bool)
        goal_local = (120, 120)
        spawn_rc, _, _ = pick_best_spawn(
            elev, goal_local, native_mpp=5.0, submask=submask, r_min_m=100.0, r_max_m=100.0,
            prefer_straight_path=True, max_path_slope_deg=45.0, bearing_step_deg=90.0)
        # bearing_step_deg=90 with pick_directional_point's fixed 40deg
        # sector only probes north/east/south/west; north (row < goal row,
        # 0deg initial turn) must win over south (row > goal row, 180deg).
        self.assertLess(spawn_rc[0], goal_local[0])


def _line_slope_to(p0_rc, p1_rc, elev, mpp):
    from sites.common import line_slope_stats
    from shading import slope_deg
    slope_native = slope_deg(elev, mpp)
    return line_slope_stats(slope_native, p0_rc, p1_rc)


if __name__ == "__main__":
    unittest.main()

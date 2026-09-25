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


def _line_slope_to(p0_rc, p1_rc, elev, mpp):
    from sites.common import line_slope_stats
    from shading import slope_deg
    slope_native = slope_deg(elev, mpp)
    return line_slope_stats(slope_native, p0_rc, p1_rc)


if __name__ == "__main__":
    unittest.main()

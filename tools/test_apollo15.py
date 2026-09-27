"""Unit tests for A5: the Apollo 15 crop must fit fully inside the
NAC_DTM_APOLLO15 strip (a narrow 2555x14311 px, 2 m/px footprint), and the
goal must project to the pixel LROC post 938's coordinate implies. These
use the real GeoTIFF header values read from the source TIF this session
(https://data.lroc.im-ldi.com/lroc/view_rdr/NAC_DTM_APOLLO15) rather than
downloading the 146 MB file in a unit test.
"""
from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from georef import EquirectParams
from sites.apollo15 import (APOLLO15_CROP_PX, GOAL_ELEV_CITED_M, GOAL_LAT, GOAL_LON,
                             GOAL_UNCERTAINTY_M, crop_origin)

# NAC_DTM_APOLLO15.TIF header, read directly from the source file this
# session (a 500KB range request, then re-verified against the full
# 146,373,579-byte download): width 2555, height 14311, 2.0 m/px,
# Equirectangular on the Moon ellipsoid (radius 1737400 m), std parallel
# 26.0N, center lon 180.0E.
STRIP_WIDTH = 2555
STRIP_HEIGHT = 14311
_HEADER = {
    "tiepoint": (0.0, 0.0, 0.0, -4810338.0000014, 804664.00000024, 0.0),
    "pixel_scale": (2.0000000000006, 2.0000000000006, 0.0),
    "geokeys": {3075: 17, 3078: 26.0, 2057: 1737400.0, 3088: 180.0, 3089: 0.0},
}


class Apollo15GoalCoordinateTests(unittest.TestCase):
    def test_goal_matches_lroc_post_938(self):
        # LROC post 938, "Spacecraft Related Coordinates - 2016 Update":
        # "Apollo 15 LRV | 26.13174 | 3.63803 | -1928 | 0.5".
        self.assertEqual(GOAL_LAT, 26.13174)
        self.assertEqual(GOAL_LON, 3.63803)
        self.assertEqual(GOAL_ELEV_CITED_M, -1928.0)
        self.assertEqual(GOAL_UNCERTAINTY_M, 0.5)

    def test_goal_projects_to_the_pixel_read_this_session(self):
        # Confirmed this session against the real header: the LROC-938
        # coordinate projects to (row 6131, col 1845).
        geo = EquirectParams.from_header(_HEADER)
        goal_i, goal_j = geo.latlon_to_pixel(GOAL_LAT, GOAL_LON)
        self.assertAlmostEqual(round(goal_j), 6131)
        self.assertAlmostEqual(round(goal_i), 1845)


class Apollo15A5CropFitsTests(unittest.TestCase):
    """A5: 'Apollo 15 LRV crop fits: strip ~5.2km wide, LRV ~1.4km from
    east edge (computed from page bounds)' -- checked in this lane per the
    plan's assumptions ledger."""

    def test_crop_is_native_2m_no_resample(self):
        # G2: native 2m terrain, 1024px = 2.048km crop, no resample.
        self.assertEqual(APOLLO15_CROP_PX, 1024)

    def test_goal_to_east_edge_distance_matches_a5_estimate(self):
        goal_col = 1845
        dist_m = (STRIP_WIDTH - 1 - goal_col) * 2.0
        # A5 estimated ~1.4km from the east edge; the real header gives
        # 708.97px * 2m = 1417.9m, confirming the assumption.
        self.assertAlmostEqual(dist_m, 1417.9, delta=1.0)

    def test_crop_fits_fully_inside_the_strip(self):
        goal_row, goal_col = 6131, 1845
        r0, c0 = crop_origin(goal_row, goal_col, STRIP_HEIGHT, STRIP_WIDTH)
        self.assertGreaterEqual(r0, 0)
        self.assertGreaterEqual(c0, 0)
        self.assertLessEqual(r0 + APOLLO15_CROP_PX, STRIP_HEIGHT)
        self.assertLessEqual(c0 + APOLLO15_CROP_PX, STRIP_WIDTH)
        # The goal pixel itself must land inside the cropped window.
        self.assertTrue(r0 <= goal_row < r0 + APOLLO15_CROP_PX)
        self.assertTrue(c0 <= goal_col < c0 + APOLLO15_CROP_PX)

    def test_crop_origin_clamps_when_goal_is_near_an_edge(self):
        # A goal near row 0 (or the far edge) must clamp r0 to 0 (or
        # height - crop_px) instead of going negative / off the raster --
        # this is the failure mode A5's "crop fits" guards against for a
        # goal close to the strip boundary.
        r0, c0 = crop_origin(5, 5, STRIP_HEIGHT, STRIP_WIDTH)
        self.assertEqual(r0, 0)
        self.assertEqual(c0, 0)
        r0, c0 = crop_origin(STRIP_HEIGHT - 5, STRIP_WIDTH - 5, STRIP_HEIGHT, STRIP_WIDTH)
        self.assertEqual(r0, STRIP_HEIGHT - APOLLO15_CROP_PX)
        self.assertEqual(c0, STRIP_WIDTH - APOLLO15_CROP_PX)


if __name__ == "__main__":
    unittest.main()

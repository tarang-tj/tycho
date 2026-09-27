"""Unit tests for tools/sites/change3.py's sourced facts and structural
invariants (goal vs Yutu coordinates from LROC post 938, near-side no-relay
convention). See tools/sites/change3.py's module docstring for citations.
"""
from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sites.change3 import (CHANGE3_CROP_PX, GOAL_ELEV_CITED_M, GOAL_LAT, GOAL_LON,
                            GOAL_UNCERTAINTY_M, LANDING_DATE, YUTU_ELEV_CITED_M, YUTU_LAT,
                            YUTU_LON, YUTU_UNCERTAINTY_M)


class Change3GoalCoordinateTests(unittest.TestCase):
    def test_goal_matches_lroc_post_938_lander_row(self):
        # LROC post 938, "Spacecraft Related Coordinates - 2016 Update":
        # "Chang'e 3 | 44.1214 | 340.4883 | -2630 | 9.1"
        self.assertEqual(GOAL_LAT, 44.1214)
        self.assertEqual(GOAL_LON, 340.4883)
        self.assertEqual(GOAL_ELEV_CITED_M, -2630.0)
        self.assertEqual(GOAL_UNCERTAINTY_M, 9.1)

    def test_yutu_matches_lroc_post_938_rover_row(self):
        # Same post: "Yutu Rover | 44.1208 | 340.4878 | -2630 | 12.9"
        self.assertEqual(YUTU_LAT, 44.1208)
        self.assertEqual(YUTU_LON, 340.4878)
        self.assertEqual(YUTU_ELEV_CITED_M, -2630.0)
        self.assertEqual(YUTU_UNCERTAINTY_M, 12.9)

    def test_goal_and_yutu_are_distinct_coordinates(self):
        # The lander and rover are two separately surveyed objects; the
        # goal (lander) must never silently collapse onto Yutu's position.
        self.assertNotEqual((GOAL_LAT, GOAL_LON), (YUTU_LAT, YUTU_LON))

    def test_landing_date_is_recorded(self):
        self.assertEqual(LANDING_DATE, "14 December 2013")

    def test_crop_is_native_resolution_1024_square(self):
        # 5 m/px product, 1024 px crop -> 5.12 km square, no resample.
        self.assertEqual(CHANGE3_CROP_PX, 1024)


if __name__ == "__main__":
    unittest.main()

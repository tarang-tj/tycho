"""Unit test for H1: the Chang'e-4 goal coordinate must be the LRO-frame
position (the frame the shipped NAC_DTM_CHANGE4 DTM is in), not Liu et al.
2019's CE2TMap2015-frame headline figure, which is offset ~415 m in this
DTM. See tools/sites/change4.py's module docstring for the full citation.
"""
from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sites.change4 import (GOAL_LAT, GOAL_LAT_LIU_CE2TMAP_FRAME, GOAL_LAT_LIU_LRO_FRAME,
                            GOAL_LON, GOAL_LON_LIU_CE2TMAP_FRAME, GOAL_LON_LIU_LRO_FRAME)


class Change4GoalCoordinateTests(unittest.TestCase):
    def test_goal_matches_lroc_post_1087_lro_frame_value(self):
        # LROC post 1087, "Chang'e 4 Lander Coordinates":
        # "45.457 S, 177.589 E, plus or minus 20 meters."
        self.assertEqual(GOAL_LAT, -45.457)
        self.assertEqual(GOAL_LON, 177.589)

    def test_goal_is_not_the_ce2tmap2015_frame_coordinate(self):
        # Liu et al. 2019's headline (CE2TMap2015-frame) figure is a
        # DIFFERENT coordinate system than the shipped LRO-frame DTM; using
        # it as the goal would misplace the goal ~415 m (H1). The goal must
        # never equal this value.
        self.assertNotEqual((GOAL_LAT, GOAL_LON),
                             (GOAL_LAT_LIU_CE2TMAP_FRAME, GOAL_LON_LIU_CE2TMAP_FRAME))

    def test_goal_agrees_with_liu_et_al_lro_frame_value_within_20m(self):
        # Liu et al. 2019 also report an LRO-frame value (177.5885E,
        # 45.4561S) that should agree with LROC's within ~20 m (~0.00018 deg
        # of latitude at the Moon's radius).
        self.assertAlmostEqual(GOAL_LAT, GOAL_LAT_LIU_LRO_FRAME, delta=0.001)
        self.assertAlmostEqual(GOAL_LON, GOAL_LON_LIU_LRO_FRAME, delta=0.001)


if __name__ == "__main__":
    unittest.main()

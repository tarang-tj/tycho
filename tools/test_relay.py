"""Unit tests for tools/sites/relay.py's far-side relay light-time model."""
from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sites.relay import SPEED_OF_LIGHT_KM_S, relay_light_time_sec


class RelayLightTimeTests(unittest.TestCase):
    def test_default_inputs_give_seconds_in_plausible_range(self):
        one_way_sec, legs_km = relay_light_time_sec()
        # Direct Earth-Moon one-way light time is ~1.28s; a relay hop via
        # Queqiao (which adds real distance on both legs) must be longer.
        self.assertGreater(one_way_sec, 1.28)
        # But still well under a minute -- this is a cislunar link, not deep space.
        self.assertLess(one_way_sec, 5.0)
        self.assertEqual(len(legs_km), 2)
        self.assertTrue(all(km > 0 for km in legs_km))

    def test_matches_hand_computed_distance_over_c(self):
        one_way_sec, legs_km = relay_light_time_sec(
            earth_moon_km=384_400.0, queqiao_beyond_moon_km=65_000.0, moon_radius_km=1_737.4)
        expected_total_km = (384_400.0 + 65_000.0) + (65_000.0 - 1_737.4)
        self.assertAlmostEqual(one_way_sec, expected_total_km / SPEED_OF_LIGHT_KM_S, places=6)

    def test_leg2_never_negative_even_with_tiny_offset(self):
        _, legs_km = relay_light_time_sec(queqiao_beyond_moon_km=1000.0, moon_radius_km=1_737.4)
        self.assertGreaterEqual(legs_km[1], 0.0)

    def test_direct_earth_moon_path_is_a_lower_bound(self):
        # Sanity: a direct (non-relay) Earth-Moon one-way light time should
        # be shorter than the relay path returned above.
        direct_sec = 384_400.0 / SPEED_OF_LIGHT_KM_S
        relay_sec, _ = relay_light_time_sec()
        self.assertLess(direct_sec, relay_sec)


if __name__ == "__main__":
    unittest.main()

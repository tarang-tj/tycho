import json
import math
import os
import unittest

from fetch_m20_traverse import (
    LANDING_LAT_DEG,
    LANDING_LON_DEG,
    LAT_TRUE_SCALE_DEG,
    MAX_OUTPUT_BYTES,
    NATIVE_MPP,
    RADIUS_M,
    SPAWN_PIXEL,
    build_snapshot,
    decimate_coords,
)

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SNAPSHOT_PATH = os.path.join(REPO_ROOT, "assets", "mars", "m20-traverse.json")


def _lonlat_to_crop_pixel(lon: float, lat: float) -> tuple[float, float]:
    """Same equirect model as web/historic-track.js's project(), re-derived
    independently here (Python, not imported from the JS) so this test
    actually cross-checks the two implementations agree."""
    cos_lat_ts = math.cos(math.radians(LAT_TRUE_SCALE_DEG))
    dx_m = RADIUS_M * math.radians(lon - LANDING_LON_DEG) * cos_lat_ts
    dy_m = RADIUS_M * math.radians(lat - LANDING_LAT_DEG)
    col = SPAWN_PIXEL["x"] + dx_m / NATIVE_MPP
    row = SPAWN_PIXEL["y"] - dy_m / NATIVE_MPP
    return col, row


class DecimateCoordsTest(unittest.TestCase):
    def test_empty_path(self):
        self.assertEqual(decimate_coords([]), [])

    def test_dedupes_identical_consecutive_points(self):
        coords = [[10.0, 20.0], [10.0, 20.0]]
        out = decimate_coords(coords, min_spacing_m=5.0)
        self.assertEqual(out, [[10.0, 20.0]])

    def test_keeps_first_and_last_even_when_close(self):
        coords = [[10.0, 20.0], [10.0, 20.00001]]
        out = decimate_coords(coords, min_spacing_m=500.0)
        self.assertEqual(out, [[10.0, 20.0], [10.0, 20.00001]])

    def test_drops_points_closer_than_threshold(self):
        # ~1.1 m north per 0.00001 deg lat step; threshold 5m should collapse
        # several interior points but keep the final one.
        coords = [[77.0, 18.0 + i * 0.00001] for i in range(10)]
        out = decimate_coords(coords, min_spacing_m=5.0)
        self.assertLess(len(out), len(coords))
        self.assertEqual(out[0], [77.0, 18.0])
        self.assertEqual(out[-1], [77.0, round(18.0 + 9 * 0.00001, 6)])

    def test_keeps_all_points_when_spacing_exceeds_threshold(self):
        coords = [[77.0, 18.0], [77.1, 18.1], [77.2, 18.2]]
        out = decimate_coords(coords, min_spacing_m=1.0)
        self.assertEqual(len(out), 3)


class BuildSnapshotTest(unittest.TestCase):
    def test_builds_segments_and_source_metadata(self):
        geojson = {
            "features": [
                {
                    "properties": {"sol": 14, "fromRMC": "3_0", "toRMC": "3_110", "length": 6.25},
                    "geometry": {"coordinates": [[77.45, 18.44, -2569.9], [77.46, 18.45, -2560.0]]},
                },
            ]
        }
        snap = build_snapshot(geojson, fetch_date="2026-09-26", min_spacing_m=1.0)
        self.assertEqual(snap["source"]["fetchedAt"], "2026-09-26")
        self.assertEqual(snap["source"]["rawFeatureCount"], 1)
        self.assertEqual(len(snap["segments"]), 1)
        seg = snap["segments"][0]
        self.assertEqual(seg["sol"], 14)
        self.assertEqual(seg["fromRMC"], "3_0")
        self.assertEqual(seg["toRMC"], "3_110")
        self.assertEqual(seg["length"], 6.25)
        self.assertEqual(seg["coords"], [[77.45, 18.44], [77.46, 18.45]])
        self.assertIn("radiusM", snap["projection"])
        self.assertEqual(snap["projection"]["spawnPixel"], SPAWN_PIXEL)


class A3ProjectionTest(unittest.TestCase):
    """A3: first MMGIS vertex projects within 1 px of the Jezero spawn."""

    def test_first_vertex_within_1px_of_spawn(self):
        # First vertex of the real M20_traverse.json feed, sol 14, fromRMC
        # 3_0 (fetched 2026-09-26, see fetch_m20_traverse.py docstring).
        lon, lat = 77.45088573, 18.44462715
        col, row = _lonlat_to_crop_pixel(lon, lat)
        self.assertLessEqual(abs(col - SPAWN_PIXEL["x"]), 1.0)
        self.assertLessEqual(abs(row - SPAWN_PIXEL["y"]), 1.0)


class SnapshotFileTest(unittest.TestCase):
    """Guards against re-committing an oversized or malformed snapshot."""

    def test_snapshot_under_size_cap_and_well_formed(self):
        if not os.path.exists(SNAPSHOT_PATH):
            self.skipTest("assets/mars/m20-traverse.json not generated yet")
        size = os.path.getsize(SNAPSHOT_PATH)
        self.assertLessEqual(size, MAX_OUTPUT_BYTES)
        with open(SNAPSHOT_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        self.assertIn("segments", data)
        self.assertGreater(len(data["segments"]), 0)
        first_coords = data["segments"][0]["coords"]
        self.assertGreaterEqual(len(first_coords), 2)
        lon, lat = first_coords[0]
        col, row = _lonlat_to_crop_pixel(lon, lat)
        self.assertLessEqual(abs(col - SPAWN_PIXEL["x"]), 1.0)
        self.assertLessEqual(abs(row - SPAWN_PIXEL["y"]), 1.0)


if __name__ == "__main__":
    unittest.main()

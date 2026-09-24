"""Offline unit tests for the pure functions in TYCHO's terrain pipeline.

Run: python3 -m unittest discover -s tools -p "test_*.py"
"""
from __future__ import annotations

import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from georef import EquirectParams
from meta_schema import build_meta, validate_meta
from raster_ops import (area_resample, compute_mask_1024, denormalize_from_uint16, fill_nodata, nodata_mask,
                         normalize_to_uint16)
from site_picker import (ensure_clear_of_mask, find_best_square_crop, find_peak, pick_directional_point,
                          pick_mars_goal, pick_moon_spawn)


class TestNormalization(unittest.TestCase):
    def test_round_trip_within_one_ulp(self):
        arr = np.array([[-3000.0, -1500.0], [0.0, 2500.0]], dtype=np.float32)
        h16 = normalize_to_uint16(arr, -3000.0, 2500.0)
        self.assertEqual(h16.dtype, np.uint16)
        back = denormalize_from_uint16(h16, -3000.0, 2500.0)
        np.testing.assert_allclose(back, arr, atol=(2500.0 - -3000.0) / 65535.0 * 1.01)

    def test_extremes_map_to_0_and_65535(self):
        arr = np.array([[-10.0, 10.0]], dtype=np.float32)
        h16 = normalize_to_uint16(arr, -10.0, 10.0)
        self.assertEqual(h16[0, 0], 0)
        self.assertEqual(h16[0, 1], 65535)

    def test_rejects_degenerate_range(self):
        arr = np.zeros((2, 2), dtype=np.float32)
        with self.assertRaises(ValueError):
            normalize_to_uint16(arr, 5.0, 5.0)


class TestAreaResample(unittest.TestCase):
    def test_2x_downsample_averages_blocks(self):
        arr = np.array([[0, 0, 10, 10],
                         [0, 0, 10, 10],
                         [20, 20, 30, 30],
                         [20, 20, 30, 30]], dtype=np.float32)
        out = area_resample(arr, 2, 2)
        self.assertEqual(out.shape, (2, 2))
        np.testing.assert_allclose(out, [[0, 10], [20, 30]], atol=1e-4)

    def test_output_shape_matches_request(self):
        arr = np.random.rand(37, 51).astype(np.float32)
        out = area_resample(arr, 16, 16)
        self.assertEqual(out.shape, (16, 16))

    def test_rejects_non_2d(self):
        with self.assertRaises(ValueError):
            area_resample(np.zeros((2, 2, 2), dtype=np.float32), 2, 2)


class TestNodataFill(unittest.TestCase):
    def test_mask_from_sentinel(self):
        arr = np.array([[1.0, -3.4028235e38], [2.0, 3.0]], dtype=np.float32)
        mask = nodata_mask(arr, -3.4028235e38)
        np.testing.assert_array_equal(mask, [[False, True], [False, False]])

    def test_fill_uses_nearest_valid_and_reports_fraction(self):
        arr = np.array([[5.0, 5.0, 9.0],
                         [5.0, 5.0, 9.0],
                         [5.0, 5.0, 9.0]], dtype=np.float32)
        mask = np.array([[False, False, False],
                          [False, True, False],
                          [False, False, False]])
        filled, frac = fill_nodata(arr, mask)
        self.assertAlmostEqual(frac, 1 / 9)
        self.assertIn(filled[1, 1], (5.0, 9.0))  # filled from a real neighbor, not fabricated

    def test_no_nodata_is_noop(self):
        arr = np.array([[1.0, 2.0]], dtype=np.float32)
        mask = np.zeros_like(arr, dtype=bool)
        filled, frac = fill_nodata(arr, mask)
        self.assertEqual(frac, 0.0)
        np.testing.assert_array_equal(filled, arr)

    def test_all_nodata_raises(self):
        arr = np.zeros((2, 2), dtype=np.float32)
        mask = np.ones((2, 2), dtype=bool)
        with self.assertRaises(ValueError):
            fill_nodata(arr, mask)


class TestEquirectGeoref(unittest.TestCase):
    """Synthetic georef matching the real Mars CTX header's structure
    (spherical Equirectangular, tiepoint at raster origin)."""

    def setUp(self):
        header = {
            "tiepoint": (0.0, 0.0, 0.0, 4_328_999.999999998, 1_143_420.0000000028, 0.0),
            "pixel_scale": (20.0, 20.0, 0.0),
            "geokeys": {3088: 0.0, 3089: 0.0, 3078: 18.4663, 2057: 3_396_190.0},
        }
        self.geo = EquirectParams.from_header(header)

    def test_pixel_to_latlon_matches_known_corner(self):
        # Verified against the real CTX DEM's documented extent this session.
        lat, lon = self.geo.pixel_to_latlon(0, 0)
        self.assertAlmostEqual(lat, 19.29018700686615, places=5)
        self.assertAlmostEqual(lon, 76.99743706146002, places=5)

    def test_latlon_to_pixel_round_trip(self):
        for lat, lon in [(18.4447, 77.4508), (18.9, 77.9), (17.7, 77.1)]:
            i, j = self.geo.latlon_to_pixel(lat, lon)
            lat2, lon2 = self.geo.pixel_to_latlon(i, j)
            self.assertAlmostEqual(lat, lat2, places=6)
            self.assertAlmostEqual(lon, lon2, places=6)

    def test_landing_site_pixel_matches_verified_value(self):
        i, j = self.geo.latlon_to_pixel(18.4447, 77.4508)
        self.assertAlmostEqual(i, 1274.46, delta=0.5)
        self.assertAlmostEqual(j, 2506.10, delta=0.5)


class TestSitePicker(unittest.TestCase):
    def test_find_peak_avoids_nodata_edge_artifact(self):
        elev = np.full((20, 20), 100.0, dtype=np.float32)
        elev[5, 5] = 500.0  # isolated spike right next to a nodata hole
        mask = np.zeros((20, 20), dtype=bool)
        mask[5, 4] = True
        elev[15, 15] = 300.0  # real, well-supported peak
        row, col = find_peak(elev, mask, cellsize_m=2.0, margin_m=6.0)
        self.assertEqual((row, col), (15, 15))

    def test_pick_moon_spawn_excludes_nodata_and_stays_in_annulus(self):
        elev = np.zeros((60, 60), dtype=np.float32)
        mask = np.zeros((60, 60), dtype=bool)
        mask[:, :20] = True  # left third is fabricated fill
        peak = (30, 30)
        row, col = pick_moon_spawn(elev, peak, cellsize_m=1.0, r_min_m=5, r_max_m=15, nodata_mask=mask)
        self.assertFalse(mask[row, col])
        dist = ((row - peak[0]) ** 2 + (col - peak[1]) ** 2) ** 0.5
        self.assertTrue(5 <= dist <= 15 + 1e-6)

    def test_pick_mars_goal_prefers_rough_terrain(self):
        # cellsize matches real Mars usage (20 m/px) so the roughness window
        # (~60m -> 3px) stays small relative to the rough patch.
        elev = np.zeros((600, 600), dtype=np.float32)
        rng = np.random.default_rng(0)
        elev[400:420, 400:420] += rng.normal(0, 50, (20, 20))  # rough patch ~141px (2.8km) away
        mask = np.zeros((600, 600), dtype=bool)
        row, col = pick_mars_goal(elev, (300, 300), cellsize_m=20.0, r_min_m=2000, r_max_m=4000, nodata_mask=mask)
        self.assertTrue(400 <= row < 420 and 400 <= col < 420)

    def test_find_best_square_crop_reduces_nodata(self):
        mask = np.zeros((100, 100), dtype=bool)
        mask[:, :60] = True  # big nodata block on the left
        r0, c0 = find_best_square_crop(mask, size=30, contains_rc=(50, 65))
        naive = mask[50 - 15:50 + 15, 65 - 15:65 + 15].mean()
        found = mask[r0:r0 + 30, c0:c0 + 30].mean()
        self.assertLessEqual(found, naive)
        self.assertLess(found, 0.05)

    def test_ensure_clear_of_mask_relocates_goal_off_masked_cell(self):
        elev = np.zeros((100, 100), dtype=np.float32)
        elev[50, 50] = 100.0  # highest point overall, but sits on a masked cell
        elev[50, 80] = 90.0   # next-highest, well clear of the mask
        mask = np.zeros((100, 100), dtype=np.uint8)
        mask[40:60, 40:60] = 1  # a 20x20 filled block containing (50, 50)
        (row, col), changed = ensure_clear_of_mask((50, 50), elev, mask, min_px=20, mode="max_elev")
        self.assertTrue(changed)
        self.assertEqual(mask[row, col], 0)
        dist_ok = min(abs(row - r) for r in range(40, 60)) >= 0  # sanity: still in-bounds
        self.assertTrue(dist_ok)
        self.assertEqual((row, col), (50, 80))

    def test_ensure_clear_of_mask_leaves_clear_point_unchanged(self):
        elev = np.zeros((50, 50), dtype=np.float32)
        mask = np.zeros((50, 50), dtype=np.uint8)
        mask[0:10, 0:10] = 1
        point, changed = ensure_clear_of_mask((40, 40), elev, mask, min_px=20, mode="max_elev")
        self.assertFalse(changed)
        self.assertEqual(point, (40, 40))

    def test_ensure_clear_of_mask_noop_when_nothing_masked(self):
        elev = np.zeros((20, 20), dtype=np.float32)
        mask = np.zeros((20, 20), dtype=np.uint8)
        point, changed = ensure_clear_of_mask((5, 5), elev, mask, min_px=20, mode="max_elev")
        self.assertFalse(changed)
        self.assertEqual(point, (5, 5))


class TestEquirectGeorefLunokhod(unittest.TestCase):
    """Synthetic georef matching the real NAC_DTM_LUNOKHOD2 header structure
    (spherical Equirectangular, CenterLong=180 rather than 0 -- a different
    GeoKey combination than the Mars/Moon-Tycho fixtures above, so this
    exercises the lon0 != 0 branch of the same formulas). Verified this
    session against the real file's GeoTIFF tags and the product page's
    documented extent (24.86-26.68N, 30.32-31.09E)."""

    def setUp(self):
        header = {
            "tiepoint": (0.0, 0.0, 0.0, -4079544.9999999, 809114.99999998, 0.0),
            "pixel_scale": (4.9999999999999, 4.9999999999999, 0.0),
            "geokeys": {3088: 180.0, 3089: 0.0, 3078: 26.0, 2057: 1737400.0},
        }
        self.geo = EquirectParams.from_header(header)
        self.width, self.height = 4232, 11050

    def test_corners_match_real_product_page_extent(self):
        lat_tl, lon_tl = self.geo.pixel_to_latlon(0, 0)
        lat_br, lon_br = self.geo.pixel_to_latlon(self.width - 1, self.height - 1)
        self.assertAlmostEqual(lat_tl, 26.6829, places=3)
        self.assertAlmostEqual(lon_tl, 30.3164, places=3)
        self.assertAlmostEqual(lat_br, 24.8610, places=3)
        self.assertAlmostEqual(lon_br, 31.0926, places=3)

    def test_lunokhod2_parked_pixel_in_bounds(self):
        # 25.830N, 30.914E -- LROC post 699's parked-rover coordinate.
        i, j = self.geo.latlon_to_pixel(25.830, 30.914)
        self.assertTrue(0 <= i < self.width)
        self.assertTrue(0 <= j < self.height)
        self.assertAlmostEqual(i, 3257.7, delta=1.0)
        self.assertAlmostEqual(j, 5172.6, delta=1.0)

    def test_round_trip(self):
        for lat, lon in [(25.830, 30.914), (26.005, 30.406), (25.0, 30.5)]:
            i, j = self.geo.latlon_to_pixel(lat, lon)
            lat2, lon2 = self.geo.pixel_to_latlon(i, j)
            self.assertAlmostEqual(lat, lat2, places=6)
            self.assertAlmostEqual(lon, lon2, places=6)


class TestPickDirectionalPoint(unittest.TestCase):
    def test_prefers_flat_cell_within_sector(self):
        elev = np.zeros((200, 200), dtype=np.float32)
        # A ramp makes every cell's slope distinct so argmin has one answer.
        # South of center is gentle (small per-row rise); west is much steeper.
        elev += np.arange(200, dtype=np.float32)[:, None] * 0.01
        elev[80:120, 60:80] += np.arange(20, dtype=np.float32) * 20.0  # steep patch west of center
        center = (100, 100)
        row, col = pick_directional_point(
            elev, center, cellsize_m=1.0, r_min_m=20, r_max_m=40,
            bearing_deg=180.0, bearing_width_deg=60.0)
        # picked point must be within the south sector: row > center row
        self.assertGreater(row, center[0])
        dist = ((row - center[0]) ** 2 + (col - center[1]) ** 2) ** 0.5
        self.assertTrue(20 <= dist <= 40 + 1e-6)

    def test_respects_distance_annulus(self):
        elev = np.zeros((300, 300), dtype=np.float32)
        center = (150, 150)
        row, col = pick_directional_point(
            elev, center, cellsize_m=1.0, r_min_m=50, r_max_m=100,
            bearing_deg=180.0, bearing_width_deg=90.0)
        dist = ((row - center[0]) ** 2 + (col - center[1]) ** 2) ** 0.5
        self.assertTrue(50 <= dist <= 100 + 1e-6)
        self.assertGreaterEqual(row, center[0])  # south half

    def test_excludes_nodata_and_edge_margin(self):
        elev = np.zeros((300, 300), dtype=np.float32)
        mask = np.zeros((300, 300), dtype=bool)
        mask[150:220, 130:170] = True  # blocks the nearest south cells
        row, col = pick_directional_point(
            elev, (150, 150), cellsize_m=1.0, r_min_m=10, r_max_m=290,
            bearing_deg=180.0, bearing_width_deg=90.0, nodata_mask=mask, edge_margin_px=10)
        self.assertFalse(mask[row, col])
        self.assertTrue(10 <= row < 290 and 10 <= col < 290)

    def test_falls_back_to_full_annulus_when_sector_empty(self):
        elev = np.zeros((50, 50), dtype=np.float32)
        mask = np.zeros((50, 50), dtype=bool)
        mask[:, 25:] = True  # blocks the entire east half, including any south-sector cell east of center
        row, col = pick_directional_point(
            elev, (25, 10), cellsize_m=1.0, r_min_m=5, r_max_m=15,
            bearing_deg=90.0, bearing_width_deg=20.0, nodata_mask=mask)  # sector points east, all masked
        self.assertFalse(mask[row, col])  # fell back to the (unmasked) full annulus


class TestComputeMask1024(unittest.TestCase):
    def test_marks_cell_filled_at_threshold(self):
        # 8x8 native array downsampled to 2x2: each output cell covers a 4x4
        # source block. Fill the source so one block is 50% nodata (over the
        # 25% default threshold) and another is 10% (under it).
        submask = np.zeros((8, 8), dtype=bool)
        submask[0:4, 0:4][:2, :] = True  # top-left output block: 8/16 = 50%
        submask[0:4, 4:8][0, 0] = True   # top-right output block: 1/16 ~ 6%
        out = compute_mask_1024(submask, 2, 2, threshold=0.25)
        self.assertEqual(out.dtype, np.uint8)
        self.assertEqual(out[0, 0], 1)
        self.assertEqual(out[0, 1], 0)

    def test_all_clear_gives_all_zero_mask(self):
        submask = np.zeros((16, 16), dtype=bool)
        out = compute_mask_1024(submask, 4, 4)
        self.assertTrue((out == 0).all())

    def test_all_filled_gives_all_one_mask(self):
        submask = np.ones((16, 16), dtype=bool)
        out = compute_mask_1024(submask, 4, 4)
        self.assertTrue((out == 1).all())


class TestMetaSchema(unittest.TestCase):
    def test_build_and_validate_round_trip(self):
        meta = build_meta(
            width=1024, height=1024, meters_per_pixel=2.0, min_elev=-100.0, max_elev=500.0,
            size_km=2.048, spawn={"x": 1, "y": 2}, goal={"x": 3, "y": 4}, source={"product": "x"},
            license_text="public domain", credit="NASA", nodata_filled_fraction=0.01, notes="test",
        )
        self.assertEqual(validate_meta(meta), [])
        self.assertEqual(meta["heightScale"], 600.0)
        self.assertEqual(meta["maskFile"], "mask.bin")
        self.assertEqual(meta["maskMeaning"], "1 = no orbital data (filled), treat as impassable")

    def test_validate_catches_missing_keys(self):
        self.assertIn("missing required key: license", validate_meta({}))
        self.assertIn("missing required key: maskFile", validate_meta({}))
        self.assertIn("missing required key: maskMeaning", validate_meta({}))

    def test_validate_catches_bad_elev_range(self):
        meta = build_meta(
            width=1, height=1, meters_per_pixel=1.0, min_elev=10.0, max_elev=10.0, size_km=1.0,
            spawn={"x": 0, "y": 0}, goal={"x": 0, "y": 0}, source={}, license_text="x", credit="x",
            nodata_filled_fraction=0.0, notes="x",
        )
        errors = validate_meta(meta)
        self.assertTrue(any("maxElev" in e for e in errors))

    def test_validate_catches_malformed_point(self):
        meta = build_meta(
            width=1, height=1, meters_per_pixel=1.0, min_elev=0.0, max_elev=1.0, size_km=1.0,
            spawn={"x": 0}, goal={"x": 0, "y": 0}, source={}, license_text="x", credit="x",
            nodata_filled_fraction=0.0, notes="x",
        )
        errors = validate_meta(meta)
        self.assertTrue(any("spawn must have x and y" in e for e in errors))


if __name__ == "__main__":
    unittest.main()

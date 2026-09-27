"""Offline unit tests for tools/pds_img.py and tools/ortho_albedo.py's pure
functions. No network access (see plan-wave3.md L3 accept line: "PDS3
label parser unit-tested on a saved label").

Run: python3 -m unittest discover -s tools -p "test_*.py"
"""
from __future__ import annotations

import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from ortho_albedo import _anchored_rowcol_to_latlon, _best_ncc_offset, _to_uint8_stretch
from pds_img import OrthoLabel, parse_label

# Saved verbatim (CRLF normalized to LF) from the first 8000 bytes of
# https://lroc.im-ldi.com/data/LRO-L-LROC-5-RDR-V1.0/LROLRC_2001/DATA/SDP/NAC_DTM/APOLLO17/NAC_DTM_APOLLO17_MOSAIC_5M.IMG
# (HTTP Range fetch, 2026-09-26). This is the exact PDS3 label of the
# ortho product tools/ortho_albedo.py pairs with assets/apollo17/.
APOLLO17_ORTHO_LABEL = """PDS_VERSION_ID            = PDS3

/* The source image data definition. */
RECORD_TYPE   = FIXED_LENGTH
RECORD_BYTES  = 19970
FILE_RECORDS  = 11601
LABEL_RECORDS = 1
^IMAGE        = 2

/* Identification Information  */
DATA_SET_ID               = "LRO-L-LROC-5-RDR-V1.0"
DATA_SET_NAME             = "LRO MOON LROC 5 RDR V1.0"
VOLUME_ID                 = "LROLRC_2001"
PRODUCER_INSTITUTION_NAME = "ARIZONA STATE UNIVERSITY"
PRODUCER_ID               = LRO_LROC_TEAM
PRODUCER_FULL_NAME        = "MARK ROBINSON, PH.D"
PRODUCT_ID                = NAC_DTM_APOLLO17_MOSAIC_5M
PRODUCT_VERSION_ID        = "v1.9"
PRODUCT_TYPE              = RDR
INSTRUMENT_HOST_NAME      = "LUNAR RECONNAISSANCE ORBITER"
INSTRUMENT_HOST_ID        = LRO
INSTRUMENT_NAME           = "LUNAR RECONNAISSANCE ORBITER CAMERA"
INSTRUMENT_ID             = LROC
TARGET_NAME               = MOON

/* Time Parameters */
START_TIME                   = 2010-07-28T19:35:36
STOP_TIME                    = 2016-03-17T19:55:14

OBJECT = IMAGE_MAP_PROJECTION
    ^DATA_SET_MAP_PROJECTION     = "DSMAP.CAT"
    MAP_PROJECTION_TYPE          = EQUIRECTANGULAR
    PROJECTION_LATITUDE_TYPE     = PLANETOCENTRIC
    A_AXIS_RADIUS                = 1737.4 <KM>
    B_AXIS_RADIUS                = 1737.4 <KM>
    C_AXIS_RADIUS                = 1737.4 <KM>
    COORDINATE_SYSTEM_NAME       = PLANETOCENTRIC
    POSITIVE_LONGITUDE_DIRECTION = EAST
    KEYWORD_LATITUDE_TYPE        = PLANETOCENTRIC
    CENTER_LATITUDE               = 20.0 <DEG>
    CENTER_LONGITUDE              = 180.0 <DEG>
    LINE_FIRST_PIXEL              = 1
    LINE_LAST_PIXEL                = 11600
    SAMPLE_FIRST_PIXEL             = 1
    SAMPLE_LAST_PIXEL              = 9985
    MAP_PROJECTION_ROTATION        = 0.0 <DEG>
    MAP_RESOLUTION                 = 6064.67008483 <PIX/DEG>
    MAP_SCALE                      = 4.9999999999999005 <METERS/PIXEL>
    MAXIMUM_LATITUDE                = 21.30330227 <DEG>
    MINIMUM_LATITUDE                = 19.39074976 <DEG>
    EASTERNMOST_LONGITUDE           = 31.65760468 <DEG>
    WESTERNMOST_LONGITUDE           = 29.90575346 <DEG>
    LINE_PROJECTION_OFFSET          = 129197.5 <PIXEL>
    SAMPLE_PROJECTION_OFFSET        = 855375.5 <PIXEL>
END_OBJECT = IMAGE_MAP_PROJECTION

OBJECT = IMAGE
    DESCRIPTION                = "Apollo 17 Landing Site in Taurus-Littrow
                                 Valley orthomosaic from NAC images at 5.00
                                 m/px. For more info, see
                                 [HENRIKSENETAL2017]."
    LINES                      = 11600
    LINE_SAMPLES               = 9985
    SAMPLE_TYPE                = LSB_INTEGER
    SAMPLE_BITS                = 16
    SAMPLE_BIT_MASK            = 2#1111111111111111#
    SCALING_FACTOR             = 1.0
    OFFSET                     = 0.0
    CORE_NULL                  = -32768
    CORE_LOW_REPR_SATURATION   = -32767
    CORE_LOW_INSTR_SATURATION  = -32766
    CORE_HIGH_REPR_SATURATION  = -32764
    CORE_HIGH_INSTR_SATURATION = -32765
    BAND_STORAGE_TYPE          = BAND_SEQUENTIAL
    BANDS                      = 1
    FILTER_NAME                = BROADBAND
END_OBJECT = IMAGE

END
"""


class ParseLabelTests(unittest.TestCase):
    def test_parses_flat_key_values(self):
        values = parse_label(APOLLO17_ORTHO_LABEL)
        self.assertEqual(values["PRODUCT_ID"], "NAC_DTM_APOLLO17_MOSAIC_5M")
        self.assertEqual(values["LINES"], 11600)
        self.assertEqual(values["LINE_SAMPLES"], 9985)
        self.assertEqual(values["SAMPLE_TYPE"], "LSB_INTEGER")
        self.assertEqual(values["CORE_NULL"], -32768)
        self.assertAlmostEqual(values["MAP_SCALE"], 4.9999999999999005)
        self.assertEqual(values["MAP_PROJECTION_TYPE"], "EQUIRECTANGULAR")

    def test_ignores_comment_and_continuation_lines(self):
        values = parse_label(APOLLO17_ORTHO_LABEL)
        # DESCRIPTION's continuation lines have no '=' and must not leak
        # into the flat namespace as bogus keys.
        self.assertNotIn("VALLEY", values)
        self.assertIn("DESCRIPTION", values)

    def test_stops_scanning_at_end_line(self):
        # A trailing blank line after END must not confuse anything the
        # caller does after parse_label (fetch_label_text is what actually
        # truncates at END; parse_label itself just ignores lines with no
        # '=', so this just confirms nothing after END leaks a bad key).
        values = parse_label(APOLLO17_ORTHO_LABEL)
        self.assertNotIn("END", values)


class OrthoLabelTests(unittest.TestCase):
    def setUp(self):
        self.label = OrthoLabel.from_text(APOLLO17_ORTHO_LABEL)

    def test_basic_fields(self):
        self.assertEqual(self.label.lines, 11600)
        self.assertEqual(self.label.samples, 9985)
        self.assertEqual(self.label.dtype, "<i2")
        self.assertEqual(self.label.core_null, -32768.0)
        self.assertEqual(self.label.image_byte_offset, 19970)  # (IMAGE record 2 - 1) * RECORD_BYTES

    def test_rejects_non_equirectangular_projection(self):
        bad = APOLLO17_ORTHO_LABEL.replace("MAP_PROJECTION_TYPE          = EQUIRECTANGULAR",
                                            "MAP_PROJECTION_TYPE          = POLAR_STEREOGRAPHIC")
        with self.assertRaises(ValueError):
            OrthoLabel.from_text(bad)

    def test_rejects_unsupported_sample_type(self):
        bad = APOLLO17_ORTHO_LABEL.replace("SAMPLE_TYPE                = LSB_INTEGER",
                                            "SAMPLE_TYPE                = MSB_INTEGER")
        with self.assertRaises(ValueError):
            OrthoLabel.from_text(bad)

    def test_corner_latlon_matches_labels_own_stated_bounds(self):
        # A1 verification: recompute the label's own MAXIMUM_LATITUDE/
        # MINIMUM_LATITUDE/EASTERNMOST_LONGITUDE/WESTERNMOST_LONGITUDE from
        # LINES/LINE_SAMPLES via the projection formula and check they
        # match to within 0.001 deg (~40m) -- confirmed against all four
        # of this repo's ortho labels this session (see module docstrings).
        lat0, lon0 = self.label.rowcol_to_latlon(0, 0)
        lat1, lon1 = self.label.rowcol_to_latlon(self.label.lines - 1, self.label.samples - 1)
        self.assertAlmostEqual(lat0, self.label.max_lat, delta=0.001)
        self.assertAlmostEqual(lon0, self.label.west_lon, delta=0.001)
        self.assertAlmostEqual(lat1, self.label.min_lat, delta=0.001)
        self.assertAlmostEqual(lon1, self.label.east_lon, delta=0.001)

    def test_latlon_pixel_roundtrip(self):
        lat, lon = self.label.rowcol_to_latlon(5000.0, 4000.0)
        row, col = self.label.latlon_to_rowcol(lat, lon)
        self.assertAlmostEqual(row, 5000.0, places=6)
        self.assertAlmostEqual(col, 4000.0, places=6)

    def test_rejects_record_layout_with_unexpected_prefix_bytes(self):
        bad = APOLLO17_ORTHO_LABEL.replace("RECORD_BYTES  = 19970", "RECORD_BYTES  = 20000")
        with self.assertRaises(ValueError):
            OrthoLabel.from_text(bad)


class BestNccOffsetTests(unittest.TestCase):
    def test_recovers_known_integer_shift(self):
        rng = np.random.default_rng(0)
        base = rng.normal(size=(64, 64))
        shifted = np.roll(np.roll(base, 2, axis=0), -3, axis=1)
        dy, dx, ncc = _best_ncc_offset(base, shifted, search_px=5)
        # _best_ncc_offset's convention (see ortho_albedo.py): the returned
        # offset is the negative of the roll applied to b relative to a.
        self.assertEqual((dy, dx), (-2, 3))
        self.assertGreater(ncc, 0.99)

    def test_flat_image_gives_low_incoherent_correlation(self):
        rng = np.random.default_rng(1)
        flat = np.full((64, 64), 100.0)
        noise = rng.normal(scale=0.01, size=(64, 64))
        dy, dx, ncc = _best_ncc_offset(flat, noise, search_px=4)
        self.assertLess(abs(ncc), 0.5)


class ToUint8StretchTests(unittest.TestCase):
    def test_stretches_full_range(self):
        arr = np.linspace(100.0, 200.0, 100).reshape(10, 10)
        out = _to_uint8_stretch(arr, lo_pct=0.0, hi_pct=100.0)
        self.assertEqual(out.dtype, np.uint8)
        self.assertEqual(out.min(), 0)
        self.assertEqual(out.max(), 255)

    def test_constant_array_does_not_divide_by_zero(self):
        arr = np.full((10, 10), 42.0)
        out = _to_uint8_stretch(arr)
        self.assertTrue(np.all(np.isfinite(out)))


class AnchoredRowColToLatLonTests(unittest.TestCase):
    def _meta(self, spawn_lat, spawn_lon):
        return {
            "goalLatLon": {"lat": 25.830, "lon": 30.914},
            "goal": {"x": 512, "y": 512},
            "spawnLatLon": {"lat": spawn_lat, "lon": spawn_lon},
            "spawn": {"x": 524, "y": 924},
            "metersPerPixel": 4.9999999999999,
        }

    def test_self_check_passes_for_consistent_meta(self):
        # spawnLatLon here is assets/lunokhod/meta.json's real recorded
        # value at its real recorded spawn pixel -- must round-trip.
        fn = _anchored_rowcol_to_latlon(self._meta(25.76199, 30.91626), "lunokhod")
        self.assertTrue(callable(fn))

    def test_self_check_raises_on_inconsistent_spawn_latlon(self):
        # A spawnLatLon far from what the goal-anchored formula predicts at
        # the recorded spawn pixel must fail loud, not silently ship a
        # misplaced crop.
        with self.assertRaises(ValueError):
            _anchored_rowcol_to_latlon(self._meta(26.5, 32.0), "lunokhod")


if __name__ == "__main__":
    unittest.main()

"""PDS3 IMG (ISIS/LROC RDR label + raster) reader for LRO NAC orthophoto
products, read via HTTP byte-range requests (these files are 25-230+ MB;
only the label and the pixels a caller actually needs are fetched).

Label format and the IMAGE_MAP_PROJECTION cartographic math below were
confirmed this session (2026-09-26) by fetching and parsing all four
orthophoto labels this repo's existing Moon sites pair with, and
recomputing each label's own MAXIMUM_LATITUDE/MINIMUM_LATITUDE/
EASTERNMOST_LONGITUDE/WESTERNMOST_LONGITUDE from LINES/LINE_SAMPLES,
matching every one to within 0.001 deg (<40 m):
  - https://lroc.im-ldi.com/data/LRO-L-LROC-5-RDR-V1.0/LROLRC_2001/DATA/SDP/NAC_DTM/APOLLO17/NAC_DTM_APOLLO17_MOSAIC_5M.IMG
    (EQUIRECTANGULAR, LINES=11600, LINE_SAMPLES=9985, LSB_INTEGER, CORE_NULL=-32768)
  - .../CHANGE4/NAC_DTM_CHANGE4_M1303619844_5M.IMG (LINES=5496, LINE_SAMPLES=2184, LSB_UNSIGNED_INTEGER, CORE_NULL=0)
  - .../LUNOKHOD2/NAC_DTM_LUNOKHOD2_MOSAIC_5M.IMG (LINES=11050, LINE_SAMPLES=4232, LSB_UNSIGNED_INTEGER, CORE_NULL=0)
  - .../TYCHOPK01/NAC_DTM_TYCHOPK01_M1136634925_2M.IMG (LINES=15256, LINE_SAMPLES=3480, LSB_UNSIGNED_INTEGER, CORE_NULL=0)

Projection formula (PDS3 IMAGE_MAP_PROJECTION, spherical Equirectangular,
1-indexed pixel centers -- verified numerically above, not assumed):
    line   = LINE_PROJECTION_OFFSET + 1 - R*radians(lat)/MAP_SCALE
    sample = SAMPLE_PROJECTION_OFFSET + 1 + R*cos(radians(CENTER_LATITUDE))*radians(lon-CENTER_LONGITUDE)/MAP_SCALE
Note CENTER_LATITUDE only scales longitude (it is the projection's standard
parallel); latitude itself is measured from the equator, not from
CENTER_LATITUDE -- confirmed by the residual check above (using
CENTER_LATITUDE as a latitude origin instead misplaces line 1 by tens of
degrees).
"""
from __future__ import annotations

import re

import numpy as np
import requests

RANGE_LABEL_BYTES = 8000  # every label seen this session is well under this
_DTYPE_MAP = {("LSB_INTEGER", 16): "<i2", ("LSB_UNSIGNED_INTEGER", 16): "<u2"}
_NUMBER_RE = re.compile(r"^(-?\d+\.?\d*(?:[eE][+-]?\d+)?)\s*(?:<[A-Za-z/]+>)?$")
_KEY_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")


def _parse_value(raw: str):
    raw = raw.strip()
    m = _NUMBER_RE.match(raw)
    if m:
        s = m.group(1)
        return float(s) if ("." in s or "e" in s.lower()) else int(s)
    if raw.startswith('"') and raw.endswith('"') and len(raw) >= 2:
        return raw[1:-1]
    return raw


def parse_label(text: str) -> dict:
    """Flat dict of every simple KEY = VALUE line in a PDS3 label. Nested
    OBJECT/GROUP blocks share one flat namespace (fine here: none of the
    keys this reader needs collide across objects in any of the four
    labels checked this session)."""
    values: dict[str, object] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("/*") or "=" not in line:
            continue
        key, _, raw = line.partition("=")
        key = key.strip().lstrip("^")
        if not key or not _KEY_RE.match(key):
            continue
        values[key] = _parse_value(raw)
    return values


def fetch_label_text(url: str, max_bytes: int = RANGE_LABEL_BYTES, session: "requests.Session | None" = None) -> str:
    """Fetches the first max_bytes of url and returns the text up to and
    including the PDS3 label's terminating 'END' line. Raises if the
    server does not honor the byte-range request or no END is found."""
    get = (session or requests).get
    resp = get(url, headers={"Range": f"bytes=0-{max_bytes - 1}"}, timeout=30)
    resp.raise_for_status()
    if resp.status_code != 206:
        raise RuntimeError(f"server did not honor Range request for {url} (status {resp.status_code})")
    text = resp.content.decode("latin1")
    end_match = None
    for m in re.finditer(r"(?m)^END\s*\r?$", text):
        end_match = m
        break
    if end_match is None:
        raise ValueError(f"PDS3 label END not found in first {max_bytes} bytes of {url}; "
                          "increase max_bytes")
    return text[:end_match.end()]


class OrthoLabel:
    """Parsed PDS3 IMAGE_MAP_PROJECTION + IMAGE object fields needed to
    georeference and read an LROC NAC orthophoto .IMG."""

    def __init__(self, values: dict):
        self.values = values
        self.lines = int(values["LINES"])
        self.samples = int(values["LINE_SAMPLES"])
        sample_type = values["SAMPLE_TYPE"]
        sample_bits = int(values["SAMPLE_BITS"])
        key = (sample_type, sample_bits)
        if key not in _DTYPE_MAP:
            raise ValueError(f"unsupported PDS3 SAMPLE_TYPE/SAMPLE_BITS combo: {key}")
        self.dtype = _DTYPE_MAP[key]
        self.core_null = float(values["CORE_NULL"])
        self.record_bytes = int(values["RECORD_BYTES"])
        self.image_record = int(values["IMAGE"])  # 1-indexed record where pixel data starts
        map_type = values.get("MAP_PROJECTION_TYPE")
        if map_type != "EQUIRECTANGULAR":
            raise ValueError(f"unsupported MAP_PROJECTION_TYPE: {map_type!r} (only EQUIRECTANGULAR handled)")
        self.map_scale = float(values["MAP_SCALE"])
        self.center_lat = float(values["CENTER_LATITUDE"])
        self.center_lon = float(values["CENTER_LONGITUDE"])
        self.line_offset = float(values["LINE_PROJECTION_OFFSET"])
        self.sample_offset = float(values["SAMPLE_PROJECTION_OFFSET"])
        self.radius_m = float(values["A_AXIS_RADIUS"]) * 1000.0
        self.min_lat = float(values["MINIMUM_LATITUDE"])
        self.max_lat = float(values["MAXIMUM_LATITUDE"])
        self.west_lon = float(values["WESTERNMOST_LONGITUDE"])
        self.east_lon = float(values["EASTERNMOST_LONGITUDE"])
        self.product_id = values.get("PRODUCT_ID")
        itemsize = np.dtype(self.dtype).itemsize
        if self.record_bytes != self.samples * itemsize:
            raise ValueError(f"unexpected record layout: RECORD_BYTES={self.record_bytes} != "
                              f"LINE_SAMPLES({self.samples})*itemsize({itemsize}); this reader assumes "
                              "no per-record prefix/suffix bytes")
        self.image_byte_offset = (self.image_record - 1) * self.record_bytes

    @classmethod
    def from_text(cls, label_text: str) -> "OrthoLabel":
        return cls(parse_label(label_text))

    # -- projection: row/col are 0-based pixel indices (row=line-1, col=sample-1) --
    def line_to_lat(self, line) -> float:
        y = self.map_scale * (self.line_offset + 1 - line)
        return np.degrees(y / self.radius_m)

    def sample_to_lon(self, sample) -> float:
        x = self.map_scale * (sample - 1 - self.sample_offset)
        return self.center_lon + np.degrees(x / (self.radius_m * np.cos(np.radians(self.center_lat))))

    def lat_to_line(self, lat):
        y = self.radius_m * np.radians(lat)
        return self.line_offset + 1 - y / self.map_scale

    def lon_to_sample(self, lon):
        x = self.radius_m * np.cos(np.radians(self.center_lat)) * np.radians(lon - self.center_lon)
        return self.sample_offset + 1 + x / self.map_scale

    def rowcol_to_latlon(self, row, col):
        return self.line_to_lat(row + 1), self.sample_to_lon(col + 1)

    def latlon_to_rowcol(self, lat, lon):
        return self.lat_to_line(lat) - 1, self.lon_to_sample(lon) - 1


def fetch_window(url: str, label: OrthoLabel, row0: int, row1: int, col0: int, col1: int,
                  session: "requests.Session | None" = None) -> np.ndarray:
    """Fetches full-width rows [row0, row1) via one HTTP Range request (rows
    are stored one per fixed-length record, so a row range is always
    contiguous), then slices columns [col0, col1) locally. Returns float64.
    row/col are 0-based; row1/col1 are clamped to the raster bounds."""
    row0 = max(0, row0)
    row1 = min(label.lines, row1)
    col0 = max(0, col0)
    col1 = min(label.samples, col1)
    if row0 >= row1 or col0 >= col1:
        raise ValueError(f"empty window: rows [{row0},{row1}) cols [{col0},{col1})")
    start = label.image_byte_offset + row0 * label.record_bytes
    length = (row1 - row0) * label.record_bytes
    get = (session or requests).get
    resp = get(url, headers={"Range": f"bytes={start}-{start + length - 1}"}, timeout=180)
    resp.raise_for_status()
    if resp.status_code != 206:
        raise RuntimeError(f"server did not honor Range request for {url} (status {resp.status_code})")
    raw = np.frombuffer(resp.content, dtype=label.dtype)
    n_samples_per_row = label.record_bytes // np.dtype(label.dtype).itemsize
    full = raw.reshape(row1 - row0, n_samples_per_row)
    return full[:, col0:col1].astype(np.float64)

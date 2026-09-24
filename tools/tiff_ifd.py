"""Minimal baseline-TIFF IFD parser for the tags TYCHO's pipeline needs.

Only reads tag metadata (dimensions, strip layout, GeoTIFF georeferencing,
GDAL nodata). Pixel data itself is read via PIL, which handles the
uncompressed float32 strips reliably (verified against both source files).
This module exists because PIL does not expose GeoTIFF georeferencing tags.
"""
from __future__ import annotations

import struct

_TYPES = {1: ("B", 1), 2: ("c", 1), 3: ("H", 2), 4: ("I", 4), 5: ("II", 8), 11: ("f", 4), 12: ("d", 8)}

# GeoKey IDs we care about.
GEOKEY_PROJ_COORD_TRANS = 3075  # CT_Equirectangular == 17
GEOKEY_CENTER_LONG = 3088
GEOKEY_CENTER_LAT = 3089
GEOKEY_STD_PARALLEL_1 = 3078
GEOKEY_SEMI_MAJOR_AXIS = 2057
CT_EQUIRECTANGULAR = 17


def _read_entry(data: bytes, entry_off: int, bo: str):
    tag, typ, count = struct.unpack_from(bo + "HHI", data, entry_off)
    fmt, tsize = _TYPES.get(typ, ("B", 1))
    total = tsize * count
    val_off_field = entry_off + 8
    if total <= 4:
        raw = data[val_off_field:val_off_field + total]
        offset = None
    else:
        offset = struct.unpack_from(bo + "I", data, val_off_field)[0]
        raw = data[offset:offset + total]
    if typ == 2:  # ASCII
        value = raw.split(b"\x00")[0].decode("latin1")
    elif typ in (3, 4, 11, 12):
        value = list(struct.unpack_from(bo + fmt * count, raw, 0))
    else:
        value = raw
    return tag, typ, count, offset, value


def parse_header(data: bytes) -> dict:
    """Parse enough of a baseline little-endian TIFF header to extract
    dimensions, strip layout, and GeoTIFF georeferencing. `data` must
    contain the header, IFD, and all tag value arrays (a few hundred KB
    from the start of the file is sufficient for these products)."""
    if data[:2] != b"II":
        raise ValueError("only little-endian (Intel) TIFF is supported")
    bo = "<"
    ifd_off = struct.unpack_from(bo + "I", data, 4)[0]
    n = struct.unpack_from(bo + "H", data, ifd_off)[0]
    tags: dict[int, list] = {}
    for i in range(n):
        entry_off = ifd_off + 2 + i * 12
        tag, typ, count, offset, value = _read_entry(data, entry_off, bo)
        tags[tag] = value

    geodoubles = tags.get(34736, [])
    geoascii = tags.get(34737, "")
    geokeys: dict[int, object] = {}
    gk_raw = tags.get(34735)
    if gk_raw:
        num_keys = gk_raw[3]
        for i in range(num_keys):
            base = 4 + i * 4
            key_id, loc, count, val_off = gk_raw[base:base + 4]
            if loc == 0:
                geokeys[key_id] = val_off
            elif loc == 34736:
                geokeys[key_id] = geodoubles[val_off] if count == 1 else geodoubles[val_off:val_off + count]
            elif loc == 34737:
                geokeys[key_id] = geoascii[val_off:val_off + count].rstrip("\x00|")

    nodata_str = tags.get(42113)
    nodata = float(nodata_str) if nodata_str else None

    return {
        "width": tags[256][0],
        "height": tags[257][0],
        "bits_per_sample": tags[258][0],
        "sample_format": tags.get(339, [1])[0],
        "compression": tags[259][0],
        "pixel_scale": tuple(tags[33550]),
        "tiepoint": tuple(tags[33922]),
        "geokeys": geokeys,
        "geodoubles": geodoubles,
        "geoascii": geoascii,
        "nodata": nodata,
    }


def read_header(path: str, nbytes: int = 300_000) -> dict:
    with open(path, "rb") as f:
        data = f.read(nbytes)
    return parse_header(data)

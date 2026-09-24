"""Equirectangular GeoTIFF georeferencing: pixel <-> projected meters <-> lat/lon.

Both TYCHO source rasters (LROC NAC DTM, USGS CTX Jezero DEM) use the
spherical Equirectangular projection (GeoTIFF ProjCoordTransGeoKey=17) with
tiepoint + pixel-scale affine georeferencing. Verified against both files'
GeoTIFF tags on 2026-09-23: Mars corner coordinates computed from these
formulas matched the source's documented extent (17.58-19.29N, 76.99-78.58E)
exactly.
"""
from __future__ import annotations

import math

from tiff_ifd import GEOKEY_CENTER_LAT, GEOKEY_CENTER_LONG, GEOKEY_SEMI_MAJOR_AXIS, GEOKEY_STD_PARALLEL_1


class EquirectParams:
    def __init__(self, lon0: float, lat0: float, lat_ts: float, radius_m: float,
                 tiepoint: tuple, pixel_scale: tuple):
        self.lon0 = lon0
        self.lat0 = lat0
        self.lat_ts = lat_ts
        self.radius_m = radius_m
        # tiepoint = (I0, J0, K0, X0, Y0, Z0)
        self.i0, self.j0 = tiepoint[0], tiepoint[1]
        self.x0, self.y0 = tiepoint[3], tiepoint[4]
        self.sx, self.sy = pixel_scale[0], pixel_scale[1]

    @classmethod
    def from_header(cls, header: dict) -> "EquirectParams":
        gk = header["geokeys"]
        lon0 = gk.get(GEOKEY_CENTER_LONG, 0.0)
        lat0 = gk.get(GEOKEY_CENTER_LAT, 0.0)
        lat_ts = gk.get(GEOKEY_STD_PARALLEL_1, 0.0)
        radius_m = gk.get(GEOKEY_SEMI_MAJOR_AXIS)
        if radius_m is None:
            raise ValueError("GeoTIFF header has no SemiMajorAxis geokey; cannot georeference")
        return cls(lon0, lat0, lat_ts, radius_m, header["tiepoint"], header["pixel_scale"])

    def pixel_to_model(self, i: float, j: float) -> tuple[float, float]:
        x = self.x0 + (i - self.i0) * self.sx
        y = self.y0 - (j - self.j0) * self.sy
        return x, y

    def model_to_pixel(self, x: float, y: float) -> tuple[float, float]:
        i = self.i0 + (x - self.x0) / self.sx
        j = self.j0 + (self.y0 - y) / self.sy
        return i, j

    def model_to_latlon(self, x: float, y: float) -> tuple[float, float]:
        lat = self.lat0 + math.degrees(y / self.radius_m)
        lon = self.lon0 + math.degrees(x / (self.radius_m * math.cos(math.radians(self.lat_ts))))
        return lat, lon

    def latlon_to_model(self, lat: float, lon: float) -> tuple[float, float]:
        x = self.radius_m * math.radians(lon - self.lon0) * math.cos(math.radians(self.lat_ts))
        y = self.radius_m * math.radians(lat - self.lat0)
        return x, y

    def latlon_to_pixel(self, lat: float, lon: float) -> tuple[float, float]:
        x, y = self.latlon_to_model(lat, lon)
        return self.model_to_pixel(x, y)

    def pixel_to_latlon(self, i: float, j: float) -> tuple[float, float]:
        x, y = self.pixel_to_model(i, j)
        return self.model_to_latlon(x, y)

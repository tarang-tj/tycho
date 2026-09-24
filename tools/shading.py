"""Hillshade + body-appropriate albedo texture derived from real elevation.

This produces a *shaded rendering* of the DEM, not a photograph. meta.json
notes must say so explicitly per the data contract.
"""
from __future__ import annotations

import numpy as np


def slope_deg(elev: np.ndarray, cellsize_m: float) -> np.ndarray:
    dzdy, dzdx = np.gradient(elev.astype(np.float64), cellsize_m)
    return np.degrees(np.arctan(np.sqrt(dzdx ** 2 + dzdy ** 2)))


def hillshade(elev: np.ndarray, cellsize_m: float, azimuth_deg: float = 315.0,
              altitude_deg: float = 45.0) -> np.ndarray:
    """Standard (Horn 1981 / ESRI) analytical hillshade. Returns uint8 [0,255]."""
    dzdy, dzdx = np.gradient(elev.astype(np.float64), cellsize_m)
    slope = np.arctan(np.sqrt(dzdx ** 2 + dzdy ** 2))
    aspect = np.arctan2(dzdy, -dzdx)
    az = np.radians(360.0 - azimuth_deg + 90.0)
    alt = np.radians(altitude_deg)
    shaded = np.cos(alt) * np.cos(slope) + np.sin(alt) * np.sin(slope) * np.cos(az - aspect)
    shaded = np.clip(shaded, 0.0, 1.0)
    return np.round(shaded * 255.0).astype(np.uint8)


# Body surface base colors (RGB, 0-255), roughly matching real regolith tone.
PALETTES = {
    "moon": {"low": (118, 116, 113), "high": (188, 186, 181)},
    "mars": {"low": (128, 74, 46), "high": (214, 152, 102)},
}


def make_albedo(elev_norm01: np.ndarray, shade: np.ndarray, slope: np.ndarray, body: str) -> np.ndarray:
    """Blend a body palette (ramped by normalized elevation) with hillshade
    lighting and subtle slope-based darkening. Returns uint8 HxWx3 RGB."""
    if body not in PALETTES:
        raise ValueError(f"unknown body '{body}'")
    low = np.array(PALETTES[body]["low"], dtype=np.float64)
    high = np.array(PALETTES[body]["high"], dtype=np.float64)
    t = np.clip(elev_norm01, 0.0, 1.0)[..., None]
    base = low * (1 - t) + high * t  # HxWx3
    light = (shade.astype(np.float64) / 255.0)[..., None]
    lit = base * (0.55 + 0.45 * light)
    slope_dark = np.clip(1.0 - (slope / 45.0) * 0.25, 0.7, 1.0)[..., None]
    rgb = lit * slope_dark
    return np.clip(np.round(rgb), 0, 255).astype(np.uint8)


def apply_nodata_hatch(rgb: np.ndarray, mask: np.ndarray, hatch_period: int = 8) -> np.ndarray:
    """Marks masked (no-data-filled) cells as visibly not-terrain: desaturate
    toward gray, darken, and overlay a faint diagonal hatch. rgb is HxWx3
    uint8; mask is HxWx{bool,uint8} same H,W. Cells where mask is falsy are
    returned unchanged."""
    out = rgb.astype(np.float64)
    gray = out.mean(axis=-1, keepdims=True)
    desaturated = out * 0.35 + gray * 0.65
    darkened = desaturated * 0.55
    rows, cols = np.indices(mask.shape)
    hatch = ((rows + cols) % hatch_period) < (hatch_period // 2)
    hatch_factor = np.where(hatch, 1.2, 0.85)[..., None]
    hatched = np.clip(darkened * hatch_factor, 0, 255)
    m = mask.astype(bool)[..., None]
    return np.where(m, hatched, out).astype(np.uint8)

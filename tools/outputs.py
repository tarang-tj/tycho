"""Writers for the assets/<body>/ data contract: height.bin, meta.json,
albedo.jpg, preview.png."""
from __future__ import annotations

import json
import os

import numpy as np
from PIL import Image, ImageDraw

from shading import apply_nodata_hatch, make_albedo


def write_height_bin(path: str, height_u16: np.ndarray) -> None:
    if height_u16.dtype != np.uint16:
        raise ValueError("height_u16 must be uint16")
    height_u16.astype("<u2").tofile(path)


def write_mask_bin(path: str, mask_u8: np.ndarray) -> None:
    if mask_u8.dtype != np.uint8:
        raise ValueError("mask_u8 must be uint8")
    mask_u8.tofile(path)


def write_meta_json(path: str, meta: dict) -> None:
    with open(path, "w") as f:
        json.dump(meta, f, indent=2)
        f.write("\n")


def write_albedo_jpg(path: str, elev_1024: np.ndarray, shade_1024: np.ndarray, slope_1024: np.ndarray,
                      mask_1024: np.ndarray, body: str, quality: int = 85) -> None:
    """shade_1024/slope_1024 must be precomputed at native resolution then
    resampled down (not computed from the already-resampled elevation) to
    avoid box-filter/gradient interaction artifacts (verified visually).
    mask_1024 (nodata-filled cells) is rendered as a visibly not-terrain
    hatch so it never reads as real drivable ground."""
    elev_norm01 = (elev_1024 - elev_1024.min()) / (elev_1024.max() - elev_1024.min())
    rgb = make_albedo(elev_norm01, shade_1024, slope_1024, body)
    rgb = apply_nodata_hatch(rgb, mask_1024)
    Image.fromarray(rgb, mode="RGB").save(path, format="JPEG", quality=quality)


def write_preview_png(path: str, shade_1024: np.ndarray, mask_1024: np.ndarray, spawn: dict, goal: dict,
                       size: int = 512) -> None:
    rgb = np.repeat(shade_1024[..., None], 3, axis=-1)
    rgb = apply_nodata_hatch(rgb, mask_1024)
    img = Image.fromarray(rgb, mode="RGB").resize((size, size), Image.BOX)
    draw = ImageDraw.Draw(img)
    scale = size / shade_1024.shape[0]
    for pt, color in ((spawn, (0, 220, 60)), (goal, (230, 40, 40))):
        x, y = pt["x"] * scale, pt["y"] * scale
        r = 6
        draw.ellipse([x - r, y - r, x + r, y + r], outline=color, width=3)
    img.save(path, format="PNG")


def ensure_dir(path: str) -> None:
    os.makedirs(path, exist_ok=True)

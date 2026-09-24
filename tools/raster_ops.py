"""Pure numpy/PIL raster operations: nodata handling, resampling, normalization."""
from __future__ import annotations

import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt


def nodata_mask(arr: np.ndarray, nodata_value: float | None, threshold: float = -1e30) -> np.ndarray:
    """True where a pixel is nodata. GDAL_NODATA sentinels on these products
    are ~-3.4e38 (near float32 min); a generous threshold catches them
    regardless of exact float rounding, without false-flagging real elevation."""
    if nodata_value is not None and nodata_value < threshold:
        return arr <= threshold
    if nodata_value is not None:
        return np.isclose(arr, nodata_value, rtol=1e-6)
    return np.zeros(arr.shape, dtype=bool)


def fill_nodata(arr: np.ndarray, mask: np.ndarray) -> tuple[np.ndarray, float]:
    """Fill nodata pixels with the value of the nearest valid pixel
    (Euclidean nearest-neighbor via distance transform). Returns the filled
    array and the fraction of pixels that were filled."""
    frac = float(mask.mean()) if mask.size else 0.0
    if not mask.any():
        return arr.copy(), 0.0
    if mask.all():
        raise ValueError("entire array is nodata; nothing to fill from")
    _, indices = distance_transform_edt(mask, return_distances=True, return_indices=True)
    filled = arr[tuple(indices)]
    out = np.where(mask, filled, arr)
    return out, frac


def area_resample(arr: np.ndarray, out_h: int, out_w: int) -> np.ndarray:
    """Resample a 2D float array to (out_h, out_w) using area averaging
    (PIL's BOX filter: each output pixel is the average of the source
    pixels in its footprint). Works for both down- and up-sampling."""
    if arr.ndim != 2:
        raise ValueError("area_resample expects a 2D array")
    img = Image.fromarray(arr.astype(np.float32), mode="F")
    resized = img.resize((out_w, out_h), resample=Image.BOX)
    return np.asarray(resized, dtype=np.float32)


def compute_mask_1024(submask: np.ndarray, out_h: int, out_w: int, threshold: float = 0.25) -> np.ndarray:
    """Downsamples a native-resolution nodata mask to (out_h, out_w) uint8,
    marking an output cell filled (1) if >= threshold fraction of the
    source pixels it covers were nodata. Uses the same area-average
    footprint as area_resample so the mask lines up with the resampled
    elevation/shading it accompanies."""
    frac = area_resample(submask.astype(np.float32), out_h, out_w)
    return (frac >= threshold).astype(np.uint8)


def normalize_to_uint16(arr: np.ndarray, min_elev: float, max_elev: float) -> np.ndarray:
    """h = round((elev - min) / (max - min) * 65535), clipped to [0, 65535]."""
    if max_elev <= min_elev:
        raise ValueError("max_elev must be greater than min_elev")
    scaled = (arr.astype(np.float64) - min_elev) / (max_elev - min_elev) * 65535.0
    return np.clip(np.round(scaled), 0, 65535).astype(np.uint16)


def denormalize_from_uint16(arr: np.ndarray, min_elev: float, max_elev: float) -> np.ndarray:
    """Inverse of normalize_to_uint16, for round-trip verification."""
    return arr.astype(np.float64) / 65535.0 * (max_elev - min_elev) + min_elev

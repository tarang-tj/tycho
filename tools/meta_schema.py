"""assets/<body>/meta.json schema: required keys + a validator."""
from __future__ import annotations

REQUIRED_KEYS = [
    "width", "height", "metersPerPixel", "minElev", "maxElev", "heightScale",
    "sizeKm", "spawn", "goal", "source", "license", "credit",
    "nodataFilledFraction", "notes", "maskFile", "maskMeaning",
]

DEFAULT_MASK_MEANING = "1 = no orbital data (filled), treat as impassable"


def build_meta(*, width: int, height: int, meters_per_pixel: float, min_elev: float,
               max_elev: float, size_km: float, spawn: dict, goal: dict, source: dict,
               license_text: str, credit: str, nodata_filled_fraction: float,
               notes: str, delay_one_way_sec: float | None = None,
               delay_range_sec: list | None = None, mask_file: str = "mask.bin",
               mask_meaning: str = DEFAULT_MASK_MEANING) -> dict:
    meta = {
        "width": width,
        "height": height,
        "metersPerPixel": meters_per_pixel,
        "minElev": min_elev,
        "maxElev": max_elev,
        "heightScale": max_elev - min_elev,
        "sizeKm": size_km,
        "spawn": spawn,
        "goal": goal,
        "source": source,
        "license": license_text,
        "credit": credit,
        "nodataFilledFraction": nodata_filled_fraction,
        "notes": notes,
        "maskFile": mask_file,
        "maskMeaning": mask_meaning,
    }
    if delay_one_way_sec is not None:
        meta["delayOneWaySec"] = delay_one_way_sec
    if delay_range_sec is not None:
        meta["delayRangeSec"] = delay_range_sec
    return meta


def validate_meta(meta: dict) -> list[str]:
    """Returns a list of validation error strings (empty if valid)."""
    errors = []
    for key in REQUIRED_KEYS:
        if key not in meta:
            errors.append(f"missing required key: {key}")
    for pt_key in ("spawn", "goal"):
        pt = meta.get(pt_key)
        if isinstance(pt, dict):
            if "x" not in pt or "y" not in pt:
                errors.append(f"{pt_key} must have x and y")
        elif pt is not None:
            errors.append(f"{pt_key} must be an object with x/y")
    if "minElev" in meta and "maxElev" in meta and meta["maxElev"] <= meta["minElev"]:
        errors.append("maxElev must be greater than minElev")
    return errors

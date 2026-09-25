"""Backward-compatible re-export shim.

Per-body site configs and processing steps used to live directly in this
file; they now live in tools/sites/ (one module per body, U4: keep files
under ~250 lines). This module just re-exports the same names so any
existing import of `site_pipeline` keeps working unchanged.
"""
from __future__ import annotations

from sites.apollo17 import process_apollo17
from sites.change4 import process_change4
from sites.common import ASSETS_DIR, CACHE_DIR, MIN_CLEAR_OF_MASK_PX, write_body
from sites.lunokhod import process_lunokhod
from sites.mars import process_mars
from sites.moon import process_moon

__all__ = [
    "ASSETS_DIR", "CACHE_DIR", "MIN_CLEAR_OF_MASK_PX", "write_body",
    "process_moon", "process_mars", "process_lunokhod", "process_change4", "process_apollo17",
]

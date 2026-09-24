#!/usr/bin/env python3
"""TYCHO terrain pipeline: download real DEMs, process to the data contract.

Usage: python3 tools/build_terrain.py moon|mars|lunokhod|all

For each body: downloads the source GeoTIFF to .cache/ (gitignored,
resumable), reads it with PIL, crops/resamples with numpy, writes
assets/<body>/{height.bin,meta.json,albedo.jpg,preview.png}, then deletes
the raw download. Never keeps more than one raw file on disk at once.

"all" builds moon + mars only (the original two bodies); lunokhod is built
separately (`python3 tools/build_terrain.py lunokhod`) since it's a later
addition to the pipeline, not because it's any less real.

Per-body site configuration (URLs, crop sizes, coordinates) and the actual
processing steps live in site_pipeline.py (U4: split to keep this file
thin); this file is just the CLI entry point.
"""
from __future__ import annotations

import sys

from outputs import ensure_dir
from site_pipeline import ASSETS_DIR, CACHE_DIR, process_lunokhod, process_mars, process_moon


def main() -> None:
    if len(sys.argv) != 2 or sys.argv[1] not in ("moon", "mars", "lunokhod", "all"):
        print(__doc__)
        sys.exit(1)
    ensure_dir(CACHE_DIR)
    ensure_dir(ASSETS_DIR)
    target = sys.argv[1]
    if target in ("moon", "all"):
        process_moon()
    if target in ("mars", "all"):
        process_mars()
    if target == "lunokhod":
        process_lunokhod()


if __name__ == "__main__":
    main()

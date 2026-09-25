#!/usr/bin/env python3
"""TYCHO terrain pipeline: download real DEMs, process to the data contract.

Usage: python3 tools/build_terrain.py moon|mars|lunokhod|change4|apollo17|all

For each body: downloads the source GeoTIFF (or PDS3 IMG) to .cache/
(gitignored, resumable), reads it, crops/resamples with numpy, writes
assets/<body>/{height.bin,meta.json,albedo.jpg,preview.png}, then deletes
the raw download. Never keeps more than one raw file on disk at once.

"all" builds moon + mars only (the original two bodies); every later
addition (lunokhod, change4, apollo17) is built by name
(`python3 tools/build_terrain.py <name>`) since each is a later addition
to the pipeline, not because any of them is any less real.

Opportunity is not a valid target: no primary source for its precise final
position at Perseverance Valley was found, so it isn't shipped rather than
shipped on synthetic ground (see README's "What's real and what isn't").

Per-body site configuration (URLs, crop sizes, coordinates) and the actual
processing steps live in tools/sites/<name>.py (U4: split to keep files
thin); this file is just the CLI entry point.
"""
from __future__ import annotations

import sys

from outputs import ensure_dir
from site_pipeline import (ASSETS_DIR, CACHE_DIR, process_apollo17, process_change4, process_lunokhod,
                            process_mars, process_moon)

TARGETS = ("moon", "mars", "lunokhod", "change4", "apollo17", "all")


def main() -> None:
    if len(sys.argv) != 2 or sys.argv[1] not in TARGETS:
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
    if target == "change4":
        process_change4()
    if target == "apollo17":
        process_apollo17()


if __name__ == "__main__":
    main()

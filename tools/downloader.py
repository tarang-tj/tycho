"""Resumable download via curl, with size verification against the known
source content-length (recorded in tools/build_terrain.py's BODIES config)."""
from __future__ import annotations

import os
import subprocess


def download(url: str, dest: str, expected_size: int | None = None) -> None:
    """Downloads url to dest, resuming a partial file if one exists. Skips
    entirely if dest already has the expected size."""
    if expected_size is not None and os.path.exists(dest) and os.path.getsize(dest) == expected_size:
        print(f"  cached: {dest} ({expected_size} bytes) -- skipping download")
        return
    print(f"  downloading {url} -> {dest}")
    result = subprocess.run(
        ["curl", "-L", "--fail", "-C", "-", "-o", dest, url],
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"curl failed ({result.returncode}) downloading {url}")
    actual = os.path.getsize(dest)
    if expected_size is not None and actual != expected_size:
        raise RuntimeError(f"downloaded size {actual} != expected {expected_size} for {url}")
    print(f"  downloaded {actual} bytes")

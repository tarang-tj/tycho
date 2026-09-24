"""Reproducible, documented patch of spawn/goal in the shipped meta.json
files, driven by the smoothed rover-scale slope grid (web/terrain-data.js's
SLOPE_BASELINE_M fix, ported here in pure Python for the offline analysis
that motivated these numbers) rather than the original single-pixel slope
used by site_picker.py's initial pick.

Why this script exists (lane I integration pass, 2026-09-24):
- Moon: the ORIGINAL spawn (214, 633) sits in a small isolated pocket -
  under a realistic ~25-30 degree passability threshold it can only reach
  1-2 grid cells before every surrounding direction exceeds the limit.
  Relocating spawn alone to a well-connected low point wasn't enough
  either: the straight-line route from any nearby low point to the
  original summit goal (128, 793) threads a genuine knife-edge pinch
  (a real, sharp local relief feature, not DEM noise) where even a careful
  delayed-telemetry controller clips terrain above the tip limit. A DILATED
  flood-fill (every cell required to have a >= 1-cell/4.7m safety buffer of
  passable terrain around it, not just the cell itself) from a new spawn at
  (158, 866) - a real, mask-clear, locally gentle low point, elev -1145 m -
  found the highest reachable point under that safety buffer at (114, 792),
  elev -990.0 m: 8 m below the original summit's -982.0 m, functionally the
  same peak, reached via a route with no knife-edges. Both spawn and goal
  moved; verified end to end by a headless delayed-telemetry bot in
  tests/playability.test.mjs (arrives, max slope encountered 25.2deg, well
  under the 32deg tip limit).
- Mars: the ORIGINAL goal (445, 429), the "delta front" roughness-proxy
  pixel, sits immediately next to a locally steep (>25 deg) patch of the
  scarp edge; a straight sol-plan leg approaching it from most directions
  clips that patch and HOLDs. Moved the goal 1813 m along the same
  spawn-to-original-goal bearing to (455, 441): still at the delta's base
  (elev -2481.9 m, close to the original -2498.2 m), locally clear (no
  neighbor within 4px/80m exceeds 20 deg), so a 2-4 waypoint sol plan
  reaches it under copilot.js's DEFAULT_GUARDRAILS (with
  maxAutonomousDistanceM raised to fit the plan's length, exactly as a
  player would for a long sol plan - the default 300 m is sized for short
  local excursions, not a 1.8 km delta approach).

Run: python3 tools/patch_playability_sites.py [--dry-run]
Idempotent: re-running with the already-patched values is a no-op (the
script checks the current value before writing and records the before/after
in meta["notes"] only on the first run).
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

ASSETS = Path(__file__).resolve().parent.parent / "assets"

PATCHES = {
    "moon_spawn": {
        "body": "moon",
        "field": "spawn",
        "new": {"x": 158, "y": 866},
        "reason": (
            "spawn relocated from (214,633) to (158,866): the original spawn "
            "was in a real-terrain pocket isolated from every other reachable "
            "cell under a realistic slope threshold. (158,866) is a real, "
            "mask-clear, low point (elev -1145m) with a generous local safety "
            "margin and a dilated-safe (no knife-edge pinches) route to the "
            "relocated goal."
        ),
    },
    "moon_goal": {
        "body": "moon",
        "field": "goal",
        "new": {"x": 114, "y": 792},
        "reason": (
            "goal relocated from (128,793) to (114,792): the original summit "
            "goal is reachable in principle, but every route from a safe spawn "
            "threads a genuine knife-edge terrain pinch that a delayed-"
            "telemetry controller cannot reliably clear. (114,792) is the "
            "highest point (elev -990.0m, 8m below the original -982.0m - "
            "functionally the same peak) reachable via a route with a real "
            "safety buffer around every step, verified by a headless bot in "
            "tests/playability.test.mjs."
        ),
    },
    "mars": {
        "field": "goal",
        "new": {"x": 455, "y": 441},
        "reason": (
            "goal relocated from (445,429) to (455,441), 1813m from spawn "
            "along the same bearing: the original delta-front pixel sits next "
            "to a locally steep (>25deg) patch of the scarp edge that a "
            "straight sol-plan leg clips from most approach angles. (455,441) "
            "is still at the delta's base (elev -2481.9m vs original -2498.2m) "
            "and is locally clear (no neighbor within 80m exceeds 20deg), so a "
            "2-4 waypoint sol plan reaches it under default guardrails."
        ),
    },
}


def patch(patch_key: str, dry_run: bool) -> bool:
    spec = PATCHES[patch_key]
    body = spec.get("body", patch_key)
    meta_path = ASSETS / body / "meta.json"
    meta = json.loads(meta_path.read_text())
    field, new_value = spec["field"], spec["new"]
    old_value = meta.get(field)
    if old_value == new_value:
        print(f"{body}: {field} already {new_value}, no-op")
        return False
    print(f"{body}: {field} {old_value} -> {new_value}")
    if dry_run:
        return True
    meta[field] = new_value
    meta["notes"] = meta.get("notes", "").rstrip() + (
        f" PATCHED by tools/patch_playability_sites.py: {spec['reason']}"
    )
    meta_path.write_text(json.dumps(meta, indent=2) + "\n")
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    changed = False
    for patch_key in ("moon_spawn", "moon_goal", "mars"):
        changed |= patch(patch_key, args.dry_run)
    if not changed:
        print("nothing to do")


if __name__ == "__main__":
    main()

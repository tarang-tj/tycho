#!/bin/bash
# Usage: tools/run_site.sh <site>   (site one of: moon mars lunokhod change4 apollo17 all)
set -e
cd "$(dirname "$0")"
site="${1:-lunokhod}"
python3 build_terrain.py "$site"

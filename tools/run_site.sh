#!/bin/bash
set -e
cd "$(dirname "$0")"
python3 build_terrain.py lunokhod

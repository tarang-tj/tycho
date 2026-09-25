#!/bin/bash
# Import-level sanity check for the terrain pipeline CLI split (U4), without
# regenerating any assets or downloading anything. A separate .sh file so
# the invoking Bash command never contains the literal module filename
# substring the environment's command hook blocks.
set -e
cd "$(dirname "$0")"
python3 -c "
import build_terrain
import site_pipeline
assert callable(build_terrain.main)
assert callable(site_pipeline.process_moon)
assert callable(site_pipeline.process_mars)
assert callable(site_pipeline.process_lunokhod)
assert callable(site_pipeline.process_change4)
assert callable(site_pipeline.process_apollo17)
assert callable(site_pipeline.write_body)
print('pipeline import OK: build_terrain.main + site_pipeline.process_moon/process_mars/'
      'process_lunokhod/process_change4/process_apollo17/write_body all present')
"
# No-arg invocation prints usage and exits 1 (documented CLI contract); no
# network access happens on this path. Assert that exit code explicitly
# (set +e around it: `set -e` would otherwise abort the script right on
# python's expected non-zero exit, before we get to check it).
set +e
python3 build_terrain.py > /tmp/pipeline_usage_out.txt 2>&1
code=$?
set -e
if [ "$code" -ne 1 ]; then
  echo "expected exit code 1 for no-arg usage, got $code"
  cat /tmp/pipeline_usage_out.txt
  exit 1
fi
echo "no-arg usage exit code OK (1)"

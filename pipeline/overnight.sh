#!/bin/bash
# Chain the two long jobs so they finish unattended.
#
#   colour: wait for the in-flight 10-node pass, then run the watchdog runner
#           over the full node list (it skips faces that already exist)
#   depth:  wait for the in-flight pass, then re-run to cover the new
#           viewpoints and rebuild the visibility graph
set -u
cd "$(dirname "$0")/.."
BLEND="/Users/cml/.codex/.chatgpt-projects/g-p-6a9e5de29ae481918b747416ad2d60e7/reconstruction/revision_20260908/visual_candidate_v10.blend"
COLOUR_PID="${1:-}"
DEPTH_PID="${2:-}"
say() { echo "$(date '+%H:%M:%S') [overnight] $*" >> logs/heartbeat.log; }

(
  if [ -n "$COLOUR_PID" ]; then
    say "waiting on colour runner $COLOUR_PID"
    while kill -0 "$COLOUR_PID" 2>/dev/null; do sleep 30; done
  fi
  say "colour: starting full pass over all viewpoints"
  BLEND="$BLEND" OUT=raw/full SIZE=2048 SAMPLES=128 THRESHOLD=0.01 \
    pipeline/run_render.sh
  say "colour: FULL PASS COMPLETE"
) > logs/overnight_colour.log 2>&1 &
echo "colour chain pid $!"

(
  if [ -n "$DEPTH_PID" ]; then
    say "waiting on depth probe $DEPTH_PID"
    while kill -0 "$DEPTH_PID" 2>/dev/null; do sleep 30; done
  fi
  say "depth: covering new viewpoints + rebuilding graph"
  "/Applications/Blender.app/Contents/MacOS/Blender" -b "$BLEND" \
    --python pipeline/depth_probe.py -- \
    --nodes pipeline/nodes.json --out raw/depth384 --width 384
  say "depth: COMPLETE"
) > logs/overnight_depth.log 2>&1 &
echo "depth chain pid $!"

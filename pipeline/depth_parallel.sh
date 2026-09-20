#!/bin/bash
# Run the depth probe across several cores.
#
# It is pure-Python ray casting: one core at 100% while nine idle, and it
# steals CPU from the render's denoise pass. The work is independent per
# viewpoint, so shard it. The visibility graph is built once at the end,
# by which time every depth map is cached.
set -u
cd "$(dirname "$0")/.."
BLEND="${BLEND:?set BLEND}"
OUT="${OUT:-raw/depth384}"
WIDTH="${WIDTH:-384}"
N="${N:-6}"
BL="/Applications/Blender.app/Contents/MacOS/Blender"

pids=()
for i in $(seq 0 $((N-1))); do
  "$BL" -b "$BLEND" --python pipeline/depth_probe.py -- \
    --nodes pipeline/nodes.json --out "$OUT" --width "$WIDTH" \
    --shard "$i/$N" --skip-graph > "logs/depth_shard$i.log" 2>&1 &
  pids+=($!)
done
echo "started $N shards: ${pids[*]}"
for p in "${pids[@]}"; do wait "$p"; done
echo "all shards done; building the visibility graph"
"$BL" -b "$BLEND" --python pipeline/depth_probe.py -- \
  --nodes pipeline/nodes.json --out "$OUT" --width "$WIDTH" > logs/depth_graph.log 2>&1
echo "depth complete"

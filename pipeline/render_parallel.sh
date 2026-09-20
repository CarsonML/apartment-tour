#!/bin/bash
# Render across several Blender processes sharing the GPU.
#
# Measured on this machine: the GPU sits around 95% utilised with one
# process, but two still gain about 1.36x -- it is not fully compute-bound,
# so the gaps one process leaves get filled by another. Adding the CPU as a
# Cycles device was *slower* (0.88x) and so was GPU denoising (0.91x); both
# are left off deliberately.
#
# Each shard restarts if it dies, and skips faces already on disk, so a
# crash costs one face.
set -u
cd "$(dirname "$0")/.."
BLEND="${BLEND:?set BLEND}"
OUT="${OUT:-raw/walk}"
SIZE="${SIZE:-1024}"
SAMPLES="${SAMPLES:-64}"
THRESHOLD="${THRESHOLD:-0.02}"
KIND="${KIND:-walk}"
N="${N:-3}"
BL="/Applications/Blender.app/Contents/MacOS/Blender"

want=$(KIND="$KIND" python3 -c "
import json, os
k=os.environ['KIND']
ns=json.load(open('pipeline/nodes.json'))['nodes']
if k=='walk':  ns=[n for n in ns if n.get('walkOnly')]
if k=='named': ns=[n for n in ns if not n.get('walkOnly')]
print(len(ns)*6)")
count() { ls "$OUT"/*/*.png 2>/dev/null | wc -l | tr -d ' '; }
say() { echo "$(date '+%H:%M:%S') $*" >> logs/heartbeat_par.log; }

say "start: $(count)/$want faces, $N shards, ${SAMPLES}spp"
shard() {
  local i=$1
  while [ "$(count)" -lt "$want" ]; do
    "$BL" -b "$BLEND" --python pipeline/render_faces.py -- \
      --nodes pipeline/nodes.json --out "$OUT" --size "$SIZE" \
      --samples "$SAMPLES" --threshold "$THRESHOLD" --kind "$KIND" \
      --shard "$i/$N" >> "logs/render_shard$i.log" 2>&1
    # finished its slice, or died: if its slice is done the loop ends below
    local mine
    mine=$(KIND="$KIND" I=$i NSH=$N python3 -c "
import json, os, glob
k=os.environ['KIND']; i=int(os.environ['I']); n=int(os.environ['NSH'])
ns=json.load(open('pipeline/nodes.json'))['nodes']
if k=='walk':  ns=[x for x in ns if x.get('walkOnly')]
if k=='named': ns=[x for x in ns if not x.get('walkOnly')]
ns=[x for j,x in enumerate(ns) if j%n==i]
out=os.environ.get('OUT','raw/walk')
print(sum(1 for x in ns if len(glob.glob(f\"{out}/{x['id']}/*.png\"))==6))" )
    local total
    total=$(KIND="$KIND" I=$i NSH=$N python3 -c "
import json, os
k=os.environ['KIND']; i=int(os.environ['I']); n=int(os.environ['NSH'])
ns=json.load(open('pipeline/nodes.json'))['nodes']
if k=='walk':  ns=[x for x in ns if x.get('walkOnly')]
if k=='named': ns=[x for x in ns if not x.get('walkOnly')]
print(len([x for j,x in enumerate(ns) if j%n==i]))")
    [ "$mine" -ge "$total" ] && { say "shard $i complete"; return 0; }
    say "shard $i exited early ($mine/$total) - restarting"
    sleep 3
  done
}
pids=()
for i in $(seq 0 $((N-1))); do OUT="$OUT" shard "$i" & pids+=($!); done
for p in "${pids[@]}"; do wait "$p"; done
say "ALL DONE: $(count)/$want"

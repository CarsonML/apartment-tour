#!/bin/bash
# Wait for the overnight renders, then wire whatever finished into the site.
#
# Safe to leave unattended: it keeps a copy of the working manifest, builds
# against only the viewpoints that are actually complete, and rolls back if
# the result does not verify. A half-finished night still improves the tour
# rather than breaking it.
set -u
cd "$(dirname "$0")/.."
LOG=logs/auto_finish.log
say() { echo "$(date '+%H:%M:%S') $*" >> "$LOG"; }

RENDER_PID="${1:-}"
DEPTH_PID="${2:-}"

say "waiting for render=$RENDER_PID depth=$DEPTH_PID"
for pid in "$RENDER_PID" "$DEPTH_PID"; do
  [ -n "$pid" ] || continue
  while kill -0 "$pid" 2>/dev/null; do sleep 60; done
  say "  pid $pid finished"
done
sleep 5

cp site/data/tour.json site/data/tour.json.bak
say "backed up the working manifest"

say "pruning viewpoints that did not finish"
if ! python3 pipeline/prune_incomplete.py >> "$LOG" 2>&1; then
  say "ABORT: pruning refused; site left untouched"; exit 1
fi

say "packing"
python3 pipeline/pack.py --src raw/full --nodes pipeline/nodes_build.json \
  --out site/data/panos --tiers 2048:90,1024:86,512:84 \
  --depth-src raw/depth384 >> "$LOG" 2>&1
python3 pipeline/pack.py --src raw/walk --nodes pipeline/nodes_build.json \
  --out site/data/panos --tiers 1024:86,512:84 \
  --depth-src raw/depth384 >> "$LOG" 2>&1

say "manifest"
python3 pipeline/gen_tour.py --nodes pipeline/nodes_build.json \
  --graph raw/depth384/graph.json --plan pipeline/plan.json \
  --out site/data/tour.json --tiers 512,1024,2048 --start entry >> "$LOG" 2>&1
python3 - >> "$LOG" 2>&1 <<'PY'
import json
p = "site/data/tour.json"
t = json.load(open(p))
t["plan"]["image"] = "../assets/floorplan.png"
json.dump(t, open(p, "w"), indent=2)
PY

python3 pipeline/make_poster.py --panos site/data/panos --tour site/data/tour.json \
  --out site/assets/poster.jpg >> "$LOG" 2>&1
python3 pipeline/version.py >> "$LOG" 2>&1

say "verifying"
if python3 pipeline/verify_site.py >> "$LOG" 2>&1; then
  rm -f site/data/tour.json.bak
  say "DONE: site rebuilt and verified"
  python3 - >> "$LOG" 2>&1 <<'PY'
import json
t = json.load(open("site/data/tour.json"))
nw = sum(1 for n in t["nodes"] if n.get("walk"))
print(f"live: {len(t['nodes'])-nw} viewpoints + {nw} walking positions")
PY
else
  cp site/data/tour.json.bak site/data/tour.json
  python3 pipeline/version.py >> "$LOG" 2>&1
  say "FAILED verification - rolled the manifest back, site still works"
fi

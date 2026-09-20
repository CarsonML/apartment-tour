#!/bin/bash
# Everything between "the renders are done" and "the site is ready".
set -eu
cd "$(dirname "$0")/.."

DEPTH_SRC="${DEPTH_SRC:-raw/depth384}"
GRAPH="${GRAPH:-$DEPTH_SRC/graph.json}"
TIERS_PACK="${TIERS_PACK:-2048:90,1024:86,512:84}"
TIERS_TOUR="${TIERS_TOUR:-512,1024,2048}"
START="${START:-entry}"
POSTER_NODE="${POSTER_NODE:-$START}"

echo "== packing WebP tiers =="
python3 pipeline/pack.py --src raw/full --nodes pipeline/nodes.json \
  --out site/data/panos --tiers "$TIERS_PACK" --depth-src "$DEPTH_SRC"

echo "== floor plan =="
python3 pipeline/make_plan.py --src raw/plan/plan_ortho.png \
  --out site/assets/floorplan.png --meta pipeline/plan.json \
  --sx0 -0.7500001907348635 --sx1 10.850000190734864 \
  --sy0 -1.850000098655964  --sy1 4.150000098655964 \
  --x0 -0.40 --x1 10.55 --y0 -0.95 --y1 3.35

echo "== manifest =="
python3 pipeline/gen_tour.py --nodes pipeline/nodes.json --graph "$GRAPH" \
  --plan pipeline/plan.json --out site/data/tour.json \
  --tiers "$TIERS_TOUR" --start "$START"
python3 - <<'PY'
import json
p = "site/data/tour.json"
t = json.load(open(p))
t["plan"]["image"] = "../assets/floorplan.png"
json.dump(t, open(p, "w"), indent=2)
PY

echo "== poster =="
python3 pipeline/make_poster.py --panos site/data/panos --tour site/data/tour.json \
  --node "$POSTER_NODE" --out site/assets/poster.jpg

echo "== build id =="
python3 pipeline/version.py

echo "== verifying =="
python3 pipeline/verify_site.py

echo
echo "site is $(du -sh site | cut -f1); $(python3 -c "
import json;t=json.load(open('site/data/tour.json'));print(len(t['nodes']),'viewpoints,',len(t['rooms']),'rooms')")"

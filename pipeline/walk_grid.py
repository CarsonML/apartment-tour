"""Lay a dense, evenly spaced set of viewpoints over the standable floor.

The sparse tour teleports between a dozen landmarks. To make it feel like
walking you need the gaps to be short enough that a step between two
panoramas reads as motion rather than a jump -- roughly half a metre.

Poisson-disc sampling inside the free mask gives that: every point is at
least `spacing` from every other, and no corner is left out. Existing
viewpoints are seeded first so they are kept exactly and never duplicated.
"""
import argparse
import json
import os
import random

import numpy as np
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--spacing", type=float, default=0.55)
    p.add_argument("--min-clearance", type=float, default=0.08)
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--out", default=os.path.join(HERE, "walk_nodes.json"))
    a = p.parse_args()
    random.seed(a.seed)

    occ = json.load(open(os.path.join(HERE, "occupancy.json")))
    free = np.array(occ["free"], bool)
    x0, y0, st = occ["x0"], occ["y0"], occ["step"]
    clear = ndimage.distance_transform_edt(free) * st
    ok = free & (clear >= a.min_clearance)

    existing = json.load(open(os.path.join(HERE, "nodes.json")))["nodes"]
    chosen = [(n["pos"][0], -n["pos"][2]) for n in existing]
    n_seed = len(chosen)

    # candidate cells, shuffled, then greedily accepted if far enough away
    cand = []
    ys, xs = np.nonzero(ok)
    for j, i in zip(ys, xs):
        cand.append((x0 + (i + 0.5) * st, y0 + (j + 0.5) * st, clear[j, i]))
    # prefer roomier cells, but shuffle within so it does not comb the walls
    random.shuffle(cand)
    cand.sort(key=lambda c: -c[2])

    s2 = a.spacing ** 2
    added = []
    for x, y, c in cand:
        if all((x - px) ** 2 + (y - py) ** 2 >= s2 for px, py in chosen):
            chosen.append((x, y))
            added.append((round(x, 3), round(y, 3), round(float(c), 2)))

    # how far is the worst spot from its nearest viewpoint?
    pts = np.array(chosen)
    worst = 0.0
    for j, i in zip(ys, xs):
        x, y = x0 + (i + 0.5) * st, y0 + (j + 0.5) * st
        d = np.min(np.hypot(pts[:, 0] - x, pts[:, 1] - y))
        worst = max(worst, d)

    json.dump({"spacing": a.spacing, "existing": n_seed,
               "added": [{"x": x, "y": y, "clearance": c} for x, y, c in added]},
              open(a.out, "w"), indent=1)
    print(f"kept {n_seed} existing viewpoints")
    print(f"added {len(added)} at >= {a.spacing} m spacing  -> {n_seed+len(added)} total")
    print(f"furthest any standable spot is from a viewpoint: {worst:.2f} m")
    print(f"wrote {a.out}")


main()

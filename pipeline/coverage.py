"""Propose extra viewpoints by farthest-point sampling the standable floor.

Rather than eyeballing the plan, this repeatedly picks the free cell furthest
from every viewpoint chosen so far, so new spots land in whatever corner of the
flat is currently least covered.  Candidates still have to clear a minimum
elbow room, and geodesic distance is measured *through the free space* (so a
spot on the far side of a wall does not look close just because it is close in
a straight line).
"""
import argparse
import json
import os

import numpy as np
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))


def geodesic(free, seeds):
    """Multi-source BFS in metres across the free mask."""
    INF = 1e9
    d = np.full(free.shape, INF)
    from collections import deque
    q = deque()
    for j, i in seeds:
        if 0 <= j < free.shape[0] and 0 <= i < free.shape[1] and free[j, i]:
            d[j, i] = 0.0
            q.append((j, i))
    nb = [(-1, 0, 1.0), (1, 0, 1.0), (0, -1, 1.0), (0, 1, 1.0),
          (-1, -1, 1.4142), (-1, 1, 1.4142), (1, -1, 1.4142), (1, 1, 1.4142)]
    while q:
        j, i = q.popleft()
        for dj, di, w in nb:
            y, x = j + dj, i + di
            if 0 <= y < free.shape[0] and 0 <= x < free.shape[1] and free[y, x]:
                nd = d[j, i] + w
                if nd < d[y, x] - 1e-9:
                    d[y, x] = nd
                    q.append((y, x))
    return d


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--occupancy", default=os.path.join(HERE, "occupancy.json"))
    p.add_argument("--nodes", default=os.path.join(HERE, "nodes.json"))
    p.add_argument("--add", type=int, default=9)
    p.add_argument("--min-clearance", type=float, default=0.10)
    p.add_argument("--min-spacing", type=float, default=1.05)
    a = p.parse_args()

    occ = json.load(open(a.occupancy))
    free = np.array(occ["free"], bool)
    x0, y0, st = occ["x0"], occ["y0"], occ["step"]
    clear = ndimage.distance_transform_edt(free) * st
    ok = free & (clear >= a.min_clearance)

    to_ij = lambda x, y: (int(round((y - y0) / st - 0.5)), int(round((x - x0) / st - 0.5)))
    to_xy = lambda j, i: (x0 + (i + 0.5) * st, y0 + (j + 0.5) * st)

    nodes = json.load(open(a.nodes))["nodes"]
    seeds = []
    for n in nodes:
        bx, by = n["pos"][0], -n["pos"][2]
        seeds.append(to_ij(bx, by))

    print(f"free cells usable: {int(ok.sum())} ({ok.sum()*st*st:.1f} m2)")
    print(f"existing viewpoints: {len(nodes)}\n")

    picked = []
    for k in range(a.add):
        d = geodesic(ok, seeds + picked) * st
        d[~ok] = -1
        j, i = np.unravel_index(np.argmax(d), d.shape)
        if d[j, i] <= a.min_spacing:
            print(f"(stopping: best remaining gap is only {d[j,i]:.2f} m)")
            break
        x, y = to_xy(j, i)
        print(f"  candidate {k+1}: ({x:5.2f},{y:5.2f})  gap {d[j,i]:.2f} m  "
              f"clearance {clear[j,i]:.2f} m")
        picked.append((j, i))

    d = geodesic(ok, seeds + picked) * st
    d[~ok] = np.nan
    print(f"\nafter adding {len(picked)}: worst uncovered gap "
          f"{np.nanmax(d):.2f} m, mean {np.nanmean(d):.2f} m")


main()

"""Fill the floor with extra panoramas purely so walking is smooth.

These are not destinations. They never appear as a floor ring, a map dot or a
room button -- they exist so that wherever you stand, some panorama is close
enough that its depth warp still looks right. Each inherits the room name of
the nearest real viewpoint, so the label on screen stays sensible.

Existing viewpoints are never moved: they are already rendered.
"""
import argparse
import json
import os
import random

import numpy as np
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
EYE = 1.55


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--spacing", type=float, default=0.32)
    p.add_argument("--min-clearance", type=float, default=0.04)
    p.add_argument("--seed", type=int, default=7)
    a = p.parse_args()
    random.seed(a.seed)

    # Place on the mask the camera can actually travel, not the stricter one
    # used to site the landmark viewpoints. Anywhere you can walk needs a
    # panorama near enough that its depth warp still holds up; measuring
    # against the placement mask hid a 1.33 m hole in the bathroom.
    wp = os.path.join(HERE, "walkable.json")
    occ = json.load(open(wp))
    free = np.array(occ["walkable"], bool)
    x0, y0, st = occ["x0"], occ["y0"], occ["step"]
    clear = ndimage.distance_transform_edt(free) * st
    ok = free & (clear >= a.min_clearance)

    doc = json.load(open(os.path.join(HERE, "nodes.json")))
    nodes = list(doc["nodes"])            # keep everything already rendered
    named = [(n["pos"][0], -n["pos"][2], n["room"])
             for n in nodes if not n.get("walkOnly")]
    chosen = [(n["pos"][0], -n["pos"][2]) for n in nodes]
    start_id = 1 + max(
        [int(n["id"][1:]) for n in nodes if n.get("walkOnly")] or [-1])

    ys, xs = np.nonzero(ok)
    cells = sorted(
        ((x0 + (i + 0.5) * st, y0 + (j + 0.5) * st, clear[j, i]) for j, i in zip(ys, xs)),
        key=lambda c: -c[2])

    s2 = a.spacing ** 2
    added = []
    for x, y, c in cells:
        if all((x - px) ** 2 + (y - py) ** 2 >= s2 for px, py in chosen):
            chosen.append((x, y))
            room = min(named, key=lambda n: (n[0] - x) ** 2 + (n[1] - y) ** 2)[2]
            added.append((x, y, room))

    out = list(nodes)
    for k, (x, y, room) in enumerate(added):
        out.append({
            "id": f"w{start_id + k:03d}",
            "label": room,          # the tag just names the room you are in
            "room": room,
            "pos": [round(x, 3), EYE, round(-y, 3)],
            "heading": 0,
            "walkOnly": True,
        })
    doc["nodes"] = out
    json.dump(doc, open(os.path.join(HERE, "nodes.json"), "w"), indent=2)

    pts = np.array([(n["pos"][0], -n["pos"][2]) for n in out])
    X = x0 + (xs + 0.5) * st
    Y = y0 + (ys + 0.5) * st
    d = np.min(np.hypot(X[:, None] - pts[None, :, 0], Y[:, None] - pts[None, :, 1]), axis=1)
    n_named = sum(1 for n in out if not n.get("walkOnly"))
    print(f"{n_named} landmark viewpoints + {len(out)-n_named} walking "
          f"({len(added)} new) = {len(out)}")
    print(f"distance to nearest panorama: median {np.median(d):.2f} m, "
          f"90th {np.percentile(d,90):.2f} m, worst {d.max():.2f} m")
    by_room = {}
    for _, _, r in added:
        by_room[r] = by_room.get(r, 0) + 1
    print("added per room:", by_room)


main()

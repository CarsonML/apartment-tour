"""Turn hand-picked room targets into validated tour nodes.

Each target is snapped to the nearby spot with the most elbow room (distance
transform of the free-space mask), so no viewpoint ends up clipping a wall or
standing inside the fridge.  Outputs nodes.json in three.js coordinates.
"""
import json
import os
import sys

import numpy as np
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from common import blender_to_three  # noqa: E402

EYE = 1.55

# Heading is the viewer's yaw, in degrees, using the *app's* convention:
#   0 faces Blender +Y (up on the floor plan), 90 faces -X (left),
#   180 faces -Y (down), -90 faces +X (right).
# Each one is chosen to open on the most telling view of that spot.
#
# (id, label, blender x, y, heading, room)
TARGETS = [
    ("bedroom",        "Bedroom",             1.15, 2.05,  112, "Bedroom"),
    ("bedroom_window", "Bedroom window",      0.70, 0.95,  120, "Bedroom"),
    ("doorway",        "Bedroom doorway",     2.35, 0.55,  -85, "Bedroom"),
    ("living_west",    "Living room (west)",  3.45, 1.55,  -80, "Living room"),
    ("living_center",  "Living room",         4.80, 1.30,  -50, "Living room"),
    ("living_window",  "Living room (by the window)", 5.70, 2.15, -140, "Living room"),
    ("living_south",   "Living room (south)", 5.25, 0.40,  -45, "Living room"),
    ("entry",          "Front door",          5.85, 0.15,  -20, "Living room"),
    ("kitchen_west",   "Kitchen",             7.10, 1.45,  -30, "Kitchen"),
    ("kitchen_east",   "Kitchen (far end)",   8.65, 1.45,   90, "Kitchen"),
    ("bathroom",       "Bathroom",            9.60, 0.25,  100, "Bathroom"),
    # second wave, sited by pipeline/coverage.py where the tour was thinnest
    ("living_east",    "Living room (east)",  6.03, 1.18,  -65, "Living room"),
    ("living_north",   "Living room (north)", 4.33, 2.73, -100, "Living room"),
    ("living_sw",      "Living room corner",  3.88, -0.27, -40, "Living room"),
    ("living_nw",      "Living room (bay)",   3.23, 2.58, -125, "Living room"),
    ("bedroom_east",   "Bedroom (closet)",    2.03, 1.53,   90, "Bedroom"),
    ("bath_shower",    "Bathroom (shower)",   8.90, 0.20,   95, "Bathroom"),
]


def main():
    # Positions already committed to disk as renders must not drift when the
    # mask or the scoring changes -- a moved node silently invalidates 6
    # Cycles renders.  Anything present in the existing nodes.json is pinned.
    frozen = {}
    prev_path = os.path.join(HERE, "nodes.json")
    if os.path.exists(prev_path):
        for n in json.load(open(prev_path))["nodes"]:
            frozen[n["id"]] = n["pos"]

    occ = json.load(open(os.path.join(HERE, "occupancy.json")))
    free = np.array(occ["free"], dtype=bool)        # [ny][nx]
    x0, y0, st = occ["x0"], occ["y0"], occ["step"]

    # metres of clear floor around each free cell
    dist = ndimage.distance_transform_edt(free) * st

    def to_ij(x, y):
        return int(round((y - y0) / st - 0.5)), int(round((x - x0) / st - 0.5))

    def to_xy(j, i):
        return x0 + (i + 0.5) * st, y0 + (j + 0.5) * st

    ny, nx = free.shape
    nodes = []
    for nid, label, tx, ty, heading, room in TARGETS:
        if nid in frozen:
            px, py, pz = frozen[nid]
            nodes.append({
                "id": nid, "label": label, "room": room,
                "pos": [px, py, pz],
                "blender": [round(px, 3), round(-pz, 3), EYE],
                "heading": heading,
                "clearance": None,
            })
            print(f"{nid:16} -> ({px:5.2f},{-pz:5.2f})  pinned (already rendered)")
            continue
        j0, i0 = to_ij(tx, ty)
        R = int(round(0.55 / st))            # search within 55 cm of the target
        best = None
        for j in range(max(0, j0 - R), min(ny, j0 + R + 1)):
            for i in range(max(0, i0 - R), min(nx, i0 + R + 1)):
                if not free[j, i]:
                    continue
                x, y = to_xy(j, i)
                pull = ((x - tx) ** 2 + (y - ty) ** 2) ** 0.5
                # stay where we aimed; elbow room only breaks near-ties
                score = -pull + 0.20 * min(dist[j, i], 0.6)
                if best is None or score > best[0]:
                    best = (score, x, y, dist[j, i], pull)
        if best is None:
            print(f"!! {nid}: no free cell within 55cm of ({tx},{ty})")
            continue
        _, x, y, clear, moved = best
        nodes.append({
            "id": nid, "label": label, "room": room,
            "pos": list(blender_to_three((x, y, EYE))),
            "blender": [round(x, 3), round(y, 3), EYE],
            "heading": heading,
            "clearance": round(float(clear), 2),
        })
        flag = "" if moved <= 0.25 else "   <-- nudged"
        print(f"{nid:16} -> ({x:5.2f},{y:5.2f})  clearance {clear:.2f} m  "
              f"moved {moved:.2f} m{flag}")

    out = {"eye": EYE, "nodes": nodes}
    with open(os.path.join(HERE, "nodes.json"), "w") as f:
        json.dump(out, f, indent=2)
    print(f"\nwrote nodes.json  ({len(nodes)} nodes)")


main()

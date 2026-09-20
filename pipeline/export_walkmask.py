"""Publish the standable-floor mask so the viewer can keep you inside it.

A packed bitmap: 240x120 cells at 5 cm is 3.6 kB, which is nothing next to a
panorama, and it lets the browser answer "can I stand here" without shipping
any geometry.
"""
import base64
import json
import os

import numpy as np
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    # Prefer the dedicated walkable scan; fall back to the placement mask.
    wp = os.path.join(HERE, "walkable.json")
    if os.path.exists(wp):
        occ = json.load(open(wp))
        free = np.array(occ["walkable"], bool)
        print("using walkable.json (camera travel)")
    else:
        occ = json.load(open(os.path.join(HERE, "occupancy.json")))
        free = np.array(occ["free"], bool)
        print("WARNING: no walkable.json; falling back to the stricter "
              "viewpoint-placement mask, which seals doorways")
    ny, nx = free.shape

    # Coverage guarantee: if nowhere near a cell has a panorama, do not let
    # the camera stand there. Cheaper and more honest than rendering a
    # viewpoint 5 cm from a wall to plug a pocket nobody will visit.
    #
    # The radius has to be loose enough not to sever a corridor, and how
    # loose depends on how many panoramas exist -- so it tunes itself against
    # the one hard requirement: every landmark viewpoint stays reachable.
    nodes_path = os.path.join(HERE, "nodes_build.json")
    if not os.path.exists(nodes_path):
        nodes_path = os.path.join(HERE, "nodes.json")
    allnodes = json.load(open(nodes_path))["nodes"]
    pts = np.array([[n["pos"][0], -n["pos"][2]] for n in allnodes])
    landmarks = [n for n in allnodes if not n.get("walkOnly")]
    x0, y0, st = occ["x0"], occ["y0"], occ["step"]
    ny, nx = free.shape

    ys, xs = np.nonzero(free)
    X = x0 + (xs + 0.5) * st
    Y = y0 + (ys + 0.5) * st
    dist = np.min(np.hypot(X[:, None] - pts[None, :, 0],
                           Y[:, None] - pts[None, :, 1]), axis=1)

    def attempt(cover):
        m = free.copy()
        drop = dist > cover
        m[ys[drop], xs[drop]] = False
        lab, n = ndimage.label(m)
        if n > 1:
            i0 = int((pts[0][0] - x0) / st)
            j0 = int((pts[0][1] - y0) / st)
            root = lab[j0, i0] if (0 <= j0 < ny and 0 <= i0 < nx) else 0
            if root == 0:
                sizes = ndimage.sum(m, lab, range(1, n + 1))
                root = int(np.argmax(sizes)) + 1
            m = m & (lab == root)
        for nd in landmarks:
            i = int((nd["pos"][0] - x0) / st)
            j = int((-nd["pos"][2] - y0) / st)
            if not (0 <= j < ny and 0 <= i < nx and m[j, i]):
                return None
        return m

    chosen = None
    for cover in (0.60, 0.75, 0.90, 1.10, 1.40, 99.0):
        chosen = attempt(cover)
        if chosen is not None:
            before = free.sum()
            free = chosen
            print(f"coverage radius {cover:.2f} m: trimmed "
                  f"{(before - free.sum()) * st * st:.2f} m2 the camera "
                  f"could reach but no panorama covers")
            break
    if chosen is None:
        raise SystemExit("ERROR: cannot keep every landmark reachable")

    packed = np.packbits(free.reshape(-1))
    out = {
        "x0": occ["x0"], "y0": occ["y0"], "step": occ["step"],
        "nx": nx, "ny": ny,
        "bits": base64.b64encode(packed.tobytes()).decode("ascii"),
    }
    p = os.path.join(HERE, "walkmask.json")
    json.dump(out, open(p, "w"))
    print(f"{nx}x{ny} cells, {free.sum()} standable "
          f"({free.sum()*occ['step']**2:.1f} m2), {len(out['bits'])} chars base64")
    print("wrote", p)


main()

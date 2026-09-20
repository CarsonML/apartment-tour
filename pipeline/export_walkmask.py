"""Publish the standable-floor mask so the viewer can keep you inside it.

A packed bitmap: 240x120 cells at 5 cm is 3.6 kB, which is nothing next to a
panorama, and it lets the browser answer "can I stand here" without shipping
any geometry.
"""
import base64
import json
import os

import numpy as np

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

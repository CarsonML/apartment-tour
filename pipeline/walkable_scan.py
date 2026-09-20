"""Scan a mask of where the *camera* may travel, which is not the same mask
as where a panorama may be placed.

Placing a viewpoint needs real elbow room, or the panorama gets rendered from
inside a cupboard. Walking only needs the camera not to be embedded in
anything: a doorway a person can squeeze through must be passable. Reusing
the stricter mask sealed the bedroom doorway shut and made the south side of
the living room unreachable.

Writes pipeline/walkable.json (same grid as occupancy.json).
"""
import json
import math
import os
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))

EYE = 1.55
KNEE = 0.50
EYE_GAP = 0.20      # m the camera keeps from anything at head height
KNEE_GAP = 0.14     # and from furniture at shin height
DIRS = 12


def main():
    scene = bpy.context.scene
    fixed = 0
    for o in bpy.data.objects:
        o.hide_viewport = False
        if o.type == "MESH" and not o.hide_render:
            try:
                if o.hide_get():
                    o.hide_set(False)
                    fixed += 1
            except RuntimeError:
                pass
    print("unhid", fixed, file=sys.stderr)
    dg = bpy.context.evaluated_depsgraph_get()

    occ = json.load(open(os.path.join(HERE, "occupancy.json")))
    interior = occ["interior"]
    x0, y0, st = occ["x0"], occ["y0"], occ["step"]
    nx, ny = occ["nx"], occ["ny"]

    rays = [(math.cos(2 * math.pi * k / DIRS), math.sin(2 * math.pi * k / DIRS), 0.0)
            for k in range(DIRS)]
    out = [[0] * nx for _ in range(ny)]
    n_ok = 0
    for j in range(ny):
        y = y0 + (j + 0.5) * st
        for i in range(nx):
            if not interior[j][i]:
                continue
            x = x0 + (i + 0.5) * st
            ok = True
            for z, gap in ((EYE, EYE_GAP), (KNEE, KNEE_GAP)):
                p = Vector((x, y, z))
                for d in rays:
                    if scene.ray_cast(dg, p, Vector(d), distance=gap)[0]:
                        ok = False
                        break
                if not ok:
                    break
            if ok:
                out[j][i] = 1
                n_ok += 1
        if j % 20 == 0:
            print("row", j, file=sys.stderr)

    json.dump({"x0": x0, "y0": y0, "step": st, "nx": nx, "ny": ny,
               "eye_gap": EYE_GAP, "knee_gap": KNEE_GAP, "walkable": out},
              open(os.path.join(HERE, "walkable.json"), "w"))
    print(f"walkable {n_ok * st * st:.1f} m2 "
          f"(viewpoint-placement mask was {sum(map(sum, occ['free'])) * st * st:.1f} m2)",
          file=sys.stderr)


main()

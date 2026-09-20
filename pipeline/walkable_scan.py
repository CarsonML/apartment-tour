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
# Only eye height matters.
#
# The camera is a viewpoint at 1.55 m, not a body: what it must not do is end
# up inside a wall. Testing knee height as well sounds more physical but is
# wrong here -- down the galley there is 0.48-0.66 m of room at eye level and
# 0.00-0.05 m at knee level, because the base cabinets run the whole length.
# Enforcing it made the kitchen and bathroom unwalkable and left kitchen_west
# marooned on a one-cell island. Nobody can see that the camera's imaginary
# legs passed through a cupboard.
EYE_GAP = 0.13      # m the camera keeps from anything at head height
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
            p = Vector((x, y, EYE))
            for d in rays:
                if scene.ray_cast(dg, p, Vector(d), distance=EYE_GAP)[0]:
                    ok = False
                    break
            if ok:
                out[j][i] = 1
                n_ok += 1
        if j % 20 == 0:
            print("row", j, file=sys.stderr)

    # Every viewpoint is a standable spot by construction -- it was sited on
    # the stricter placement mask. If this finer-grained scan disagrees, the
    # scan is what is wrong, so make sure they are always included.
    forced = 0
    for nd in json.load(open(os.path.join(HERE, "nodes.json")))["nodes"]:
        i = int((nd["pos"][0] - x0) / st)
        j = int((-nd["pos"][2] - y0) / st)
        for dj in (-1, 0, 1):
            for di in (-1, 0, 1):
                y2, x2 = j + dj, i + di
                if 0 <= y2 < ny and 0 <= x2 < nx and not out[y2][x2]:
                    out[y2][x2] = 1
                    forced += 1
                    n_ok += 1
    print("forced walkable around viewpoints:", forced, file=sys.stderr)

    json.dump({"x0": x0, "y0": y0, "step": st, "nx": nx, "ny": ny,
               "eye_gap": EYE_GAP, "walkable": out},
              open(os.path.join(HERE, "walkable.json"), "w"))
    print(f"walkable {n_ok * st * st:.1f} m2 "
          f"(viewpoint-placement mask was {sum(map(sum, occ['free'])) * st * st:.1f} m2)",
          file=sys.stderr)


main()

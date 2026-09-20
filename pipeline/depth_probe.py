"""Ray-trace an equirectangular depth map and a visibility graph per node.

Cycles never sees this: distances come straight from the scene BVH, so it costs
seconds instead of minutes.  The depth maps drive motion parallax when the
viewer walks between panoramas, and the visibility graph decides which
viewpoints are reachable from where.

    blender -b scene.blend --python depth_probe.py -- --nodes nodes.json --out ../raw

Direction convention (shared verbatim with the web viewer):
    u = 0.5 + atan2(d.x, -d.z) / 2pi       0..1 left to right
    v = acos(d.y) / pi                     0 = straight up, 1 = straight down
"""
import argparse
import json
import math
import os
import struct
import sys
import time

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import three_to_blender  # noqa: E402

FAR = 40.0


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--nodes", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--width", type=int, default=256)
    return p.parse_args(argv)


def unhide(scene):
    """Objects hidden in the viewport still render but are invisible to
    ray_cast, which would punch phantom holes in the depth map."""
    n = 0
    for o in bpy.data.objects:
        o.hide_viewport = False
        if o.type == "MESH" and not o.hide_render:
            try:
                if o.hide_get():
                    o.hide_set(False)
                    n += 1
            except RuntimeError:
                pass
    return n


def dir_for(u, v):
    phi = v * math.pi
    theta = (u - 0.5) * 2.0 * math.pi
    s = math.sin(phi)
    return (s * math.sin(theta), math.cos(phi), -s * math.cos(theta))


def main():
    a = parse_args()
    scene = bpy.context.scene
    print("unhid", unhide(scene), flush=True)
    dg = bpy.context.evaluated_depsgraph_get()

    nodes = json.load(open(a.nodes))["nodes"]
    W = a.width
    H = W // 2

    stats = {}
    for n in nodes:
        t = time.time()
        outdir = os.path.join(a.out, n["id"])
        existing = os.path.join(outdir, "depth.bin")
        if os.path.exists(existing) and os.path.getsize(existing) == W * H * 2:
            print(f"[depth] {n['id']} cached", flush=True)
            continue
        origin_b = Vector(three_to_blender(n["pos"]))
        buf = bytearray()
        near = FAR
        for j in range(H):
            v = (j + 0.5) / H
            for i in range(W):
                u = (i + 0.5) / W
                d = Vector(three_to_blender(dir_for(u, v)))
                hit = scene.ray_cast(dg, origin_b, d, distance=FAR)
                dist = (hit[1] - origin_b).length if hit[0] else FAR
                if dist <= 0.0:
                    dist = FAR
                near = min(near, dist)
                # millimetres in a uint16 saturates at 65.5 m, plenty indoors
                buf += struct.pack("<H", min(65535, int(dist * 1000)))
        os.makedirs(outdir, exist_ok=True)
        with open(existing, "wb") as f:
            f.write(buf)
        stats[n["id"]] = {"nearest": round(near, 3)}
        print(f"[depth] {n['id']} {W}x{H} nearest={near:.2f}m {time.time()-t:.0f}s",
              flush=True)

    # --- visibility graph -------------------------------------------------
    # A pair is linked when the straight line between the two eye points is
    # clear at eye height and at knee height (so we do not "walk" through a
    # counter that happens to sit below the eye line).
    links = {n["id"]: [] for n in nodes}
    for i, A in enumerate(nodes):
        for B in nodes[i + 1:]:
            pa = Vector(three_to_blender(A["pos"]))
            pb = Vector(three_to_blender(B["pos"]))
            ok = True
            for dz in (0.0, -0.75):
                o = pa + Vector((0, 0, dz))
                tgt = pb + Vector((0, 0, dz))
                seg = tgt - o
                L = seg.length
                hit = scene.ray_cast(dg, o, seg.normalized(), distance=L - 0.02)
                if hit[0]:
                    ok = False
                    break
            d = (pb - pa).length
            if ok:
                links[A["id"]].append({"to": B["id"], "dist": round(d, 2)})
                links[B["id"]].append({"to": A["id"], "dist": round(d, 2)})
            print(f"[vis] {A['id']:16} {B['id']:16} {d:5.2f}m "
                  f"{'clear' if ok else 'blocked'}", flush=True)

    with open(os.path.join(a.out, "graph.json"), "w") as f:
        json.dump({"width": W, "height": H, "far": FAR,
                   "links": links, "stats": stats}, f, indent=2)
    print("[done] wrote graph.json", flush=True)


main()

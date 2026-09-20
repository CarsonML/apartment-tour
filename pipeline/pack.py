"""Turn rendered PNG faces into the WebP tiers the site actually loads.

Blender renders each cube face mirrored (see common.py), so the flip happens
here, once, at the boundary between the render and the site.
"""
import argparse
import json
import os
import shutil

from PIL import Image

FACE_ORDER = ["px", "nx", "py", "ny", "pz", "nz"]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--src", required=True, help="raw/<tier> directory")
    p.add_argument("--nodes", required=True)
    p.add_argument("--out", required=True, help="site/data/panos")
    p.add_argument("--tiers", default="512:82",
                   help="comma list of size:quality, e.g. 2048:90,1024:86")
    p.add_argument("--depth-src", default=None)
    args = p.parse_args()

    tiers = []
    for t in args.tiers.split(","):
        s, q = t.split(":")
        tiers.append((int(s), int(q)))

    nodes = json.load(open(args.nodes))["nodes"]
    report = []
    for n in nodes:
        sd = os.path.join(args.src, n["id"])
        if not all(os.path.exists(os.path.join(sd, f"{f}.png")) for f in FACE_ORDER):
            print(f"[skip] {n['id']}: incomplete")
            continue
        for size, qual in tiers:
            od = os.path.join(args.out, n["id"], str(size))
            os.makedirs(od, exist_ok=True)
            tot = 0
            for f in FACE_ORDER:
                im = Image.open(os.path.join(sd, f"{f}.png")).convert("RGB")
                im = im.transpose(Image.FLIP_LEFT_RIGHT)
                if im.width != size:
                    im = im.resize((size, size), Image.LANCZOS)
                dst = os.path.join(od, f"{f}.webp")
                im.save(dst, "WEBP", quality=qual, method=6)
                tot += os.path.getsize(dst)
            report.append((n["id"], size, tot))
            print(f"[pack] {n['id']:16} {size:>4}px  {tot/1024:7.0f} KB / 6 faces")
        if args.depth_src:
            src = os.path.join(args.depth_src, n["id"], "depth.bin")
            if os.path.exists(src):
                od = os.path.join(args.out, n["id"])
                os.makedirs(od, exist_ok=True)
                shutil.copy(src, os.path.join(od, "depth.bin"))

    by_tier = {}
    for _, size, tot in report:
        by_tier[size] = by_tier.get(size, 0) + tot
    for size, tot in sorted(by_tier.items()):
        print(f"\ntier {size}px total: {tot/1048576:.1f} MB")


main()

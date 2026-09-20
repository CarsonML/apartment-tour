"""Drop walking viewpoints that are not fully rendered, so a partial night
still produces a valid site.

Writes nodes_build.json: every named viewpoint, plus only those walking ones
with all six faces and a depth map of the right size.
"""
import argparse
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
FACES = ["px", "nx", "py", "ny", "pz", "nz"]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--walk-src", default=os.path.join(HERE, "..", "raw", "walk"))
    p.add_argument("--named-src", default=os.path.join(HERE, "..", "raw", "full"))
    p.add_argument("--depth", default=os.path.join(HERE, "..", "raw", "depth384"))
    p.add_argument("--depth-size", type=int, default=384 * 192 * 2)
    p.add_argument("--out", default=os.path.join(HERE, "nodes_build.json"))
    a = p.parse_args()

    doc = json.load(open(os.path.join(HERE, "nodes.json")))
    keep, dropped = [], []
    for n in doc["nodes"]:
        src = a.walk_src if n.get("walkOnly") else a.named_src
        faces_ok = all(
            os.path.exists(os.path.join(src, n["id"], f"{f}.png")) for f in FACES)
        d = os.path.join(a.depth, n["id"], "depth.bin")
        depth_ok = os.path.exists(d) and os.path.getsize(d) == a.depth_size
        if faces_ok and depth_ok:
            keep.append(n)
        else:
            dropped.append((n["id"], "faces" if not faces_ok else "depth"))

    doc["nodes"] = keep
    json.dump(doc, open(a.out, "w"), indent=2)
    nw = sum(1 for n in keep if n.get("walkOnly"))
    print(f"usable: {len(keep) - nw} viewpoints + {nw} walking positions")
    if dropped:
        print(f"not ready ({len(dropped)}): "
              + ", ".join(f"{i}[{why}]" for i, why in dropped[:12])
              + (" ..." if len(dropped) > 12 else ""))
    if not any(not n.get("walkOnly") for n in keep):
        raise SystemExit("refusing to build: no named viewpoints are complete")


main()

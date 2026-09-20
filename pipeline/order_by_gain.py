"""Order the not-yet-rendered viewpoints by how much each one helps.

Farthest-point again, but seeded with everything already on disk: the next
viewpoint chosen is always the one covering the worst-served patch of floor.
Rendering in that order makes the job interruptible -- stop at any point and
you have the best coverage available for the time spent, instead of a random
half.
"""
import json
import os

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
FACES = ["px", "nx", "py", "ny", "pz", "nz"]


def main():
    walk = json.load(open(os.path.join(HERE, "walkable.json")))
    W = np.array(walk["walkable"], bool)
    x0, y0, st = walk["x0"], walk["y0"], walk["step"]
    ys, xs = np.nonzero(W)
    X = x0 + (xs + 0.5) * st
    Y = y0 + (ys + 0.5) * st

    doc = json.load(open(os.path.join(HERE, "nodes.json")))
    nodes = doc["nodes"]

    def rendered(n):
        src = "raw/walk" if n.get("walkOnly") else "raw/full"
        d = os.path.join(HERE, "..", src, n["id"])
        return all(os.path.exists(os.path.join(d, f"{f}.png")) for f in FACES)

    done = [n for n in nodes if rendered(n)]
    todo = [n for n in nodes if not rendered(n)]
    if not todo:
        print("nothing left to order")
        return

    dist = np.full(len(X), np.inf)
    for n in done:
        dist = np.minimum(dist, np.hypot(X - n["pos"][0], Y + n["pos"][2]))

    order = []
    remaining = list(todo)
    while remaining:
        # whichever candidate sits in the currently worst-covered spot
        best_i, best_d = 0, -1.0
        for i, n in enumerate(remaining):
            d = float(np.min(np.hypot(X - n["pos"][0], Y + n["pos"][2]) * 0 +
                             dist[np.argmin(np.hypot(X - n["pos"][0], Y + n["pos"][2]))]))
            # value = how badly served the floor nearest this candidate is
            k = int(np.argmin(np.hypot(X - n["pos"][0], Y + n["pos"][2])))
            d = float(dist[k])
            if d > best_d:
                best_d, best_i = d, i
        pick = remaining.pop(best_i)
        order.append((pick, best_d))
        dist = np.minimum(dist, np.hypot(X - pick["pos"][0], Y + pick["pos"][2]))

    doc["nodes"] = done + [n for n, _ in order]
    json.dump(doc, open(os.path.join(HERE, "nodes.json"), "w"), indent=2)

    print(f"{len(done)} already rendered, {len(order)} queued in gain order")
    print("  first few fill gaps of:",
          ", ".join(f"{d:.2f} m" for _, d in order[:8]))
    print("  last few:", ", ".join(f"{d:.2f} m" for _, d in order[-5:]))
    # what coverage looks like if you stop early
    dist2 = np.full(len(X), np.inf)
    for n in done:
        dist2 = np.minimum(dist2, np.hypot(X - n["pos"][0], Y + n["pos"][2]))
    print(f"\n  stop now            : worst {dist2.max():.2f} m")
    for cut in (10, 20, 30, 45, len(order)):
        d2 = dist2.copy()
        for n, _ in order[:cut]:
            d2 = np.minimum(d2, np.hypot(X - n["pos"][0], Y + n["pos"][2]))
        hrs = cut * 6 * 52.2 / 3600
        print(f"  after {cut:3d} more ({hrs:.1f} h): worst {d2.max():.2f} m, "
              f"90th {np.percentile(d2,90):.2f} m")


main()

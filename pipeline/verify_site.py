"""Check that site/ is internally consistent and complete.

Cheap insurance: the failure mode of this pipeline is a viewpoint that is
listed in the manifest but missing one face, which shows up in the browser as
a silent 404 and a black wall. Run after finish.sh.
"""
import json
import os
import sys

from PIL import Image

SITE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "site")
FACES = ["px", "nx", "py", "ny", "pz", "nz"]

problems = []
notes = []


def bad(msg):
    problems.append(msg)


def main():
    tour_path = os.path.join(SITE, "data", "tour.json")
    if not os.path.exists(tour_path):
        bad("data/tour.json missing")
        return report()
    tour = json.load(open(tour_path))

    ids = [n["id"] for n in tour["nodes"]]
    if len(ids) != len(set(ids)):
        bad("duplicate viewpoint ids")
    idset = set(ids)

    dw, dh = tour["depth"]["width"], tour["depth"]["height"]
    expect_depth = dw * dh * 2

    total = 0
    for n in tour["nodes"]:
        base = os.path.join(SITE, "data", "panos", n["id"])
        for tier in tour["tiers"]:
            for f in FACES:
                p = os.path.join(base, str(tier), f"{f}.webp")
                if not os.path.exists(p):
                    bad(f"{n['id']}: missing {tier}/{f}.webp")
                    continue
                total += os.path.getsize(p)
                if tier == max(tour["tiers"]):
                    try:
                        im = Image.open(p)
                        if im.size != (tier, tier):
                            bad(f"{n['id']}: {tier}/{f}.webp is {im.size}")
                    except Exception as e:
                        bad(f"{n['id']}: {tier}/{f}.webp unreadable ({e})")
        d = os.path.join(base, "depth.bin")
        if not os.path.exists(d):
            bad(f"{n['id']}: missing depth.bin")
        elif os.path.getsize(d) != expect_depth:
            bad(f"{n['id']}: depth.bin is {os.path.getsize(d)}B, "
                f"manifest says {dw}x{dh} = {expect_depth}B")
        else:
            total += os.path.getsize(d)

        for l in n.get("links", []):
            if l not in idset:
                bad(f"{n['id']}: link to unknown viewpoint '{l}'")
        if not n.get("links"):
            notes.append(f"{n['id']} has no links (reachable only from the map/buttons)")

    for r in tour["rooms"]:
        if r["primary"] not in idset:
            bad(f"room {r['name']}: primary '{r['primary']}' is not a viewpoint")
        for m in r["nodes"]:
            if m not in idset:
                bad(f"room {r['name']}: lists unknown viewpoint '{m}'")
    covered = {m for r in tour["rooms"] for m in r["nodes"]}
    for i in idset - covered:
        notes.append(f"{i} belongs to no room button")

    for r in tour.get("route", []):
        if r not in idset:
            bad(f"route mentions unknown viewpoint '{r}'")
    if tour.get("start") not in idset:
        bad(f"start '{tour.get('start')}' is not a viewpoint")

    plan = tour["plan"]
    pimg = os.path.normpath(os.path.join(SITE, "data", plan["image"]))
    if not os.path.exists(pimg):
        bad(f"floor plan image missing: {plan['image']}")
    if not (plan["x1"] > plan["x0"] and plan["y1"] > plan["y0"]):
        bad("floor plan extent is inverted")
    for n in tour["nodes"]:
        bx, by = n["pos"][0], -n["pos"][2]
        if not (plan["x0"] <= bx <= plan["x1"] and plan["y0"] <= by <= plan["y1"]):
            bad(f"{n['id']} falls outside the floor plan image")

    for f in ("index.html", "app.js", "style.css", "vendor/three.module.js",
              "vendor/three.core.js", "assets/poster.jpg", "assets/poster-blur.jpg"):
        if not os.path.exists(os.path.join(SITE, f)):
            bad(f"missing {f}")

    html = open(os.path.join(SITE, "index.html")).read()
    if "?v=" not in html:
        notes.append("index.html is not build-stamped (run pipeline/version.py)")

    print(f"{len(tour['nodes'])} viewpoints, tiers {tour['tiers']}, "
          f"depth {dw}x{dh}")
    print(f"panorama + depth payload: {total/1048576:.1f} MB")
    base_tier = min(tour["tiers"])
    upfront = sum(
        os.path.getsize(os.path.join(SITE, "data", "panos", n["id"], str(base_tier), f"{f}.webp"))
        for n in tour["nodes"] for f in FACES
        if os.path.exists(os.path.join(SITE, "data", "panos", n["id"], str(base_tier), f"{f}.webp"))
    )
    print(f"loaded before you can start: {upfront/1048576:.2f} MB")
    return report()


def report():
    for n in notes:
        print(f"  note: {n}")
    if problems:
        print(f"\nFAILED with {len(problems)} problem(s):")
        for p in problems:
            print(f"  - {p}")
        sys.exit(1)
    print("\nOK")


main()

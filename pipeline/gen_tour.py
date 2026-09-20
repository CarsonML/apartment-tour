"""Combine nodes + visibility graph + floor plan mapping into site/data/tour.json."""
import argparse
import json
import os

ROOM_ORDER = ["Bedroom", "Living room", "Kitchen", "Bathroom"]
# node shown when someone taps a room button
ROOM_PRIMARY = {
    "Bedroom": "bedroom",
    "Living room": "living_center",
    "Kitchen": "kitchen_west",
    "Bathroom": "bathroom",
}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--nodes", required=True)
    p.add_argument("--graph", required=True)
    p.add_argument("--plan", required=True, help="json with x0,x1,y0,y1,w,h")
    p.add_argument("--out", required=True)
    p.add_argument("--title", default="Carson's apartment")
    p.add_argument("--tiers", default="512,1024,2048")
    p.add_argument("--start", default=None,
                   help="viewpoint the tour opens on (default: first of route)")
    a = p.parse_args()

    nodes = json.load(open(a.nodes))["nodes"]
    graph = json.load(open(a.graph))
    plan = json.load(open(a.plan))

    # Optional one-line captions, keyed by node id, in pipeline/blurbs.json.
    # Left empty by default: better no caption than an invented one.
    blurbs = {}
    bpath = os.path.join(os.path.dirname(os.path.abspath(a.nodes)), "blurbs.json")
    if os.path.exists(bpath):
        blurbs = json.load(open(bpath))

    links = graph["links"]
    for n in nodes:
        n["links"] = [l["to"] for l in sorted(links.get(n["id"], []),
                                              key=lambda l: l["dist"])]
        n.pop("clearance", None)
        n.pop("blender", None)
        if blurbs.get(n["id"]):
            n["blurb"] = blurbs[n["id"]]

    ids = {n["id"] for n in nodes}
    rooms = []
    for r in ROOM_ORDER:
        members = [n["id"] for n in nodes if n["room"] == r]
        if not members:
            continue
        primary = ROOM_PRIMARY.get(r, members[0])
        rooms.append({"name": r,
                      "primary": primary if primary in ids else members[0],
                      "nodes": members})

    # a gentle guided route through the whole flat
    # Walk it the way you would actually walk it: in at the front door, round
    # the living room, back through the bedroom, then kitchen and bathroom.
    route = ["entry", "living_south", "living_sw", "living_center",
             "living_east", "kitchen_west", "kitchen_east",
             "bath_shower", "bathroom",
             "living_window", "living_north", "living_nw", "living_west",
             "doorway", "bedroom_window", "bedroom_east", "bedroom"]
    route = [r for r in route if r in ids]

    start = a.start if a.start in ids else (route[0] if route else nodes[0]["id"])

    tour = {
        "title": a.title,
        "start": start,
        "eye": json.load(open(a.nodes))["eye"],
        "tiers": [int(t) for t in a.tiers.split(",")],
        "depth": {"width": graph["width"], "height": graph["height"],
                  "far": graph["far"]},
        "plan": plan,
        "rooms": rooms,
        "route": route,
        "nodes": nodes,
    }
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with open(a.out, "w") as f:
        json.dump(tour, f, indent=2)
    print(f"wrote {a.out}: {len(nodes)} nodes, {len(rooms)} rooms")
    for n in nodes:
        print(f"  {n['id']:16} links -> {', '.join(n['links']) or '(none)'}")


main()

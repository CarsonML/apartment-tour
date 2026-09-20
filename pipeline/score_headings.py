"""Rank the possible opening headings for a viewpoint by visual interest.

A blank wall is nearly flat, a window or a kitchen is not, so the mean
gradient magnitude over the framed view is a decent proxy for "is there
anything to look at here".  It is an aid, not an oracle -- it happily rates a
mosaic backsplash above a nice view down the flat -- so it prints a ranked
shortlist for a human to choose from.
"""
import json
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from make_poster import FACE_ORDER, sample_cube  # noqa: E402

TOUR = os.path.join(HERE, "..", "site", "data", "tour.json")
PANOS = os.path.join(HERE, "..", "site", "data", "panos")
W, H, HFOV, PITCH = 240, 135, 82.0, -9.0


def view(faces, yaw_deg):
    yaw, pitch = np.radians(yaw_deg), np.radians(PITCH)
    th = np.tan(np.radians(HFOV) / 2)
    tv = th * H / W
    U, V = np.meshgrid(np.linspace(-th, th, W), np.linspace(tv, -tv, H))
    d = np.stack([U, V, -np.ones_like(U)], -1)
    cp, sp = np.cos(pitch), np.sin(pitch)
    d = np.stack([d[..., 0], cp * d[..., 1] - sp * d[..., 2],
                  sp * d[..., 1] + cp * d[..., 2]], -1)
    cy, sy = np.cos(yaw), np.sin(yaw)
    d = np.stack([cy * d[..., 0] + sy * d[..., 2], d[..., 1],
                  -sy * d[..., 0] + cy * d[..., 2]], -1)
    d /= np.linalg.norm(d, axis=-1, keepdims=True)
    return sample_cube(faces, d)


def score(img):
    g = np.asarray(Image.fromarray(img).convert("L"), float)
    gx = np.abs(np.diff(g, axis=1)).mean()
    gy = np.abs(np.diff(g, axis=0)).mean()
    return (gx + gy) / 2


def main():
    wanted = sys.argv[1:] or None
    tour = json.load(open(TOUR))
    for n in tour["nodes"]:
        if wanted and n["id"] not in wanted:
            continue
        d = os.path.join(PANOS, n["id"], "512")
        faces = {f: np.asarray(Image.open(os.path.join(d, f"{f}.webp")).convert("RGB"))
                 for f in FACE_ORDER}
        rows = []
        for yaw in range(-180, 180, 5):
            rows.append((score(view(faces, yaw)), yaw))
        rows.sort(reverse=True)
        cur = score(view(faces, n["heading"]))
        top = ", ".join(f"{y}({s:.1f})" for s, y in rows[:6])
        print(f"{n['id']:16} current {n['heading']:>4} ({cur:.1f})   best: {top}")


main()

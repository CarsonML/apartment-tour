"""Tile the opening view of every viewpoint into one sheet.

This is what a visitor sees the instant they arrive somewhere, so it is the
fastest way to spot a camera jammed into a cupboard or a heading pointing at
a blank wall.
"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from make_poster import FACE_ORDER, sample_cube  # noqa: E402

TOUR = os.path.join(HERE, "..", "site", "data", "tour.json")
PANOS = os.path.join(HERE, "..", "site", "data", "panos")
W, H, HFOV, PITCH = 480, 270, 82.0, -9.0
COLS = 3


def view(faces, yaw_deg, pitch_deg):
    yaw, pitch = np.radians(yaw_deg), np.radians(pitch_deg)
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
    return Image.fromarray(sample_cube(faces, d))


def main():
    tour = json.load(open(TOUR))
    nodes = tour["nodes"]
    size = 512 if len(sys.argv) < 2 else int(sys.argv[1])
    rows = (len(nodes) + COLS - 1) // COLS
    sheet = Image.new("RGB", (COLS * W, rows * (H + 22)), (18, 18, 20))
    dr = ImageDraw.Draw(sheet)
    for k, n in enumerate(nodes):
        d = os.path.join(PANOS, n["id"], str(size))
        faces = {f: np.asarray(Image.open(os.path.join(d, f"{f}.webp")).convert("RGB"))
                 for f in FACE_ORDER}
        im = view(faces, n["heading"], PITCH)
        x, y = (k % COLS) * W, (k // COLS) * (H + 22)
        sheet.paste(im, (x, y))
        dr.text((x + 6, y + H + 5),
                f"{n['id']}  heading {n['heading']}  links {len(n['links'])}",
                fill=(235, 225, 200))
    out = "/tmp/qa_grid.png"
    sheet.save(out)
    print(f"{len(nodes)} viewpoints -> {out} {sheet.size}")


main()

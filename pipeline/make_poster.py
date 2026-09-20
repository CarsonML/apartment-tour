"""Render a normal perspective still from a viewpoint's packed cube faces.

Used for the opening screen and the link preview, so sharing the tour shows
the apartment rather than a black rectangle.  Reprojects per pixel into the
cube with the same conventions as the viewer, so the poster is literally a
frame of the tour.
"""
import argparse
import json
import os

import numpy as np
from PIL import Image, ImageFilter

FACE_ORDER = ["px", "nx", "py", "ny", "pz", "nz"]


def sample_cube(faces, d):
    """d: (...,3) directions in three.js world space -> RGB uint8."""
    S = faces["px"].shape[0]
    ax = np.abs(d)
    major = np.argmax(ax, -1)
    ma = np.max(ax, -1)
    pos = np.take_along_axis(d, major[..., None], -1)[..., 0] > 0
    x, y, z = d[..., 0], d[..., 1], d[..., 2]
    sc = np.zeros_like(x); tc = np.zeros_like(x); idx = np.zeros(x.shape, int)
    m = (major == 0) & pos;  sc[m] = -z[m]; tc[m] = -y[m]; idx[m] = 0
    m = (major == 0) & ~pos; sc[m] =  z[m]; tc[m] = -y[m]; idx[m] = 1
    m = (major == 1) & pos;  sc[m] =  x[m]; tc[m] =  z[m]; idx[m] = 2
    m = (major == 1) & ~pos; sc[m] =  x[m]; tc[m] = -z[m]; idx[m] = 3
    m = (major == 2) & pos;  sc[m] =  x[m]; tc[m] = -y[m]; idx[m] = 4
    m = (major == 2) & ~pos; sc[m] = -x[m]; tc[m] = -y[m]; idx[m] = 5
    fs = np.clip(((sc / ma + 1) / 2 * S).astype(int), 0, S - 1)
    ft = np.clip(((tc / ma + 1) / 2 * S).astype(int), 0, S - 1)
    out = np.zeros(d.shape[:-1] + (3,), np.uint8)
    for k, name in enumerate(FACE_ORDER):
        m = idx == k
        out[m] = faces[name][ft[m], fs[m]]
    return out


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--panos", required=True)
    p.add_argument("--tour", required=True)
    p.add_argument("--node", default=None, help="defaults to the tour's start")
    p.add_argument("--size", type=int, default=2048)
    p.add_argument("--out", required=True)
    p.add_argument("--width", type=int, default=1600)
    p.add_argument("--height", type=int, default=900)
    p.add_argument("--hfov", type=float, default=82.0)
    p.add_argument("--pitch", type=float, default=-6.0)
    p.add_argument("--heading", type=float, default=None,
                   help="override the viewpoint's default heading")
    a = p.parse_args()

    tour = json.load(open(a.tour))
    nid = a.node or tour.get("start") or tour["nodes"][0]["id"]
    node = next(n for n in tour["nodes"] if n["id"] == nid)
    yaw = np.radians(a.heading if a.heading is not None else node["heading"])
    pitch = np.radians(a.pitch)

    d = os.path.join(a.panos, nid, str(a.size))
    faces = {f: np.asarray(Image.open(os.path.join(d, f"{f}.webp")).convert("RGB"))
             for f in FACE_ORDER}

    W, H = a.width, a.height
    th = np.tan(np.radians(a.hfov) / 2)
    tv = th * H / W
    u = np.linspace(-th, th, W)
    v = np.linspace(tv, -tv, H)
    U, V = np.meshgrid(u, v)
    # camera looks down -Z, then pitch about X, then yaw about Y
    dirs = np.stack([U, V, -np.ones_like(U)], -1)
    cp, sp = np.cos(pitch), np.sin(pitch)
    dirs = np.stack([dirs[..., 0],
                     cp * dirs[..., 1] - sp * dirs[..., 2],
                     sp * dirs[..., 1] + cp * dirs[..., 2]], -1)
    cy, sy = np.cos(yaw), np.sin(yaw)
    dirs = np.stack([cy * dirs[..., 0] + sy * dirs[..., 2],
                     dirs[..., 1],
                     -sy * dirs[..., 0] + cy * dirs[..., 2]], -1)
    dirs /= np.linalg.norm(dirs, axis=-1, keepdims=True)

    img = Image.fromarray(sample_cube(faces, dirs))
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    img.save(a.out, "JPEG", quality=88, optimize=True)
    print(f"poster: {nid} @ heading {node['heading']} -> {a.out} {img.size}")

    blur = img.resize((W // 4, H // 4), Image.LANCZOS).filter(ImageFilter.GaussianBlur(6))
    blur = blur.resize((W // 2, H // 2), Image.LANCZOS)
    bpath = os.path.join(os.path.dirname(a.out), "poster-blur.jpg")
    blur.save(bpath, "JPEG", quality=70, optimize=True)
    print(f"blurred backdrop -> {bpath} {blur.size}")


if __name__ == "__main__":
    main()

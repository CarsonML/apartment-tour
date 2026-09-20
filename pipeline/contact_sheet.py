"""Rebuild an equirectangular view from the packed cube faces, with yaw ticks.

Purely a authoring aid: it is how the default heading for each viewpoint was
chosen, instead of guessing at compass directions.  yaw maps to u as
    u = 0.5 - yaw / 2pi
which is the inverse of what the viewer's camera does.
"""
import argparse
import json
import os

import numpy as np
from PIL import Image, ImageDraw


def load_faces(d, size):
    out = {}
    for f in ["px", "nx", "py", "ny", "pz", "nz"]:
        out[f] = np.asarray(Image.open(os.path.join(d, str(size), f"{f}.webp")).convert("RGB"))
    return out


def equirect(faces, W=1600):
    H = W // 2
    S = faces["px"].shape[0]
    u = (np.arange(W) + 0.5) / W
    v = (np.arange(H) + 0.5) / H
    th = (u - 0.5) * 2 * np.pi
    ph = v * np.pi
    T, P = np.meshgrid(th, ph)
    s = np.sin(P)
    d = np.stack([s * np.sin(T), np.cos(P), -s * np.cos(T)], -1)

    ax = np.abs(d)
    major = np.argmax(ax, -1)
    ma = np.max(ax, -1)
    sgn = np.take_along_axis(d, major[..., None], -1)[..., 0] > 0
    x, y, z = d[..., 0], d[..., 1], d[..., 2]

    # (sc, tc) per GL cube-map face convention
    sc = np.zeros_like(x); tc = np.zeros_like(x); idx = np.zeros(x.shape, int)
    m = (major == 0) & sgn;  sc[m] = -z[m]; tc[m] = -y[m]; idx[m] = 0   # px
    m = (major == 0) & ~sgn; sc[m] =  z[m]; tc[m] = -y[m]; idx[m] = 1   # nx
    m = (major == 1) & sgn;  sc[m] =  x[m]; tc[m] =  z[m]; idx[m] = 2   # py
    m = (major == 1) & ~sgn; sc[m] =  x[m]; tc[m] = -z[m]; idx[m] = 3   # ny
    m = (major == 2) & sgn;  sc[m] =  x[m]; tc[m] = -y[m]; idx[m] = 4   # pz
    m = (major == 2) & ~sgn; sc[m] = -x[m]; tc[m] = -y[m]; idx[m] = 5   # nz

    fs = np.clip(((sc / ma + 1) / 2 * S).astype(int), 0, S - 1)
    ft = np.clip(((tc / ma + 1) / 2 * S).astype(int), 0, S - 1)
    order = ["px", "nx", "py", "ny", "pz", "nz"]
    out = np.zeros((H, W, 3), np.uint8)
    for k, name in enumerate(order):
        m = idx == k
        out[m] = faces[name][ft[m], fs[m]]
    return Image.fromarray(out)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--panos", required=True)
    p.add_argument("--nodes", required=True)
    p.add_argument("--size", type=int, default=512)
    p.add_argument("--out", required=True)
    a = p.parse_args()
    os.makedirs(a.out, exist_ok=True)
    nodes = json.load(open(a.nodes))["nodes"]
    for n in nodes:
        d = os.path.join(a.panos, n["id"])
        if not os.path.exists(os.path.join(d, str(a.size))):
            print(f"[skip] {n['id']}")
            continue
        im = equirect(load_faces(d, a.size))
        W, H = im.size
        dr = ImageDraw.Draw(im)
        for yaw in range(-180, 181, 30):
            u = (0.5 - yaw / 360.0) % 1.0
            x = u * W
            cur = abs(((yaw - n["heading"] + 180) % 360) - 180) < 8
            dr.line([x, 0, x, 26], fill=(255, 210, 60) if cur else (255, 255, 255), width=3)
            dr.text((x + 4, 6), f"{yaw}", fill=(255, 210, 60) if cur else (255, 255, 255))
        dr.text((8, H - 22), f"{n['id']}  heading={n['heading']}", fill=(255, 210, 60))
        im.save(os.path.join(a.out, f"{n['id']}.png"))
        print(f"[sheet] {n['id']}")


main()

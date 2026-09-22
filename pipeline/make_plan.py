"""Crop the orthographic plan render to the flat and knock out its background.

The knock-out floods in from the border so dark things *inside* the apartment
(the stove, the shower recess) keep their pixels.
"""
import argparse
import json
import os

import numpy as np
from PIL import Image
from scipy import ndimage


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--src", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--meta", required=True)
    # world extent of the source render
    p.add_argument("--sx0", type=float, required=True)
    p.add_argument("--sx1", type=float, required=True)
    p.add_argument("--sy0", type=float, required=True)
    p.add_argument("--sy1", type=float, required=True)
    # world extent we want to keep
    p.add_argument("--x0", type=float, required=True)
    p.add_argument("--x1", type=float, required=True)
    p.add_argument("--y0", type=float, required=True)
    p.add_argument("--y1", type=float, required=True)
    a = p.parse_args()

    im = Image.open(a.src).convert("RGB")
    W, H = im.size
    px = lambda x: int(round((x - a.sx0) / (a.sx1 - a.sx0) * W))
    py = lambda y: int(round((a.sy1 - y) / (a.sy1 - a.sy0) * H))
    box = (px(a.x0), py(a.y1), px(a.x1), py(a.y0))
    im = im.crop(box)

    arr = np.array(im).astype(np.int16)
    lum = arr[:, :, 0] * 0.3 + arr[:, :, 1] * 0.59 + arr[:, :, 2] * 0.11
    dark = lum < 30
    lab, n = ndimage.label(dark)
    border = set(lab[0, :]) | set(lab[-1, :]) | set(lab[:, 0]) | set(lab[:, -1])
    border.discard(0)
    outside = np.isin(lab, list(border))

    keep = ~outside
    # drop stray bits of the courtyard that survived the flood fill
    lab2, n2 = ndimage.label(keep)
    if n2 > 1:
        sizes = ndimage.sum(keep, lab2, range(1, n2 + 1))
        keep = lab2 == (int(np.argmax(sizes)) + 1)
    rgba = np.dstack([arr.astype(np.uint8),
                      np.where(keep, 255, 0).astype(np.uint8)])
    out = Image.fromarray(rgba, "RGBA")
    # soften the cut edge by one pixel so it does not look like a sticker
    alpha = out.split()[3].filter(__import__("PIL.ImageFilter", fromlist=["x"]).GaussianBlur(0.6))
    out.putalpha(alpha)
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    out.save(a.out)

    # The minimap is ~330 px wide on screen; shipping a 1752 px RGBA PNG made
    # the floor plan nearly half the first load. WebP at 900 px is 40x smaller
    # and still sharper than it is ever displayed.
    web = out.copy()
    web.thumbnail((900, 900), Image.LANCZOS)
    web_path = os.path.splitext(a.out)[0] + ".webp"
    web.save(web_path, "WEBP", quality=88, method=6)
    print(f"web copy: {web.size[0]}x{web.size[1]} -> {web_path} "
          f"({os.path.getsize(web_path)/1024:.0f} KB, "
          f"source {os.path.getsize(a.out)/1024:.0f} KB)")

    meta = {"image": os.path.basename(web_path),
            "x0": a.x0, "x1": a.x1, "y0": a.y0, "y1": a.y1,
            "w": out.width, "h": out.height}
    json.dump(meta, open(a.meta, "w"), indent=2)
    print("plan:", out.size, "->", a.out)
    print(json.dumps(meta))


main()

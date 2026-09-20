"""Render one Cycles cube-map face set per tour node.

    blender -b scene.blend --python render_faces.py -- \
        --nodes nodes.json --out ../raw --size 2048 --samples 128

Resumable: a face whose PNG already exists is skipped, so the job can be
stopped and restarted freely.
"""
import argparse
import json
import math
import os
import sys
import time

import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import CUBE_FACES, FACE_ORDER, three_to_blender  # noqa: E402


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--nodes", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--size", type=int, default=2048)
    p.add_argument("--samples", type=int, default=128)
    p.add_argument("--threshold", type=float, default=0.01)
    p.add_argument("--only", default=None, help="comma separated node ids")
    p.add_argument("--kind", choices=["all", "walk", "named"], default="all",
                   help="walk = only the dense walking viewpoints")
    p.add_argument("--shard", default=None,
                   help="I/N: render only every Nth viewpoint, so several "
                        "processes can share the GPU")
    return p.parse_args(argv)


def setup_cycles(scene, samples, threshold):
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "METAL"
    prefs.get_devices()
    for d in prefs.devices:
        d.use = d.type == "METAL"

    cy = scene.cycles
    cy.device = "GPU"
    cy.use_adaptive_sampling = True
    cy.samples = samples
    cy.adaptive_threshold = threshold
    cy.use_denoising = True
    cy.denoiser = "OPENIMAGEDENOISE"

    # Cycles' default tile is 2048, so a 2048px face is one enormous GPU
    # launch.  On Metal that deadlocked reliably in MetalDeviceQueue::
    # synchronize() on the heavier viewpoints (the ones seeing out of a
    # window).  Splitting the film into 1024px tiles keeps each launch small.
    cy.use_auto_tile = True
    cy.tile_size = 1024
    # Leave bounces / caustics exactly as the artist set them: benchmarking
    # showed trimming them saves <10% but changes the look.
    # Denoise on the CPU: it costs a couple of seconds at this resolution and
    # keeps one more thing off a GPU queue that has already proved fragile.
    try:
        cy.denoising_use_gpu = False
    except AttributeError:
        pass

    r = scene.render
    r.resolution_percentage = 100
    r.use_border = False
    r.film_transparent = False
    r.image_settings.file_format = "PNG"
    r.image_settings.color_mode = "RGB"
    r.image_settings.color_depth = "8"
    r.image_settings.compression = 15


def make_face_camera(scene, size):
    cd = bpy.data.cameras.new("TourFace")
    cd.type = "PERSP"
    cd.sensor_fit = "HORIZONTAL"
    cd.lens_unit = "FOV"
    cd.angle = math.radians(90.0)
    cd.clip_start = 0.01
    cd.clip_end = 250.0
    cd.shift_x = 0.0
    cd.shift_y = 0.0
    co = bpy.data.objects.new("TourFace", cd)
    scene.collection.objects.link(co)
    scene.camera = co
    scene.render.resolution_x = size
    scene.render.resolution_y = size
    return co


def face_matrix(pos_three, face):
    """Camera matrix that renders `face`, mirrored horizontally.

    Columns are (image-right, image-up, -view_dir) in Blender space.  We negate
    image-right so the basis stays right-handed; the caller flips the PNG.
    """
    d, r, u = CUBE_FACES[face]
    X = Vector(three_to_blender((-r[0], -r[1], -r[2])))
    Y = Vector(three_to_blender(u))
    Z = Vector(three_to_blender((-d[0], -d[1], -d[2])))
    m = Matrix(((X.x, Y.x, Z.x), (X.y, Y.y, Z.y), (X.z, Y.z, Z.z))).to_4x4()
    m.translation = Vector(three_to_blender(pos_three))
    return m


def main():
    a = parse_args()
    scene = bpy.context.scene
    setup_cycles(scene, a.samples, a.threshold)
    cam = make_face_camera(scene, a.size)

    nodes = json.load(open(a.nodes))["nodes"]
    if a.only:
        keep = set(a.only.split(","))
        nodes = [n for n in nodes if n["id"] in keep]
    if a.kind == "walk":
        nodes = [n for n in nodes if n.get("walkOnly")]
    elif a.kind == "named":
        nodes = [n for n in nodes if not n.get("walkOnly")]
    if a.shard:
        i, n = (int(v) for v in a.shard.split("/"))
        nodes = [nd for k, nd in enumerate(nodes) if k % n == i]
        print(f"[shard] {i}/{n}: {len(nodes)} viewpoints", flush=True)

    total = len(nodes) * 6
    done = 0
    t_start = time.time()
    for n in nodes:
        outdir = os.path.join(a.out, n["id"])
        os.makedirs(outdir, exist_ok=True)
        for face in FACE_ORDER:
            path = os.path.join(outdir, f"{face}.png")
            done += 1
            if os.path.exists(path) and os.path.getsize(path) > 1024:
                print(f"[skip] {n['id']}/{face}", flush=True)
                continue
            cam.matrix_world = face_matrix(n["pos"], face)
            scene.render.filepath = path[:-4]
            t = time.time()
            bpy.ops.render.render(write_still=True)
            el = time.time() - t
            per = (time.time() - t_start) / max(1, done)
            print(
                f"[render] {n['id']}/{face} {el:.1f}s "
                f"({done}/{total}, eta {(total - done) * per / 60:.0f} min)",
                flush=True,
            )
    print(f"[done] {time.time() - t_start:.0f}s total", flush=True)


main()

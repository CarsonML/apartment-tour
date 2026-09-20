# Apartment tour

A photoreal walk-around of the apartment, built to be opened by someone who has
never used a 3D anything before.

Everything you see is a **Cycles render**. Nothing is shaded in the browser, so
what loads on a laptop is the image Blender produced — verified pixel-for-pixel
(see *Colour*, below).

The earlier attempt exported the scene to glTF and re-lit it in three.js with a
generic studio environment, which is why it looked flat. This scene's materials
are procedural — noise, voronoi and mosaic generators with no baked textures —
and its lighting is path-traced global illumination. Neither survives an
export. Pre-rendering sidesteps both problems instead of fighting them.

    site/        the deliverable: plain static files, no build step
    pipeline/    Blender + Python scripts that produce site/data
    raw/         intermediate PNG renders and depth maps (not deployed)
    logs/

## How it works

**Viewpoints.** 17 spots at eye height (1.55 m). None were placed, aimed, or
labelled by guessing.
`occupancy_scan.py` raycasts the scene on a 5 cm grid to find where a person
could actually stand — floor below, ceiling above, real headroom, and nothing
within 30 cm at eye and chest height. That yields 27.5 m² of interior and
13.4 m² of standable floor. `place_nodes.py` snaps hand-chosen targets onto
that mask, and `coverage.py` proposes further spots by farthest-point sampling
it, measuring distance *through* the free space so somewhere on the other side
of a wall is not mistaken for nearby. That is how the kitchen/bathroom doorway
turned up: a 3.58 m hole in the coverage, and the reason those two rooms had no
line of sight to each other.

**Colour.** Each viewpoint is six 90° Cycles renders — a cube map — at 2048 px
per face, 128 samples with OpenImageDenoise. (256 samples was indistinguishable
in an A/B, so the extra time buys nothing.) Cube faces rather than one
equirectangular image because they spend no pixels over-sampling the poles, and
every face stays inside the texture-size limit of an older tablet.

**Depth.** Each viewpoint also stores a 384×192 equirectangular depth map,
ray-traced straight from the scene BVH — seconds per viewpoint, with Cycles not
involved at all. The viewer pushes a sphere out to those distances, so a
panorama is a *shell* with the walls where the walls really are. Standing
still that is identical to a skybox; while walking between two viewpoints the
near walls slide past the far ones and it reads as movement rather than a
cross-fade.

**Tiers.** A 512 px cube map is fetched for every viewpoint up front (~50 KB
each) so arriving anywhere is instant; 1024 then 2048 stream in for wherever
you actually are. The top tier is chosen from what the device admits to
(`maxTextureSize`, `deviceMemory`, screen size), because a 2048 px cube map is
~134 MB of video memory once mipped and two are resident during a walk. Only
two are ever kept.

## Rebuilding

Needs Blender 5.x and Python with `pillow`, `numpy`, `scipy`.

```bash
BLEND=/path/to/visual_candidate_v10.blend

# 1. where can a person stand  (~10 min -> pipeline/occupancy.json)
blender -b "$BLEND" --python pipeline/occupancy_scan.py

# 2. choose and validate viewpoints
python3 pipeline/place_nodes.py
python3 pipeline/coverage.py --add 8       # optional: propose more

# 3. depth maps + which viewpoints can see each other  (~1 h, CPU only,
#    so it can run alongside step 4)
blender -b "$BLEND" --python pipeline/depth_probe.py -- \
  --nodes pipeline/nodes.json --out raw/depth384 --width 384

# 4. the long one: 6 Cycles renders per viewpoint  (~3.5 min each)
BLEND="$BLEND" OUT=raw/full pipeline/run_render.sh

# 5. flip to GL cube-map orientation, encode the WebP tiers
python3 pipeline/pack.py --src raw/full --nodes pipeline/nodes.json \
  --out site/data/panos --tiers 2048:90,1024:86,512:84 --depth-src raw/depth384

# 6. floor plan for the minimap, then the manifest
python3 pipeline/make_plan.py --src <ortho render> --out site/assets/floorplan.png \
  --meta pipeline/plan.json --sx0 .. --sx1 .. --sy0 .. --sy1 .. \
  --x0 -0.40 --x1 10.55 --y0 -0.95 --y1 3.35
python3 pipeline/gen_tour.py --nodes pipeline/nodes.json \
  --graph raw/depth384/graph.json --plan pipeline/plan.json \
  --out site/data/tour.json --tiers 512,1024,2048 --start entry
```

Steps 3 and 4 are both resumable — anything already on disk is skipped — so
they can be stopped and picked up freely.

## The authoring tools

None of these render anything; they all read the packed site and are cheap to
re-run.

`contact_sheet.py` rebuilds a labelled equirectangular view of each viewpoint
from the packed faces. It doubles as an independent check that the cube-map
convention is right: if the faces were wrong, the reassembled panorama would
not be seamless.

`qa_grid.py` tiles the *opening view* of all 17 viewpoints onto one sheet —
exactly what a visitor sees the instant they arrive. It is the fastest way to
spot a camera aimed into a cupboard.

`score_headings.py` ranks every possible opening heading by mean gradient
magnitude, a rough proxy for "is there anything to look at". It caught two
viewpoints opening on blank surfaces that had passed a casual eyeball:
`bedroom_east` at 0.5 and `living_window` at 1.3, against a typical 5–7. Treat
it as an aid, not an oracle — it rates a mosaic backsplash above a good view
down the flat, and `living_window` deliberately keeps a heading it does not
rank first, because the top-scoring one is half a metre of window glass.

`coverage.py` proposes new viewpoints by farthest-point sampling the standable
floor. One caveat learned the hard way: it measures distance *through* the free
space, and where the mask is fragmented by a tight threshold rather than by an
actual wall, it reports a gap that is not real. It once proposed a spot 0.38 m
from an existing viewpoint as a 3.58 m hole. Check candidates against the
straight-line distance before rendering six faces of one.

`verify_site.py` is the gate: every viewpoint has all 18 faces at the right
dimensions, depth matches what the manifest claims, links point at real
viewpoints, every viewpoint falls inside the floor plan, rooms and route are
consistent. `finish.sh` runs it last, so a packaging mistake fails loudly
rather than turning into a silent 404 and a black wall.

`version.py` stamps `index.html` and the tour fetch with a hash of the built
files. Without it a browser will happily pair a new `app.js` with a cached
`tour.json`.

## Four things that will bite you

**Cycles' default tile is 2048, so a 2048 px face is one enormous GPU launch.**
On Metal that deadlocked in `MetalDeviceQueue::synchronize()` on the heavier
viewpoints — the ones that see out of a window. One face took **4875 seconds**
instead of ~200. Setting `use_auto_tile` with `tile_size = 1024` took that same
face to **190 s**. `run_render.sh` also watches the finished-face count and
restarts Blender if progress stops for nine minutes, because a multi-hour
unattended render should not need a human.

**Objects hidden in the viewport still render, but `scene.ray_cast` cannot see
them.** `Living ceiling` and `Bedroom ceiling` are both in that state. Every
script that raycasts calls `hide_set(False)` first. Without it the occupancy
scan loses two entire rooms and the depth maps get holes where the ceiling
should be.

**Cube faces are stored mirrored.** WebGL cube maps are left-handed.
`render_faces.py` writes each face with its horizontal axis negated (so the
Blender camera basis stays right-handed) and `pack.py` flips it back, which
lands the pixels in the GL convention. The shader then samples with the
direction **as-is** — three.js negates x in its own cube shaders because those
consume textures authored the other way round, and copying that mirrors the
whole flat. It is a convincing bug: the panorama still looks seamless, it is
just backwards. Compare a face against `raw/full/<node>/px.png` to catch it.

**Moving a viewpoint silently invalidates six renders.** `place_nodes.py` pins
the position of anything already present in `nodes.json`, so changing the mask
or the scoring can never shift a spot that has already been rendered. Delete
the entry from `nodes.json` if you genuinely want it re-sited.

## Bounding video memory

A 2048 px cube map is about 134 MB of video memory once mipped, and two are
resident while walking. Left alone the base tier compounds that: every
viewpoint you visit keeps its own, which across 17 is another 140 MB. So:

- the sharpest tier is chosen from what the device admits to — an older tablet
  or any small touch screen gets 1024 instead of 2048;
- at most two high-res sets are kept, and at most eight base ones, both LRU;
- the base tier has mipmaps off, since it is only ever magnified;
- the boot preload fetches the *files* rather than building textures, so the
  bytes are local but the GPU stays empty until you actually go somewhere.

Worst case lands near 200 MB instead of 410 MB. If you raise `BASE_CACHE`,
note that `ensureNode` deliberately checks whether the textures still exist
rather than trusting a "loaded once" flag — an evicted viewpoint handed back
on a stale flag renders as a black room, and only after enough walking to
trigger an eviction.

## Publishing

`site/` is static. Drag the folder onto Netlify Drop, or:

```bash
npx wrangler pages deploy site --project-name apartment-tour
```

GitHub Pages works too. The only requirement is that `.webp` and `.bin` get
sane MIME types, which every host does by default. `_headers` sets long cache
lifetimes for Netlify and Cloudflare Pages.

## Changing the words

Nothing user-facing is hard-coded in the JavaScript.

- Title and subtitle: `site/data/tour.json` (`title`) and `site/index.html`.
- Room names and which viewpoint a room button opens: `ROOM_ORDER` and
  `ROOM_PRIMARY` in `pipeline/gen_tour.py`.
- The order the guided tour walks: `route`, same file.
- Optional one-line captions under the room name: `pipeline/blurbs.json`.
  Deliberately empty — better no caption than an invented one.

Re-run `gen_tour.py` after editing any of those, or just edit
`site/data/tour.json` directly for a one-off change.

## Colour

`THREE.ColorManagement` is **off**, `outputColorSpace` is linear-sRGB, textures
are `NoColorSpace` and tone mapping is `NoToneMapping`. The WebP faces already
hold Blender's AgX-tonemapped sRGB bytes; anything else would tone-map a second
time. Sampling the same face in the browser and in the source PNG agrees to
within 0.5–2 levels out of 255 — WebP quantisation, not a gamma shift:

    reference (Blender PNG)   150.93  147.55  139.63
    browser readPixels        151.47  148.25  140.18

If someone later "fixes" the colour management, that test is how you find out.

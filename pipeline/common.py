"""Shared conventions for the apartment tour pipeline.

Coordinate systems
------------------
Blender is Z-up, right-handed.  three.js is Y-up, right-handed.
We publish all tour data in *three.js* space and convert once, here:

    three (x, y, z)  ->  blender (x, -z, y)
    blender (x, y, z) -> three (x, z, -y)

Cube faces
----------
WebGL cube maps are left-handed: for each face the texture s axis runs along
`sc` and the t axis (which increases *downward* in the stored image) runs along
`tc`.  So image-right = sc and image-up = -tc.  A normal Blender camera is
right-handed, so we render each face with the horizontal axis negated and flip
the result horizontally afterwards.
"""

# direction, image-right, image-up  -- all in three.js world space
CUBE_FACES = {
    "px": ((1, 0, 0), (0, 0, -1), (0, 1, 0)),
    "nx": ((-1, 0, 0), (0, 0, 1), (0, 1, 0)),
    "py": ((0, 1, 0), (1, 0, 0), (0, 0, -1)),
    "ny": ((0, -1, 0), (1, 0, 0), (0, 0, 1)),
    "pz": ((0, 0, 1), (1, 0, 0), (0, 1, 0)),
    "nz": ((0, 0, -1), (-1, 0, 0), (0, 1, 0)),
}
FACE_ORDER = ["px", "nx", "py", "ny", "pz", "nz"]


def three_to_blender(v):
    return (v[0], -v[2], v[1])


def blender_to_three(v):
    return (v[0], v[2], -v[1])

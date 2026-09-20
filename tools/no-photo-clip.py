#!/usr/bin/env python3
"""The no-photo clip people can print at home.

Shape: a peg. A front plate carrying a raised X, a back plate under it, and a
half round bend joining them at one end. The 2.4 mm gap between the plates grips
a shirt, a pocket edge, a cap or a bag strap. It prints flat on the bed with no
supports; PETG or PLA both work, a few perimeters and 20 percent infill.

Output: files/semrede-no-photo-clip.stl (binary STL, millimetres)
"""
import math
import struct
import pathlib

TRIS = []
WIDTH = 32.0        # across the clip
PLATE = 2.6         # plate thickness
FRONT_LEN = 40.0    # the face that carries the X
BACK_LEN = 26.0     # the jaw behind the fabric
GAP = 2.4           # the fabric slides in here
BAR_LEN = 30.0      # one stroke of the X
BAR_W = 6.0
BAR_H = 2.2
ARC_STEPS = 24


def add_tri(a, b, c):
    ux, uy, uz = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
    vx, vy, vz = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
    n = (uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
    length = math.sqrt(sum(k * k for k in n)) or 1.0
    TRIS.append(((n[0] / length, n[1] / length, n[2] / length), a, b, c))


def add_quad(a, b, c, d):
    add_tri(a, b, c)
    add_tri(a, c, d)


def box(center, size, angle_deg=0.0):
    """A closed box, optionally turned around Z."""
    cx, cy, cz = center
    hx, hy, hz = (s / 2 for s in size)
    t = math.radians(angle_deg)
    cos_t, sin_t = math.cos(t), math.sin(t)
    corners = []
    for dz in (-hz, hz):
        for dx, dy in ((-hx, -hy), (hx, -hy), (hx, hy), (-hx, hy)):
            corners.append((cx + dx * cos_t - dy * sin_t, cy + dx * sin_t + dy * cos_t, cz + dz))
    b0, b1, b2, b3, t0, t1, t2, t3 = corners
    add_quad(b0, b3, b2, b1)
    add_quad(t0, t1, t2, t3)
    add_quad(b0, b1, t1, t0)
    add_quad(b1, b2, t2, t1)
    add_quad(b2, b3, t3, t2)
    add_quad(b3, b0, t0, t3)


# --- the two jaws ---
# front plate: z from 0 to PLATE, y from 0 to FRONT_LEN
box((0, FRONT_LEN / 2, PLATE / 2), (WIDTH, FRONT_LEN, PLATE))
# back plate: z from -(GAP + PLATE) to -GAP
box((0, BACK_LEN / 2, -(GAP + PLATE / 2)), (WIDTH, BACK_LEN, PLATE))

# --- the bend, a half ring in the YZ plane that meets both plates exactly ---
inner, outer = GAP / 2, GAP / 2 + PLATE
cz = -GAP / 2
hw = WIDTH / 2


def arc_point(angle, radius, x):
    return (x, -radius * math.sin(angle), cz + radius * math.cos(angle))


for i in range(ARC_STEPS):
    a0 = math.pi * i / ARC_STEPS
    a1 = math.pi * (i + 1) / ARC_STEPS
    o0l, o1l = arc_point(a0, outer, -hw), arc_point(a1, outer, -hw)
    o0r, o1r = arc_point(a0, outer, hw), arc_point(a1, outer, hw)
    i0l, i1l = arc_point(a0, inner, -hw), arc_point(a1, inner, -hw)
    i0r, i1r = arc_point(a0, inner, hw), arc_point(a1, inner, hw)
    add_quad(o0l, o0r, o1r, o1l)      # outside of the bend
    add_quad(i1l, i1r, i0r, i0l)      # inside of the bend
    add_quad(o0l, o1l, i1l, i0l)      # left edge
    add_quad(i0r, i1r, o1r, o0r)      # right edge

# the flat ends of the ring close against the plates
add_quad(arc_point(0, inner, -hw), arc_point(0, outer, -hw), arc_point(0, outer, hw), arc_point(0, inner, hw))
add_quad(arc_point(math.pi, inner, hw), arc_point(math.pi, outer, hw),
         arc_point(math.pi, outer, -hw), arc_point(math.pi, inner, -hw))

# --- the X on the front face ---
x_centre_y = FRONT_LEN * 0.55
for angle in (45, -45):
    box((0, x_centre_y, PLATE + BAR_H / 2), (BAR_LEN, BAR_W, BAR_H), angle)

out = pathlib.Path(__file__).resolve().parent.parent / 'files' / 'semrede-no-photo-clip.stl'
out.parent.mkdir(parents=True, exist_ok=True)
with out.open('wb') as f:
    f.write(b'SemRede no-photo clip, semrede.com'.ljust(80, b' '))
    f.write(struct.pack('<I', len(TRIS)))
    for n, a, b, c in TRIS:
        f.write(struct.pack('<12fH', *n, *a, *b, *c, 0))

pts = [p for _, a, b, c in TRIS for p in (a, b, c)]
dims = [max(p[i] for p in pts) - min(p[i] for p in pts) for i in range(3)]
print(f'{out}: {len(TRIS)} triangles, {dims[0]:.1f} x {dims[1]:.1f} x {dims[2]:.1f} mm')

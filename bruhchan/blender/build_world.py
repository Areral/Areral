"""bruhchan — procedural island, ruins and props for the spatial imageboard.

Deterministic: the same seed always produces the same island, so the server-side
heightmap in world.json matches the rendered terrain exactly.

Outputs (glTF / three.js Y-up coordinates):
  world.glb     terrain, ruins, flora, rocks, spawn plaza, brazier
  marker.glb    thread monolith ("marker_stone") with an emissive flame glyph ("rune")
  wanderer.glb  hooded anonymous wanderer ("wanderer_body", "wanderer_void", "glow")
  world.json    heightmap + circle colliders + spawn, shared by client and server

Usage:
  blender -b --factory-startup -P blender/build_world.py -- --out public/assets [--seed 1337] [--preview out.png]

Inside a live Blender session (e.g. over MCP) set BRUHCHAN_OUT before exec'ing this file.
"""

import json
import math
import os
import random
import sys

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

# ---------------------------------------------------------------- arguments


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    here = os.path.dirname(os.path.abspath(globals().get("__file__", os.getcwd() + "/x")))
    out = globals().get("BRUHCHAN_OUT") or os.path.join(here, "..", "public", "assets")
    seed, preview = 1337, globals().get("BRUHCHAN_PREVIEW")
    i = 0
    while i < len(argv):
        if argv[i] == "--out":
            out = argv[i + 1]; i += 2
        elif argv[i] == "--seed":
            seed = int(argv[i + 1]); i += 2
        elif argv[i] == "--preview":
            preview = argv[i + 1]; i += 2
        else:
            i += 1
    return os.path.abspath(out), seed, preview


OUT_DIR, SEED, PREVIEW = parse_args()

# ---------------------------------------------------------------- palette (sRGB)

PAL = {
    "seabed": "#3b4747", "wet_sand": "#6b6755", "sand": "#a09780", "moss": "#58664a",
    "dry": "#78734f", "rock": "#6c6964", "rock_dark": "#524f4b", "ash": "#8d8882",
    "paving": "#8a847a", "stone": "#7b766d", "stone_dark": "#5d5851", "bark": "#3a322b",
    "pine": "#3a483a", "pine_dark": "#2f3b30", "cloak": "#4a4550", "cloak_hem": "#5b5561",
    "void": "#050505", "coal": "#2a1a14",
}


def hex_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))


def to_linear(c):
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


def mix(a, b, t):
    t = max(0.0, min(1.0, t))
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def shade(c, k):
    return tuple(max(0.0, min(1.0, x * k)) for x in c)


C = {k: hex_rgb(v) for k, v in PAL.items()}

# ---------------------------------------------------------------- noise (pure python, version-independent)


def _hash(ix, iy, s):
    n = ((ix * 73856093) ^ (iy * 19349663) ^ (s * 83492791)) & 0xFFFFFFFF
    n = ((n ^ (n >> 13)) * 1274126177) & 0xFFFFFFFF
    n ^= n >> 16
    return (n & 0xFFFFFF) / float(0xFFFFFF)


def vnoise(x, y, s):
    ix, iy = math.floor(x), math.floor(y)
    fx, fy = x - ix, y - iy
    u, v = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
    a, b = _hash(ix, iy, s), _hash(ix + 1, iy, s)
    c, d = _hash(ix, iy + 1, s), _hash(ix + 1, iy + 1, s)
    return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2.0 - 1.0


def fbm(x, y, s, octaves=5):
    amp, freq, tot, norm = 1.0, 1.0, 0.0, 0.0
    for o in range(octaves):
        tot += amp * vnoise(x * freq, y * freq, s + o * 101)
        norm += amp
        amp *= 0.5
        freq *= 2.0
    return tot / norm


def smoothstep(e0, e1, x):
    t = max(0.0, min(1.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


# ---------------------------------------------------------------- terrain field (Blender XY, Z up)

WORLD = 264.0          # terrain square side, metres
CELL = 3.0             # grid spacing → low-poly facets
SEA_FLOOR = -7.0
GATE_ANGLE = 0.12      # east headland with cliffs
STAIRS_ANGLE = math.atan2(-52, -40)
ISLET = (82.0, -90.0)  # unreachable rock offshore, a silhouette in the fog


def coast_radius(ang):
    ca, sa = math.cos(ang), math.sin(ang)
    return 82.0 + 15.0 * fbm(ca * 1.6 + 5.0, sa * 1.6 + 5.0, SEED + 1, 4) + 6.0 * fbm(ca * 4.2 - 3.0, sa * 4.2 + 1.0, SEED + 7, 3)


def ang_diff(a, b):
    return abs((a - b + math.pi) % (2 * math.pi) - math.pi)


def natural(x, y):
    r = math.hypot(x, y)
    ang = math.atan2(y, x)
    cliff = math.exp(-(ang_diff(ang, GATE_ANGLE) / 0.33) ** 2)
    R = coast_radius(ang)
    width = 20.0 - 15.0 * cliff
    warp = 10.0 * fbm(x * 0.025 + 11.0, y * 0.025 - 7.0, SEED + 4, 3)   # bays and headlands
    land = smoothstep(R + width * 0.3, R - width * 0.7, r + warp)
    islet = smoothstep(13.0, 3.0, math.hypot(x - ISLET[0], y - ISLET[1]) + 4.0 * fbm(x * 0.2, y * 0.2, SEED + 5, 2))
    e = 2.0 + 5.5 * (fbm(x * 0.022, y * 0.022, SEED + 2) * 0.5 + 0.5)
    e += 3.0 * max(0.0, fbm(x * 0.05, y * 0.05, SEED + 3, 3))
    # headland rises only in a band near the shore, so the east ends in sea cliffs, not an inland wall
    e += 7.0 * cliff * smoothstep(R - 42.0, R - 14.0, r + warp)
    h = SEA_FLOOR + (e - SEA_FLOOR) * land
    return max(h, SEA_FLOOR + (9.0 - SEA_FLOOR) * islet)


def find_edge(ang, below):
    """Outermost radius along a ray where the land still stands at least `below` high (scanning in from the sea)."""
    r = 125.0
    while r > 20.0:
        if natural(math.cos(ang) * r, math.sin(ang) * r) >= below:
            return r
        r -= 0.5
    return 60.0


def polar(ang, r):
    return (math.cos(ang) * r, math.sin(ang) * r)


SPAWN = (0.0, -34.0)
CIRCLE = (-6.0, 26.0)
COLONNADE = ((-50.0, -6.0), (-33.0, 16.0))
TOWER = (22.0, 60.0)
GATE = polar(GATE_ANGLE, find_edge(GATE_ANGLE, 6.0) - 7.0)
STAIRS = polar(STAIRS_ANGLE, find_edge(STAIRS_ANGLE, 0.9) - 3.0)


def seg_dist(px, py, a, b):
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + dx * t), py - (ay + dy * t)), t


FLATS = [
    # (centre, r_in, r_out, target height)
    (SPAWN, 8.0, 17.0, max(natural(*SPAWN), 2.4)),
    (CIRCLE, 11.0, 22.0, natural(*CIRCLE) + 3.0),
    (TOWER, 6.5, 15.0, natural(*TOWER) + 1.5),
    (GATE, 5.0, 11.0, natural(*GATE)),
    (STAIRS, 4.0, 9.0, max(natural(*STAIRS), 1.1)),
]
COL_T0, COL_T1 = natural(*COLONNADE[0]), natural(*COLONNADE[1])


def height(x, y):
    h = natural(x, y)
    for (cx, cy), r_in, r_out, target in FLATS:
        w = smoothstep(r_out, r_in, math.hypot(x - cx, y - cy))
        h += (target - h) * w
    d, t = seg_dist(x, y, *COLONNADE)
    w = smoothstep(9.0, 3.5, d)
    h += (COL_T0 + (COL_T1 - COL_T0) * t - h) * w
    return h


# ---------------------------------------------------------------- mesh accumulation


class Group:
    """Accumulates many primitives into one mesh with per-face (corner) colours."""

    def __init__(self, name):
        self.name, self.verts, self.faces, self.cols = name, [], [], []

    def add(self, bm, color_fn):
        bm.verts.index_update()
        bm.normal_update()
        off = len(self.verts)
        self.verts.extend(v.co.copy() for v in bm.verts)
        for f in bm.faces:
            self.faces.append([off + v.index for v in f.verts])
            self.cols.append(color_fn(f.calc_center_median(), f.normal))
        bm.free()

    def build(self, collection, material):
        mesh = bpy.data.meshes.new("bc_" + self.name)
        mesh.from_pydata([tuple(v) for v in self.verts], [], self.faces)
        mesh.update()
        attr = mesh.color_attributes.new(name="Col", type="BYTE_COLOR", domain="CORNER")
        flat = []
        for face, col in zip(self.faces, self.cols):
            lin = to_linear(col)
            flat.extend((lin[0], lin[1], lin[2], 1.0) * len(face))
        attr.data.foreach_set("color", flat)
        mesh.color_attributes.active_color = attr
        mesh.polygons.foreach_set("use_smooth", [False] * len(mesh.polygons))
        mesh.materials.append(material)
        obj = bpy.data.objects.new(self.name, mesh)
        collection.objects.link(obj)
        return obj


def jittered(col, key, amount=0.12):
    return shade(col, 1.0 - amount / 2 + amount * _hash(int(key * 7919) & 0xFFFFF, 17, SEED))


def xform(bm, loc=(0, 0, 0), rot=(0, 0, 0), scale=None):
    m = Matrix.Translation(Vector(loc)) @ Euler(rot, "XYZ").to_matrix().to_4x4()
    if scale:
        m = m @ Matrix.Diagonal(Vector((*scale, 1.0)))
    bmesh.ops.transform(bm, matrix=m, verts=bm.verts)
    return bm


def bm_box(sx, sy, sz):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=(sx, sy, sz), verts=bm.verts)
    bmesh.ops.translate(bm, vec=(0, 0, sz / 2), verts=bm.verts)
    return bm


def bm_prism(r_bot, r_top, h, segs):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segs,
                          radius1=r_bot, radius2=r_top, depth=h)
    bmesh.ops.translate(bm, vec=(0, 0, h / 2), verts=bm.verts)
    return bm


def bm_rock(radius, rng, squash=0.7):
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=1, radius=radius)
    for v in bm.verts:
        v.co *= 0.78 + rng.random() * 0.44
        v.co.z *= squash
    return bm


def roughen(bm, rng, amt):
    for v in bm.verts:
        v.co += Vector((rng.uniform(-amt, amt), rng.uniform(-amt, amt), rng.uniform(-amt, amt)))
    return bm


def break_top(bm, rng, depth):
    top = max(v.co.z for v in bm.verts)
    for v in bm.verts:
        if v.co.z > top - 1e-4:
            v.co.z -= rng.random() * depth
    return bm


def stone_color(base, z0, moss=0.45):
    def fn(center, normal):
        c = jittered(base, center.x * 3.1 + center.y * 1.7 + center.z * 5.3)
        low = smoothstep(z0 + 1.2, z0 + 0.1, center.z)
        top = max(0.0, normal.z) * 0.35
        return mix(c, C["moss"], moss * max(low, top))
    return fn


# ---------------------------------------------------------------- scene helpers


def fresh_collection(name):
    old = bpy.data.collections.get(name)
    if old:
        for o in list(old.objects):
            data = o.data
            bpy.data.objects.remove(o, do_unlink=True)
            if isinstance(data, bpy.types.Mesh) and data.users == 0:
                bpy.data.meshes.remove(data)
        bpy.data.collections.remove(old)
    col = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(col)
    return col


def make_material(name, base="#ffffff", emissive=None, strength=1.0, vertex_colors=False, rough=0.95):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    if mat.node_tree is None and hasattr(mat, "use_nodes"):
        mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is None:
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        out = next((n for n in nt.nodes if n.type == "OUTPUT_MATERIAL"), None) or nt.nodes.new("ShaderNodeOutputMaterial")
        nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    lin = to_linear(hex_rgb(base))
    bsdf.inputs["Base Color"].default_value = (*lin, 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    if vertex_colors and not any(n.type == "VERTEX_COLOR" for n in nt.nodes):
        vc = nt.nodes.new("ShaderNodeVertexColor")
        vc.layer_name = "Col"
        nt.links.new(vc.outputs["Color"], bsdf.inputs["Base Color"])
    if emissive:
        sock = bsdf.inputs.get("Emission Color") or bsdf.inputs.get("Emission")
        sock.default_value = (*to_linear(hex_rgb(emissive)), 1.0)
        bsdf.inputs["Emission Strength"].default_value = strength
    mat.diffuse_color = (*lin, 1.0)
    return mat


def mesh_object(name, bm, collection, material):
    mesh = bpy.data.meshes.new("bc_" + name)
    bm.to_mesh(mesh)
    bm.free()
    mesh.polygons.foreach_set("use_smooth", [False] * len(mesh.polygons))
    mesh.materials.append(material)
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    return obj


def bm_merge(target, src):
    mesh = bpy.data.meshes.new("bc_tmp")
    src.to_mesh(mesh)
    src.free()
    target.from_mesh(mesh)
    bpy.data.meshes.remove(mesh)


def export_glb(path, objects):
    layer = bpy.context.view_layer
    for o in layer.objects:
        o.select_set(False)
    for o in objects:
        o.select_set(True)
    layer.objects.active = objects[0]
    props = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
    wanted = dict(
        export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
        export_normals=True, export_texcoords=False, export_materials="EXPORT",
        export_vertex_color="ACTIVE", export_cameras=False, export_lights=False,
        export_extras=False, export_animations=False, export_skins=False, export_morph=False,
    )
    kwargs = {k: v for k, v in wanted.items() if k in props}
    bpy.ops.export_scene.gltf(filepath=path, **kwargs)
    for o in objects:
        o.select_set(False)


# ---------------------------------------------------------------- world


COLLIDERS = []   # (x, y, r) in Blender XY


def collide(x, y, r):
    COLLIDERS.append((round(x, 2), round(y, 2), round(r, 2)))


def build_terrain(col, mat):
    n = int(WORLD / CELL) + 1
    x0 = -WORLD / 2
    heights = [[height(x0 + c * CELL, -(x0 + r * CELL)) for c in range(n)] for r in range(n)]
    g = Group("terrain")
    g.verts = [Vector((x0 + c * CELL, -(x0 + r * CELL), heights[r][c])) for r in range(n) for c in range(n)]
    for r in range(n - 1):
        for c in range(n - 1):
            a, b = r * n + c, r * n + c + 1
            cc, d = (r + 1) * n + c, (r + 1) * n + c + 1
            # split along B–C: must match heightAt() in server/world.js and public/js/terrain.js
            for tri in ((a, cc, b), (b, cc, d)):
                p = [g.verts[i] for i in tri]
                if max(v.z for v in p) < -4.5:
                    continue  # deep seafloor is hidden under the water plane; the heightmap keeps it
                normal = (p[1] - p[0]).cross(p[2] - p[0]).normalized()
                center = (p[0] + p[1] + p[2]) / 3
                g.faces.append(list(tri))
                g.cols.append(terrain_color(center, normal))
    g.build(col, mat)
    return {"x0": x0, "z0": x0, "cell": CELL, "cols": n, "rows": n,
            "heights": [round(h, 2) for row in heights for h in row]}


def terrain_color(center, normal):
    h, nz = center.z, normal.z
    key = center.x * 0.37 + center.y * 0.91
    if h < -0.15:
        base = mix(C["wet_sand"], C["seabed"], smoothstep(-0.15, -3.0, h))
    elif h < 1.1:
        base = mix(C["wet_sand"], C["sand"], smoothstep(-0.1, 0.6, h))
    else:
        grass = mix(C["moss"], C["dry"], fbm(center.x * 0.04, center.y * 0.04, SEED + 9, 3) * 0.9 + 0.45)
        grass = mix(C["sand"], grass, smoothstep(1.1, 1.9, h))
        base = mix(C["rock"], grass, smoothstep(0.72, 0.9, nz))
        if nz < 0.6:
            base = C["rock_dark"]
        base = mix(base, C["ash"], smoothstep(10.5, 14.0, h) * 0.6)
    return jittered(base, key, 0.1)


def build_plaza(g, rng):
    cx, cy = SPAWN
    ground = height(cx, cy)
    rings = [(0.0, 1), (1.55, 6), (3.1, 12), (4.65, 17), (6.2, 22)]
    for radius, count in rings:
        for i in range(count):
            if radius > 5 and rng.random() < 0.22:
                continue  # missing flagstones at the rim
            a = 2 * math.pi * i / count + radius * 0.3
            x, y = cx + math.cos(a) * radius, cy + math.sin(a) * radius
            size = 1.32 if radius else 1.5
            bm = bm_box(size, size * 0.92, 0.3)
            roughen(bm, rng, 0.03)
            xform(bm, (x, y, height(x, y) - 0.24 + rng.uniform(0, 0.05)), (0, 0, a + rng.uniform(-0.1, 0.1)))
            g.add(bm, stone_color(C["paving"], ground, 0.25))
    for k in range(4):   # low broken walls around the plaza
        a = math.pi * 0.35 + k * math.pi * 0.42
        x, y = cx + math.cos(a) * 8.2, cy + math.sin(a) * 8.2
        length = 2.6 + rng.random() * 1.6
        bm = break_top(bm_box(length, 0.6, 1.3), rng, 0.7)
        roughen(bm, rng, 0.04)
        xform(bm, (x, y, height(x, y) - 0.2), (0, 0, a + math.pi / 2))
        g.add(bm, stone_color(C["stone"], height(x, y)))
        for t in (-0.35, 0.0, 0.35):
            collide(x + math.cos(a + math.pi / 2) * length * t, y + math.sin(a + math.pi / 2) * length * t, 0.55)


def build_brazier(col, rng, stone_mat, ember_mat):
    cx, cy = SPAWN
    z = height(cx, cy) + 0.06
    g = Group("brazier")
    bm = bm_prism(0.62, 0.5, 0.95, 8)
    xform(bm, (cx, cy, z - 0.05))
    g.add(bm, stone_color(C["stone_dark"], z, 0.3))
    bm = bm_prism(0.36, 0.82, 0.42, 8)
    xform(bm, (cx, cy, z + 0.9))
    g.add(bm, stone_color(C["stone_dark"], z, 0.0))
    obj = g.build(col, stone_mat)
    coals = bm_prism(0.72, 0.6, 0.08, 8)
    roughen(coals, rng, 0.03)
    xform(coals, (cx, cy, z + 1.27))
    ember = mesh_object("coals", coals, col, ember_mat)
    collide(cx, cy, 0.95)
    return [obj, ember], (cx, cy, z + 1.45)


def standing_stone(g, rng, x, y, h, face_angle, w=1.2, d=0.55):
    bm = break_top(bm_box(w, d, h), rng, 0.45)
    for v in bm.verts:      # slight taper
        k = 1.0 - 0.18 * (v.co.z / h)
        v.co.x *= k
        v.co.y *= k
    roughen(bm, rng, 0.05)
    base = height(x, y)
    xform(bm, (x, y, base - 0.45), (rng.uniform(-0.07, 0.07), rng.uniform(-0.05, 0.05), face_angle))
    g.add(bm, stone_color(C["stone"], base))


def build_circle(g, rng):
    cx, cy = CIRCLE
    count = 12
    for i in range(count):
        a = 2 * math.pi * i / count + 0.2
        x, y = cx + math.cos(a) * 8.6, cy + math.sin(a) * 8.6
        if i in (3, 8):
            continue
        if i == 6:  # fallen stone
            bm = bm_box(1.2, 0.6, 3.2)
            roughen(bm, rng, 0.05)
            xform(bm, (x, y, height(x, y) - 0.1), (math.pi / 2 - 0.08, 0, a + 0.4))
            g.add(bm, stone_color(C["stone"], height(x, y) - 0.2, 0.6))
            ox, oy = math.cos(a + 0.4 + math.pi / 2), math.sin(a + 0.4 + math.pi / 2)
            for t in (0.4, 1.4, 2.4):
                collide(x - ox * t, y - oy * t, 0.6)
            continue
        standing_stone(g, rng, x, y, 2.5 + rng.random() * 1.3, a + math.pi / 2)
        collide(x, y, 0.8)
    base = height(cx, cy)
    bm = bm_box(2.5, 1.3, 0.75)
    roughen(bm, rng, 0.03)
    xform(bm, (cx, cy, base - 0.1), (0, 0, 0.35))
    g.add(bm, stone_color(C["stone_dark"], base))
    collide(cx, cy, 1.35)


def column(g, rng, x, y, full, h):
    base = height(x, y)
    bm = bm_box(1.25, 1.25, 0.4)
    roughen(bm, rng, 0.03)
    xform(bm, (x, y, base - 0.18))
    g.add(bm, stone_color(C["stone_dark"], base))
    shaft = bm_prism(0.44, 0.38, h, 8)
    if not full:
        break_top(shaft, rng, 0.55)
    roughen(shaft, rng, 0.025)
    xform(shaft, (x, y, base + 0.2), (0, 0, rng.random()))
    g.add(shaft, stone_color(C["stone"], base))
    if full:
        cap = bm_box(1.2, 1.2, 0.38)
        xform(cap, (x, y, base + 0.2 + h))
        g.add(cap, stone_color(C["stone"], base))
    collide(x, y, 0.68)
    return base + 0.2 + h + (0.38 if full else 0)


def build_colonnade(g, rng):
    (ax, ay), (bx, by) = COLONNADE
    length = math.hypot(bx - ax, by - ay)
    ux, uy = (bx - ax) / length, (by - ay) / length
    along = math.atan2(uy, ux)
    pattern = [(True, 5.4), (False, 2.3), (True, 5.4), None, (False, 3.4), (True, 5.4), (False, 1.3), (True, 5.4)]
    tops = {}
    step = length / (len(pattern) - 1)
    for i, spec in enumerate(pattern):
        x, y = ax + ux * step * i, ay + uy * step * i
        if spec is None:  # toppled column: three drums in a line
            base = height(x, y)
            for k in range(3):
                d = bm_prism(0.42, 0.42, 1.5, 8)
                roughen(d, rng, 0.03)
                ox, oy = math.cos(along + 1.9) * (1.2 + 1.7 * k), math.sin(along + 1.9) * (1.2 + 1.7 * k)
                xform(d, (x + ox, y + oy, height(x + ox, y + oy) + 0.28), (math.pi / 2, 0, along + 1.9 + math.pi / 2 + rng.uniform(-0.2, 0.2)))
                g.add(d, stone_color(C["stone"], base, 0.6))
                collide(x + ox, y + oy, 0.65)
            continue
        tops[i] = column(g, rng, x, y, *spec)
    # architrave resting on columns 0 and 2
    if 0 in tops and 2 in tops:
        mx, my = ax + ux * step, ay + uy * step
        z = min(tops[0], tops[2])
        bm = bm_box(step * 2 + 1.3, 1.1, 0.7)
        roughen(bm, rng, 0.03)
        xform(bm, (mx, my, z), (0, 0, along))
        g.add(bm, stone_color(C["stone"], z - 1, 0.1))
    # fallen architrave near the broken end
    fx, fy = ax + ux * step * 5.5 + math.cos(along - 1.6) * 2.6, ay + uy * step * 5.5 + math.sin(along - 1.6) * 2.6
    bm = bm_box(4.6, 1.1, 0.7)
    roughen(bm, rng, 0.04)
    xform(bm, (fx, fy, height(fx, fy) - 0.2), (0.12, 0.05, along + 0.35))
    g.add(bm, stone_color(C["stone"], height(fx, fy), 0.6))
    for t in (-1.6, 0.0, 1.6):
        collide(fx + math.cos(along + 0.35) * t, fy + math.sin(along + 0.35) * t, 0.75)


def build_gate(g, rng):
    gx, gy = GATE
    rad = math.atan2(gy, gx)
    tx, ty = -math.sin(rad), math.cos(rad)    # tangent: pillars stand side by side, gate looks out to sea
    base = height(gx, gy)
    for s in (-1, 1):
        x, y = gx + tx * 2.3 * s, gy + ty * 2.3 * s
        bm = bm_box(0.95, 0.95, 5.6)
        roughen(bm, rng, 0.03)
        xform(bm, (x, y, height(x, y) - 0.35), (0, 0, rad))
        g.add(bm, stone_color(C["stone"], height(x, y)))
        collide(x, y, 0.72)
    bm = bm_box(1.0, 6.8, 0.8)
    roughen(bm, rng, 0.03)
    xform(bm, (gx, gy, base + 5.2), (0.035, 0, rad))
    g.add(bm, stone_color(C["stone"], base, 0.15))
    bm = bm_box(0.5, 5.0, 0.45)
    xform(bm, (gx, gy, base + 4.15), (0, 0, rad))
    g.add(bm, stone_color(C["stone_dark"], base, 0.1))


def build_tower(g, rng):
    cx, cy = TOWER
    segs, radius = 16, 3.5
    door = int(round(((math.atan2(SPAWN[1] - cy, SPAWN[0] - cx)) % (2 * math.pi)) / (2 * math.pi) * segs)) % segs
    phase = rng.random() * math.pi * 2
    for i in range(segs):
        if i == door:
            continue
        a = 2 * math.pi * i / segs
        x, y = cx + math.cos(a) * radius, cy + math.sin(a) * radius
        h = 1.6 + 8.0 * (0.5 + 0.5 * math.cos(a - phase)) ** 1.5 + rng.random() * 0.8
        bm = break_top(bm_box(2 * math.pi * radius / segs * 1.06, 0.75, h), rng, 0.6)
        roughen(bm, rng, 0.03)
        base = height(x, y)
        xform(bm, (x, y, base - 0.3), (0, 0, a + math.pi / 2))
        g.add(bm, stone_color(C["stone"], base))
        collide(x, y, 0.85)
    for k in range(6):   # rubble inside and around
        a = rng.random() * math.pi * 2
        r = rng.uniform(0.5, 6.5)
        x, y = cx + math.cos(a) * r, cy + math.sin(a) * r
        bm = bm_box(0.5 + rng.random() * 0.6, 0.4 + rng.random() * 0.4, 0.35 + rng.random() * 0.3)
        xform(bm, (x, y, height(x, y) - 0.1), (rng.uniform(-0.3, 0.3), rng.uniform(-0.3, 0.3), rng.random() * 3))
        g.add(bm, stone_color(C["stone"], height(x, y), 0.6))


def build_stairs(g, rng):
    sx, sy = STAIRS
    rad = math.atan2(sy, sx)                      # climb outward, toward the sea
    ux, uy = math.cos(rad), math.sin(rad)
    ref = height(sx, sy)
    steps = 12
    for k in range(steps):
        x, y = sx + ux * 0.52 * k, sy + uy * 0.52 * k
        ground = min(height(x, y), ref) - 0.6
        top = ref + (k + 1) * 0.34
        bm = bm_box(0.54, 2.4, top - ground)
        roughen(bm, rng, 0.02)
        xform(bm, (x, y, ground), (0, 0, rad))
        g.add(bm, stone_color(C["stone"], ref, 0.35))
        if k % 2 == 0:
            collide(x, y, 1.3)


def scatter(rng, count, min_h, avoid, fn):
    placed = 0
    tries = 0
    while placed < count and tries < count * 60:
        tries += 1
        a = rng.random() * math.pi * 2
        r = math.sqrt(rng.random()) * 100.0
        x, y = math.cos(a) * r, math.sin(a) * r
        h = height(x, y)
        if h < min_h:
            continue
        if any(math.hypot(x - ax, y - ay) < ar for (ax, ay), ar in avoid):
            continue
        if seg_dist(x, y, *COLONNADE)[0] < 7.0:
            continue
        fn(x, y, h)
        placed += 1


def build_flora_and_rocks(col, rng, mat):
    flora, rocks = Group("flora"), Group("rocks")
    avoid = [(SPAWN, 13.0), (CIRCLE, 14.5), (GATE, 9.0), (TOWER, 9.5), (STAIRS, 7.0)]

    def pine(x, y, h):
        s = 0.75 + rng.random() * 0.6
        bm = bm_prism(0.2 * s, 0.12 * s, 1.4 * s, 6)
        xform(bm, (x, y, h - 0.2))
        flora.add(bm, lambda c, n: jittered(C["bark"], c.z))
        for k, (rb, hh) in enumerate(((1.5, 1.9), (1.15, 1.7), (0.78, 1.5))):
            bm = bm_prism(rb * s, 0.05, hh * s, 7)
            roughen(bm, rng, 0.06 * s)
            xform(bm, (x, y, h + (1.0 + k * 1.05) * s), (0, 0, rng.random() * 3))
            flora.add(bm, lambda c, n, k=k: jittered(mix(C["pine_dark"], C["pine"], k / 2 + max(0, n.z) * 0.3), c.x + c.z))
        collide(x, y, 0.45 * s)

    def dead_tree(x, y, h):
        s = 0.8 + rng.random() * 0.5
        th = (4.0 + rng.random() * 2.0) * s
        tilt = (rng.uniform(-0.12, 0.12), rng.uniform(-0.12, 0.12), rng.random() * 3)
        bm = bm_prism(0.3 * s, 0.07 * s, th, 6)
        xform(bm, (x, y, h - 0.3), tilt)
        flora.add(bm, lambda c, n: jittered(C["bark"], c.z * 2))
        rot = Euler(tilt, "XYZ").to_matrix()
        for k in range(3):
            bz = th * (0.45 + 0.17 * k)
            origin = Vector((x, y, h - 0.3)) + rot @ Vector((0, 0, bz))
            length = (1.2 + rng.random() * 1.3) * s
            br = bm_prism(0.1 * s, 0.02, length, 5)
            xform(br, tuple(origin), (rng.uniform(0.6, 1.1), 0, k * 2.1 + rng.random()))
            flora.add(br, lambda c, n: jittered(C["bark"], c.x))
        collide(x, y, 0.4 * s)

    def rock(x, y, h):
        radius = 0.35 + rng.random() ** 2 * 2.0
        bm = bm_rock(radius, rng, 0.55 + rng.random() * 0.3)
        xform(bm, (x, y, h - radius * 0.15), (0, 0, rng.random() * 3))
        rocks.add(bm, lambda c, n: jittered(mix(C["rock"], C["moss"], max(0.0, n.z - 0.55) * 0.9), c.x * 1.3 + c.y + c.z))
        if radius > 0.5:
            collide(x, y, radius * 0.85)

    scatter(rng, 42, 1.6, avoid, pine)
    scatter(rng, 26, 1.3, avoid, dead_tree)
    scatter(rng, 75, 0.2, avoid, rock)
    return [flora.build(col, mat), rocks.build(col, mat)]


def build_world(stone_mat, ember_mat):
    col = fresh_collection("bruhchan_world")
    rng = random.Random(SEED)
    COLLIDERS.clear()
    heightmap = build_terrain(col, stone_mat)
    terrain = col.objects["terrain"]
    ruins = Group("ruins")
    build_plaza(ruins, rng)
    build_circle(ruins, rng)
    build_colonnade(ruins, rng)
    build_gate(ruins, rng)
    build_tower(ruins, rng)
    build_stairs(ruins, rng)
    ruins_obj = ruins.build(col, stone_mat)
    brazier_objs, fire = build_brazier(col, rng, stone_mat, ember_mat)
    nature = build_flora_and_rocks(col, rng, stone_mat)
    spawn = (SPAWN[0], SPAWN[1] - 4.0)
    to_circle = (CIRCLE[0] - spawn[0], -(CIRCLE[1] - spawn[1]))   # three.js XZ
    meta = {
        "version": 1,
        "seed": SEED,
        "water": 0.0,
        "radius": 112.0,
        "heightmap": heightmap,
        "spawn": {"pos": [spawn[0], round(height(*spawn), 2), -spawn[1]],
                  "yaw": round(math.atan2(to_circle[0], to_circle[1]), 4)},
        "fire": [round(fire[0], 2), round(fire[2], 2), round(-fire[1], 2)],
        "landmarks": {k: [round(v[0], 2), round(height(*v), 2), round(-v[1], 2)] for k, v in
                      (("circle", CIRCLE), ("gate", GATE), ("tower", TOWER), ("stairs", STAIRS), ("spawn", SPAWN))},
        "colliders": [[x, -y, r] for x, y, r in COLLIDERS],
    }
    return [terrain, ruins_obj, *brazier_objs, *nature], meta


# ---------------------------------------------------------------- thread marker

# Same lobes as public/img/emblem.svg (64×64 SVG space, y down).
FLAME = {
    "left": ((6, 16), [((13, 22), (25, 30), (25, 44)), ((25, 54), (20, 60), (14, 60)),
                       ((8, 60), (3, 54), (3, 45)), ((3, 34), (8, 27), (6, 16))]),
    "right": ((58, 16), [((51, 22), (39, 30), (39, 44)), ((39, 54), (44, 60), (50, 60)),
                         ((56, 60), (61, 54), (61, 45)), ((61, 34), (56, 27), (58, 16))]),
    "center": ((33, 3), [((36, 14), (47, 22), (47, 38)), ((47, 51), (40, 61), (32, 61)),
                         ((24, 61), (17, 51), (17, 38)), ((17, 25), (27, 18), (33, 3))]),
}


def bezier_outline(start, segments, samples=7):
    pts, p0 = [], start
    for c1, c2, p3 in segments:
        for i in range(samples):
            t = i / samples
            mt = 1 - t
            pts.append((mt ** 3 * p0[0] + 3 * mt * mt * t * c1[0] + 3 * mt * t * t * c2[0] + t ** 3 * p3[0],
                        mt ** 3 * p0[1] + 3 * mt * mt * t * c1[1] + 3 * mt * t * t * c2[1] + t ** 3 * p3[1]))
        p0 = p3
    return pts


def flame_prism(bm, outline, size, cz, y_face, depth):
    """Extrude an SVG-space outline out of a face lying in the XZ plane (front is −Y)."""
    front = [bm.verts.new(((sx - 32) / 64 * size, y_face - depth, cz + (32 - sy) / 64 * size)) for sx, sy in outline]
    back = [bm.verts.new(((sx - 32) / 64 * size, y_face + 0.01, cz + (32 - sy) / 64 * size)) for sx, sy in outline]
    bm.faces.new(front)
    bm.faces.new(list(reversed(back)))
    n = len(outline)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((front[i], front[j], back[j], back[i]))


def build_marker(stone_mat, rune_mat):
    col = fresh_collection("bruhchan_marker")
    rng = random.Random(SEED + 77)
    width, depth, tall = 0.95, 0.32, 1.95
    bm = bm_box(width, depth, tall)
    for v in bm.verts:
        if v.co.z > tall - 1e-4:
            v.co.x *= 0.88
            v.co.z += rng.uniform(-0.14, 0.03) + (0.08 if v.co.x < 0 else -0.04)
    bmesh.ops.bevel(bm, geom=list(bm.edges), offset=0.035, segments=1, profile=0.5, affect="EDGES")
    bmesh.ops.translate(bm, vec=(0, 0, -0.25), verts=bm.verts)   # planted 25 cm into the ground
    g = Group("marker_stone")
    g.add(bm, lambda c, n: jittered(mix(C["stone_dark"], C["moss"], smoothstep(0.35, -0.2, c.z) * 0.6), c.x * 4 + c.z * 3))
    for k in range(4):
        a = -math.pi / 2 + (k - 1.5) * 0.9
        r = bm_rock(0.12 + rng.random() * 0.1, rng, 0.6)
        xform(r, (math.cos(a) * 0.62, math.sin(a) * 0.42, 0.0))
        g.add(r, lambda c, n: jittered(C["rock"], c.x * 9))
    stone = g.build(col, stone_mat)
    rune_bm = bmesh.new()
    face_y = -depth / 2
    for name, d in (("left", 0.018), ("right", 0.018), ("center", 0.03)):
        start, segs = FLAME[name]
        flame_prism(rune_bm, bezier_outline(start, segs), 0.6, 1.02, face_y, d)
    bmesh.ops.recalc_face_normals(rune_bm, faces=rune_bm.faces)
    rune = mesh_object("rune", rune_bm, col, rune_mat)
    return [stone, rune]


# ---------------------------------------------------------------- wanderer


def build_wanderer(cloth_mat, glow_mat):
    col = fresh_collection("bruhchan_wanderer")
    rng = random.Random(SEED + 5)
    body = Group("wanderer_body")
    cloak = bm_prism(0.44, 0.18, 1.36, 10)
    for i, v in enumerate(sorted(cloak.verts, key=lambda v: math.atan2(v.co.y, v.co.x))):
        if v.co.z < 0.01:
            v.co.z += rng.random() * 0.09
            v.co.x *= 1.0 + (0.08 if i % 2 else -0.04)
            v.co.y *= 1.0 + (0.08 if i % 2 else -0.04)
    xform(cloak, (0, 0, 0.02))
    body.add(cloak, lambda c, n: mix(C["cloak_hem"], C["cloak"], smoothstep(0.1, 0.6, c.z)))
    mantle = bm_prism(0.3, 0.2, 0.22, 10)
    xform(mantle, (0, 0, 1.24))
    body.add(mantle, lambda c, n: C["cloak"])
    hood = bm_prism(0.26, 0.03, 0.66, 10)
    for v in hood.verts:
        v.co.y += (v.co.z / 0.66) ** 2 * 0.16     # tip droops backwards
    xform(hood, (0, 0.02, 1.3), (-0.12, 0, 0))
    body.add(hood, lambda c, n: shade(C["cloak"], 1.1))
    body_obj = body.build(col, cloth_mat)
    void = Group("wanderer_void")
    face = bmesh.new()
    bmesh.ops.create_icosphere(face, subdivisions=1, radius=0.15)
    xform(face, (0, -0.15, 1.52), scale=(0.95, 0.55, 1.2))
    void.add(face, lambda c, n: C["void"])
    void_obj = void.build(col, cloth_mat)
    glow = bmesh.new()
    for sx in (-0.055, 0.055):   # two faint embers for eyes
        eye = bm_box(0.04, 0.02, 0.028)
        xform(eye, (sx, -0.235, 1.53))
        bm_merge(glow, eye)
    lantern = bm_box(0.13, 0.13, 0.19)
    xform(lantern, (0.34, -0.14, 0.62))
    bm_merge(glow, lantern)
    glow_obj = mesh_object("glow", glow, col, glow_mat)
    frame = bm_box(0.17, 0.17, 0.03)
    xform(frame, (0.34, -0.14, 0.81))
    handle = bm_prism(0.012, 0.012, 0.28, 4)
    xform(handle, (0.34, -0.14, 0.84), (0, 0.35, 0))
    iron = Group("lantern_frame")
    iron.add(frame, lambda c, n: C["coal"])
    iron.add(handle, lambda c, n: C["coal"])
    iron_obj = iron.build(col, cloth_mat)
    return [body_obj, void_obj, glow_obj, iron_obj]


# ---------------------------------------------------------------- preview render (sanity check only)


def render_preview(path, meta):
    col = fresh_collection("bruhchan_preview")
    cam = bpy.data.objects.new("bc_cam", bpy.data.cameras.new("bc_cam"))
    col.objects.link(cam)
    sx, sy, sz = meta["spawn"]["pos"]
    eye = Vector((sx, -sz + 9.0, sy + 6.5))
    target = Vector((CIRCLE[0], CIRCLE[1], height(*CIRCLE) + 1.0))
    cam.location = eye
    cam.rotation_euler = (target - eye).to_track_quat("-Z", "Y").to_euler()
    cam.data.lens = 24
    sun = bpy.data.objects.new("bc_sun", bpy.data.lights.new("bc_sun", "SUN"))
    sun.data.energy = 3.0
    sun.rotation_euler = (math.radians(55), 0, math.radians(35))
    col.objects.link(sun)
    scene = bpy.context.scene
    scene.camera = cam
    if scene.world is None:
        scene.world = bpy.data.worlds.new("bc_world")
    wnt = scene.world.node_tree
    bg = next((n for n in wnt.nodes if n.type == "BACKGROUND"), None) if wnt else None
    if bg:
        bg.inputs["Color"].default_value = (*to_linear(hex_rgb("#9aa2a6")), 1.0)
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 12
    scene.cycles.device = "CPU"
    scene.render.resolution_x, scene.render.resolution_y = 1280, 720
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


# ---------------------------------------------------------------- main


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    stone = make_material("bc_vertex", vertex_colors=True)
    ember = make_material("bc_ember", base="#2a1208", emissive="#ff5a00", strength=3.0)
    rune = make_material("bc_rune", base="#3a1a00", emissive="#ff9900", strength=4.0, rough=0.6)
    glow = make_material("bc_glow", base="#402000", emissive="#ffa033", strength=3.0)

    world_objs, meta = build_world(stone, ember)
    export_glb(os.path.join(OUT_DIR, "world.glb"), world_objs)
    export_glb(os.path.join(OUT_DIR, "marker.glb"), build_marker(stone, rune))
    export_glb(os.path.join(OUT_DIR, "wanderer.glb"), build_wanderer(stone, glow))
    with open(os.path.join(OUT_DIR, "world.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, separators=(",", ":"))
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in world_objs)
    print(f"[bruhchan] world: {tris} tris, {len(meta['colliders'])} colliders, spawn {meta['spawn']}")
    print(f"[bruhchan] landmarks: {meta['landmarks']}")
    print(f"[bruhchan] assets written to {OUT_DIR}")
    if PREVIEW:
        render_preview(os.path.abspath(PREVIEW), meta)
        print(f"[bruhchan] preview: {PREVIEW}")


main()

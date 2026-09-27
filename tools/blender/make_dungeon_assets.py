# Dungeon Assault (jeu #4) — generation des 3 nouveaux assets low-poly (Blender 4.2 LTS headless)
# Sortie: assets/dungeon_key.glb, assets/dungeon_mage.glb, assets/dungeon_spikes.glb
# Conventions GameLoom: origine a la base (z=0 Blender -> y=0 glTF), 1 mesh par asset (join),
# transform_apply avant export, export_yup=True.

import bpy
import math
import os
from mathutils import Vector

OUT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'assets'))
os.makedirs(OUT, exist_ok=True)


def clean_scene():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for m in list(bpy.data.meshes):
        bpy.data.meshes.remove(m)
    for m in list(bpy.data.materials):
        bpy.data.materials.remove(m)


def make_mat(name, color, roughness=0.8, metallic=0.0, emission=None, emission_strength=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    if emission is not None:
        bsdf.inputs["Emission Color"].default_value = (*emission, 1.0)
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    return mat


def add_cube(name, size, loc, rot, mat):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.name = name
    o.scale = (size[0], size[1], size[2])
    o.data.materials.append(mat)
    apply_t(o)
    return o


def add_cyl(name, radius, depth, verts, loc, mat, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cylinder_add(radius=radius, depth=depth, vertices=verts, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.name = name
    o.data.materials.append(mat)
    apply_t(o)
    return o


def add_cone(name, radius, depth, verts, loc, mat, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cone_add(radius1=radius, radius2=0.0, depth=depth, vertices=verts, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.name = name
    o.data.materials.append(mat)
    apply_t(o)
    return o


def apply_t(o):
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def join_all(parts):
    bpy.ops.object.select_all(action='DESELECT')
    for p in parts:
        p.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    obj = bpy.context.active_object
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(island_margin=0.02)
    bpy.ops.object.mode_set(mode='OBJECT')
    return obj


def export_sel(obj, path):
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.context.scene.cursor.location = (0, 0, 0)
    bpy.ops.object.origin_set(type='ORIGIN_CURSOR')
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True,
        export_apply=True, export_materials='EXPORT', export_yup=True,
    )
    print("VERTS=%d" % len(obj.data.vertices))
    print("UV_LAYERS=%d" % len(obj.data.uv_layers))
    bb = [(obj.matrix_world @ Vector(c)) for c in obj.bound_box]
    xs = [v.x for v in bb]; ys = [v.y for v in bb]; zs = [v.z for v in bb]
    print("BBOX x[%.2f,%.2f] y[%.2f,%.2f] z[%.2f,%.2f]" % (min(xs), max(xs), min(ys), max(ys), min(zs), max(zs)))
    print("GLB_SIZE=%d" % os.path.getsize(path))


# ============================================================
# 1. DUNGEON KEY — cle doree sur socle (hauteur ~0.45 m)
# ============================================================
clean_scene()
gold = make_mat("KeyGold", (0.85, 0.70, 0.20), roughness=0.3, metallic=0.9)
dark = make_mat("KeyStone", (0.22, 0.20, 0.18), roughness=0.85)

parts = []
parts.append(add_cyl("key_base", 0.16, 0.05, 12, (0, 0, 0.025), dark))
bpy.ops.mesh.primitive_torus_add(major_radius=0.11, minor_radius=0.035, major_segments=12, minor_segments=6,
                                 location=(0, 0, 0.24), rotation=(0, math.pi / 2, 0))
t = bpy.context.active_object
t.name = "key_ring"
t.data.materials.append(gold)
apply_t(t)
parts.append(t)
parts.append(add_cube("key_shaft", (0.30, 0.05, 0.05), (0.24, 0, 0.24), (0, 0, 0), gold))
parts.append(add_cube("key_tooth1", (0.05, 0.05, 0.10), (0.30, 0, 0.32), (0, 0, 0), gold))
parts.append(add_cube("key_tooth2", (0.04, 0.04, 0.08), (0.36, 0, 0.30), (0, 0, 0), gold))

k = join_all(parts)
export_sel(k, os.path.join(OUT, 'dungeon_key.glb'))
print("KEY_OK")

# ============================================================
# 2. DUNGEON MAGE — ennemi a distance en robe (hauteur ~1.75 m)
# ============================================================
clean_scene()
robe = make_mat("MageRobe", (0.32, 0.18, 0.48), roughness=0.85)
hood = make_mat("MageHood", (0.20, 0.12, 0.32), roughness=0.9)
face = make_mat("MageFace", (0.12, 0.10, 0.14), roughness=0.9)
eye = make_mat("MageEye", (0.30, 0.90, 1.00), roughness=0.3, emission=(0.3, 0.9, 1.0), emission_strength=2.0)
wood = make_mat("MageStaff", (0.35, 0.25, 0.15), roughness=0.8)

parts = []
parts.append(add_cone("robe", 0.45, 1.15, 8, (0, 0, 0.575), robe))
parts.append(add_cone("hood", 0.22, 0.30, 8, (0, 0, 1.30), hood))
bpy.ops.mesh.primitive_uv_sphere_add(segments=10, ring_count=6, radius=0.13, location=(0, 0, 1.28))
s = bpy.context.active_object
s.name = "head"
s.data.materials.append(face)
apply_t(s)
parts.append(s)
parts.append(add_cube("eyes", (0.16, 0.04, 0.05), (0, 0.11, 1.30), (0, 0, 0), eye))
parts.append(add_cyl("staff", 0.03, 1.5, 8, (0.45, 0, 0.75), wood))
bpy.ops.mesh.primitive_uv_sphere_add(segments=10, ring_count=6, radius=0.09, location=(0.45, 0, 1.55))
o = bpy.context.active_object
o.name = "orb"
o.data.materials.append(eye)
apply_t(o)
parts.append(o)

m = join_all(parts)
export_sel(m, os.path.join(OUT, 'dungeon_mage.glb'))
print("MAGE_OK")

# ============================================================
# 3. DUNGEON SPIKES — piege de sol, tapis 3x3 (hauteur ~0.39 m)
# ============================================================
clean_scene()
spike_metal = make_mat("SpikeMetal", (0.25, 0.26, 0.28), roughness=0.5, metallic=0.7)
base_stone = make_mat("SpikeBase", (0.30, 0.28, 0.26), roughness=0.9)

parts = []
parts.append(add_cube("spike_base", (3.0, 3.0, 0.05), (0, 0, 0.025), (0, 0, 0), base_stone))
i = 0
for gx in (-1.0, 0.0, 1.0):
    for gz in (-1.0, 0.0, 1.0):
        parts.append(add_cone("spike_%d" % i, 0.22, 0.34, 6, (gx, 0, 0.22), spike_metal))
        i += 1

sp = join_all(parts)
export_sel(sp, os.path.join(OUT, 'dungeon_spikes.glb'))
print("SPIKES_OK")

print("DUNGEON_ASSETS_OK")

# Ruins Raid (jeu #3) — generation des 3 nouveaux assets low-poly (Blender 4.2 LTS headless)
# Sortie: assets/guardian.glb, assets/artifact.glb, assets/ruins_column.glb
# Conventions GameLoom: origine a la base (z=0 Blender -> y=0 glTF), 1 mesh par asset,
# transform_apply avant export, export_yup=True.

import bpy
import os

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
    bb = [ (obj.matrix_world @ Vector(c)) for c in obj.bound_box ]
    xs = [v.x for v in bb]; ys = [v.y for v in bb]; zs = [v.z for v in bb]
    print("BBOX x[%.2f,%.2f] y[%.2f,%.2f] z[%.2f,%.2f]" % (min(xs), max(xs), min(ys), max(ys), min(zs), max(zs)))
    print("GLB_SIZE=%d" % os.path.getsize(path))


from mathutils import Vector

# ============================================================
# 1. GUARDIAN — golem de pierre (hauteur ~1.75 m, face vers +Y)
# ============================================================
clean_scene()
stone = make_mat("GuardianStone", (0.40, 0.38, 0.35), roughness=0.9)
dark = make_mat("GuardianDark", (0.20, 0.19, 0.18), roughness=0.85)
eye = make_mat("GuardianEye", (0.95, 0.55, 0.08), roughness=0.4, emission=(1.0, 0.58, 0.08), emission_strength=2.5)

parts = []
# jambes (2 blocs)
parts.append(add_cube("leg_l", (0.30, 0.32, 0.55), (-0.26, 0, 0.275), (0, 0, 0), dark))
parts.append(add_cube("leg_r", (0.30, 0.32, 0.55), (0.26, 0, 0.275), (0, 0, 0), dark))
# bassin + torse
parts.append(add_cube("pelvis", (0.62, 0.40, 0.24), (0, 0, 0.60), (0, 0, 0), stone))
parts.append(add_cube("torso", (0.85, 0.55, 0.70), (0, 0, 1.05), (0, 0, 0), stone))
# epaules + bras (2 blocs de chaque cote)
parts.append(add_cube("sh_l", (0.26, 0.44, 0.24), (-0.56, 0, 1.30), (0, 0, 0), dark))
parts.append(add_cube("sh_r", (0.26, 0.44, 0.24), (0.56, 0, 1.30), (0, 0, 0), dark))
parts.append(add_cube("arm_l", (0.24, 0.40, 0.58), (-0.58, 0, 0.95), (0, 0, 0), stone))
parts.append(add_cube("arm_r", (0.24, 0.40, 0.58), (0.58, 0, 0.95), (0, 0, 0), stone))
# tete + visiere (yeux)
parts.append(add_cube("head", (0.50, 0.50, 0.40), (0, 0, 1.62), (0, 0, 0), stone))
parts.append(add_cube("visor", (0.36, 0.10, 0.12), (0, 0.24, 1.65), (0, 0, 0), eye))
# coeur lumineux (poitrine, face avant +Y)
parts.append(add_cube("core", (0.20, 0.12, 0.20), (0, 0.27, 1.08), (0, 0, 0), eye))

g = join_all(parts)
export_sel(g, os.path.join(OUT, 'guardian.glb'))
print("GUARDIAN_OK")

# ============================================================
# 2. ARTIFACT — cristal sur socle (hauteur ~1.15 m)
# ============================================================
clean_scene()
base_stone = make_mat("ArtifactStone", (0.28, 0.26, 0.25), roughness=0.85)
trim = make_mat("ArtifactTrim", (0.55, 0.45, 0.20), roughness=0.4, metallic=0.8)
crystal = make_mat("ArtifactCrystal", (0.15, 0.85, 0.95), roughness=0.2,
                   emission=(0.2, 0.9, 1.0), emission_strength=1.8)

parts = []
# socle (3 marches)
parts.append(add_cube("base", (0.70, 0.70, 0.14), (0, 0, 0.07), (0, 0, 0), base_stone))
parts.append(add_cube("step2", (0.56, 0.56, 0.14), (0, 0, 0.21), (0, 0, 0), base_stone))
parts.append(add_cube("step3", (0.42, 0.42, 0.14), (0, 0, 0.35), (0, 0, 0), trim))
# anneau orne autour du cristal
bpy.ops.mesh.primitive_torus_add(major_radius=0.30, minor_radius=0.045, major_segments=16, minor_segments=8,
                                 location=(0, 0, 0.52))
t = bpy.context.active_object
t.name = "ring"
t.data.materials.append(trim)
apply_t(t)
parts.append(t)
# cristal: bipyramide hexagonale (2 cones emboites)
parts.append(add_cone("crystal_top", 0.30, 0.55, 6, (0, 0, 0.85), crystal))          # pointe vers le haut (base 0.575, tip 1.125)
parts.append(add_cone("crystal_bot", 0.30, 0.30, 6, (0, 0, 0.42), crystal, rot=(3.14159, 0, 0)))  # pointe vers le bas

a = join_all(parts)
export_sel(a, os.path.join(OUT, 'artifact.glb'))
print("ARTIFACT_OK")

# ============================================================
# 3. RUINS COLUMN — colonne brisee (hauteur ~3.0 m)
# ============================================================
clean_scene()
sand = make_mat("ColumnSand", (0.60, 0.53, 0.42), roughness=0.9)
dark_stone = make_mat("ColumnDark", (0.40, 0.37, 0.32), roughness=0.95)

parts = []
# base (2 blocs)
parts.append(add_cube("col_base", (1.10, 1.10, 0.35), (0, 0, 0.175), (0, 0, 0), dark_stone))
parts.append(add_cube("col_drum_bottom", (0.95, 0.95, 0.25), (0, 0, 0.475), (0, 0, 0), sand))
# fust (cylindre cannelé: cylindre + 6 gouttieres verticales)
parts.append(add_cyl("col_shaft", 0.36, 1.90, 12, (0, 0, 1.60), sand))
for i in range(6):
    import math
    ang = i * (2 * math.pi / 6)
    x, y = 0.365 * math.cos(ang), 0.365 * math.sin(ang)
    parts.append(add_cube("flute_%d" % i, (0.09, 0.09, 1.90), (x, y, 1.60), (0, 0, 0), dark_stone))
# chapiteau (bloc + chute legerement etroite)
parts.append(add_cube("col_cap", (0.95, 0.95, 0.28), (0, 0, 2.72), (0, 0, 0), sand))
parts.append(add_cube("cap_eaves", (1.15, 1.15, 0.16), (0, 0, 2.96), (0, 0, 0), dark_stone))
# sommet brise: fragment incline + eclat
parts.append(add_cube("col_broken", (0.55, 0.55, 0.30), (0.22, 0.10, 3.10), (0.25, 0.35, 0.10), sand))
parts.append(add_cube("col_shard", (0.28, 0.24, 0.22), (-0.18, 0.30, 3.05), (0.5, 0.2, 0.4), dark_stone))

c = join_all(parts)
export_sel(c, os.path.join(OUT, 'ruins_column.glb'))
print("COLUMN_OK")

print("RUINS_ASSETS_OK")

# Caisse de munitions — 3 variantes visuelles (FPS, comparaison)
# Sortie: assets/ammo_military.glb, assets/ammo_scifi.glb, assets/ammo_industrial.glb
# Origine a la base (z=0 Blender) → y=0 glTF (export_yup=True) · 1 mesh par asset (join)
# Blender 4.2.23 LTS headless — pattern: tools/blender/make_assets.py

import bpy
import os
import math

OUT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'assets'))
os.makedirs(OUT, exist_ok=True)

def clean_scene():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for m in list(bpy.data.meshes): bpy.data.meshes.remove(m)
    for m in list(bpy.data.materials): bpy.data.materials.remove(m)

def make_mat(name, color, roughness=0.8, metallic=0.0, emission=None):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    b = mat.node_tree.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value = (*color, 1.0)
    b.inputs["Roughness"].default_value = roughness
    b.inputs["Metallic"].default_value = metallic
    if emission is not None:
        b.inputs["Emission Color"].default_value = (*emission, 1.0)
        b.inputs["Emission Strength"].default_value = 1.0
    return mat

def box(name, size, loc, mat, rot=(0.0, 0.0, 0.0)):
    bpy.ops.object.select_all(action='DESELECT')
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.name = name
    o.scale = (size[0], size[1], size[2])
    o.data.materials.append(mat)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return o

def cyl(name, radius, depth, verts, loc, mat, rot=(0.0, 0.0, 0.0)):
    bpy.ops.object.select_all(action='DESELECT')
    bpy.ops.mesh.primitive_cylinder_add(radius=radius, depth=depth, vertices=verts,
                                        location=loc, rotation=rot)
    o = bpy.context.active_object
    o.name = name
    o.data.materials.append(mat)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return o

def bevel(o, offset):
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.bevel(offset=offset, segments=1)
    bpy.ops.object.mode_set(mode='OBJECT')

def join_all(parts):
    bpy.ops.object.select_all(action='DESELECT')
    for p in parts: p.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    return bpy.context.view_layer.objects.active

def export_sel(path):
    o = bpy.context.view_layer.objects.active
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.context.scene.cursor.location = (0, 0, 0)
    bpy.ops.object.origin_set(type='ORIGIN_CURSOR')
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True,
        export_apply=True, export_materials='EXPORT', export_yup=True,
    )
    print("VERTS=%d" % len(o.data.vertices))
    print("GLB_SIZE=%d" % os.path.getsize(path))

# =====================================================================
# 1. MILITAIRE MODERNE — mat, olive, coins renforces, marquages tampon
# =====================================================================
clean_scene()
olive    = make_mat("MilOlive",     (0.26, 0.29, 0.16), 0.85)
dolive   = make_mat("MilDarkOlive", (0.15, 0.17, 0.09), 0.80)
rust     = make_mat("MilRust",      (0.23, 0.15, 0.09), 0.70, 0.30)
tan      = make_mat("MilStencil",   (0.70, 0.64, 0.45), 0.90)

body = box("body", (0.85, 0.55, 0.42), (0, 0, 0.21), olive)
bevel(body, 0.02)
parts = [body]
parts.append(box("lid", (0.90, 0.60, 0.09), (0, 0, 0.465), dolive))
for sx in (-1, 1):
    for sy in (-1, 1):
        parts.append(box("rib_%d_%d" % (sx, sy), (0.08, 0.08, 0.44),
                         (sx * 0.405, sy * 0.255, 0.21), dolive))
for sx in (-1, 1):
    parts.append(box("handle_%d" % sx, (0.02, 0.16, 0.07), (sx * 0.428, 0, 0.40), rust))
parts.append(box("stencil_1", (0.30, 0.014, 0.05), (-0.16, -0.278, 0.32), tan))
parts.append(box("stencil_2", (0.18, 0.014, 0.05), (0.20, -0.278, 0.32), tan))
parts.append(box("stencil_3", (0.05, 0.014, 0.16), (0.30, -0.278, 0.22), tan))
o = join_all(parts)
export_sel(os.path.join(OUT, 'ammo_military.glb'))
print("MILITARY_OK")

# =====================================================================
# 2. SCIENCE-FICTION — lisse, hexagonal, blanc/gunmetal, lueurs cyan
# =====================================================================
clean_scene()
hull     = make_mat("SfHull",     (0.82, 0.86, 0.90), 0.35)
gunmetal = make_mat("SfGunmetal", (0.09, 0.11, 0.14), 0.45, 0.85)
cyan     = make_mat("SfGlow",     (0.00, 0.35, 0.45), 0.30, 0.0, emission=(0.05, 0.85, 1.00))

rz = math.radians(30)
body = cyl("body", 0.42, 0.40, 6, (0, 0, 0.24), hull, rot=(0, 0, rz))
parts = [body]
parts.append(cyl("base", 0.44, 0.06, 6, (0, 0, 0.03), gunmetal, rot=(0, 0, rz)))
parts.append(cyl("top", 0.44, 0.07, 6, (0, 0, 0.455), hull, rot=(0, 0, rz)))
parts.append(cyl("groove", 0.425, 0.05, 6, (0, 0, 0.10), gunmetal, rot=(0, 0, rz)))
parts.append(cyl("glowband", 0.425, 0.025, 6, (0, 0, 0.40), cyan, rot=(0, 0, rz)))
# embleme avant (face -Y): apotheme hexagone = 0.42 * cos(30 deg) = 0.364
parts.append(cyl("ring", 0.14, 0.015, 24, (0, -0.365, 0.26), gunmetal, rot=(math.radians(90), 0, 0)))
parts.append(cyl("emblem", 0.10, 0.02, 24, (0, -0.368, 0.26), cyan, rot=(math.radians(90), 0, 0)))
# fentes de ventilation (face +Y)
for i, vx in enumerate((-0.14, 0.0, 0.14)):
    for j, vz in enumerate((0.19, 0.25, 0.31)):
        parts.append(box("vent_%d_%d" % (i, j), (0.09, 0.014, 0.03), (vx, 0.368, vz), gunmetal))
# greebles sur le capot
for sx in (-1, 1):
    for sy in (-1, 1):
        parts.append(box("greeble_%d_%d" % (sx, sy), (0.06, 0.06, 0.03),
                         (sx * 0.28, sy * 0.16, 0.475), gunmetal))
# ports lateraux
for sx in (-1, 1):
    parts.append(cyl("port_%d" % sx, 0.05, 0.03, 12, (sx * 0.368, 0, 0.15),
                     gunmetal, rot=(math.radians(90), 0, 0)))
o = join_all(parts)
export_sel(os.path.join(OUT, 'ammo_scifi.glb'))
print("SCIFI_OK")

# =====================================================================
# 3. INDUSTRIEL / RECUPERE — rouille, boite boitee, tuyau, chevrons
# =====================================================================
clean_scene()
rust      = make_mat("IndRust",      (0.40, 0.19, 0.09), 0.95)
patch     = make_mat("IndPatch",     (0.30, 0.27, 0.24), 0.85, 0.40)
darksteel = make_mat("IndDarkSteel", (0.13, 0.12, 0.11), 0.80)
yellow    = make_mat("IndHazardY",   (0.75, 0.55, 0.04), 0.80)
black     = make_mat("IndHazardB",   (0.06, 0.06, 0.06), 0.90)

body = box("body", (0.90, 0.60, 0.48), (0, 0, 0.26), rust)
bevel(body, 0.015)
parts = [body]
# couvercle boite (decale + leve)
parts.append(box("lid", (0.86, 0.58, 0.09), (0.03, 0, 0.565), patch, rot=(0, 0, math.radians(2.5))))
# plaques de tôle avant
parts.append(box("patch_1", (0.26, 0.014, 0.18), (0.15, -0.307, 0.30), patch))
parts.append(box("patch_2", (0.18, 0.014, 0.12), (-0.458, -0.15, 0.20), patch,
                 rot=(0, math.radians(90), 0)))
# boulons avant
for sx in (-1, 1):
    parts.append(cyl("bolt_%d" % sx, 0.04, 0.05, 8, (sx * 0.36, -0.315, 0.45),
                     darksteel, rot=(math.radians(90), 0, 0)))
# plaques de renfort laterales (levees)
parts.append(box("brace_1", (0.016, 0.50, 0.14), (0.458, 0.05, 0.30), darksteel,
                 rot=(0, 0, math.radians(6))))
parts.append(box("brace_2", (0.016, 0.44, 0.12), (-0.458, 0.12, 0.34), darksteel,
                 rot=(0, 0, math.radians(-4))))
# tuyau sur l'arriere + colliers
parts.append(cyl("pipe", 0.045, 0.78, 10, (0, 0.33, 0.36), darksteel, rot=(0, math.radians(90), 0)))
for sx in (-1, 1):
    parts.append(box("clamp_%d" % sx, (0.08, 0.10, 0.12), (sx * 0.25, 0.33, 0.36), patch))
# chevrons de signalisation (avant bas)
for i, vx in enumerate((-0.15, 0.0, 0.15)):
    parts.append(box("chev_%d" % i, (0.10, 0.014, 0.05), (vx, -0.307, 0.10),
                     yellow if i % 2 == 0 else black))
# clips du couvercle
for sx in (-1, 1):
    parts.append(box("latch_%d" % sx, (0.07, 0.03, 0.05), (sx * 0.20 + 0.03, -0.29, 0.585),
                     darksteel, rot=(0, 0, math.radians(2.5))))
o = join_all(parts)
export_sel(os.path.join(OUT, 'ammo_industrial.glb'))
print("INDUSTRIAL_OK")

print("AMMO_VARIANTS_OK",
      [f for f in ('ammo_military.glb', 'ammo_scifi.glb', 'ammo_industrial.glb')
       if os.path.exists(os.path.join(OUT, f))])

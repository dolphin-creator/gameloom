# Barrel Blaster — génération des 3 assets low-poly (Blender 4.2.3 headless)
# Sortie: assets/crate.glb, assets/barrel.glb, assets/target.glb
# Origine: bas de l'objet à y=0 (Blender) → bas à z=0 (glTF/three.js)

import bpy
import os

OUT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'assets'))
os.makedirs(OUT, exist_ok=True)

def clean_scene():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for m in list(bpy.data.meshes): bpy.data.meshes.remove(m)
    for m in list(bpy.data.materials): bpy.data.materials.remove(m)

def make_mat(name, color, roughness=0.8):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    return mat

def export_sel(path):
    # origine à la base de l'objet (z=0) → espace local exploitable directement
    bpy.context.scene.cursor.location = (0, 0, 0)
    bpy.ops.object.origin_set(type='ORIGIN_CURSOR')
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True,
        export_apply=True, export_materials='EXPORT', export_yup=True,
    )

# ---------- 1. CRATE (caisse 1.5m) ----------
clean_scene()
mat = make_mat("Wood", (0.55, 0.38, 0.20), 0.85)
bpy.ops.mesh.primitive_cube_add(size=1.5, location=(0, 0, 0.75))
obj = bpy.context.active_object
obj.data.materials.append(mat)
# arêtes: bevel léger pour le low-poly
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.bevel(offset=0.03, segments=1)
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.select_all(action='DESELECT')
obj.select_set(True)
bpy.context.view_layer.objects.active = obj
export_sel(os.path.join(OUT, 'crate.glb'))

# ---------- 2. BARIL (0.9m) ----------
clean_scene()
mat = make_mat("BarrelRed", (0.65, 0.16, 0.10), 0.6)
bpy.ops.mesh.primitive_cylinder_add(radius=0.45, depth=0.9, location=(0, 0, 0.45), vertices=14)
obj = bpy.context.active_object
obj.data.materials.append(mat)
# 2 bandes métalliques (torus aplatis)
mat2 = make_mat("Band", (0.25, 0.27, 0.30), 0.4)
for h in (0.22, 0.68):
    bpy.ops.mesh.primitive_torus_add(major_radius=0.455, minor_radius=0.03, location=(0, 0, h), major_segments=14, minor_segments=6)
    t = bpy.context.active_object
    t.data.materials.append(mat2)
    t.select_set(True)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.join()
bpy.ops.object.select_all(action='DESELECT')
obj.select_set(True)
bpy.context.view_layer.objects.active = obj
export_sel(os.path.join(OUT, 'barrel.glb'))

# ---------- 3. TARGET (cible 1.0m) ----------
clean_scene()
mat = make_mat("TargetRed", (0.80, 0.18, 0.15), 0.7)
bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, 0, 0.5))
obj = bpy.context.active_object
obj.data.materials.append(mat)
mat2 = make_mat("TargetWhite", (0.92, 0.92, 0.90), 0.7)
bpy.ops.mesh.primitive_cube_add(size=0.6, location=(0, 0, 0.56))
t = bpy.context.active_object
t.data.materials.append(mat2)
t.select_set(True)
obj.select_set(True)
bpy.context.view_layer.objects.active = obj
bpy.ops.object.join()
bpy.ops.object.select_all(action='DESELECT')
obj.select_set(True)
bpy.context.view_layer.objects.active = obj
export_sel(os.path.join(OUT, 'target.glb'))

print("ASSETS_OK", [f for f in ('crate.glb', 'barrel.glb', 'target.glb') if os.path.exists(os.path.join(OUT, f))])

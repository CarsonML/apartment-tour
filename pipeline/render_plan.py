"""Top-down orthographic render of the flat, for the minimap.

Ceilings (and anything above 2.35 m) are hidden first, otherwise the
camera just sees the underside of the ceiling.  Prints the exact world
extent it covered -- make_plan.py needs those numbers to map viewpoints
onto the image.
"""
import bpy, os, sys, math
sc=bpy.context.scene
OUT=os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','raw','plan')
os.makedirs(OUT,exist_ok=True)
prefs=bpy.context.preferences.addons['cycles'].preferences
prefs.compute_device_type='METAL'; prefs.get_devices()
for d in prefs.devices: d.use=(d.type=='METAL')
cy=sc.cycles; cy.device='GPU'; cy.samples=96; cy.adaptive_threshold=0.015
cy.use_adaptive_sampling=True; cy.use_denoising=True; cy.denoiser='OPENIMAGEDENOISE'

hidden=0
for o in bpy.data.objects:
    if o.type!='MESH': continue
    nm=o.name.lower()
    zmin=min((o.matrix_world @ v.co).z for v in o.data.vertices) if len(o.data.vertices)<20000 else 0
    if 'ceiling' in nm or zmin>2.35:
        o.hide_render=True; hidden+=1
print("hidden for plan:", hidden, file=sys.stderr)

# top-down ortho covering the apartment footprint
cd=bpy.data.cameras.new("PLAN"); cd.type='ORTHO'; cd.clip_start=0.1; cd.clip_end=40
cd.ortho_scale=11.6
co=bpy.data.objects.new("PLAN",cd); sc.collection.objects.link(co); sc.camera=co
CX,CY=5.05,1.15
co.location=(CX,CY,8.0); co.rotation_euler=(0,0,0)
W=1856; H=int(W*(6.0/11.6))
sc.render.resolution_x=W; sc.render.resolution_y=H; sc.render.resolution_percentage=100
sc.render.image_settings.file_format='PNG'
sc.render.filepath=os.path.join(OUT,"plan_ortho")
bpy.ops.render.render(write_still=True)
# record exact world->image mapping
half_w=cd.ortho_scale/2.0; half_h=half_w*H/W
print(f"PLANMAP x0={CX-half_w} x1={CX+half_w} y0={CY-half_h} y1={CY+half_h} w={W} h={H}", file=sys.stderr)

"""Raycast the scene at 5 cm to find where a person can stand.

Writes pipeline/occupancy.json: an `interior` mask (floor below, ceiling
above, real headroom) and a `free` mask (nothing within 30 cm at eye and
chest height).  place_nodes.py snaps viewpoints onto the free mask.
"""
import bpy, json, math, sys, os
from mathutils import Vector
dg = bpy.context.evaluated_depsgraph_get(); sc = bpy.context.scene

# CRITICAL: objects hidden in viewport are invisible to ray_cast but still render.
fixed=0
for o in bpy.data.objects:
    if o.type=='MESH' and not o.hide_render:
        try:
            if o.hide_get(): o.hide_set(False); fixed+=1
        except: pass
    o.hide_viewport=False
dg = bpy.context.evaluated_depsgraph_get()
print("unhid", fixed, file=sys.stderr)

X0,Y0,STEP = -1.0,-2.0,0.05
NX,NY = 240,120
EYE=1.55
rc = sc.ray_cast

interior=[[0]*NX for _ in range(NY)]
free=[[0]*NX for _ in range(NY)]
DIRS8=[(math.cos(2*math.pi*k/8),math.sin(2*math.pi*k/8),0.0) for k in range(8)]
DOWN=Vector((0,0,-1)); UP=Vector((0,0,1))

for j in range(NY):
    y=Y0+(j+0.5)*STEP
    for i in range(NX):
        x=X0+(i+0.5)*STEP
        o=Vector((x,y,1.20))
        hd=rc(dg,o,DOWN,distance=3.0)
        if not hd[0]: continue
        fz=hd[1].z
        if fz<-0.30 or fz>0.45: continue
        hu=rc(dg,o,UP,distance=4.0)
        if not hu[0]: continue
        if not (1.90 <= hu[1].z-fz <= 3.30): continue
        interior[j][i]=1
        # free = camera body fits: nothing within 30cm at eye height or chest height
        ok=True
        for z in (EYE, 1.00):
            p=Vector((x,y,z))
            for d in DIRS8:
                if rc(dg,p,Vector(d),distance=0.30)[0]: ok=False; break
            if not ok: break
        free[j][i]=1 if ok else 0
    if j%20==0: print("row",j,file=sys.stderr)

ai=sum(map(sum,interior)); af=sum(map(sum,free))
print(f"interior {ai*STEP*STEP:.2f} m2 | free {af*STEP*STEP:.2f} m2", file=sys.stderr)
json.dump(dict(x0=X0,y0=Y0,step=STEP,nx=NX,ny=NY,eye=EYE,interior=interior,free=free),
          open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "occupancy.json"), "w"))

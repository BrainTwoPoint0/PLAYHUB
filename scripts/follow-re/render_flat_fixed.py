"""Framing FIX demo: same clip, OURS baseline framing | OURS flat (tighter fov) | SPIIDEO.
Aim = reg (Spiideo's actual aim) so ONLY the framing change is visible, not the follow aim.
FLAT policy: fov_flat = clip(fov_reg - FOVCUT, 16, 34). Window around t=47.
"""
import json, glob, numpy as np, cv2
from scipy.spatial import cKDTree
import mesh_dewarp as MD
G8="b923d40f"; WOFF=900
RAW=glob.glob(f"/tmp/follow-pair/raw_{G8}*_s{WOFF}.mp4")[0]; PLAY=glob.glob(f"/tmp/follow-pair/play_{G8}*_s{WOFF}.mp4")[0]
reg=json.load(open(f"/tmp/imitation/reg_{G8}.json")); rt=np.array(reg["t"]); rpx=np.array(reg["pano_x"]); rpy=np.array(reg["pano_y"]); fw=np.array(reg["footw"])
W,H=640,360; FOVCUT=8
projs,_=MD.load_mesh("/tmp/follow-pair/mesh")
UV=np.vstack([p["uv"] for p in projs]); WORLD=np.vstack([p["world"] for p in projs]); RAYN=WORLD[:,:2]/WORLD[:,2:3]; uvt=cKDTree(UV)
def u2pt(u,v): rn=RAYN[uvt.query([[u,v]])[1][0]]; x,y=float(rn[0]),float(rn[1]); n=np.sqrt(x*x+y*y+1); return np.degrees(np.arctan2(-x,1)),np.degrees(-np.arcsin(y/n))
def render(rawf,pan,tilt,fov):
    u,v=MD.bake_uv_map(projs,np.radians(pan),np.radians(tilt),fov,W,H); th,tw=rawf.shape[:2]
    m1=(u*tw).astype("f4"); m2=(v*th).astype("f4"); m1[u<0]=-1; m2[u<0]=-1; return cv2.remap(rawf,m1,m2,cv2.INTER_LINEAR)
def sm(a,k=7): return np.convolve(a,np.ones(k)/k,"same")
T0,T1=38.0,56.0
mask=(rt>=T0)&(rt<=T1); idx=np.where(mask)[0]
pan=np.array([u2pt(rpx[i],rpy[i])[0] for i in idx]); tilt=np.array([u2pt(rpx[i],rpy[i])[1] for i in idx])
fov=np.clip(fw[idx]*95,20,46)
pan=sm(pan); tilt=sm(tilt); fov=sm(fov); fovflat=np.clip(fov-FOVCUT,16,34)
tt=rt[idx]
capr=cv2.VideoCapture(RAW); capp=cv2.VideoCapture(PLAY); fps=capp.get(5) or 25
vw=cv2.VideoWriter("/tmp/imitation/flat_fixed.mp4",cv2.VideoWriter_fourcc(*"mp4v"),fps,(W*3,H+26))
def lab(im,t,c): cv2.rectangle(im,(0,0),(W,26),(0,0,0),-1); cv2.putText(im,t,(6,18),cv2.FONT_HERSHEY_SIMPLEX,0.5,c,1); return im
n=0
for fi in range(int(T0*fps),int(T1*fps)):
    capr.set(1,fi); okr,rf=capr.read(); capp.set(1,fi); okp,pf=capp.read()
    if not okr: break
    ct=fi/fps
    pn=np.interp(ct,tt,pan); tl=np.interp(ct,tt,tilt); fv=np.interp(ct,tt,fov); fvf=np.interp(ct,tt,fovflat)
    a=lab(render(rf,pn,tl,fv),f"OURS baseline fov{fv:.0f}",(120,255,120))
    b=lab(render(rf,pn,tl,fvf),f"OURS FLAT fov{fvf:.0f} (fix)",(0,255,255))
    c=lab(cv2.resize(pf,(W,H)) if okp else np.zeros((H,W,3),np.uint8),"SPIIDEO Play",(210,210,210))
    fr=np.vstack([np.zeros((26,W*3,3),np.uint8),np.hstack([a[26:],b[26:],c[26:]])])
    # redo labels on final composite bars
    fr=np.hstack([lab(render(rf,pn,tl,fv),f"OURS baseline fov{fv:.0f}",(120,255,120)),
                  lab(render(rf,pn,tl,fvf),f"OURS FLAT fov{fvf:.0f} (fix)",(0,255,255)),
                  lab(cv2.resize(pf,(W,H)) if okp else np.zeros((H,W,3),np.uint8),"SPIIDEO Play",(210,210,210))])
    vw.write(np.vstack([np.zeros((26,W*3,3),np.uint8),fr])[:H+26]) if False else vw.write(cv2.copyMakeBorder(fr,26,0,0,0,cv2.BORDER_CONSTANT)[:H+26])
    n+=1
    if fi==int(47*fps): cv2.imwrite("/tmp/imitation/flat_fixed_still.png",fr)
capr.release(); capp.release(); vw.release()
print(f"wrote /tmp/imitation/flat_fixed.mp4 ({n} frames) + flat_fixed_still.png")

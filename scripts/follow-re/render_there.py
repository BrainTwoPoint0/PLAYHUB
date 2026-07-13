"""'Are we there' demo: OURS (flattened raw, balanced flat framing) | SPIIDEO Play.
Aim = reg (Spiideo's actual aim) so this shows FLATTEN + FRAMING quality at parity, not the
follow aim. fov_flat = clip(fov_reg - 6, 18, 34). 960x540/panel, ~20s of continuous action."""
import json, glob, numpy as np, cv2
from scipy.spatial import cKDTree
import mesh_dewarp as MD
G8="b923d40f"; WOFF=900
RAW=glob.glob(f"/tmp/follow-pair/raw_{G8}*_s{WOFF}.mp4")[0]; PLAY=glob.glob(f"/tmp/follow-pair/play_{G8}*_s{WOFF}.mp4")[0]
reg=json.load(open(f"/tmp/imitation/reg_{G8}.json")); rt=np.array(reg["t"]); rpx=np.array(reg["pano_x"]); rpy=np.array(reg["pano_y"]); fw=np.array(reg["footw"])
W,H=960,540; FOVCUT=0
projs,_=MD.load_mesh("/tmp/follow-pair/mesh")
UV=np.vstack([p["uv"] for p in projs]); WORLD=np.vstack([p["world"] for p in projs]); RAYN=WORLD[:,:2]/WORLD[:,2:3]; uvt=cKDTree(UV)
def u2pt(u,v): rn=RAYN[uvt.query([[u,v]])[1][0]]; x,y=float(rn[0]),float(rn[1]); n=np.sqrt(x*x+y*y+1); return np.degrees(np.arctan2(-x,1)),np.degrees(-np.arcsin(y/n))
def render(rawf,pan,tilt,fov):
    u,v=MD.bake_uv_map(projs,np.radians(pan),np.radians(tilt),fov,W,H); th,tw=rawf.shape[:2]
    m1=(u*tw).astype("f4"); m2=(v*th).astype("f4"); m1[u<0]=-1; m2[u<0]=-1; return cv2.remap(rawf,m1,m2,cv2.INTER_LINEAR)
def sm(a,k=9): return np.convolve(a,np.ones(k)/k,"same")
T0,T1=38.0,58.0; m=(rt>=T0)&(rt<=T1); idx=np.where(m)[0]
pan=sm(np.array([u2pt(rpx[i],rpy[i])[0] for i in idx])); tilt=sm(np.array([u2pt(rpx[i],rpy[i])[1] for i in idx]))
fov=sm(np.clip(fw[idx]*95,20,46)); fovflat=np.clip(fov-FOVCUT,18,34); tt=rt[idx]
capr=cv2.VideoCapture(RAW); capp=cv2.VideoCapture(PLAY); fps=capp.get(5) or 25
vw=cv2.VideoWriter("/tmp/imitation/there_wide.mp4",cv2.VideoWriter_fourcc(*"mp4v"),fps,(W*2,H))
def lab(im,t,c): cv2.rectangle(im,(0,0),(W,30),(0,0,0),-1); cv2.putText(im,t,(10,21),cv2.FONT_HERSHEY_SIMPLEX,0.6,c,2); return im
n=0
for fi in range(int(T0*fps),int(T1*fps)):
    capr.set(1,fi); okr,rf=capr.read(); capp.set(1,fi); okp,pf=capp.read()
    if not okr: break
    ct=fi/fps; pn=np.interp(ct,tt,pan); tl=np.interp(ct,tt,tilt); fv=np.interp(ct,tt,fovflat)
    a=lab(render(rf,pn,tl,fv),"PLAYHUB (our flatten, Spiideo-matched zoom)",(0,255,255))
    b=lab(cv2.resize(pf,(W,H)) if okp else np.zeros((H,W,3),np.uint8),"SPIIDEO Play",(210,210,210))
    fr=np.hstack([a,b]); vw.write(fr); n+=1
    if fi==int(47*fps): cv2.imwrite("/tmp/imitation/there_wide_still.png",fr)
capr.release(); capp.release(); vw.release()
print(f"wrote /tmp/imitation/there_wide.mp4 ({n} frames) + still")

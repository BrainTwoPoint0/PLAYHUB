"""Smooth, no-burst, Spiideo-zoom render. Fixes: (1) edge-safe savgol smoothing of aim+fov
(no jerky start), (2) coverage-clamp then coverage-SAFE smoothing of fov (no zoom bursts),
(3) fov = footw*95 * 1.17 (EXACT Spiideo zoom — not wider, to match their perspective/curve),
(4) 1s warm-up trimmed. Aim = reg (isolates picture quality, not the follow)."""
import os, json, glob, numpy as np, cv2
from scipy.spatial import cKDTree
from scipy.signal import savgol_filter
import mesh_dewarp as MD
import anti_bow as AB
import color_match as CM
ANTIBOW=float(os.environ.get("ANTIBOW","0"))   # radial anti-bow; 0=off (Spiideo-match)
GRADE=CM.load_luts() if os.environ.get("GRADE") else None   # reverse-engineered Spiideo colour grade
SUF=("_antibow" if ANTIBOW else "")+("_grade" if GRADE else "")
G8="b923d40f"; WOFF=900
RAW=glob.glob(f"/tmp/follow-pair/raw_{G8}*_s{WOFF}.mp4")[0]; PLAY=glob.glob(f"/tmp/follow-pair/play_{G8}*_s{WOFF}.mp4")[0]
reg=json.load(open(f"/tmp/imitation/reg_{G8}.json")); rt=np.array(reg["t"]); rpx=np.array(reg["pano_x"]); rpy=np.array(reg["pano_y"]); fw=np.array(reg["footw"])
W,H=960,540; FOVMUL=1.40   # zoomed out vs Spiideo's ~1.17 (Karim: 1.17 too tight; 1.40 = more context + follow margin)
projs,_=MD.load_mesh(os.environ.get("MESH","/tmp/follow-pair/mesh-fixed"))  # 4-proj fixed mesh (80% cov)
UV=np.vstack([p["uv"] for p in projs]); WORLD=np.vstack([p["world"] for p in projs]); RAYN=WORLD[:,:2]/WORLD[:,2:3]; uvt=cKDTree(UV)
def u2pt(u,v): rn=RAYN[uvt.query([[u,v]])[1][0]]; x,y=float(rn[0]),float(rn[1]); n=np.sqrt(x*x+y*y+1); return np.degrees(np.arctan2(-x,1)),np.degrees(-np.arcsin(y/n))
def coverage(pan,tilt,fov):
    u,_=MD.bake_uv_map(projs,np.radians(pan),np.radians(tilt),fov,W,H); return float(np.mean(u>=0))
def clamp_fov(pan,tilt,fov,floor=14):
    f=fov
    for _ in range(40):
        if coverage(pan,tilt,f)>=0.999 or f<=floor: break
        f*=0.98
    return f
def render(rawf,pan,tilt,fov):
    u,v=MD.bake_uv_map(projs,np.radians(pan),np.radians(tilt),fov,W,H)
    if ANTIBOW: u,v=AB.warp_uv(u,v,ANTIBOW)
    th,tw=rawf.shape[:2]
    m1=(u*tw).astype("f4"); m2=(v*th).astype("f4"); m1[u<0]=-1; m2[u<0]=-1
    out=cv2.remap(rawf,m1,m2,cv2.INTER_LINEAR)
    if GRADE is not None: out=CM.apply_luts(out,GRADE)
    return out
def sg(a,w=15,p=2):
    w=min(w, len(a)-(1-len(a)%2)); w=max(5,w if w%2 else w-1)
    return savgol_filter(a,w,p,mode="nearest")
# reg-grid trajectory over a padded window; render the inner window (warm-up trimmed)
T0,T1=31.0,56.0
m=(rt>=T0-2)&(rt<=T1+2); idx=np.where(m)[0]
pan=sg(np.array([u2pt(rpx[i],rpy[i])[0] for i in idx]))
tilt=sg(np.array([u2pt(rpx[i],rpy[i])[1] for i in idx]))
fovwant=sg(np.clip(fw[idx]*95,20,46))*FOVMUL
# clamp per reg-frame (coverage-safe), then smooth but never exceed the clamp (stays covered)
fovc=np.array([clamp_fov(pan[k],tilt[k],fovwant[k]) for k in range(len(idx))])
fovs=np.minimum(sg(fovc,11,2), fovc)
tt=rt[idx]
capr=cv2.VideoCapture(RAW); capp=cv2.VideoCapture(PLAY); fps=capp.get(5) or 25
vw=cv2.VideoWriter(f"/tmp/imitation/smooth_follow{SUF}.mp4",cv2.VideoWriter_fourcc(*"mp4v"),fps,(W*2,H))
_pl=f"PLAYHUB (fov x{FOVMUL:.2f}, smoothed{', anti-bow '+str(ANTIBOW) if ANTIBOW else ''}{', Spiideo-grade' if GRADE else ''})"
def lab(im,t,c): cv2.rectangle(im,(0,0),(W,26),(0,0,0),-1); cv2.putText(im,t,(10,18),cv2.FONT_HERSHEY_SIMPLEX,0.5,c,1); return im
n=0
for fi in range(int(T0*fps),int(T1*fps)):
    capr.set(1,fi); okr,rf=capr.read(); capp.set(1,fi); okp,pf=capp.read()
    if not okr: break
    ct=fi/fps; pn=np.interp(ct,tt,pan); tl=np.interp(ct,tt,tilt); fv=np.interp(ct,tt,fovs)
    a=lab(render(rf,pn,tl,fv),_pl,(0,255,255))
    b=lab(cv2.resize(pf,(W,H)) if okp else np.zeros((H,W,3),np.uint8),"SPIIDEO Play",(210,210,210))
    vw.write(np.hstack([a,b])); n+=1
    if fi==int(47*fps): cv2.imwrite(f"/tmp/imitation/smooth_still{SUF}.png",np.hstack([a,b]))
capr.release(); capp.release(); vw.release()
print(f"wrote /tmp/imitation/smooth_follow{SUF}.mp4 ({n} frames) + still")

"""Dense roll(pan) measurement + up-axis solve.
For ~30 reg samples across pan: invert framing, render ours, similarity-fit
vs their Play frame -> rotation. Then solve the up axis u* whose induced roll
best explains the measurements; output corrected TILT/YAW/ROLL."""
import json, os, sys
import numpy as np, cv2
from scipy.optimize import least_squares
sys.path.insert(0, os.path.join(os.environ['WS'], 'PLAYHUB', 'scripts', 'follow-re'))
import mesh_dewarp as MD

SP = os.environ['SP']
projs, _ = MD.load_mesh(os.environ.get('MESH') or os.path.join(os.environ['WS'], 'PLAYHUB', 'public', 'vp-mesh-kuwait'))
reg = json.load(open(f"{SP}/reg_1fps.json"))
RAW = f"{SP}/raw_afb81f5f-12a3-4250-bc3d-d1824f82e94e_s900.mp4"
PLAY = f"{SP}/play_afb81f5f-12a3-4250-bc3d-d1824f82e94e_s900.mp4"
t = np.array(reg['t'], float); px = np.array(reg['pano_x'], float)
py = np.array(reg['pano_y'], float); fw = np.array(reg['footw'], float)
ok = np.isfinite(px) & np.isfinite(py) & np.isfinite(fw) & (fw < 0.5)

# stratified pan coverage: bin pano_x into 10 bins, up to 3 per bin
bins = np.linspace(px[ok].min(), px[ok].max(), 11)
sel = []
for b in range(10):
    idxs = np.where(ok & (px >= bins[b]) & (px < bins[b+1]))[0]
    for i in idxs[:: max(1, len(idxs)//3)][:3]:
        sel.append(int(i))
print('samples:', len(sel))

def center_and_footprint(pan, tilt, fov):
    u, v = MD.bake_uv_map(projs, np.radians(pan), np.radians(tilt), fov, 160, 90)
    cu, cv = u[45, 80], v[45, 80]
    row = u[45]; valid = row >= 0
    fwv = (row[valid].max() - row[valid].min()) if valid.any() else 0.0
    return float(cu), float(cv), float(fwv)

def invert(pano_x, pano_y, footw):
    pan = float(np.degrees(-(pano_x*3840.0 - 1871.0241366046919)/1160.7297633076787))
    tilt, fov = -20.0, 30.0
    for _ in range(40):
        cu, cv, f = center_and_footprint(pan, tilt, fov)
        pan  = np.clip(pan  + np.clip((cu - pano_x) * 120.0, -8, 8), -120, 120)
        tilt = np.clip(tilt + np.clip((cv - pano_y) * 80.0,  -6, 6), -85, 35)
        fov  = np.clip(fov  + np.clip((footw - f) * 60.0,    -6, 6), 14, 110)
        if abs(pano_x-cu) < 0.002 and abs(pano_y-cv) < 0.002 and abs(footw-f) < 0.004:
            break
    return float(pan), float(tilt), float(fov)

capr = cv2.VideoCapture(RAW); capp = cv2.VideoCapture(PLAY)
sift = cv2.SIFT_create(2500); bf = cv2.BFMatcher()
obs = []
for i in sel:
    pan, tilt, fov = invert(px[i], py[i], fw[i])
    if abs(pan) >= 119: continue
    capr.set(cv2.CAP_PROP_POS_MSEC, t[i]*1000); okr, raw = capr.read()
    capp.set(cv2.CAP_PROP_POS_MSEC, t[i]*1000); okp, play = capp.read()
    if not (okr and okp): continue
    u, v = MD.bake_uv_map(projs, np.radians(pan), np.radians(tilt), fov, 960, 540)
    H, W = raw.shape[:2]
    mu = (u*W).astype(np.float32); mv = (v*H).astype(np.float32)
    mu[u<0] = -1; mv[v<0] = -1
    ours = cv2.remap(raw, mu, mv, cv2.INTER_LINEAR)
    theirs = cv2.resize(play, (960, 540))
    g1 = cv2.cvtColor(ours, cv2.COLOR_BGR2GRAY); g2 = cv2.cvtColor(theirs, cv2.COLOR_BGR2GRAY)
    k1, d1 = sift.detectAndCompute(g1, None); k2, d2 = sift.detectAndCompute(g2, None)
    if d1 is None or d2 is None: continue
    m = bf.knnMatch(d1, d2, k=2)
    good = [a for a, b in m if a.distance < 0.75*b.distance]
    if len(good) < 20: continue
    p1 = np.float32([k1[a.queryIdx].pt for a in good])
    p2 = np.float32([k2[a.trainIdx].pt for a in good])
    Msim, inl = cv2.estimateAffinePartial2D(p1, p2, method=cv2.RANSAC, ransacReprojThreshold=4.0)
    if Msim is None or inl.sum() < 20: continue
    rot = float(np.degrees(np.arctan2(Msim[1,0], Msim[0,0])))
    obs.append((pan, tilt, rot, int(inl.sum())))
    print(f"pan={pan:7.1f} tilt={tilt:6.1f} rot={rot:+6.2f} inl={int(inl.sum())}")

obs = np.array([(a,b,c) for a,b,c,_ in obs])
np.save(f"{SP}/roll_obs.npy", obs)

def fwd(pan, tilt):
    ct = np.cos(np.radians(tilt))
    return np.array([ct*np.sin(np.radians(pan)), -np.sin(np.radians(tilt)), ct*np.cos(np.radians(pan))])

UP0 = np.array([0., -1., 0.])
def right_of(up, z):
    x = np.cross(up, z); n = np.linalg.norm(x)
    return x/n if n > 0 else None

def resid(params):
    dx, dz = params  # small rotation of up axis about x and z
    Rx = cv2.Rodrigues(np.array([dx, 0., 0.]))[0]
    Rz = cv2.Rodrigues(np.array([0., 0., dz]))[0]
    up = (Rz @ Rx @ UP0)
    out = []
    for pan, tilt, rot in obs:
        z = fwd(pan, tilt)
        r0 = right_of(UP0, z); r1 = right_of(up, z)
        s = np.dot(np.cross(r0, r1), z)
        c = np.dot(r0, r1)
        out.append(np.degrees(np.arctan2(s, c)) - rot)
    return np.array(out)

sol = least_squares(resid, [0.0, 0.0])
dx, dz = sol.x
res = resid(sol.x)
print(f"\nup-axis correction: rot_x={np.degrees(dx):+.2f}deg rot_z={np.degrees(dz):+.2f}deg")
print(f"residual roll rms {np.sqrt((res**2).mean()):.2f}deg (raw rms {np.sqrt((obs[:,2]**2).mean()):.2f})")

# compose into a corrected mount: world' = Rc . world  =>  Rmount' = Rmount . Rc^-1
fit = json.load(open(os.path.join(os.environ['WS'], 'PLAYHUB', 'scripts', 'vp-calibration', 'kuwait-fit.json')))
rx, ry, rz = np.radians(fit['TILT']), np.radians(fit['YAW']), np.radians(fit['ROLL'])
Rmount = (cv2.Rodrigues(np.array([0.,0.,rz]))[0] @ cv2.Rodrigues(np.array([0.,ry,0.]))[0]
          @ cv2.Rodrigues(np.array([rx,0.,0.]))[0])
Rc = cv2.Rodrigues(np.array([0.,0.,dz]))[0] @ cv2.Rodrigues(np.array([dx,0.,0.]))[0]
Rm2 = Rmount @ np.linalg.inv(Rc)
# decompose Rm2 = Rz(rz2) Ry(ry2) Rx(rx2)
ry2 = np.arcsin(np.clip(Rm2[0,2] if False else -Rm2[2,0] if False else Rm2[0][2], -1, 1))
# safer: numeric decomposition
def decomp(R):
    # R = Rz(rz) @ Ry(ry) @ Rx(rx):  R[2,0] = -sin(ry)... standard ZYX euler
    ry_ = -np.arcsin(np.clip(R[2,0], -1, 1))
    rx_ = np.arctan2(R[2,1], R[2,2])
    rz_ = np.arctan2(R[1,0], R[0,0])
    return rx_, ry_, rz_
rx2, ry2, rz2 = decomp(Rm2)
Rcheck = (cv2.Rodrigues(np.array([0.,0.,rz2]))[0] @ cv2.Rodrigues(np.array([0.,ry2,0.]))[0]
          @ cv2.Rodrigues(np.array([rx2,0.,0.]))[0])
print(f"decomp check max|dR| = {np.abs(Rcheck-Rm2).max():.2e}")
print(f"corrected mount: TILT={np.degrees(rx2):.3f} YAW={np.degrees(ry2):.3f} ROLL={np.degrees(rz2):.3f}")
print(f"(current:       TILT={fit['TILT']} YAW={fit['YAW']} ROLL={fit['ROLL']})")

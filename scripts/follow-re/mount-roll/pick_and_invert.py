"""Pick corner framings from reg_1fps.json, invert (pan,tilt,fov) via the
CURRENT public mesh, and emit side-by-side panels (their Play frame | our
pinhole mesh-dewarp render of the raw VP at the matched framing)."""
import json, sys, os
import numpy as np, cv2
sys.path.insert(0, os.path.join(os.environ['WS'], 'PLAYHUB', 'scripts', 'follow-re'))
import mesh_dewarp as MD

SP = os.environ['SP']
MESH = os.environ.get('MESH') or os.path.join(os.environ['WS'], 'PLAYHUB', 'public', 'vp-mesh-kuwait')
projs, _ = MD.load_mesh(MESH)
reg = json.load(open(f"{SP}/reg_1fps.json"))
RAW = f"{SP}/raw_afb81f5f-12a3-4250-bc3d-d1824f82e94e_s900.mp4"
PLAY = f"{SP}/play_afb81f5f-12a3-4250-bc3d-d1824f82e94e_s900.mp4"

t = np.array(reg['t'], float); px = np.array(reg['pano_x'], float)
py = np.array(reg['pano_y'], float); fw = np.array(reg['footw'], float)
ok = np.isfinite(px) & np.isfinite(py) & np.isfinite(fw)

# corner framings: pano_x extremes, prefer tight zoom, spaced >=30s
def pick(side):
    order = np.argsort(px[ok]) if side == 'L' else np.argsort(-px[ok])
    idxs = np.where(ok)[0][order]
    chosen = []
    for i in idxs:
        if fw[i] > 0.45: continue          # skip wide overviews
        if all(abs(t[i]-t[j]) > 30 for j in chosen):
            chosen.append(i)
        if len(chosen) == 3: break
    return chosen

sel = pick('L') + pick('R')
print('selected:', [(round(t[i],1), round(px[i],3), round(fw[i],3)) for i in sel])

def center_and_footprint(pan, tilt, fov):
    u, v = MD.bake_uv_map(projs, np.radians(pan), np.radians(tilt), fov, 160, 90)
    cu, cv = u[45, 80], v[45, 80]
    row = u[45]; valid = row >= 0
    fwv = (row[valid].max() - row[valid].min()) if valid.any() else 0.0
    return float(cu), float(cv), float(fwv)

def invert(pano_x, pano_y, footw):
    # seed pan from the closed form (current fit: CX=1871.02, F=1160.73):
    # mesh_pan = -(px*W - CX)/F  (center_u DECREASES as pan increases)
    pan = float(np.degrees(-(pano_x*3840.0 - 1871.0241366046919)/1160.7297633076787))
    tilt, fov = -20.0, 30.0
    for _ in range(40):
        cu, cv, f = center_and_footprint(pan, tilt, fov)
        dpan = (cu - pano_x) * 120.0
        dtilt = (cv - pano_y) * 80.0
        dfov = (footw - f) * 60.0
        pan = np.clip(pan + np.clip(dpan, -8, 8), -120, 120)
        tilt = np.clip(tilt + np.clip(dtilt, -6, 6), -85, 35)
        fov = np.clip(fov + np.clip(dfov, -6, 6), 14, 110)
        if abs(pano_x-cu) < 0.002 and abs(pano_y-cv) < 0.002 and abs(footw-f) < 0.004:
            break
    return float(pan), float(tilt), float(fov), (cu, cv, f)

capr = cv2.VideoCapture(RAW); capp = cv2.VideoCapture(PLAY)
out = []
for i in sel:
    pan, tilt, fov, achieved = invert(px[i], py[i], fw[i])
    capr.set(cv2.CAP_PROP_POS_MSEC, t[i]*1000); okr, fr = capr.read()
    capp.set(cv2.CAP_PROP_POS_MSEC, t[i]*1000); okp, fp = capp.read()
    if not (okr and okp): continue
    u, v = MD.bake_uv_map(projs, np.radians(pan), np.radians(tilt), fov, 960, 540)
    H, W = fr.shape[:2]
    mu = (u * W).astype(np.float32); mv = (v * H).astype(np.float32)
    mu[u < 0] = -1; mv[v < 0] = -1
    ours = cv2.remap(fr, mu, mv, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
    theirs = cv2.resize(fp, (960, 540))
    panel = np.vstack([theirs, ours])
    cv2.putText(panel, f"t={t[i]:.0f}s SPIIDEO PLAY", (10, 30), 0, 0.9, (0,255,255), 2)
    cv2.putText(panel, f"OURS pinhole pan={pan:.1f} tilt={tilt:.1f} fov={fov:.1f}", (10, 570), 0, 0.9, (0,255,255), 2)
    name = f"{SP}/panel_{os.environ.get(chr(77)+chr(69)+chr(83)+chr(72)) and chr(103) or chr(111)}_t{int(t[i])}.png"
    cv2.imwrite(name, panel)
    out.append(dict(t=float(t[i]), pan=pan, tilt=tilt, fov=fov, pano_x=float(px[i]), pano_y=float(py[i]), footw=float(fw[i])))
    print('wrote', name, 'pan/tilt/fov', round(pan,1), round(tilt,1), round(fov,1))
json.dump(out, open(f"{SP}/framings.json", 'w'), indent=1)

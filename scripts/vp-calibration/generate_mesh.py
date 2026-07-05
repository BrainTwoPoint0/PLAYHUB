#!/usr/bin/env python3
"""Layer 2 — generate a multi-projection VirtualPanorama de-warp mesh from our
own fisheye model. Splits the pan range into NPROJ projections, each oriented at
its own centre (its own R_view), so each projection's gnomonic stays bounded
(a single flat plane blows up past ~±60°). The player composes them into one
seamless pannable panorama (world rays are continuous across projections).

Env: F,CX,CY,K1..K4 (fisheye); TILT,YAW,ROLL (mount deg); PAN_DEG,TILT_LO,TILT_HI
(panorama extent deg); NPROJ, OVL_DEG (seam overlap), COLS,ROWS (per projection);
W,H (raw size); OUT.
"""
import os, json, numpy as np, cv2

# auto-load the fisheye calibration from calibrate.py (env still overrides)
_fit = {}
try:
    _fit = json.load(open(os.path.join(os.path.dirname(__file__), 'kuwait-fit.json')))
except Exception:
    pass
env = lambda k, d: float(os.environ.get(k, _fit.get(k, d)))
OUT = os.environ.get('OUT', 'PLAYHUB/public/vp-mesh-kuwait')
W = int(env('W', 3840)); H = int(env('H', 2160))
F = env('F', 1100); CX = env('CX', W/2); CY = env('CY', H/2)
D = np.array([[env('K1', 0)], [env('K2', 0)], [env('K3', 0)], [env('K4', 0)]], np.float64)
K = np.array([[F, 0, CX], [0, F, CY], [0, 0, 1]], np.float64)
rx, ry, rz = np.radians(env('TILT', 32)), np.radians(env('YAW', 0)), np.radians(env('ROLL', 0))
Rmount = (cv2.Rodrigues(np.array([0., 0., rz]))[0] @ cv2.Rodrigues(np.array([0., ry, 0.]))[0]
          @ cv2.Rodrigues(np.array([rx, 0., 0.]))[0])
rvec = cv2.Rodrigues(Rmount)[0]

PAN = np.radians(env('PAN_DEG', 90)); TLO = np.radians(env('TILT_LO', -74)); THI = np.radians(env('TILT_HI', 2))
NPROJ = int(env('NPROJ', 2)); OVL = np.radians(env('OVL_DEG', 6))
COLS = int(env('COLS', 150)); ROWS = int(env('ROWS', 110))
MOUNT_S = np.array([[0, -0.218849, 0.975731], [-1.000013, 0, 0], [0, -0.975762, -0.218884]], np.float64)
MS_inv = np.linalg.inv(MOUNT_S)
tmid = (TLO + THI) / 2

def ray(pan, tilt):
    ct = np.cos(tilt)
    return np.array([ct * np.sin(pan), -np.sin(tilt), ct * np.cos(pan)])

def view_basis(fwd):  # rows [right, up, z=fwd]; R@fwd = +z
    z = fwd / np.linalg.norm(fwd)
    x = np.cross(np.array([0., -1., 0.]), z); x /= np.linalg.norm(x)
    y = np.cross(z, x)
    return np.array([x, y, z])

# split pan into NPROJ sub-ranges (equal, with overlap)
edges = np.linspace(-PAN, PAN, NPROJ + 1)
all_v, projs, indices, vbase = [], [], [], 0
for i in range(NPROJ):
    p0 = edges[i] - (OVL if i > 0 else 0)
    p1 = edges[i + 1] + (OVL if i < NPROJ - 1 else 0)
    Rview = view_basis(ray((p0 + p1) / 2, tmid))
    tw = Rview                       # want player's tw_i = Rview
    R_scene = tw.T @ MS_inv          # so transpose(R_scene·MOUNT_S) = tw
    tw_inv = np.linalg.inv(tw)
    pans = np.linspace(p0, p1, COLS); tilts = np.linspace(TLO, THI, ROWS)
    pg, tg = np.meshgrid(pans, tilts); ct = np.cos(tg)
    d = np.stack([ct * np.sin(pg), -np.sin(tg), ct * np.cos(pg)], -1).reshape(-1, 3)
    g = (tw_inv @ d.T).T
    v = np.zeros((ROWS * COLS, 5), np.float32)
    v[:, 0] = g[:, 0] / g[:, 2]; v[:, 1] = g[:, 1] / g[:, 2]
    px = cv2.fisheye.projectPoints(d.reshape(-1, 1, 3).astype(np.float64), rvec, np.zeros(3), K, D)[0].reshape(-1, 2)
    v[:, 2] = px[:, 0] / W; v[:, 3] = px[:, 1] / H
    # feather each projection's overlap edges (fade to 0 over the OVL band)
    alpha = np.ones(COLS)
    band = max(1, int(OVL / (p1 - p0) * COLS))
    if i > 0: alpha[:band] = np.linspace(0, 1, band)
    if i < NPROJ - 1: alpha[-band:] = np.linspace(1, 0, band)
    v[:, 4] = np.tile(alpha, ROWS).astype(np.float32)
    all_v.append(v)
    for r in range(ROWS - 1):
        for c in range(COLS - 1):
            a = vbase + r * COLS + c; b = a + 1; e = a + COLS; f = e + 1
            indices += [a, e, b, b, e, f]
    projs.append({'camera': {'position': [0., 0., 0.], 'rotation': R_scene.flatten().tolist()},
                  'n_vertices': ROWS * COLS, 'n_indices': (ROWS - 1) * (COLS - 1) * 6,
                  'texture_offset': 0.0, 'texture_offset_scale': 1.0})
    vbase += ROWS * COLS
    print(f'  proj{i}: pan[{np.degrees(p0):.0f},{np.degrees(p1):.0f}] f0[{v[:,0].min():.1f},{v[:,0].max():.1f}] '
          f'f1[{v[:,1].min():.1f},{v[:,1].max():.1f}] uv x[{px[:,0].min():.0f},{px[:,0].max():.0f}]')

os.makedirs(OUT, exist_ok=True)
np.concatenate(all_v).tofile(f'{OUT}/vertices.bin')
np.array(indices, np.uint32).tofile(f'{OUT}/indices.bin')
json.dump({'index_description': 'uint32', 'minPan': float(-PAN), 'maxPan': float(PAN),
           'minTilt': float(TLO), 'maxTilt': float(THI), 'minRelativeZoom': 0.2, 'maxRelativeZoom': 16.0,
           'projections': projs, 'vertex_description': ['float32'] * 5}, open(f'{OUT}/scene.json', 'w'), indent=2)
print(f'wrote {OUT}: {NPROJ} projections, {ROWS}x{COLS} each, F={F} tilt={np.degrees(rx):.0f} pan±{np.degrees(PAN):.0f}')

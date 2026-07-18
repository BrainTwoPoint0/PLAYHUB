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
    _fit = json.load(open(os.path.join(os.path.dirname(__file__), f"{os.environ.get('SITE', 'kuwait')}-fit.json")))
except Exception:
    pass
env = lambda k, d: float(os.environ.get(k, _fit.get(k, d)))
OUT = os.environ.get('OUT', f"PLAYHUB/public/vp-mesh-{os.environ.get('SITE', 'kuwait')}")
W = int(env('W', 3840)); H = int(env('H', 2160))
F = env('F', 1100); CX = env('CX', W/2); CY = env('CY', H/2)
D = np.array([[env('K1', 0)], [env('K2', 0)], [env('K3', 0)], [env('K4', 0)]], np.float64)
rx, ry, rz = np.radians(env('TILT', 32)), np.radians(env('YAW', 0)), np.radians(env('ROLL', 0))
Rmount = (cv2.Rodrigues(np.array([0., 0., rz]))[0] @ cv2.Rodrigues(np.array([0., ry, 0.]))[0]
          @ cv2.Rodrigues(np.array([rx, 0., 0.]))[0])

# Geometry: NPROJ pan strips cover tilt [TILT_SPLIT, TILT_HI], plus ONE polar-cap "floor
# bowl" projection covering ALL pans in tilt [TILT_LO, TILT_SPLIT]. A gnomonic plane can
# only represent directions in front of its projection plane — putting full-wrap pan ranges
# into strips silently MIRRORS directions past 90 deg from the plane (world flips through
# the origin). The bowl's farthest direction (any pan at TILT_SPLIT) is only ~52 deg off its
# straight-down-ish axis, so everything stays representable. Strips and bowl abut exactly at
# TILT_SPLIT: same fisheye fit on both sides → identical content, invisible seam, no z-fight.
# TILT_LO -89.95 (not -74: that dropped a 16-deg cone around the nadir — the bottom-centre
# "notch" over real pitch). -90 exactly is pan-degenerate, but -89.95 makes the bowl's bottom
# grid row converge to a sub-pixel ring around the nadir pixel — closes the hole to ~1px.
# THETA_MAX 100: rays are projected manually (below), which is valid past 90 deg — the lens
# captures >180 deg FOV — but single-K1 equidistant extrapolation degrades far past the
# fitted range, so cap at 100 and require the projected pixel to land in-frame.
# Optional line-straightening displacement field (flatten_lines.py output):
# after projecting each vertex ray to raw px, add the interpolated (dx, dy).
# Display cosmetic ONLY — see flatten_lines.py docstring for scope/limits.
_flat = None
if os.environ.get('FLATTEN'):
    _fj = json.load(open(os.environ['FLATTEN']))
    _flat = (np.array(_fj['dx'], np.float64), np.array(_fj['dy'], np.float64),
             float(_fj['grid_step']))
    print(f"  flatten field: {os.environ['FLATTEN']} "
          f"({_flat[0].shape[1]}x{_flat[0].shape[0]} @ {_flat[2]:g}px)")

def flatten_disp(px):
    if _flat is None:
        return px
    DX, DY, step = _flat
    gx = np.clip(px[:, 0] / step, 0, DX.shape[1] - 1.001)
    gy = np.clip(px[:, 1] / step, 0, DX.shape[0] - 1.001)
    i0 = np.floor(gx).astype(int); j0 = np.floor(gy).astype(int)
    fx = gx - i0; fy = gy - j0
    def bil(G):
        return (G[j0, i0] * (1 - fx) * (1 - fy) + G[j0, i0 + 1] * fx * (1 - fy)
                + G[j0 + 1, i0] * (1 - fx) * fy + G[j0 + 1, i0 + 1] * fx * fy)
    return px + np.column_stack([bil(DX), bil(DY)])

PAN = np.radians(env('PAN_DEG', 135)); TLO = np.radians(env('TILT_LO', -89.95)); THI = np.radians(env('TILT_HI', 2))
TSPLIT = np.radians(env('TILT_SPLIT', -55))
THETA_MAX = np.radians(env('THETA_MAX', 100))
NPROJ = int(env('NPROJ', 3)); OVL = np.radians(env('OVL_DEG', 6))
COLS = int(env('COLS', 150)); ROWS = int(env('ROWS', 110))
MOUNT_S = np.array([[0, -0.218849, 0.975731], [-1.000013, 0, 0], [0, -0.975762, -0.218884]], np.float64)
MS_inv = np.linalg.inv(MOUNT_S)

def ray(pan, tilt):
    ct = np.cos(tilt)
    return np.array([ct * np.sin(pan), -np.sin(tilt), ct * np.cos(pan)])

def view_basis(fwd):  # rows [right, up, z=fwd]; R@fwd = +z
    z = fwd / np.linalg.norm(fwd)
    x = np.cross(np.array([0., -1., 0.]), z); x /= np.linalg.norm(x)
    y = np.cross(z, x)
    return np.array([x, y, z])

# NPROJ pan strips (equal, with feathered overlap) above TILT_SPLIT + the floor bowl below
edges = np.linspace(-PAN, PAN, NPROJ + 1)
specs = []
for i in range(NPROJ):
    specs.append(dict(p0=edges[i] - (OVL if i > 0 else 0), p1=edges[i + 1] + (OVL if i < NPROJ - 1 else 0),
                      t0=TSPLIT, t1=THI, feather=(i > 0, i < NPROJ - 1)))
specs.append(dict(p0=-np.pi, p1=np.pi, t0=TLO, t1=TSPLIT, feather=(False, False)))  # floor bowl
all_v, projs, indices, vbase = [], [], [], 0
for i, s in enumerate(specs):
    p0, p1, t0, t1 = s['p0'], s['p1'], s['t0'], s['t1']
    Rview = view_basis(ray((p0 + p1) / 2, (t0 + t1) / 2))
    tw = Rview                       # want player's tw_i = Rview
    R_scene = tw.T @ MS_inv          # so transpose(R_scene·MOUNT_S) = tw
    tw_inv = np.linalg.inv(tw)
    pans = np.linspace(p0, p1, COLS); tilts = np.linspace(t0, t1, ROWS)
    pg, tg = np.meshgrid(pans, tilts); ct = np.cos(tg)
    d = np.stack([ct * np.sin(pg), -np.sin(tg), ct * np.cos(pg)], -1).reshape(-1, 3)
    g = (tw_inv @ d.T).T
    v = np.zeros((ROWS * COLS, 5), np.float32)
    v[:, 0] = g[:, 0] / g[:, 2]; v[:, 1] = g[:, 1] / g[:, 2]
    # manual equidistant projection: cv2.fisheye.projectPoints computes theta via atan,
    # which FOLDS z<0 rays back inside the disc (mirrored phantoms); arccos is monotonic
    # over 0..180 deg so the beyond-90-deg ring the lens actually captures stays mappable.
    dc = (Rmount @ d.T).T
    th = np.arccos(np.clip(dc[:, 2], -1.0, 1.0))
    ph = np.arctan2(dc[:, 1], dc[:, 0])
    k1, k2, k3, k4 = D[:, 0]
    rr = F * th * (1 + k1 * th**2 + k2 * th**4 + k3 * th**6 + k4 * th**8)
    px = np.column_stack([CX + rr * np.cos(ph), CY + rr * np.sin(ph)])
    px = flatten_disp(px)
    v[:, 2] = px[:, 0] / W; v[:, 3] = px[:, 1] / H
    valid = ((th <= THETA_MAX) & (px[:, 0] >= -0.02 * W) & (px[:, 0] <= 1.02 * W)
             & (px[:, 1] >= -0.02 * H) & (px[:, 1] <= 1.02 * H))
    # feather each strip's overlap edges (fade to 0 over the OVL band); bowl has no overlap
    alpha = np.ones(COLS)
    band = max(1, int(OVL / (p1 - p0) * COLS))
    if s['feather'][0]: alpha[:band] = np.linspace(0, 1, band)
    if s['feather'][1]: alpha[-band:] = np.linspace(1, 0, band)
    v[:, 4] = np.tile(alpha, ROWS).astype(np.float32)
    all_v.append(v)
    ni0 = len(indices)
    for r in range(ROWS - 1):
        for c in range(COLS - 1):
            a = r * COLS + c; b = a + 1; e = a + COLS; f = e + 1
            if valid[a] and valid[e] and valid[b]:
                indices += [vbase + a, vbase + e, vbase + b]
            if valid[b] and valid[e] and valid[f]:
                indices += [vbase + b, vbase + e, vbase + f]
    n_idx = len(indices) - ni0
    projs.append({'camera': {'position': [0., 0., 0.], 'rotation': R_scene.flatten().tolist()},
                  'n_vertices': ROWS * COLS, 'n_indices': n_idx,
                  'texture_offset': 0.0, 'texture_offset_scale': 1.0})
    vbase += ROWS * COLS
    print(f'  proj{i}: pan[{np.degrees(p0):.0f},{np.degrees(p1):.0f}] f0[{v[:,0].min():.1f},{v[:,0].max():.1f}] '
          f'f1[{v[:,1].min():.1f},{v[:,1].max():.1f}] uv x[{px[:,0].min():.0f},{px[:,0].max():.0f}] '
          f'culled {int((~valid).sum())}/{len(valid)} verts beyond theta {np.degrees(THETA_MAX):.0f}')

os.makedirs(OUT, exist_ok=True)
np.concatenate(all_v).tofile(f'{OUT}/vertices.bin')
np.array(indices, np.uint32).tofile(f'{OUT}/indices.bin')
json.dump({'index_description': 'uint32', 'minPan': float(-PAN), 'maxPan': float(PAN),
           'minTilt': float(TLO), 'maxTilt': float(THI), 'minRelativeZoom': 0.2, 'maxRelativeZoom': 16.0,
           'projections': projs, 'vertex_description': ['float32'] * 5}, open(f'{OUT}/scene.json', 'w'), indent=2)
print(f'wrote {OUT}: {NPROJ} strips + floor bowl, {ROWS}x{COLS} each, F={F} tilt={np.degrees(rx):.0f} '
      f'pan±{np.degrees(PAN):.0f} split {np.degrees(TSPLIT):.0f}')

"""What SHAPE is the residual field really? Print the vectors, not the norms,
on an UNBIASED (loose-gate) correspondence set.

The 0.03-gate set used earlier is truncated exactly where the error is worst
(the ends), so it understates and distorts the field. Rebuild at 0.06.
"""
import json, os, sys, glob
sys.path.insert(0, '/Users/karimfawaz/Dev Projects/PLAYBACK Workspace/PLAYHUB/infrastructure/batch/player-tracklets')
import numpy as np
import cv2
from scipy.spatial import cKDTree
from scipy.optimize import linear_sum_assignment
import build_track
import detections as det_mod
import solve_h
from mesh_rays import load_mesh_rays

OUT = os.path.dirname(os.path.abspath(__file__))
streams = json.load(open(f'{OUT}/cache/streams.json'))
START = streams['start_time_us']
H = np.array(json.load(open(f'{OUT}/prod-solve.json'))['H'])
Hinv = np.linalg.inv(H)
GATE = 0.06

uv, rays = load_mesh_rays(f'{OUT}/mesh')
front = rays[:, 2] > 0.05
uv_f = uv[front]
rayn_all = rays[front][:, :2] / rays[front][:, 2:3]
uv_tree = cKDTree(uv_f)
def uv_to_rayn(pts):
    d, idx = uv_tree.query(pts, k=3)
    out = rayn_all[idx].mean(axis=1)
    out[d[:, 0] > 0.01] = np.nan
    return out

trk_items = [(i, r.encode()) for i, r in json.load(open(f'{OUT}/cache/trk_items.json'))]
fragments = build_track.parse_items(trk_items, START, 16_000_000)
spans = [(int(ts[0]), int(ts[-1]), ts.astype(np.float64), xy) for ts, xy in fragments]
LO, HI = solve_h.pitch_rect_metric(fragments)

det_frames = {}
for f in glob.glob(f'{OUT}/cache/det_*.json'):
    items = [(i, r.encode()) for i, r in json.load(open(f))]
    det_mod.parse_detection_items(items, uv_to_rayn, frames=det_frames)

M, RTRUE = [], []
for dt in sorted(det_frames):
    fuv, drn = det_frames[dt]
    met = []
    for t0, t1, ts, xy in spans:
        if t0 <= dt <= t1:
            j = int(np.searchsorted(ts, dt))
            if 0 < j < len(ts) and dt != ts[j - 1] and ts[j] - ts[j - 1] > 600_000:
                continue
            met.append([np.interp(dt, ts, xy[:, 0]), np.interp(dt, ts, xy[:, 1])])
    if not met:
        continue
    met = np.array(met, np.float64)
    d = drn[fuv[:, 1] > solve_h.FENCE_V]
    if len(d):
        _, uq = np.unique(np.round(d / 0.008).astype(np.int64), axis=0,
                          return_index=True)
        d = d[np.sort(uq)]
    mm = ((met[:, 0] > LO[0]) & (met[:, 0] < HI[0])
          & (met[:, 1] > LO[1]) & (met[:, 1] < HI[1]))
    met = met[mm]
    if len(d) < 4 or len(met) < 4:
        continue
    proj = cv2.perspectiveTransform(met[None], H)[0]
    C = np.linalg.norm(proj[:, None] - d[None], axis=2)
    ri, ci = linear_sum_assignment(np.minimum(C, GATE))
    good = C[ri, ci] < GATE
    M.extend(met[ri[good]].tolist())
    RTRUE.extend(d[ci[good]].tolist())
M = np.array(M); RTRUE = np.array(RTRUE)
m_true = cv2.perspectiveTransform(RTRUE[None].astype(np.float64), Hinv)[0]
D = M - m_true      # metric residual: H says here, detection says there
print(f'{len(M)} correspondences at gate {GATE}; '
      f'median |d| {np.median(np.linalg.norm(D, axis=1)):.3f}m')

BIN = 6.0
gx = np.floor((M[:, 0] - LO[0]) / BIN).astype(int)
gy = np.floor((M[:, 1] - LO[1]) / BIN).astype(int)
cells = {}
for i in range(len(M)):
    cells.setdefault((gx[i], gy[i]), []).append(i)
nx = int((HI[0] - LO[0]) / BIN) + 1
ny = int((HI[1] - LO[1]) / BIN) + 1

print('\nMEDIAN RESIDUAL VECTOR per 6m cell — (dx,dy) in metres, n>=20')
print('(dx>0 = H places the ring too far +x ; dy>0 = too far +y)')
print('          ' + ''.join(f'  x={LO[0] + (i + .5) * BIN:6.0f}    ' for i in range(nx)))
for j in range(ny):
    row = []
    for i in range(nx):
        idx = cells.get((i, j))
        if idx is None or len(idx) < 20:
            row.append('       .      ')
            continue
        md = np.median(D[idx], axis=0)
        row.append(f' ({md[0]:+.2f},{md[1]:+.2f}) ')
    print(f'y={LO[1] + (j + .5) * BIN:6.1f} |' + ''.join(row))

# direction coherence: is the field mostly ONE direction (parallel) ?
big = np.linalg.norm(D, axis=1) > 0.3
U = D[big] / np.linalg.norm(D[big], axis=1, keepdims=True)
mean_dir = U.mean(axis=0)
print(f'\nfield coherence (points with |d|>0.3m, n={big.sum()}):')
print(f'  mean unit vector = ({mean_dir[0]:+.3f}, {mean_dir[1]:+.3f}), '
      f'|mean| = {np.linalg.norm(mean_dir):.3f}   (1.0 = all parallel, '
      f'0 = isotropic/radial)')

# does |d| grow with distance from the CAMERA? approximate camera direction by
# the mesh: the pano image's bottom-centre looks near the camera.
r_len = np.linalg.norm(RTRUE, axis=1)
print(f'  corr(|d|, |rayn|)        = {np.corrcoef(np.linalg.norm(D, axis=1), r_len)[0, 1]:+.3f}')
print(f'  corr(|d|, |y - y_mid|)   = '
      f'{np.corrcoef(np.linalg.norm(D, axis=1), np.abs(M[:, 1] - (LO[1] + HI[1]) / 2))[0, 1]:+.3f}')
print(f'  corr(|d|, |x - x_mid|)   = '
      f'{np.corrcoef(np.linalg.norm(D, axis=1), np.abs(M[:, 0] - (LO[0] + HI[0]) / 2))[0, 1]:+.3f}')
np.savez(f'{OUT}/field06.npz', M=M, D=D, RTRUE=RTRUE, LO=LO, HI=HI)

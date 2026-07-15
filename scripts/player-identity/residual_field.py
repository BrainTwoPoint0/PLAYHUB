"""Diagnose the corner error: map the H residual across the pitch IN METRES.

A homography maps ANY plane exactly (tilt/height are absorbed). So a
systematic residual means one of:
  (a) the pitch is genuinely non-planar (crowned for drainage),
  (b) a constant HEIGHT offset between the tracker's plane and the feet
      (signature: residual radial from the camera nadir, growing with
      distance from it),
  (c) mesh/lens ray error at the rim (signature: structured in pano UV,
      not in pitch metric),
  (d) tracker noise (no structure).

Residual is converted from rayn to metres via the local inverse Jacobian of
H, so the numbers are "how far off the ring is on the grass".
"""
import json, os, sys
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
GAME_ID = 'd9fee1fc-76e9-439a-afb9-1e93e9f15733'
streams = json.load(open(f'{OUT}/cache/streams.json'))
START = streams['start_time_us']
H = np.array(json.load(open(f'{OUT}/prod-solve.json'))['H'])

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
LO, HI = solve_h.pitch_rect_metric(fragments)

# pool every cached detection window for max spatial coverage
det_frames = {}
import glob
for f in glob.glob(f'{OUT}/cache/det_*.json'):
    items = [(i, r.encode()) for i, r in json.load(open(f))]
    det_mod.parse_detection_items(items, uv_to_rayn, frames=det_frames)
print(f'{len(det_frames)} detection frames pooled')

pairs = solve_h.time_paired_sets(det_frames, fragments, LO, HI)
print(f'{len(pairs)} time-paired frames')

# matched correspondences at the eval gate, keeping the metric point + residual
M, RES, DRN = [], [], []
for drn, met in pairs:
    proj = cv2.perspectiveTransform(met[None].astype(np.float64), H)[0]
    C = np.linalg.norm(proj[:, None] - drn[None], axis=2)
    ri, ci = linear_sum_assignment(np.minimum(C, 0.03))
    good = C[ri, ci] < 0.03
    M.extend(met[ri[good]].tolist())
    RES.extend((proj[ri[good]] - drn[ci[good]]).tolist())   # rayn residual
    DRN.extend(drn[ci[good]].tolist())
M = np.array(M); RES = np.array(RES); DRN = np.array(DRN)
print(f'{len(M)} matched correspondences')

# ---- rayn residual -> METRIC residual via local inverse Jacobian -------------
Hinv = np.linalg.inv(H)
def jac_metric(m):
    """d(metric)/d(rayn) at the rayn point corresponding to metric m."""
    r0 = cv2.perspectiveTransform(m.reshape(1, 1, 2), H)[0, 0]
    e = 1e-4
    out = np.zeros((len(m), 2, 2)) if m.ndim > 1 else None
    return r0

# vectorised: perturb rayn by eps in each axis, map back through Hinv
r_proj = cv2.perspectiveTransform(M[None].astype(np.float64), H)[0]
r_true = r_proj - RES          # where the detection actually is
m_true = cv2.perspectiveTransform(r_true[None].astype(np.float64), Hinv)[0]
# metric residual = where H says the player is  MINUS  where they really are
d_metric = M - m_true
mag = np.linalg.norm(d_metric, axis=1)
print(f'\nmetric residual: median {np.median(mag):.2f}m  p90 {np.percentile(mag, 90):.2f}m')

# ---- spatial structure: bin over the pitch -----------------------------------
BIN = 6.0
gx = np.floor((M[:, 0] - LO[0]) / BIN).astype(int)
gy = np.floor((M[:, 1] - LO[1]) / BIN).astype(int)
nx, ny = gx.max() + 1, gy.max() + 1
print(f'\nper-cell MEDIAN residual vector (metres), grid {BIN}m  '
      f'[cell: |d| (dx,dy) n]')
cells = {}
for i in range(len(M)):
    cells.setdefault((gx[i], gy[i]), []).append(d_metric[i])
rows = []
for yy in range(ny):
    row = []
    for xx in range(nx):
        v = cells.get((xx, yy))
        if v is None or len(v) < 15:
            row.append('     .    ')
            continue
        md = np.median(np.array(v), axis=0)
        row.append(f'{np.linalg.norm(md):5.2f}    ')
    rows.append(f'y={LO[1] + yy * BIN:6.1f} |' + ''.join(row))
print('        ' + ''.join(f'x={LO[0] + xx * BIN:6.1f}  ' for xx in range(nx)))
for r in rows:
    print(r)

# ---- hypothesis (b): residual radial from a common origin? -------------------
# If a constant height offset dh exists, residual points along the direction
# from the camera nadir N through the player, magnitude ~ dh*|P-N|/h_cam.
# Fit N by least squares: minimise angle between d_metric and (P - N).
from scipy.optimize import minimize
big = mag > 0.15
P = M[big]; D = d_metric[big] / np.linalg.norm(d_metric[big], axis=1, keepdims=True)
def cost(n):
    v = P - n
    v = v / (np.linalg.norm(v, axis=1, keepdims=True) + 1e-9)
    return -np.abs((v * D).sum(axis=1)).mean()   # |cos| — allow either sign
best = None
for x0 in ([0, 0], [0, -40], [0, 40], [-40, 0], [40, 0]):
    r = minimize(cost, x0, method='Nelder-Mead')
    if best is None or r.fun < best.fun:
        best = r
N = best.x
v = P - N
v = v / (np.linalg.norm(v, axis=1, keepdims=True) + 1e-9)
align = np.abs((v * D).sum(axis=1))
print(f'\nradial-from-origin test (height-offset signature):')
print(f'  best origin N = ({N[0]:.1f}, {N[1]:.1f}) m')
print(f'  |cos(residual, radial-from-N)| : median {np.median(align):.3f} '
      f'mean {align.mean():.3f}  (1.0 = perfectly radial, 0.64 = random)')
dist = np.linalg.norm(P - N, axis=1)
corr = np.corrcoef(dist, mag[big])[0, 1]
print(f'  corr(|residual|, distance from N) = {corr:+.3f}')

# ---- hypothesis (c): structured in pano UV? ---------------------------------
# residual magnitude vs the detection's vertical pano position (rim proxy)
rayn_r = np.linalg.norm(DRN, axis=1)
print(f'\npano-structure test:')
print(f'  corr(|residual|, |rayn| of detection) = '
      f'{np.corrcoef(rayn_r, mag)[0, 1]:+.3f}')
for lo_q, hi_q in [(0, 25), (25, 50), (50, 75), (75, 100)]:
    a, b = np.percentile(rayn_r, [lo_q, hi_q])
    m = (rayn_r >= a) & (rayn_r <= b)
    print(f'  |rayn| {a:.2f}-{b:.2f}: median residual {np.median(mag[m]):.2f}m '
          f'(n={m.sum()})')

np.savez(f'{OUT}/residuals.npz', M=M, RES=RES, DRN=DRN, d_metric=d_metric,
         H=H, LO=LO, HI=HI)
print('\nsaved residuals.npz')

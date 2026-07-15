"""Honest correction validation: FIXED correspondence set.

Match once with the baseline H at a loose gate; then score baseline vs
correction on the SAME pairs (re-matching after correcting makes the median
self-selecting — more far-field points enter the gate and drag it up even as
accuracy improves).

Split fit/val by TIME BLOCK (frames are correlated; points are not iid).
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
LO, HI = solve_h.pitch_rect_metric(fragments)

det_frames = {}
for f in glob.glob(f'{OUT}/cache/det_*.json'):
    items = [(i, r.encode()) for i, r in json.load(open(f))]
    det_mod.parse_detection_items(items, uv_to_rayn, frames=det_frames)
print(f'{len(det_frames)} detection frames pooled')

# ---- fixed correspondence set, tagged with time ------------------------------
pairs = solve_h.time_paired_sets(det_frames, fragments, LO, HI)
# time_paired_sets sorts by ts; recover the ts order for block splitting
ts_sorted = []
for dt in sorted(det_frames):
    fuv, drn = det_frames[dt]
    ts_sorted.append(dt)
M, R, T = [], [], []
# re-derive pairs with timestamps (mirror time_paired_sets, keep dt)
spans = [(int(ts[0]), int(ts[-1]), ts.astype(np.float64), xy) for ts, xy in fragments]
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
    dm = fuv[:, 1] > solve_h.FENCE_V
    d = drn[dm]
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
    R.extend(d[ci[good]].tolist())
    T.extend([dt] * int(good.sum()))
M = np.array(M); R = np.array(R); T = np.array(T)
print(f'{len(M)} fixed correspondences at gate {GATE}')

def metric_err(Mpts, Rpts, delta=None):
    mc = Mpts - delta(Mpts) if delta is not None else Mpts
    proj = cv2.perspectiveTransform(mc[None].astype(np.float64), H)[0]
    m_true = cv2.perspectiveTransform(Rpts[None].astype(np.float64), Hinv)[0]
    return np.linalg.norm(mc - m_true, axis=1)

# ---- time-block split --------------------------------------------------------
blocks = ((T - T.min()) // int(30e6)).astype(int)   # 30s blocks
fit_mask = (blocks % 2) == 0
val_mask = ~fit_mask
print(f'fit {fit_mask.sum()} pts / val {val_mask.sum()} pts '
      f'({len(np.unique(blocks))} 30s blocks, alternating)')

cy = (LO[1] + HI[1]) / 2
def report(tag, delta=None):
    e = metric_err(M[val_mask], R[val_mask], delta)
    far = np.abs(M[val_mask][:, 1] - cy) > 18
    mid = np.abs(M[val_mask][:, 1] - cy) <= 10
    print(f'  {tag:22s} HELD-OUT median {np.median(e):.3f}m  p90 '
          f'{np.percentile(e, 90):.3f}m | ends {np.median(e[far]):.3f}m '
          f'(n={far.sum()}) | centre {np.median(e[mid]):.3f}m')
    return np.median(e[far])

def design(m, deg):
    x = (m[:, 0] - LO[0]) / (HI[0] - LO[0]) * 2 - 1
    y = (m[:, 1] - LO[1]) / (HI[1] - LO[1]) * 2 - 1
    return np.column_stack([(x ** i) * (y ** j)
                            for i in range(deg + 1)
                            for j in range(deg + 1 - i)])

print('\nSAME fixed pairs, scored:')
report('baseline (H only)')
for deg in (1, 2, 3, 4):
    A = design(M[fit_mask], deg)
    coef, *_ = np.linalg.lstsq(A, (M[fit_mask]
                                   - cv2.perspectiveTransform(
                                       R[fit_mask][None].astype(np.float64),
                                       Hinv)[0]), rcond=None)
    delta = lambda m, c=coef, d=deg: design(m, d) @ c
    report(f'poly deg {deg}', delta)
    np.save(f'{OUT}/corr2_deg{deg}.npy', coef)

# ---- match-rate view: does the correction bring far players INTO the gate? ----
print('\nmatch rate at the 0.03 product gate (ends only):')
for tag, delta in [('baseline', None),
                   ('poly deg 2', lambda m, c=np.load(f'{OUT}/corr2_deg2.npy'): design(m, 2) @ c),
                   ('poly deg 3', lambda m, c=np.load(f'{OUT}/corr2_deg3.npy'): design(m, 3) @ c)]:
    e = metric_err(M[val_mask], R[val_mask], delta)
    far = np.abs(M[val_mask][:, 1] - cy) > 18
    # convert 0.03 rayn gate to metres locally is awkward; report the fraction
    # of ends-correspondences whose metric error is under 0.3m (a ring that
    # visibly sits on the player)
    print(f'  {tag:12s} ends |err|<0.30m: {(e[far] < 0.3).mean() * 100:.1f}%  '
          f'<0.50m: {(e[far] < 0.5).mean() * 100:.1f}%')

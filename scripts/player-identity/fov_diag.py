"""Does the produced-overlay error grow with FOV and with distance from the
frame centre? That is the signature of a PROJECTION-MODEL mismatch in MY
render (I assume a pinhole; Spiideo rendered the Play mp4 with their own
projection), NOT of a bad spotlight artifact.

Distinguishing matters: the Explore player projects the ring through the SAME
camera that draws the pixels, so it is immune to this. Only the
produced-video overlay has to guess Spiideo's projection.
"""
import json, os, sys
sys.path.insert(0, '/Users/karimfawaz/Dev Projects/PLAYBACK Workspace/PLAYHUB/infrastructure/batch/player-tracklets')
import numpy as np
import cv2
from scipy.spatial import cKDTree
import detections as det_mod
from mesh_rays import load_mesh_rays, rayn_pan_tilt_deg
from ultralytics import YOLO

OUT = os.path.dirname(os.path.abspath(__file__))
streams = json.load(open(f'{OUT}/cache/streams.json'))
START = streams['start_time_us']
aim = json.load(open(f'{OUT}/aim-track.json'))
at = np.array(aim['t']); apan = np.array(aim['pan'])
atilt = np.array(aim['tilt']); afov = np.array(aim['fov'])

uv, rays = load_mesh_rays(f'{OUT}/mesh')
front = rays[:, 2] > 0.05
uv_f = uv[front]; rayn_all = rays[front][:, :2] / rays[front][:, 2:3]
uv_tree = cKDTree(uv_f)
def uv_to_rayn(pts):
    d, idx = uv_tree.query(pts, k=3)
    o = rayn_all[idx].mean(axis=1); o[d[:, 0] > 0.01] = np.nan
    return o

DEG = np.pi / 180
UP = np.array([0.0, -1.0, 0.0])
def dir_of(pan, tilt):
    p = np.asarray(pan) * DEG; t = np.asarray(tilt) * DEG
    return np.stack([-np.sin(p) * np.cos(t), -np.sin(t),
                     np.cos(p) * np.cos(t)], axis=-1)
def project(pans, tilts, cp, ct, fov_v, w, h):
    f = dir_of(cp, ct); z_ax = -f
    x_ax = np.cross(UP, z_ax); x_ax /= np.linalg.norm(x_ax)
    y_ax = np.cross(z_ax, x_ax)
    d = dir_of(pans, tilts)
    X = d @ x_ax; Y = d @ y_ax; Z = d @ z_ax
    depth = -Z; th = np.tan(fov_v / 2 * DEG)
    with np.errstate(divide='ignore', invalid='ignore'):
        nx = (X / depth) / (th * w / h); ny = (Y / depth) / th
    px = (nx + 1) / 2 * w; py = (1 - (ny + 1) / 2) * h
    px[depth < 0.05] = np.nan; py[depth < 0.05] = np.nan
    return np.column_stack([px, py])

model = YOLO('/Users/karimfawaz/Dev Projects/PLAYBACK Workspace/PLAYHUB/scripts/portrait-crop/yolov8x.pt')
rows = []
for frames_dir, T0, cache in (
        (f'{OUT}/frames_corner_cmp', 2940.0, f'{OUT}/cache/det_win_2940_12.json'),
        (f'{OUT}/frames_clean_mid', 1280.0, f'{OUT}/cache/det_win_1280_18.json')):
    det_frames = {}
    det_mod.parse_detection_items(
        [(i, r.encode()) for i, r in json.load(open(cache))], uv_to_rayn,
        frames=det_frames)
    det_ts = np.array(sorted(det_frames))
    files = sorted(os.listdir(frames_dir))[::3]
    for fn in files:
        idx = int(fn.split('_')[1].split('.')[0]) - 1
        t = T0 + idx / 12.5
        im = cv2.imread(f'{frames_dir}/{fn}')
        h, w = im.shape[:2]
        r = model(im, verbose=False, classes=[0], conf=0.35)[0]
        b = r.boxes.xyxy.cpu().numpy()
        if not len(b):
            continue
        feet = np.column_stack([(b[:, 0] + b[:, 2]) / 2, b[:, 3]])
        dt_us = START + int(t * 1e6)
        j = det_ts[np.argmin(np.abs(det_ts - dt_us))]
        if abs(int(j) - dt_us) > 200_000:
            continue
        _, rn = det_frames[j]
        pan, tilt = rayn_pan_tilt_deg(rn)
        cam = (float(np.interp(t, at, apan)), float(np.interp(t, at, atilt)),
               float(np.interp(t, at, afov)))
        px = project(pan, tilt, *cam, w, h)
        px = px[np.isfinite(px[:, 0])]
        if len(px) < 3:
            continue
        tr = cKDTree(px)
        d, _ = tr.query(feet)
        # radial distance of each YOLO foot from the frame centre, normalised
        rad = np.linalg.norm(feet - np.array([w / 2, h / 2]), axis=1) / (w / 2)
        for dd, rr in zip(d, rad):
            if dd < 400:
                rows.append((cam[2], rr, dd))
rows = np.array(rows)
print(f'{len(rows)} YOLO feet matched\n')
print('error vs FOV (vertical degrees):')
for lo, hi in [(15, 25), (25, 35), (35, 45), (45, 70)]:
    m = (rows[:, 0] >= lo) & (rows[:, 0] < hi)
    if m.sum() > 20:
        print(f'  fov {lo:2d}-{hi:2d}: median {np.median(rows[m, 2]):5.1f}px  '
              f'(n={m.sum()})')
print('\nerror vs distance from frame centre (0=centre, 1=edge):')
for lo, hi in [(0, .25), (.25, .5), (.5, .75), (.75, 1.5)]:
    m = (rows[:, 1] >= lo) & (rows[:, 1] < hi)
    if m.sum() > 20:
        print(f'  r {lo:.2f}-{hi:.2f}: median {np.median(rows[m, 2]):5.1f}px  '
              f'(n={m.sum()})')
print(f'\ncorr(error, fov)              = {np.corrcoef(rows[:, 0], rows[:, 2])[0, 1]:+.3f}')
print(f'corr(error, radius-from-centre) = {np.corrcoef(rows[:, 1], rows[:, 2])[0, 1]:+.3f}')
# narrow-fov, central subset = the regime where a pinhole is a good model
m = (rows[:, 0] < 30) & (rows[:, 1] < 0.5)
print(f'\nnarrow fov (<30) AND central (r<0.5): median '
      f'{np.median(rows[m, 2]):.1f}px (n={m.sum()})')
m2 = (rows[:, 0] > 45)
print(f'wide fov (>45): median {np.median(rows[m2, 2]):.1f}px (n={m2.sum()})')

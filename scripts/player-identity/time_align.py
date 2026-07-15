"""Is the produced-video overlay misaligned in TIME?

Detect people directly in the PRODUCED frames with YOLO -> foot points.
Then project Spiideo's pano detections through the aim pose sampled at t+dt,
and scan dt. The dt that minimises the mismatch tells us whether our frame
clock, the aim track, or neither is offset.

Control: the clip Karim judged accurate (t~1280) should peak at dt=0.
"""
import json, os, sys, glob
sys.path.insert(0, '/Users/karimfawaz/Dev Projects/PLAYBACK Workspace/PLAYHUB/infrastructure/batch/player-tracklets')
import numpy as np
import cv2
from scipy.spatial import cKDTree
import detections as det_mod
from mesh_rays import load_mesh_rays

OUT = os.path.dirname(os.path.abspath(__file__))
GAME_ID = 'd9fee1fc-76e9-439a-afb9-1e93e9f15733'
streams = json.load(open(f'{OUT}/cache/streams.json'))
START = streams['start_time_us']
aim = json.load(open(f'{OUT}/aim-track.json'))
at = np.array(aim['t']); apan = np.array(aim['pan'])
atilt = np.array(aim['tilt']); afov = np.array(aim['fov'])

uv, rays = load_mesh_rays(f'{OUT}/mesh')
front = rays[:, 2] > 0.05
uv_f = uv[front]
rayn_all = rays[front][:, :2] / rays[front][:, 2:3]
uv_tree = cKDTree(uv_f)
def uv_to_rayn(pts):
    d, idx = uv_tree.query(pts, k=3)
    o = rayn_all[idx].mean(axis=1)
    o[d[:, 0] > 0.01] = np.nan
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
    depth = -Z
    th = np.tan(fov_v / 2 * DEG)
    with np.errstate(divide='ignore', invalid='ignore'):
        nx = (X / depth) / (th * w / h); ny = (Y / depth) / th
    px = (nx + 1) / 2 * w; py = (1 - (ny + 1) / 2) * h
    bad = depth < 0.05
    px[bad] = np.nan; py[bad] = np.nan
    return np.column_stack([px, py])

from ultralytics import YOLO
model = YOLO('/Users/karimfawaz/Dev Projects/PLAYBACK Workspace/PLAYHUB/scripts/portrait-crop/yolov8x.pt')

def analyse(frames_dir, T0, fps, det_cache_file, label):
    files = sorted(os.listdir(frames_dir))[::5]
    det_frames = {}
    det_mod.parse_detection_items(
        [(i, r.encode()) for i, r in json.load(open(det_cache_file))],
        uv_to_rayn, frames=det_frames)
    det_ts = np.array(sorted(det_frames))

    def pano_dets_at(t):
        dt_us = START + int(t * 1e6)
        j = det_ts[np.argmin(np.abs(det_ts - dt_us))]
        if abs(int(j) - dt_us) > 200_000:
            return np.zeros((0, 2))
        _, rn = det_frames[j]
        from mesh_rays import rayn_pan_tilt_deg
        pan, tilt = rayn_pan_tilt_deg(rn)
        return np.column_stack([pan, tilt])

    # YOLO people in the produced frames
    truth = {}
    for fn in files:
        idx = int(fn.split('_')[1].split('.')[0]) - 1
        t = T0 + idx / fps
        im = cv2.imread(f'{frames_dir}/{fn}')
        r = model(im, verbose=False, classes=[0], conf=0.35)[0]
        b = r.boxes.xyxy.cpu().numpy()
        if len(b):
            feet = np.column_stack([(b[:, 0] + b[:, 2]) / 2, b[:, 3]])
            truth[t] = feet
    h, w = cv2.imread(f'{frames_dir}/{files[0]}').shape[:2]
    n_people = np.median([len(v) for v in truth.values()])
    print(f'\n{label}: {len(truth)} frames, median {n_people:.0f} people/frame '
          f'detected in the produced video')

    rows = []
    for dt in np.arange(-3.0, 3.01, 0.25):
        errs = []
        for t, feet in truth.items():
            ts = t + dt
            cam = (float(np.interp(ts, at, apan)), float(np.interp(ts, at, atilt)),
                   float(np.interp(ts, at, afov)))
            pd = pano_dets_at(ts)
            if not len(pd):
                continue
            px = project(pd[:, 0], pd[:, 1], *cam, w, h)
            px = px[np.isfinite(px[:, 0])]
            inb = px[(px[:, 0] > -100) & (px[:, 0] < w + 100)
                     & (px[:, 1] > -100) & (px[:, 1] < h + 100)]
            if len(inb) < 3:
                continue
            tr = cKDTree(inb)
            d, _ = tr.query(feet)
            errs.extend(d[d < 400].tolist())
        if len(errs) > 30:
            rows.append((dt, float(np.median(errs)), len(errs)))
    rows.sort(key=lambda r: r[1])
    print(f'  best dt = {rows[0][0]:+.2f}s -> median YOLO-foot to '
          f'projected-detection distance {rows[0][1]:.1f}px')
    print(f'  dt= 0.00s -> ' + next(f'{m:.1f}px' for d_, m, _ in rows if abs(d_) < 1e-6))
    print('  scan (dt, px):', ' '.join(f'{d_:+.2f}:{m:.0f}' for d_, m, _ in
                                       sorted(rows)[::2]))
    return rows[0][0]

# corner clip (Karim: "not even close")
analyse(f'{OUT}/frames_corner_cmp', 2940.0, 12.5,
        f'{OUT}/cache/det_win_2940_12.json', 'CORNER clip t=2940 (fast camera)')
# control: the clip Karim judged accurate
if os.path.isdir(f'{OUT}/frames_clean_mid'):
    cf = f'{OUT}/cache/det_win_1280_18.json'
    if not os.path.exists(cf):
        w = (START + int(1280 * 1e6), START + int(1298 * 1e6))
        items = det_mod.fetch_window_items(GAME_ID, streams['detections'][0], w)
        json.dump([(i, r.decode()) for i, r in items], open(cf, 'w'))
    analyse(f'{OUT}/frames_clean_mid', 1280.0, 12.5, cf,
            'CONTROL clip t=1280 ("accurate, more or less")')

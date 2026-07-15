"""Render spotlight rings onto the PRODUCED (auto-follow) Play mp4.

Camera model — verified symbolically against VirtualPanoramaPlayer:
  dir(pan,tilt) = (-sin pan cos tilt, -sin tilt, cos pan cos tilt)
  (== mesh_rays.pan_tilt_deg inverse; equals the client's
   forward=(0,0,1) / up=(0,-1,0) / right=(1,0,0) basis composition)
  camera at origin, looks along dir(aim_pan, aim_tilt), world up = (0,-1,0),
  three.js lookAt basis, PerspectiveCamera.fov = VERTICAL degrees.

Overlays:
  GREEN  = Spiideo person detections, pano uv -> mesh ray -> pan/tilt.
           Ground truth: independent of H. If greens sit on players, the
           camera model + aim track are right.
  RED    = tracklets metric -> H -> rayn -> pan/tilt. Shows H error.

usage: produced_overlay.py T0 DUR OUTNAME [--clean]
"""
import json, os, subprocess, sys
sys.path.insert(0, '/Users/karimfawaz/Dev Projects/PLAYBACK Workspace/PLAYHUB/infrastructure/batch/player-tracklets')
import numpy as np
import cv2
from scipy.spatial import cKDTree
import build_track
import detections as det_mod
import spiideo
from mesh_rays import load_mesh_rays, rayn_pan_tilt_deg

OUT = os.path.dirname(os.path.abspath(__file__))
GAME_ID = 'd9fee1fc-76e9-439a-afb9-1e93e9f15733'
PROD_KEY = 'recordings/2026-07-10/d9fee1fc-76e9-439a-afb9-1e93e9f15733/4bd703bf-ccf7-49ad-8c00-619becc2cfac.mp4'
BUCKET = 'playhub-recordings-eu-west-2'

T0 = float(sys.argv[1]); DUR = float(sys.argv[2]); NAME = sys.argv[3]
CLEAN = '--clean' in sys.argv
FPS = 12.5

streams = json.load(open(f'{OUT}/cache/streams.json'))
START = streams['start_time_us']
H = np.array(json.load(open(f'{OUT}/prod-solve.json'))['H'])

# ---- mesh + uv<->ray ---------------------------------------------------------
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

# ---- artifacts ---------------------------------------------------------------
aim = json.load(open(f'{OUT}/aim-track.json'))
at = np.array(aim['t']); apan = np.array(aim['pan'])
atilt = np.array(aim['tilt']); afov = np.array(aim['fov'])

trk_items = [(i, r.encode()) for i, r in json.load(open(f'{OUT}/cache/trk_items.json'))]
fragments = build_track.parse_items(trk_items, START, 16_000_000)
spans = [(int(ts[0]), int(ts[-1]), ts.astype(np.float64), xy) for ts, xy in fragments]

def tracklets_at(t_s):
    """-> (pan, tilt) arrays of every tracked player at produced-video time t."""
    dt = START + int(t_s * 1e6)
    met = []
    for t0, t1, ts, xy in spans:
        if t0 <= dt <= t1:
            j = int(np.searchsorted(ts, dt))
            if 0 < j < len(ts) and dt != ts[j - 1] and ts[j] - ts[j - 1] > 600_000:
                continue
            met.append([np.interp(dt, ts, xy[:, 0]), np.interp(dt, ts, xy[:, 1])])
    if not met:
        return np.zeros((0, 2))
    rn = cv2.perspectiveTransform(np.array(met, np.float64)[None], H)[0]
    pan, tilt = rayn_pan_tilt_deg(rn)
    return np.column_stack([pan, tilt])

# ---- detections in the window (ground truth) ---------------------------------
det_frames = {}
if not CLEAN:
    cache = f'{OUT}/cache/det_win_{int(T0)}_{int(DUR)}.json'
    if os.path.exists(cache):
        items = [(i, r.encode()) for i, r in json.load(open(cache))]
    else:
        w = (START + int(T0 * 1e6), START + int((T0 + DUR) * 1e6))
        items = det_mod.fetch_window_items(GAME_ID, streams['detections'][0], w)
        json.dump([(i, r.decode()) for i, r in items], open(cache, 'w'))
    det_mod.parse_detection_items(items, uv_to_rayn, frames=det_frames)
    print(f'{len(det_frames)} detection frames in window')
det_ts = np.array(sorted(det_frames)) if det_frames else np.zeros(0)

def detections_at(t_s):
    if not len(det_ts):
        return np.zeros((0, 2))
    dt = START + int(t_s * 1e6)
    j = det_ts[np.argmin(np.abs(det_ts - dt))]
    if abs(int(j) - dt) > 250_000:
        return np.zeros((0, 2))
    _, rn = det_frames[j]
    pan, tilt = rayn_pan_tilt_deg(rn)
    return np.column_stack([pan, tilt])

# ---- projection --------------------------------------------------------------
DEG = np.pi / 180
UP = np.array([0.0, -1.0, 0.0])

def dir_of(pan_deg, tilt_deg):
    p = np.asarray(pan_deg) * DEG
    t = np.asarray(tilt_deg) * DEG
    return np.stack([-np.sin(p) * np.cos(t), -np.sin(t),
                     np.cos(p) * np.cos(t)], axis=-1)

def project(pans, tilts, cam_pan, cam_tilt, fov_v, w, h):
    """-> (N,2) pixel coords (nan where behind/outside)."""
    f = dir_of(cam_pan, cam_tilt)
    z_ax = -f
    x_ax = np.cross(UP, z_ax); x_ax /= np.linalg.norm(x_ax)
    y_ax = np.cross(z_ax, x_ax)
    d = dir_of(pans, tilts)
    X = d @ x_ax; Y = d @ y_ax; Z = d @ z_ax
    depth = -Z
    tan_half = np.tan(fov_v / 2 * DEG)
    aspect = w / h
    with np.errstate(divide='ignore', invalid='ignore'):
        ndc_x = (X / depth) / (tan_half * aspect)
        ndc_y = (Y / depth) / tan_half
    px = (ndc_x + 1) / 2 * w
    py = (1 - (ndc_y + 1) / 2) * h
    bad = depth < 0.05
    px[bad] = np.nan; py[bad] = np.nan
    return np.column_stack([px, py])

# ---- extract frames ----------------------------------------------------------
url = subprocess.check_output(
    ['aws', 's3', 'presign', f's3://{BUCKET}/{PROD_KEY}', '--expires-in', '7200',
     '--region', 'eu-west-2'],
    env={**os.environ, 'AWS_PROFILE': 'playhub'}).decode().strip()
frames_dir = f'{OUT}/frames_{NAME}'
os.makedirs(frames_dir, exist_ok=True)
if not os.listdir(frames_dir):
    print('extracting frames...', flush=True)
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-ss', f'{T0:.3f}',
                    '-i', url, '-t', f'{DUR:.3f}', '-vf', f'fps={FPS}',
                    f'{frames_dir}/f_%05d.png'], check=True)
files = sorted(os.listdir(frames_dir))
print(f'{len(files)} frames')

first = cv2.imread(f'{frames_dir}/{files[0]}')
Hpx, Wpx = first.shape[:2]
print(f'produced video {Wpx}x{Hpx}')

vw = cv2.VideoWriter(f'{OUT}/{NAME}.mp4', cv2.VideoWriter_fourcc(*'mp4v'),
                     FPS, (Wpx, Hpx))
stats = []
for i, fn in enumerate(files):
    im = cv2.imread(f'{frames_dir}/{fn}')
    t = T0 + i / FPS
    j = int(np.argmin(np.abs(at - t)))
    cam = (float(np.interp(t, at, apan)), float(np.interp(t, at, atilt)),
           float(np.interp(t, at, afov)))
    tp = tracklets_at(t)
    if len(tp):
        px = project(tp[:, 0], tp[:, 1], *cam, Wpx, Hpx)
        for (x, y) in px:
            if np.isfinite(x) and -50 < x < Wpx + 50 and -50 < y < Hpx + 50:
                cv2.circle(im, (int(x), int(y)), 26, (60, 60, 235), 3)
    if not CLEAN:
        dp = detections_at(t)
        if len(dp):
            dpx = project(dp[:, 0], dp[:, 1], *cam, Wpx, Hpx)
            for (x, y) in dpx:
                if np.isfinite(x) and -50 < x < Wpx + 50 and -50 < y < Hpx + 50:
                    cv2.circle(im, (int(x), int(y)), 18, (60, 235, 60), 3)
        # nearest-neighbour offset red->green (the visible error, in px)
        if len(tp) and len(dp):
            g = dpx[np.isfinite(dpx[:, 0])]
            r = px[np.isfinite(px[:, 0])]
            if len(g) and len(r):
                D = np.linalg.norm(r[:, None] - g[None], axis=2)
                m = D.min(axis=1)
                stats.extend(m[m < 200].tolist())
        cv2.putText(im, f't={t:.1f}s  fov={cam[2]:.0f}  GREEN=detections(GT)'
                    f'  RED=tracklets via H', (14, 34),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
    vw.write(im)
vw.release()
if stats:
    print(f'red->green nearest offset: median {np.median(stats):.1f}px '
          f'p90 {np.percentile(stats, 90):.1f}px (n={len(stats)})')
print('wrote', f'{OUT}/{NAME}.mp4')

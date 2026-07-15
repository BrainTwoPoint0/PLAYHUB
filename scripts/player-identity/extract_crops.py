"""Extract per-player crops from the raw panorama, labelled by CHAIN ID.

Ground truth: within one chain, Spiideo's tracker held identity — so two
crops from the same chain ARE the same player. That gives us a real re-ID
benchmark with zero manual labelling.

For each sampled instant: project every live chain -> rayn -> pano uv, match
to Spiideo's own detection box (unambiguously, or skip), crop it.
"""
import json, os, subprocess, sys, glob, shutil
sys.path.insert(0, '/Users/karimfawaz/Dev Projects/PLAYBACK Workspace/PLAYHUB/infrastructure/batch/player-tracklets')
import numpy as np
import cv2
from scipy.spatial import cKDTree
import build_track
import detections as det_mod
import solve_h
from mesh_rays import load_mesh_rays

OUT = os.path.dirname(os.path.abspath(__file__))
GAME_ID = 'd9fee1fc-76e9-439a-afb9-1e93e9f15733'
RAW_KEY = 'panoramas/d9fee1fc-76e9-439a-afb9-1e93e9f15733/d949295d-206f-4893-88a8-dc6e2c539d7b.mp4'
BUCKET = 'playhub-recordings-eu-west-2'
CROPDIR = f'{OUT}/crops'
WINDOWS = [(400, 40), (1000, 40), (1600, 40), (2200, 40), (2800, 40)]
FPS = 0.5          # a crop set every 2s
MATCH_PX = 45      # chain->detection association gate
AMBIG = 1.8

streams = json.load(open(f'{OUT}/cache/streams.json'))
START = streams['start_time_us']
H = np.array(json.load(open(f'{OUT}/prod-solve.json'))['H'])

uv, rays = load_mesh_rays(f'{OUT}/mesh')
front = rays[:, 2] > 0.05
uv_f = uv[front]
rayn_all = rays[front][:, :2] / rays[front][:, 2:3]
uv_tree = cKDTree(uv_f)
rayn_tree = cKDTree(rayn_all)
def uv_to_rayn(pts):
    d, idx = uv_tree.query(pts, k=3)
    o = rayn_all[idx].mean(axis=1); o[d[:, 0] > 0.01] = np.nan
    return o
def rayn_to_uv(pts):
    _, idx = rayn_tree.query(pts, k=3)
    return uv_f[idx].mean(axis=1)

trk_items = [(i, r.encode()) for i, r in json.load(open(f'{OUT}/cache/trk_items.json'))]
fragments = build_track.parse_items(trk_items, START, 16_000_000)
LO, HI = solve_h.pitch_rect_metric(fragments)
on = build_track.filter_on_pitch(fragments, LO, HI)
chains = build_track.filter_chains_on_pitch(build_track.stitch(on), LO, HI)
print(f'{len(chains)} chains')

url = subprocess.check_output(
    ['aws', 's3', 'presign', f's3://{BUCKET}/{RAW_KEY}', '--expires-in', '10800',
     '--region', 'eu-west-2'],
    env={**os.environ, 'AWS_PROFILE': 'playhub'}).decode().strip()

os.makedirs(CROPDIR, exist_ok=True)
manifest = []
for (T0, DUR) in WINDOWS:
    tmp = f'{OUT}/_rawframes'
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp)
    print(f'\nwindow t={T0}..{T0 + DUR}s: extracting…', flush=True)
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-ss', str(T0),
                    '-i', url, '-t', str(DUR), '-vf', f'fps={FPS}',
                    '-q:v', '2', f'{tmp}/f_%04d.jpg'], check=True)
    files = sorted(os.listdir(tmp))
    # detections for this window
    cache = f'{OUT}/cache/det_crop_{T0}.json'
    if os.path.exists(cache):
        items = [(i, r.encode()) for i, r in json.load(open(cache))]
    else:
        w = (START + int(T0 * 1e6), START + int((T0 + DUR) * 1e6))
        items = det_mod.fetch_window_items(GAME_ID, streams['detections'][0], w)
        json.dump([(i, r.decode()) for i, r in items], open(cache, 'w'))
    # raw boxes keyed by ts (need the BOX, not just the foot)
    boxes = {}
    for _, raw in items:
        d = json.loads(raw)
        for cr in d.get('camera_results', []):
            for r in cr.get('results', []):
                bb = [b['bounding_box'] for b in r.get('detections', [])
                      if b.get('label') == 1]
                if bb:
                    boxes.setdefault(int(r['timestamp']), []).extend(bb)
    bts = np.array(sorted(boxes))
    print(f'  {len(files)} frames, {len(bts)} detection instants')

    for fi, fn in enumerate(files):
        t = T0 + fi / FPS
        dt_us = START + int(t * 1e6)
        if not len(bts):
            continue
        j = int(bts[np.argmin(np.abs(bts - dt_us))])
        if abs(j - dt_us) > 300_000:
            continue
        bl = boxes[j]
        feet_uv = np.array([[b['x'] + b['width'] / 2, b['y'] + b['height']]
                            for b in bl])
        img = cv2.imread(f'{tmp}/{fn}')
        if img is None:
            continue
        Ph, Pw = img.shape[:2]
        feet_px = feet_uv * [Pw, Ph]
        ftree = cKDTree(feet_px)
        # live chains at t
        for ci, (ts, xy) in enumerate(chains):
            if not (ts[0] <= dt_us <= ts[-1]):
                continue
            pos = np.array([[np.interp(dt_us, ts.astype(np.float64), xy[:, 0]),
                             np.interp(dt_us, ts.astype(np.float64), xy[:, 1])]])
            rn = cv2.perspectiveTransform(pos[None], H)[0]
            u = rayn_to_uv(rn)[0] * [Pw, Ph]
            d, idx = ftree.query(u, k=min(2, len(feet_px)))
            d = np.atleast_1d(d); idx = np.atleast_1d(idx)
            if d[0] > MATCH_PX:
                continue
            if len(d) > 1 and d[1] < AMBIG * d[0]:
                continue          # ambiguous -> would mislabel the crop
            b = bl[idx[0]]
            x0 = int(b['x'] * Pw); y0 = int(b['y'] * Ph)
            x1 = int((b['x'] + b['width']) * Pw)
            y1 = int((b['y'] + b['height']) * Ph)
            pad = int(0.12 * (y1 - y0))
            x0 = max(0, x0 - pad); y0 = max(0, y0 - pad)
            x1 = min(Pw, x1 + pad); y1 = min(Ph, y1 + pad)
            if x1 - x0 < 16 or y1 - y0 < 32:
                continue
            crop = img[y0:y1, x0:x1]
            name = f'c{ci:05d}_t{t:07.1f}.jpg'
            cv2.imwrite(f'{CROPDIR}/{name}', crop)
            manifest.append({'chain': int(ci), 't': float(t), 'file': name,
                             'metric': pos[0].tolist(),
                             'h': int(y1 - y0), 'w': int(x1 - x0)})
    shutil.rmtree(tmp, ignore_errors=True)

json.dump(manifest, open(f'{OUT}/crops_manifest.json', 'w'))
ch = {}
for m in manifest:
    ch.setdefault(m['chain'], []).append(m)
multi = {k: v for k, v in ch.items() if len(v) >= 2}
print(f'\n{len(manifest)} crops, {len(ch)} chains, '
      f'{len(multi)} chains with >=2 crops (usable as query/gallery pairs)')
hs = [m['h'] for m in manifest]
print(f'crop height px: median {np.median(hs):.0f} p10 {np.percentile(hs, 10):.0f}')

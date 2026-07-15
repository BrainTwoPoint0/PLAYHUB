"""Find produced-video times where a tracked player sits in a pitch CORNER
and the produced camera (aim track) is actually looking at them."""
import json, os, sys
sys.path.insert(0, '/Users/karimfawaz/Dev Projects/PLAYBACK Workspace/PLAYHUB/infrastructure/batch/player-tracklets')
import numpy as np
import cv2
import build_track
import solve_h
from mesh_rays import rayn_pan_tilt_deg

OUT = os.path.dirname(os.path.abspath(__file__))
streams = json.load(open(f'{OUT}/cache/streams.json'))
START = streams['start_time_us']

H = np.array(json.load(open(f'{OUT}/prod-solve.json'))['H']) if os.path.exists(f'{OUT}/prod-solve.json') else np.load(f'{OUT}/H_PROD.npy')
trk_items = [(i, r.encode()) for i, r in json.load(open(f'{OUT}/cache/trk_items.json'))]
fragments = build_track.parse_items(trk_items, START, 16_000_000)
LO, HI = solve_h.pitch_rect_metric(fragments)
print(f'pitch rect x[{LO[0]:.1f},{HI[0]:.1f}] y[{LO[1]:.1f},{HI[1]:.1f}]')

aim = json.load(open(f'{OUT}/aim-track.json'))
at = np.array(aim['t']); apan = np.array(aim['pan']); atilt = np.array(aim['tilt']); afov = np.array(aim['fov'])

# real (unpadded) pitch corners
PAD = 3.0
lo = np.array(LO) + PAD
hi = np.array(HI) - PAD
corners = {'far-left': (lo[0], lo[1]), 'far-right': (hi[0], lo[1]),
           'near-left': (lo[0], hi[1]), 'near-right': (hi[0], hi[1])}
print('corners:', {k: (round(v[0], 1), round(v[1], 1)) for k, v in corners.items()})

hits = {k: [] for k in corners}
for ts, xy in fragments:
    t_s = (ts - START) / 1e6
    rn = cv2.perspectiveTransform(xy[None].astype(np.float64), H)[0]
    pan, tilt = rayn_pan_tilt_deg(rn)
    for name, (cx, cy) in corners.items():
        d = np.hypot(xy[:, 0] - cx, xy[:, 1] - cy)
        near = d < 7.0
        if not near.any():
            continue
        for k in np.where(near)[0]:
            t = t_s[k]
            j = int(np.argmin(np.abs(at - t)))
            if abs(at[j] - t) > 0.3:
                continue
            # visible? angular offset from the produced camera axis vs its fov
            dpan = abs(((pan[k] - apan[j] + 180) % 360) - 180)
            dtilt = abs(tilt[k] - atilt[j])
            fov_v = afov[j]
            fov_h = np.degrees(2 * np.arctan(np.tan(np.radians(fov_v / 2)) * 16 / 9))
            if dpan < fov_h * 0.36 and dtilt < fov_v * 0.36:
                hits[name].append((t, float(xy[k, 0]), float(xy[k, 1]),
                                   float(d[k]), float(fov_v)))

for name, v in hits.items():
    v.sort()
    print(f'\n{name}: {len(v)} visible-in-corner samples')
    # contiguous runs
    runs = []
    for t, x, y, d, fv in v:
        if runs and t - runs[-1][-1][0] < 1.5:
            runs[-1].append((t, x, y, d, fv))
        else:
            runs.append([(t, x, y, d, fv)])
    runs = [r for r in runs if len(r) >= 12]
    runs.sort(key=lambda r: -len(r))
    for r in runs[:4]:
        print(f'   run t={r[0][0]:.1f}..{r[-1][0]:.1f}s ({len(r)} samples) '
              f'closest {min(x[3] for x in r):.1f}m fov~{np.median([x[4] for x in r]):.0f}')

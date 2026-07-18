"""Phase-0: theta/azimuth coverage of the harvested reg-SIFT correspondences.

The fit is used ONLY to bin matched raw pixels into theta/az cells (coverage
question), not to score anything. Kill criterion: if the render never yields
rim-band (theta>80) matches on the RIGHT side (az 330-30 about the principal
point), the premise dies here.

  python3 phase0.py <matches.npz> <fit.json>
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fisheye_model import kb_params, unproject  # noqa: E402


def main():
    npz = np.load(sys.argv[1])
    fit = json.load(open(sys.argv[2]))
    M = npz['matches']  # t, window, play_x, play_y, raw_x, raw_y
    F, cx, cy, ks = kb_params(fit)
    rays, ok = unproject(M[:, 4:6], F, cx, cy, ks)
    th = np.degrees(np.arccos(np.clip(rays[:, 2], -1, 1)))
    az = np.degrees(np.arctan2(M[:, 5] - cy, M[:, 4] - cx)) % 360.0
    print(f'{len(M)} matches, {len(np.unique(M[:, 0]))} frames; theta range '
          f'[{th.min():.1f}, {th[ok].max():.1f}] (invertible {ok.mean() * 100:.1f}%)')

    sectors = {'RIGHT az330-30': ((az >= 330) | (az < 30)),
               'BOT-R az30-90': (az >= 30) & (az < 90),
               'BOTTOM az90-150': (az >= 90) & (az < 150),
               'LEFT az150-210': (az >= 150) & (az < 210),
               'TOP-L az210-270': (az >= 210) & (az < 270),
               'TOP-R az270-330': (az >= 270) & (az < 330)}
    bands = [(0, 75), (75, 80), (80, 85), (85, 88), (88, 92), (92, 120)]
    hdr = 'sector           ' + ''.join(f'  th{a}-{b}' if b < 120 else '  th>92 '
                                        for a, b in bands) + '  maxth  frames(th>80)'
    print(hdr)
    for name, m in sectors.items():
        cells = ''.join(f'{(m & (th >= a) & (th < b)).sum():8d}' for a, b in bands)
        rim = m & (th > 80)
        nfr = len(np.unique(M[rim, 0]))
        mx = th[m].max() if m.any() else float('nan')
        print(f'{name:<17}{cells}  {mx:5.1f}  {nfr:6d}')

    # per-frame rim yield on the right side — which framings produce it
    rim_r = ((az >= 330) | (az < 30)) & (th > 80)
    if rim_r.any():
        ts, cnt = np.unique(M[rim_r, 0], return_counts=True)
        top = np.argsort(-cnt)[:10]
        print('top right-rim frames (t_stream, n):',
              [(float(ts[i]), int(cnt[i])) for i in top])


if __name__ == '__main__':
    main()

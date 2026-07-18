"""Promote a harvest (matches.npz) to the production constraint artifact
{site}-regsift.npz consumed by regsift_rim.py.

Filters: per-frame n>=30 matches, play-frame spread >=0.25, render fov <=
FOV_MAX (their render's non-pinhole error grows with fov — measured this
session: fov 45-65 median 4.9-8 mrad vs 4.5 at 15-30). Caps: spatial-grid
subsample to CAP matches/frame; frames ranked by max theta reached (through
BIN_FIT, coverage-binning only) with an az-sector quota so one side cannot
crowd out the other; total <= MAX_FRAMES.

  python3 promote.py <matches.npz> <aim.json> <bin_fit.json> <out.npz>
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fisheye_model import kb_params, unproject  # noqa: E402

FOV_MAX = 45.0
CAP = 120
MAX_FRAMES = 60
MIN_MATCHES = 30
MIN_SPREAD = 0.25


def grid_cap(play, cap):
    if len(play) <= cap:
        return np.arange(len(play))
    g = 8
    cell = (np.clip(play[:, 0] // (1920 / g), 0, g - 1) * g
            + np.clip(play[:, 1] // (1080 / g), 0, g - 1)).astype(int)
    # round-robin across spatial cells so the cap keeps frame-wide coverage
    rng = np.random.default_rng(0)
    by_cell = {}
    for i in np.arange(len(play)):
        by_cell.setdefault(cell[i], []).append(i)
    for c in by_cell:
        rng.shuffle(by_cell[c])
    picked = []
    while len(picked) < cap:
        added = False
        for c in list(by_cell):
            if by_cell[c]:
                picked.append(by_cell[c].pop())
                added = True
                if len(picked) >= cap:
                    break
        if not added:
            break
    return np.array(sorted(picked))


def main():
    npz = np.load(sys.argv[1])
    aim = json.load(open(sys.argv[2]))
    fit = json.load(open(sys.argv[3]))
    out = sys.argv[4]
    M = npz['matches']
    if '--windows' in sys.argv:
        wl = [float(w) for w in
              sys.argv[sys.argv.index('--windows') + 1].split(',')]
        M = M[np.isin(M[:, 1], wl)]
        print(f'window filter {wl}: {len(M)} matches')
    F, cx, cy, ks = kb_params(fit)
    rays, ok = unproject(M[:, 4:6], F, cx, cy, ks)
    th = np.degrees(np.arccos(np.clip(rays[:, 2], -1, 1)))
    az = np.degrees(np.arctan2(M[:, 5] - cy, M[:, 4] - cx)) % 360.0
    fov = np.interp(M[:, 0], aim['t'], aim['fov'])

    cands = []
    for t in np.unique(M[:, 0]):
        fm = np.where(M[:, 0] == t)[0]
        if len(fm) < MIN_MATCHES:
            continue
        play = M[fm, 2:4]
        spread = np.hypot(*(play.max(0) - play.min(0))) / np.hypot(1920, 1080)
        if spread < MIN_SPREAD or fov[fm].mean() > FOV_MAX:
            continue
        mth = float(th[fm].max())
        maz = float(np.median(az[fm[th[fm] > np.percentile(th[fm], 75)]]))
        cands.append((mth, maz, t, fm))
    cands.sort(key=lambda c: -c[0])

    sector = lambda a: int(a // 60) % 6
    picked, per_sector = [], {}
    for mth, maz, t, fm in cands:
        s = sector(maz)
        if per_sector.get(s, 0) >= MAX_FRAMES // 4 and len(picked) < MAX_FRAMES:
            continue
        picked.append((t, fm))
        per_sector[s] = per_sector.get(s, 0) + 1
        if len(picked) >= MAX_FRAMES:
            break

    frames = []
    for t, fm in picked:
        sel = fm[grid_cap(M[fm, 2:4], CAP)]
        frames.append(dict(t=float(t),
                           play=M[sel, 2:4].astype(np.float32),
                           raw=M[sel, 4:6].astype(np.float32)))
    np.savez(out, frames=np.array(frames, dtype=object))
    n = sum(len(f['play']) for f in frames)
    mths = [float(th[np.abs(M[:, 0] - f['t']) < 1e-6].max()) for f in frames]
    print(f'promoted {len(frames)} frames / {n} matches -> {out} '
          f'(max theta per frame: min {min(mths):.1f} med '
          f'{np.median(mths):.1f} max {max(mths):.1f})')


if __name__ == '__main__':
    main()

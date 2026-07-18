"""Arbiter: score competing fisheye fits against the reg-SIFT correspondences.

Per frame: unproject matched raw pixels through a candidate fit -> rays; DLT a
play-px -> ray homography (absorbs their per-frame pan/tilt/roll/f); residual =
angle(predicted ray, unprojected ray) in mrad. The per-frame H means only the
RAY FIELD of our fit is scored — their camera pose never needs solving.

Fairness: the trim set (false-SIFT rejection) is shared across fits — a match
survives if its first-pass residual under ANY fit is < TRIM_MRAD — then every
fit is scored on the same kept set.

  python3 arbiter.py <matches.npz> <name=fit.json> [name2=fit2.json ...] [--aim aim.json]
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fisheye_model import kb_params, unproject  # noqa: E402
from marks_solver import ray_dlt_homography  # noqa: E402

TRIM_MRAD = 20.0
MIN_MATCHES = 30
MIN_SPREAD = 0.25  # play-frame bbox diagonal, fraction of frame diagonal


def frame_resid(play, rays):
    H = ray_dlt_homography(play / 100.0, rays)  # /100 keeps DLT well-scaled
    pred = (H @ np.column_stack([play / 100.0, np.ones(len(play))]).T).T
    pn = np.linalg.norm(pred, axis=1)
    dots = np.abs(np.sum(pred * rays, axis=1)) / np.maximum(pn, 1e-12)
    return 1000.0 * np.arccos(np.clip(dots, -1, 1))


def main():
    npz = np.load(sys.argv[1])
    M = npz['matches']
    fits = {}
    aim = None
    args = sys.argv[2:]
    i = 0
    while i < len(args):
        if args[i] == '--aim':
            aim = json.load(open(args[i + 1]))
            i += 2
            continue
        if args[i] == '--windows':
            wl = [float(w) for w in args[i + 1].split(',')]
            M = M[np.isin(M[:, 1], wl)]
            print(f'window filter {wl}: {len(M)} matches')
            i += 2
            continue
        name, path = args[i].split('=', 1)
        fits[name] = json.load(open(path))
        i += 1

    # unproject once per fit
    U = {}
    for name, fit in fits.items():
        F, cx, cy, ks = kb_params(fit)
        rays, ok = unproject(M[:, 4:6], F, cx, cy, ks)
        U[name] = (rays, ok)

    ref = list(fits)[0]
    Fr, cxr, cyr, ksr = kb_params(fits[ref])
    th_ref = np.degrees(np.arccos(np.clip(U[ref][0][:, 2], -1, 1)))
    az_ref = np.degrees(np.arctan2(M[:, 5] - cyr, M[:, 4] - cxr)) % 360.0

    aim_fov = None
    if aim is not None:
        aim_fov = np.interp(M[:, 0], aim['t'], aim['fov'])

    ts = np.unique(M[:, 0])
    rows = {n: [] for n in fits}   # (idx, resid) accumulated
    frame_stats = []
    for t in ts:
        fm = np.where(M[:, 0] == t)[0]
        if len(fm) < MIN_MATCHES:
            continue
        play = M[fm, 2:4]
        d = np.hypot(*(play.max(0) - play.min(0))) / np.hypot(1920, 1080)
        if d < MIN_SPREAD:
            continue
        ok_all = np.ones(len(fm), bool)
        for n in fits:
            ok_all &= U[n][1][fm]
        if ok_all.sum() < MIN_MATCHES:
            continue
        fm = fm[ok_all]
        play = M[fm, 2:4]
        # first pass residuals per fit -> shared trim
        first = {n: frame_resid(play, U[n][0][fm]) for n in fits}
        keep = np.zeros(len(fm), bool)
        for n in fits:
            keep |= first[n] < TRIM_MRAD
        if keep.sum() < MIN_MATCHES:
            continue
        fm = fm[keep]
        play = M[fm, 2:4]
        med = {}
        for n in fits:
            r = frame_resid(play, U[n][0][fm])
            med[n] = float(np.median(r))
            rows[n].append((fm, r))
        frame_stats.append((float(t), len(fm),
                            float(aim_fov[fm].mean()) if aim_fov is not None else np.nan,
                            float(th_ref[fm].max()), med))

    print(f'{len(frame_stats)} frames scored '
          f'({sum(len(f[0]) for f in rows[ref])} matches kept)')
    idx = {n: np.concatenate([f for f, _ in rows[n]]) for n in fits}
    res = {n: np.concatenate([r for _, r in rows[n]]) for n in fits}

    def stat(name, mask):
        out = f'{name:<22}'
        for n in fits:
            m = mask[idx[n]] if mask is not None else np.ones(len(res[n]), bool)
            if m.sum() < 20:
                out += f'  {n}: (n={m.sum()})'
                continue
            r = res[n][m]
            out += (f'  {n}: {np.median(r):6.2f}/{np.percentile(r, 90):6.2f} mrad'
                    f' (n={m.sum()})')
        print(out)

    print('\nmedian/p90 residual (mrad; 17.5 mrad = 1 deg):')
    stat('ALL', None)
    for a, b in [(0, 60), (60, 75), (75, 80), (80, 85), (85, 95)]:
        stat(f'theta {a}-{b}', (th_ref >= a) & (th_ref < b))
    right = (az_ref >= 330) | (az_ref < 30)
    left = (az_ref >= 150) & (az_ref < 210)
    stat('RIGHT az330-30', right)
    stat('RIGHT rim th>78', right & (th_ref > 78))
    stat('LEFT az150-210', left)
    stat('LEFT rim th>78', left & (th_ref > 78))
    if aim_fov is not None:
        for a, b in [(15, 30), (30, 45), (45, 65)]:
            stat(f'render fov {a}-{b}', (aim_fov >= a) & (aim_fov < b))

    # per-frame medians for the most rim-reaching frames
    frame_stats.sort(key=lambda f: -f[3])
    print('\ntop rim-reaching frames (t, n, fov, max_th, per-fit median mrad):')
    for t, n, fov, mth, med in frame_stats[:12]:
        meds = '  '.join(f'{k}={v:5.2f}' for k, v in med.items())
        print(f'  t={t:7.1f} n={n:4d} fov={fov:5.1f} maxth={mth:5.1f}  {meds}')


if __name__ == '__main__':
    main()

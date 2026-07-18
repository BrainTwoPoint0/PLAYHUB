"""Harvest dense raw-fisheye <-> Play-render SIFT correspondences (reg-SIFT rim
source, Phase-0). Fit-FREE outlier filtering (mutual NN + ratio + local-affine
consistency) so the arbiter can score competing fits on the same match pool.

Output: regsift/matches.npz with per-match rows:
  t_stream, window, play_x, play_y (native 1920x1080), raw_x, raw_y (native 4K)
plus per-frame table (t_stream, n_matches).

  python3 harvest.py <pair_dir> <out_npz> [--fps 1.0] [--aim aim.json --dense-pan 55 --dense-fps 3]
"""
import json
import re
import sys
from pathlib import Path

import cv2
import numpy as np

RAW_W, RAW_H = 1920, 1080     # SIFT working size for the 4K raw (coords x2 out)
PLAY_W, PLAY_H = 1280, 720    # SIFT working size for the 1080p play (coords x1.5 out)


def local_affine_filter(pp, rp, k=12, tol=25.0, min_nb=6):
    """Keep matches whose raw position is predicted by a local affine fit of
    their k nearest neighbours (in play coords). Fit-free, mapping-smoothness
    only. tol is in RAW working px."""
    n = len(pp)
    if n < min_nb + 1:
        return np.zeros(n, bool)
    d2 = ((pp[:, None, :] - pp[None, :, :]) ** 2).sum(-1)
    np.fill_diagonal(d2, np.inf)
    nb = np.argsort(d2, axis=1)[:, :k]
    keep = np.zeros(n, bool)
    for i in range(n):
        js = nb[i]
        js = js[np.isfinite(d2[i, js])]
        if len(js) < min_nb:
            continue
        A = np.column_stack([pp[js], np.ones(len(js))])
        try:
            sol, *_ = np.linalg.lstsq(A, rp[js], rcond=None)
        except np.linalg.LinAlgError:
            continue
        pred = np.array([pp[i, 0], pp[i, 1], 1.0]) @ sol
        keep[i] = np.hypot(*(pred - rp[i])) < tol
    return keep


def harvest_pair(raw_path, play_path, start_s, sample_ts, sift, bf):
    capr = cv2.VideoCapture(str(raw_path))
    capp = cv2.VideoCapture(str(play_path))
    rows, frames = [], []
    for tc in sample_ts:
        capp.set(cv2.CAP_PROP_POS_MSEC, tc * 1000)
        okp, fp = capp.read()
        capr.set(cv2.CAP_PROP_POS_MSEC, tc * 1000)
        okr, fr = capr.read()
        if not (okp and okr):
            continue
        gp = cv2.cvtColor(cv2.resize(fp, (PLAY_W, PLAY_H)), cv2.COLOR_BGR2GRAY)
        gr = cv2.cvtColor(cv2.resize(fr, (RAW_W, RAW_H)), cv2.COLOR_BGR2GRAY)
        kp, dp = sift.detectAndCompute(gp, None)
        kr, dr = sift.detectAndCompute(gr, None)
        if dp is None or dr is None:
            continue
        m_pr = bf.knnMatch(dp, dr, k=2)
        good = {}
        for a, b in m_pr:
            if a.distance < 0.78 * b.distance:
                good[a.queryIdx] = a.trainIdx
        # mutual check
        m_rp = bf.knnMatch(dr, dp, k=2)
        back = {}
        for a, b in m_rp:
            if a.distance < 0.78 * b.distance:
                back[a.queryIdx] = a.trainIdx
        pairs = [(q, t) for q, t in good.items() if back.get(t) == q]
        if len(pairs) < 12:
            frames.append((start_s + tc, 0))
            continue
        pp = np.float32([kp[q].pt for q, _ in pairs])
        rp = np.float32([kr[t].pt for _, t in pairs])
        keep = local_affine_filter(pp, rp)
        pp, rp = pp[keep], rp[keep]
        frames.append((start_s + tc, len(pp)))
        for (px, py), (rx, ry) in zip(pp, rp):
            rows.append((start_s + tc, start_s,
                         px * 1920.0 / PLAY_W, py * 1080.0 / PLAY_H,
                         rx * 3840.0 / RAW_W, ry * 2160.0 / RAW_H))
    capr.release()
    capp.release()
    return rows, frames


def main():
    pair_dir = Path(sys.argv[1])
    out = sys.argv[2]
    fps = float(sys.argv[sys.argv.index('--fps') + 1]) if '--fps' in sys.argv else 1.0
    aim = None
    if '--aim' in sys.argv:
        aim = json.load(open(sys.argv[sys.argv.index('--aim') + 1]))
    dense_pan = float(sys.argv[sys.argv.index('--dense-pan') + 1]) if '--dense-pan' in sys.argv else 55.0
    dense_fps = float(sys.argv[sys.argv.index('--dense-fps') + 1]) if '--dense-fps' in sys.argv else 3.0

    sift = cv2.SIFT_create(4000)
    bf = cv2.BFMatcher()
    all_rows, all_frames = [], []
    raws = sorted(pair_dir.glob('raw_*.mp4'))
    for raw_path in raws:
        m = re.search(r'_s(\d+)\.mp4$', raw_path.name)
        start_s = float(m.group(1)) if m else 0.0
        play_path = Path(str(raw_path).replace('raw_', 'play_'))
        if not play_path.exists():
            continue
        cap = cv2.VideoCapture(str(play_path))
        dur = (cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0) / (cap.get(cv2.CAP_PROP_FPS) or 25.0)
        cap.release()
        ts = set(np.round(np.arange(0.0, dur, 1.0 / fps), 2))
        if aim is not None:
            at = np.array(aim['t'])
            apan = np.array(aim['pan'])
            sel = np.abs(apan) > dense_pan
            tt = at[sel] - start_s
            tt = tt[(tt >= 0) & (tt < dur)]
            for t0 in np.arange(0.0, dur, 1.0 / dense_fps):
                if len(tt) and np.min(np.abs(tt - t0)) < 0.5:
                    ts.add(round(float(t0), 2))
        ts = sorted(ts)
        rows, frames = harvest_pair(raw_path, play_path, start_s, ts, sift, bf)
        all_rows += rows
        all_frames += frames
        n_ok = sum(1 for _, n in frames if n >= 12)
        print(f'{raw_path.name}: {len(frames)} frames sampled, {n_ok} with >=12 matches, '
              f'{len(rows)} matches total', flush=True)
    R = np.array(all_rows, np.float64)
    F = np.array(all_frames, np.float64)
    np.savez(out, matches=R, frames=F)
    print(f'saved {len(R)} matches / {len(F)} frames -> {out}')


if __name__ == '__main__':
    main()

"""Compare follow-target signals against Spiideo's AutoFollow, off a cached player
detection pass (cache_players.py). Iterates in seconds — no re-detection.

Signals derived from the cached per-frame player x-positions (+ global motion):
  mean            : mean of ALL detected persons (the naive one — dragged to midfield
                    by sideline spectators; FAILS).
  median          : robust central position.
  dense_cluster   : KDE mode of player x — the densest pack (proxy for the ball/action).
  motion          : global motion-centroid (the DEPLOYED signal).
  motion_players  : mean of players NEAR the motion-centroid (action pack, motion-gated).

Scored vs Spiideo pan (affine-aligned): correlation (unit-free headline), residual,
jerk P95, whips. Correlation is scale-invariant, so it holds even when Spiideo pans
little (small pitch).

  python3 compare_signals.py /tmp/follow-pair/cache_<g>.json [--pano-fov 140] [--bw 0.08]
"""
from __future__ import annotations

import json
import sys

import numpy as np

from controller import FollowController

WHIP_STEP, WHIP_FRAMES = 0.15, 6


def kde_mode(xs, bw, grid):
    if not xs:
        return None
    xs = np.asarray(xs)
    d = np.exp(-0.5 * ((grid[:, None] - xs[None, :]) / bw) ** 2).sum(1)
    return float(grid[int(d.argmax())])


def build_targets(cache, kind, bw=0.08):
    players = {int(k): v for k, v in cache["players"].items()}
    motion = {int(k): v for k, v in cache["motion"].items()}
    grid = np.linspace(0, 1, 101)
    out = {}
    if kind == "motion":
        return dict(motion)
    for fr, xs in players.items():
        if not xs:
            continue
        if kind == "mean":
            out[fr] = float(np.mean(xs))
        elif kind == "median":
            out[fr] = float(np.median(xs))
        elif kind == "dense_cluster":
            out[fr] = kde_mode(xs, bw, grid)
        elif kind == "motion_players":
            # players within ±0.2 of the nearest motion-centroid, else fall back to dense mode
            mk = min(motion, key=lambda m: abs(m - fr)) if motion else None
            if mk is not None and abs(mk - fr) < 15:
                mx = motion[mk]
                near = [x for x in xs if abs(x - mx) < 0.2]
                out[fr] = float(np.mean(near)) if near else kde_mode(xs, bw, grid)
            else:
                out[fr] = kde_mode(xs, bw, grid)
    return out


SLEW = 0.05  # hard cap on |Δpan| per controller frame (whip guard)


def controller_pan(targets, n, fps, slew=False):
    ctl = FollowController(fps=fps)
    pan, last = [], None
    for fr in range(n):
        t = targets.get(fr)
        v = ctl.step({"pan": t, "tilt": 0.0, "fov": 40.0} if t is not None else None)["pan"]
        if slew and last is not None:
            v = last + max(-SLEW, min(SLEW, v - last))
            ctl.view["pan"] = v  # keep controller state consistent with the clamp
        pan.append(v); last = v
    return np.array(pan)


def score(ours_native, vfps, pan_S, sfps, pano_fov):
    tgt_t = np.arange(len(pan_S)) / sfps
    ours = np.interp(tgt_t, np.arange(len(ours_native)) / vfps, ours_native)
    A = np.vstack([ours, np.ones_like(ours)]).T
    (a, b), *_ = np.linalg.lstsq(A, pan_S, rcond=None)
    resid = pan_S - (a * ours + b)
    rms = float(np.sqrt((resid ** 2).mean()))
    corr = float(np.corrcoef(ours, pan_S)[0, 1]) if ours.std() > 1e-9 else 0.0
    deg = (rms / abs(a)) * pano_fov if a != 0 else float("nan")
    jerk = float(np.percentile(np.abs(np.diff(ours_native, 2)), 95)) if len(ours_native) > 2 else 0.0
    w = int(sum(abs(ours_native[i + WHIP_FRAMES] - ours_native[i]) > WHIP_STEP for i in range(len(ours_native) - WHIP_FRAMES)))
    return corr, rms, deg, jerk, w


def main():
    cache = json.load(open(sys.argv[1]))
    pano_fov = float(sys.argv[sys.argv.index("--pano-fov") + 1]) if "--pano-fov" in sys.argv else 140.0
    bw = float(sys.argv[sys.argv.index("--bw") + 1]) if "--bw" in sys.argv else 0.08
    vfps, n = cache["video_fps"], cache["video_frames"]
    pan_S = np.asarray(cache["spiideo_pan"]); sfps = cache["spiideo_fps"]
    print(f"scene: {n} frames @ {vfps:.1f}fps | Spiideo pan range {cache['spiideo_pan_range']:.3f} "
          f"({'LOW — weak signal' if cache['spiideo_pan_range'] < 0.15 else 'ok'}) | "
          f"players/frame median {np.median([len(v) for v in cache['players'].values()]):.0f}")
    print(f"\n  {'signal':16} corr↑    resid↓    ~resid°   jerkP95↓  whips↓")
    rows = {}
    variants = [("mean", "mean", False), ("median", "median", False), ("dense_cluster", "dense_cluster", False),
                ("motion", "motion", False), ("motion+slew", "motion", True),
                ("motion_players", "motion_players", False), ("mean+slew", "mean", True)]
    for label, kind, slew in variants:
        tg = build_targets(cache, kind, bw)
        pan = controller_pan(tg, n, vfps, slew=slew)
        rows[label] = score(pan, vfps, pan_S, sfps, pano_fov)
        c, r, d, j, w = rows[label]
        print(f"  {label:16} {c:+.3f}   {r:.4f}    {d:5.1f}°    {j:.5f}   {w}")
    best = max(rows, key=lambda k: rows[k][0])
    print(f"\n  best action-tracker (corr) = {best} ({rows[best][0]:+.3f})")
    print(f"  deployed motion-centroid   = motion ({rows['motion'][0]:+.3f})")
    print(f"  naive player mean          = mean ({rows['mean'][0]:+.3f})")


if __name__ == "__main__":
    main()

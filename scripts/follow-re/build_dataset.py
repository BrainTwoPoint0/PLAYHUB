"""Assemble the imitation dataset per match: align raw-VP features (cache_players) to
the SIFT-registered Spiideo targets (register_render) by TIME (both streams share the
source start-ts), and emit X/Y arrays + heuristic baselines for the eval.

  X : [T, DIM]  per-frame features (imit_features)
  Y : [T, 3]    teacher targets  (pano_x, pano_y, zoom=-log footw)
  baselines: motion-centroid pano_x, player-mean pano_x (the incumbents to beat)
  w : [T]       target confidence (SIFT inliers, for loss weighting / masking)

  python3 build_dataset.py <cache.json> <reg.json> <out.npz>
"""
from __future__ import annotations

import json
import sys

import numpy as np

import imit_features as F


def build(cachef, regf):
    c = json.load(open(cachef)); r = json.load(open(regf))
    vfps = c["video_fps"]
    players = c["players"]; mhist = c["mhist"]; motion = c.get("motion", {})
    frames = sorted(int(k) for k in mhist)                       # canonical sample set

    rt = np.array(r["t"]); rpx = np.array(r["pano_x"]); rpy = np.array(r["pano_y"])
    rfw = np.array(r["footw"]); rin = np.array(r["inliers"], float)

    X, Y, W, bm, bp, T = [], [], [], [], [], []
    for idx in frames:
        s = str(idx)
        pxs = [p[0] for p in players.get(s, [])]
        mot = motion.get(s, np.nan)
        X.append(F.frame_features(pxs, mhist.get(s), mot))
        t = idx / vfps
        px = float(np.interp(t, rt, rpx)); py = float(np.interp(t, rt, rpy))
        fw = float(np.interp(t, rt, rfw)); inl = float(np.interp(t, rt, rin))
        Y.append([px, py, -np.log(max(fw, 1e-3))])
        W.append(inl)
        bm.append(mot if mot == mot else (np.mean(pxs) if pxs else 0.5))
        bp.append(np.mean(pxs) if pxs else 0.5)
        T.append(t)
    return (np.array(X, np.float32), np.array(Y, np.float32), np.array(W, np.float32),
            np.array(bm, np.float32), np.array(bp, np.float32), np.array(T, np.float32))


def main():
    cachef, regf, out = sys.argv[1:4]
    X, Y, W, bm, bp, T = build(cachef, regf)
    np.savez(out, X=X, Y=Y, w=W, base_motion=bm, base_playermean=bp, t=T)
    print(f"{out}: T={len(X)} DIM={X.shape[1]}  pano_x {Y[:,0].min():.3f}–{Y[:,0].max():.3f}  "
          f"median inliers {np.median(W):.0f}")


if __name__ == "__main__":
    main()

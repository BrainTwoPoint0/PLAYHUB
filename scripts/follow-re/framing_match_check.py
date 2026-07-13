"""Honest full-clip framing check: for EVERY sample, render ours at the inverted framing,
SIFT-match to Spiideo, fit a similarity, and measure deviation from IDENTITY (scale≈1,
translation≈0). Framing matches Spiideo iff the similarity is ~identity — NOT merely low
residual (a wide view containing Spiideo's crop also gives low residual; that was the bug).

  python3 framing_match_check.py <raw.mp4> <play.mp4> <framing.json>
"""
from __future__ import annotations

import json
import sys
import numpy as np
import cv2

import mesh_dewarp as MD

OW, OH = 640, 360
projs, _ = MD.load_mesh("/tmp/follow-pair/mesh")
sift = cv2.SIFT_create(2500); bf = cv2.BFMatcher()


def main():
    raw, play, framingf = sys.argv[1:4]
    fr = json.load(open(framingf))
    t = np.array(fr["t"]); pan = np.array(fr["pan"]); tilt = np.array(fr["tilt"]); fov = np.array(fr["fov"])
    capr = cv2.VideoCapture(raw); capp = cv2.VideoCapture(play)
    scales, txs, tys, ok = [], [], [], []
    for i in range(len(t)):
        capr.set(cv2.CAP_PROP_POS_MSEC, t[i] * 1000); okr, rf = capr.read()
        capp.set(cv2.CAP_PROP_POS_MSEC, t[i] * 1000); okp, pf = capp.read()
        if not (okr and okp):
            ok.append(False); continue
        our = MD.dewarp(rf, projs, np.radians(pan[i]), np.radians(tilt[i]), fov[i], OW, OH)
        pl = cv2.resize(pf, (OW, OH))
        k1, d1 = sift.detectAndCompute(cv2.cvtColor(our, cv2.COLOR_BGR2GRAY), None)
        k2, d2 = sift.detectAndCompute(cv2.cvtColor(pl, cv2.COLOR_BGR2GRAY), None)
        if d1 is None or d2 is None:
            ok.append(False); continue
        good = [a for a, b in bf.knnMatch(d1, d2, k=2) if a.distance < 0.8 * b.distance]
        if len(good) < 15:
            ok.append(False); continue
        src = np.float32([k1[x.queryIdx].pt for x in good]).reshape(-1, 1, 2)
        dst = np.float32([k2[x.trainIdx].pt for x in good]).reshape(-1, 1, 2)
        M, inl = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=4.0)
        if M is None or inl.sum() < 12:
            ok.append(False); continue
        s = float(np.hypot(M[0, 0], M[1, 0]))
        scales.append(s); txs.append(M[0, 2] / OW); tys.append(M[1, 2] / OH); ok.append(True)
    capr.release(); capp.release()
    scales = np.array(scales); txs = np.array(txs); tys = np.array(tys)
    tmag = np.hypot(txs, tys)
    # framing matches iff scale near 1 AND translation near 0
    good = (np.abs(scales - 1) < 0.15) & (tmag < 0.10)
    print(f"matched {sum(ok)}/{len(t)} frames (SIFT ok)")
    print(f"scale (our→Spiideo, 1.0=same zoom): median {np.median(scales):.3f}  p10 {np.percentile(scales,10):.3f}  p90 {np.percentile(scales,90):.3f}")
    print(f"translation |t|/frame: median {np.median(tmag):.3f}  p90 {np.percentile(tmag,90):.3f}")
    print(f"FRAMING GOOD (scale~1 & small shift): {good.mean()*100:.0f}%  ({(~good).sum()} off)")
    # where are the off frames?
    offt = t[np.array(ok)][~good]
    print(f"off-framing times (s): {sorted(round(float(x)) for x in offt)[:40]}")


if __name__ == "__main__":
    main()

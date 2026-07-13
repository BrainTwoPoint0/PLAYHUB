"""Find the constant tilt correction that nulls the systematic vertical framing offset
(our view sits ~15% too low vs Spiideo). For a sample of frames, measure the output
vertical shift ty (SIFT similarity our→Spiideo) at the current tilt and at tilt+Δ, get
the ty-vs-tilt slope per frame, solve the Δtilt that makes ty=0, and take the median as a
global correction. Also reports horizontal (pan) bias.

  python3 calibrate_tilt.py <raw.mp4> <play.mp4> <framing.json>
"""
from __future__ import annotations

import json
import sys
import numpy as np
import cv2

import mesh_dewarp as MD

OW, OH = 640, 360
projs, _ = MD.load_mesh("/tmp/follow-pair/mesh")
sift = cv2.SIFT_create(3000); bf = cv2.BFMatcher()


def sim(our, pl):
    k1, d1 = sift.detectAndCompute(cv2.cvtColor(our, cv2.COLOR_BGR2GRAY), None)
    k2, d2 = sift.detectAndCompute(cv2.cvtColor(pl, cv2.COLOR_BGR2GRAY), None)
    if d1 is None or d2 is None:
        return None
    good = [a for a, b in bf.knnMatch(d1, d2, k=2) if a.distance < 0.8 * b.distance]
    if len(good) < 15:
        return None
    src = np.float32([k1[x.queryIdx].pt for x in good]).reshape(-1, 1, 2)
    dst = np.float32([k2[x.trainIdx].pt for x in good]).reshape(-1, 1, 2)
    M, inl = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=4.0)
    if M is None or inl.sum() < 12:
        return None
    return M[0, 2] / OW, M[1, 2] / OH   # tx, ty (normalized)


def main():
    raw, play, framingf = sys.argv[1:4]
    fr = json.load(open(framingf))
    t = np.array(fr["t"]); pan = np.array(fr["pan"]); tilt = np.array(fr["tilt"]); fov = np.array(fr["fov"])
    capr = cv2.VideoCapture(raw); capp = cv2.VideoCapture(play)
    idx = np.linspace(5, len(t) - 5, 24).astype(int)
    dtilts, txs = [], []
    for i in idx:
        capr.set(cv2.CAP_PROP_POS_MSEC, t[i] * 1000); okr, rf = capr.read()
        capp.set(cv2.CAP_PROP_POS_MSEC, t[i] * 1000); okp, pf = capp.read()
        if not (okr and okp):
            continue
        pl = cv2.resize(pf, (OW, OH))
        r0 = sim(MD.dewarp(rf, projs, np.radians(pan[i]), np.radians(tilt[i]), fov[i], OW, OH), pl)
        r1 = sim(MD.dewarp(rf, projs, np.radians(pan[i]), np.radians(tilt[i] + 5), fov[i], OW, OH), pl)
        if r0 is None or r1 is None:
            continue
        tx0, ty0 = r0; _, ty1 = r1
        slope = (ty1 - ty0) / 5.0           # d(ty)/d(tilt)
        if abs(slope) > 1e-3:
            dtilts.append(-ty0 / slope)     # Δtilt to null ty0
            txs.append(tx0)
    capr.release(); capp.release()
    dtilts = np.array(dtilts); txs = np.array(txs)
    print(f"samples {len(dtilts)}")
    print(f"tilt correction Δ to null vertical offset: median {np.median(dtilts):+.2f}°  (IQR {np.percentile(dtilts,25):+.1f}..{np.percentile(dtilts,75):+.1f})")
    print(f"horizontal (pan) bias tx: median {np.median(txs):+.3f}  (→ small = pan ok)")
    print(f"\n→ apply tilt += {np.median(dtilts):.1f}° globally and re-render")


if __name__ == "__main__":
    main()

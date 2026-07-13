"""Calibrate the ONE remaining projection parameter — the aspect/y-scale — by matching
our mesh dewarp to Spiideo's own Play frames. For each candidate aspect, render at the
SIFT-best pan/tilt/fov and measure the SIMILARITY (4-dof: scale+rot+translation) edge
residual to Spiideo. Similarity absorbs framing (scale/rot/shift) but NOT an aspect
mismatch, so the aspect that minimizes similarity-edge-residual is the true one.
Averages over several frames for robustness.

  python3 calib_aspect.py <raw.mp4> <play.mp4>
"""
from __future__ import annotations

import sys
import numpy as np
import cv2

import mesh_dewarp as MD

PW, PH = 960, 540
F, CX, W_PANO = 1158.15, 1820.72, 3840.0
projs, _ = MD.load_mesh("/tmp/follow-pair/mesh")
sift = cv2.SIFT_create(3000); bf = cv2.BFMatcher()


def sift_pano_x(rawf, playf):
    s = cv2.SIFT_create(4000)
    rr = cv2.resize(rawf, (1920, 1080)); pp = cv2.resize(playf, (PW, PH))
    k1, d1 = s.detectAndCompute(cv2.cvtColor(pp, cv2.COLOR_BGR2GRAY), None)
    k2, d2 = s.detectAndCompute(cv2.cvtColor(rr, cv2.COLOR_BGR2GRAY), None)
    good = [a for a, b in bf.knnMatch(d1, d2, k=2) if a.distance < 0.75 * b.distance]
    src = np.float32([k1[x.queryIdx].pt for x in good]).reshape(-1, 1, 2)
    dst = np.float32([k2[x.trainIdx].pt for x in good]).reshape(-1, 1, 2)
    Hm, _ = cv2.findHomography(src, dst, cv2.RANSAC, 5.0)
    c = cv2.perspectiveTransform(np.float32([[[PW / 2, PH / 2]]]), Hm)[0, 0]
    return -1.0 * (c[0] / 1920.0 * W_PANO - CX) / F   # mesh_pan rad


def sim_edge_resid(rawf, playf, pan_deg, aspect):
    pl = cv2.resize(playf, (PW, PH))
    best = (1e9, None)
    for tilt in np.arange(-33, -8, 3):
        for fov in np.arange(24, 46, 3):
            u, v = MD.bake_uv_map(projs, np.radians(pan_deg), np.radians(tilt), fov, PW, PH, aspect=aspect)
            th, tw = rawf.shape[:2]; m1 = (u * tw).astype("f4"); m2 = (v * th).astype("f4"); m1[u < 0] = -1; m2[u < 0] = -1
            our = cv2.remap(rawf, m1, m2, cv2.INTER_LINEAR)
            k1, d1 = sift.detectAndCompute(cv2.cvtColor(our, cv2.COLOR_BGR2GRAY), None)
            k2, d2 = sift.detectAndCompute(cv2.cvtColor(pl, cv2.COLOR_BGR2GRAY), None)
            if d1 is None or d2 is None:
                continue
            good = [a for a, b in bf.knnMatch(d1, d2, k=2) if a.distance < 0.75 * b.distance]
            if len(good) < 30:
                continue
            src = np.float32([k1[x.queryIdx].pt for x in good]).reshape(-1, 1, 2)
            dst = np.float32([k2[x.trainIdx].pt for x in good]).reshape(-1, 1, 2)
            M, _ = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=4.0)  # similarity
            if M is None:
                continue
            s = src.reshape(-1, 2); proj = (M[:, :2] @ s.T).T + M[:, 2]
            e = np.linalg.norm(proj - dst.reshape(-1, 2), axis=1)
            edge = np.abs(s[:, 0] - PW / 2) > PW * 0.3
            er = float(np.median(e[edge])) if edge.any() else float(np.median(e))
            if er < best[0]:
                best = (er, (tilt, fov, len(good)))
    return best


def main():
    raw, play = sys.argv[1:3]
    capr = cv2.VideoCapture(raw); capp = cv2.VideoCapture(play)
    frames = []
    for t in (25, 45, 70, 95):
        capr.set(cv2.CAP_PROP_POS_MSEC, t * 1000); okr, rf = capr.read()
        capp.set(cv2.CAP_PROP_POS_MSEC, t * 1000); okp, pf = capp.read()
        if okr and okp:
            pan = np.degrees(sift_pano_x(rf, pf)); frames.append((rf, pf, pan))
    capr.release(); capp.release()
    print(f"{len(frames)} frames; sweeping aspect (current default 1.778 = 16:9)")
    for asp in [1.50, 1.60, 1.70, 1.778, 1.85, 1.95]:
        ers = [sim_edge_resid(rf, pf, pan, asp)[0] for rf, pf, pan in frames]
        print(f"  aspect {asp:.3f}:  similarity edge residual (median px) = {np.median(ers):.2f}   per-frame {[round(e,1) for e in ers]}")


if __name__ == "__main__":
    main()

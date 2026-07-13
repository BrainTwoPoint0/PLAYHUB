"""FINAL STAMP: reproject structural pitch landmarks (fence/goal/line features — the fixed
points; moving players are RANSAC outliers) between OUR dewarp and Spiideo across the FULL
pan range. Align by homography (exact relation of two co-centred pinhole views) and report
the inlier reprojection error + its radial profile. If our dewarp == Spiideo's geometry:
error stays small AND FLAT to the rim (a different distortion would bow → rim error grows).

  python3 landmark_stamp.py <raw.mp4> <play.mp4> <framing.json> [--n 18]
"""
from __future__ import annotations

import json
import sys
import numpy as np
import cv2
from scipy.optimize import minimize

import mesh_dewarp as MD

PW, PH = 960, 540
F, CX, W_ = 1158.15, 1820.72, 3840.0
projs, _ = MD.load_mesh("/tmp/follow-pair/mesh")
sift = cv2.SIFT_create(5000); bf = cv2.BFMatcher()


def render(rawf, pan, tilt, fov):
    u, v = MD.bake_uv_map(projs, np.radians(pan), np.radians(tilt), fov, PW, PH)
    th, tw = rawf.shape[:2]; m1 = (u * tw).astype("f4"); m2 = (v * th).astype("f4"); m1[u < 0] = -1; m2[u < 0] = -1
    return cv2.remap(rawf, m1, m2, cv2.INTER_LINEAR)


def match(our, k2d2):
    k2, d2 = k2d2
    k1, d1 = sift.detectAndCompute(cv2.cvtColor(our, cv2.COLOR_BGR2GRAY), None)
    if d1 is None: return None
    good = [a for a, b in bf.knnMatch(d1, d2, k=2) if a.distance < 0.8 * b.distance]
    if len(good) < 30: return None
    src = np.float32([k1[x.queryIdx].pt for x in good]).reshape(-1, 1, 2)
    dst = np.float32([k2[x.trainIdx].pt for x in good]).reshape(-1, 1, 2)
    return src, dst


def main():
    raw, play, framingf = sys.argv[1:4]
    N = int(sys.argv[sys.argv.index("--n") + 1]) if "--n" in sys.argv else 18
    fr = json.load(open(framingf)); t = np.array(fr["t"]); pan_traj = np.array(fr["pan"])
    # pick frames spanning the pan range
    order = np.argsort(pan_traj); idx = order[np.linspace(0, len(order) - 1, N).astype(int)]
    idx = np.unique(idx)
    capr = cv2.VideoCapture(raw); capp = cv2.VideoCapture(play)

    rows = []
    allrad = {0: [], 1: [], 2: []}
    for i in sorted(idx, key=lambda j: pan_traj[j]):
        tv = t[i]
        capr.set(cv2.CAP_PROP_POS_MSEC, tv * 1000); okr, rawf = capr.read()
        capp.set(cv2.CAP_PROP_POS_MSEC, tv * 1000); okp, pf = capp.read()
        if not (okr and okp): continue
        pl = cv2.resize(pf, (PW, PH))
        k2, d2 = sift.detectAndCompute(cv2.cvtColor(pl, cv2.COLOR_BGR2GRAY), None)
        def resid(x):
            m = match(render(rawf, *x), (k2, d2))
            if m is None: return 1e9
            H, inl = cv2.findHomography(m[0], m[1], cv2.RANSAC, 3.0)
            if H is None: return 1e9
            s = m[0].reshape(-1, 2)[inl.ravel() > 0]
            return float(np.median(np.linalg.norm(cv2.perspectiveTransform(m[0], H).reshape(-1, 2)[inl.ravel() > 0] - m[1].reshape(-1, 2)[inl.ravel() > 0], axis=1)))
        res = minimize(resid, [pan_traj[i], -20, 32], method="Nelder-Mead", options=dict(xatol=0.05, fatol=0.02, maxiter=120))
        m = match(render(rawf, *res.x), (k2, d2))
        if m is None: continue
        H, inl = cv2.findHomography(m[0], m[1], cv2.RANSAC, 3.0)
        s = m[0].reshape(-1, 2)[inl.ravel() > 0]; d = m[1].reshape(-1, 2)[inl.ravel() > 0]
        proj = cv2.perspectiveTransform(m[0], H).reshape(-1, 2)[inl.ravel() > 0]
        err = np.linalg.norm(proj - d, axis=1)
        rad = np.linalg.norm(s - [PW / 2, PH / 2], axis=1) / (np.hypot(PW, PH) / 2)
        prof = []
        for b, (lo, hi) in enumerate([(0, .4), (.4, .7), (.7, 1.1)]):
            mk = (rad >= lo) & (rad < hi)
            e = float(np.median(err[mk])) if mk.any() else np.nan
            prof.append(e)
            if not np.isnan(e): allrad[b].append(e)
        rows.append((res.x[0], int(inl.sum()), float(np.median(err)), float(np.percentile(err, 95)), prof))
    capr.release(); capp.release()

    print(f"{'pan°':>6} {'inliers':>8} {'med px':>7} {'p95 px':>7}  {'center':>7} {'mid':>6} {'EDGE':>6}")
    for pan, nin, med, p95, prof in rows:
        print(f"{pan:6.0f} {nin:8d} {med:7.2f} {p95:7.2f}  {prof[0]:7.2f} {prof[1]:6.2f} {prof[2]:6.2f}")
    meds = [r[2] for r in rows]; p95s = [r[3] for r in rows]
    c = np.median(allrad[0]); mi = np.median(allrad[1]); e = np.median(allrad[2])
    print(f"\n=== FINAL STAMP (full pan range {rows[0][0]:.0f}°..{rows[-1][0]:.0f}°, {len(rows)} views) ===")
    print(f"reprojection error vs Spiideo:  median {np.median(meds):.2f}px   worst-frame median {max(meds):.2f}px   overall p95 {max(p95s):.2f}px")
    print(f"radial profile (median px):  center {c:.2f}  →  mid {mi:.2f}  →  EDGE {e:.2f}   (edge/center = {e/c:.2f})")
    print(f"VERDICT: {'FLAT — no radial growth, same geometry as Spiideo' if e/c < 1.6 and e < 2.5 else 'radial growth detected — investigate'}")


if __name__ == "__main__":
    main()

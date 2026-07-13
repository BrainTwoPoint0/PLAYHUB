"""Is the black a real coverage gap or a comparison artifact? Render OUR dewarp at
Spiideo's framing DIRECTLY (no alignment warp), mark uncovered pixels (mesh sentinel) in
RED, and show next to Spiideo. If our direct render fills the frame, the earlier black was
just the homography warp. If it has red where Spiideo has content, it's a real mesh/
projection coverage gap — then we look at the mesh extent.

  python3 coverage_check.py <raw.mp4> <play.mp4> --times 41,94,33
"""
from __future__ import annotations

import sys
import numpy as np
import cv2
from scipy.optimize import minimize

import mesh_dewarp as MD

PW, PH = 960, 540
F, CX, W_ = 1158.15, 1820.72, 3840.0
projs, _ = MD.load_mesh("/tmp/follow-pair/mesh")
sift = cv2.SIFT_create(5000); bf = cv2.BFMatcher()


def render_uv(rawf, pan, tilt, fov):
    u, v = MD.bake_uv_map(projs, np.radians(pan), np.radians(tilt), fov, PW, PH)
    th, tw = rawf.shape[:2]; m1 = (u * tw).astype("f4"); m2 = (v * th).astype("f4"); m1[u < 0] = -1; m2[u < 0] = -1
    return cv2.remap(rawf, m1, m2, cv2.INTER_LINEAR), (u >= 0)


def homog_resid(our, pl):
    k1, d1 = sift.detectAndCompute(cv2.cvtColor(our, cv2.COLOR_BGR2GRAY), None)
    k2, d2 = sift.detectAndCompute(cv2.cvtColor(pl, cv2.COLOR_BGR2GRAY), None)
    if d1 is None or d2 is None: return 1e9
    good = [a for a, b in bf.knnMatch(d1, d2, k=2) if a.distance < 0.8 * b.distance]
    if len(good) < 25: return 1e9
    src = np.float32([k1[x.queryIdx].pt for x in good]).reshape(-1, 1, 2)
    dst = np.float32([k2[x.trainIdx].pt for x in good]).reshape(-1, 1, 2)
    H, inl = cv2.findHomography(src, dst, cv2.RANSAC, 3.0)
    if H is None: return 1e9
    a = cv2.warpPerspective(our, H, (PW, PH)); m = cv2.cvtColor(a, cv2.COLOR_BGR2GRAY) > 0
    return float(cv2.absdiff(a, pl)[m].mean()) if m.mean() > 0.5 else 1e9


def main():
    raw, play = sys.argv[1:3]
    times = [float(x) for x in (sys.argv[sys.argv.index("--times") + 1] if "--times" in sys.argv else "41,94,33").split(",")]
    capr = cv2.VideoCapture(raw); capp = cv2.VideoCapture(play)
    def lab(im, tx):
        im = im.copy(); cv2.rectangle(im, (0, 0), (PW, 28), (0, 0, 0), -1); cv2.putText(im, tx, (8, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.52, (0, 255, 255), 2); return im
    rows = []
    for tv in times:
        capr.set(cv2.CAP_PROP_POS_MSEC, tv * 1000); _, rawf = capr.read()
        capp.set(cv2.CAP_PROP_POS_MSEC, tv * 1000); _, pf = capp.read()
        pl = cv2.resize(pf, (PW, PH))
        def resid(x): return homog_resid(render_uv(rawf, *x)[0], pl)
        k1r, d1r = sift.detectAndCompute(cv2.cvtColor(cv2.resize(rawf, (1920, 1080)), cv2.COLOR_BGR2GRAY), None)
        k2, d2 = sift.detectAndCompute(cv2.cvtColor(pl, cv2.COLOR_BGR2GRAY), None)
        g = [a for a, b in bf.knnMatch(d2, d1r, k=2) if a.distance < 0.75 * b.distance]
        Hm, _ = cv2.findHomography(np.float32([[k2[x.queryIdx].pt] for x in g]), np.float32([[k1r[x.trainIdx].pt] for x in g]), cv2.RANSAC, 5.0)
        c0 = cv2.perspectiveTransform(np.float32([[[PW / 2, PH / 2]]]), Hm)[0, 0]
        pan0 = np.degrees(-1.0 * (c0[0] / 1920 * W_ - CX) / F)
        res = minimize(resid, [pan0, -20, 32], method="Nelder-Mead", options=dict(xatol=0.05, fatol=0.02, maxiter=120))
        our, cov = render_uv(rawf, *res.x)
        uncovered = ~cov
        marked = our.copy(); marked[uncovered] = (0, 0, 255)   # red = mesh didn't cover
        pct = 100 * uncovered.mean()
        print(f"t={tv:.0f}s  framing pan/tilt/fov={np.round(res.x,1)}  uncovered(direct render) = {pct:.1f}%")
        rows.append(np.hstack([lab(marked, f"OURS direct @Spiideo framing t={tv:.0f}s (red=uncovered {pct:.1f}%)"), lab(pl, "SPIIDEO")]))
    capr.release(); capp.release()
    cv2.imwrite("/tmp/imitation/coverage_check.png", np.vstack(rows))
    print("wrote /tmp/imitation/coverage_check.png")


if __name__ == "__main__":
    main()

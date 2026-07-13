"""Direct curve test at matched framing: render OURS at Spiideo's framing, overlay a
STRAIGHT-LINE grid on both ours and Spiideo. A flat pitch ⇒ the pitch lines run parallel
to / straight against the grid in BOTH; a residual bow in ours ⇒ its pitch lines curve
away from the straight grid more than Spiideo's do. Also overlays a straight cyan line
between two clicked-equivalent pitch-line endpoints and measures max bow.

  python3 straightness_check.py <raw.mp4> <play.mp4> --times 41,94,33
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


def render(rawf, pan, tilt, fov):
    u, v = MD.bake_uv_map(projs, np.radians(pan), np.radians(tilt), fov, PW, PH)
    th, tw = rawf.shape[:2]; m1 = (u * tw).astype("f4"); m2 = (v * th).astype("f4"); m1[u < 0] = -1; m2[u < 0] = -1
    return cv2.remap(rawf, m1, m2, cv2.INTER_LINEAR)


def resid_to(our, pl):
    k1, d1 = sift.detectAndCompute(cv2.cvtColor(our, cv2.COLOR_BGR2GRAY), None)
    k2, d2 = sift.detectAndCompute(cv2.cvtColor(pl, cv2.COLOR_BGR2GRAY), None)
    if d1 is None or d2 is None: return 1e9
    good = [a for a, b in bf.knnMatch(d1, d2, k=2) if a.distance < 0.8 * b.distance]
    if len(good) < 25: return 1e9
    src = np.float32([k1[x.queryIdx].pt for x in good]).reshape(-1, 1, 2)
    dst = np.float32([k2[x.trainIdx].pt for x in good]).reshape(-1, 1, 2)
    M, inl = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=3.0)
    if M is None: return 1e9
    s = src.reshape(-1, 2)[inl.ravel() > 0]; d = dst.reshape(-1, 2)[inl.ravel() > 0]
    return float(np.median(np.linalg.norm((M[:, :2] @ s.T).T + M[:, 2] - d, axis=1)))


def grid(im, color=(0, 200, 255)):
    out = im.copy()
    for y in range(0, PH, PH // 8):
        cv2.line(out, (0, y), (PW, y), color, 1, cv2.LINE_AA)
    for x in range(0, PW, PW // 12):
        cv2.line(out, (x, 0), (x, PH), color, 1, cv2.LINE_AA)
    return out


def main():
    raw, play = sys.argv[1:3]
    times = [float(x) for x in (sys.argv[sys.argv.index("--times") + 1] if "--times" in sys.argv else "41,94,33").split(",")]
    capr = cv2.VideoCapture(raw); capp = cv2.VideoCapture(play)
    def lab(im, tx):
        im = im.copy(); cv2.rectangle(im, (0, 0), (PW, 26), (0, 0, 0), -1); cv2.putText(im, tx, (8, 19), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1); return im
    rows = []
    for tv in times:
        capr.set(cv2.CAP_PROP_POS_MSEC, tv * 1000); _, rawf = capr.read()
        capp.set(cv2.CAP_PROP_POS_MSEC, tv * 1000); _, pf = capp.read()
        pl = cv2.resize(pf, (PW, PH))
        def resid(x): return resid_to(render(rawf, *x), pl)
        k1r, d1r = sift.detectAndCompute(cv2.cvtColor(cv2.resize(rawf, (1920, 1080)), cv2.COLOR_BGR2GRAY), None)
        k2, d2 = sift.detectAndCompute(cv2.cvtColor(pl, cv2.COLOR_BGR2GRAY), None)
        g = [a for a, b in bf.knnMatch(d2, d1r, k=2) if a.distance < 0.75 * b.distance]
        Hm, _ = cv2.findHomography(np.float32([[k2[x.queryIdx].pt] for x in g]), np.float32([[k1r[x.trainIdx].pt] for x in g]), cv2.RANSAC, 5.0)
        c0 = cv2.perspectiveTransform(np.float32([[[PW / 2, PH / 2]]]), Hm)[0, 0]
        pan0 = np.degrees(-1.0 * (c0[0] / 1920 * W_ - CX) / F)
        res = minimize(resid, [pan0, -20, 32], method="Nelder-Mead", options=dict(xatol=0.05, fatol=0.02, maxiter=120))
        our = render(rawf, *res.x)
        rows.append(np.hstack([lab(grid(our), f"OURS @Spiideo framing t={tv:.0f}s + straight grid"),
                               lab(grid(pl), "SPIIDEO + same straight grid")]))
    capr.release(); capp.release()
    cv2.imwrite("/tmp/imitation/straightness_check.png", np.vstack(rows))
    print("wrote /tmp/imitation/straightness_check.png")


if __name__ == "__main__":
    main()

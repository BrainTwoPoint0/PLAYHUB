"""'Are they identical?' — the direct test. At a few frames, point OUR dewarp at the same
view as Spiideo (fine-optimize pan/tilt/fov to their frame), similarity-align, and show the
ABSOLUTE DIFFERENCE. Static structure (pitch lines, goal, fence) cancels to ~black iff our
calibration/mesh/dewarp is identical to Spiideo's; only moving players (different sub-frame
timing) should light up. No AutoFollow needed — framing is only to view the same patch.

  python3 diff_proof.py <raw.mp4> <play.mp4> --times 41,60,94
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


def match(our, k2d2):
    k2, d2 = k2d2
    k1, d1 = sift.detectAndCompute(cv2.cvtColor(our, cv2.COLOR_BGR2GRAY), None)
    if d1 is None: return None
    good = [a for a, b in bf.knnMatch(d1, d2, k=2) if a.distance < 0.8 * b.distance]
    if len(good) < 25: return None
    src = np.float32([k1[x.queryIdx].pt for x in good]).reshape(-1, 1, 2)
    dst = np.float32([k2[x.trainIdx].pt for x in good]).reshape(-1, 1, 2)
    M, inl = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=3.0)
    if M is None or inl.sum() < 15: return None
    s = src.reshape(-1, 2)[inl.ravel() > 0]; d = dst.reshape(-1, 2)[inl.ravel() > 0]
    return M, float(np.median(np.linalg.norm((M[:, :2] @ s.T).T + M[:, 2] - d, axis=1)))


def main():
    raw, play = sys.argv[1:3]
    times = [float(x) for x in (sys.argv[sys.argv.index("--times") + 1] if "--times" in sys.argv else "41,60,94").split(",")]
    capr = cv2.VideoCapture(raw); capp = cv2.VideoCapture(play)
    def lab(im, tx):
        im = im.copy(); cv2.rectangle(im, (0, 0), (PW, 26), (0, 0, 0), -1); cv2.putText(im, tx, (7, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1); return im
    rows = []
    for tv in times:
        capr.set(cv2.CAP_PROP_POS_MSEC, tv * 1000); _, rawf = capr.read()
        capp.set(cv2.CAP_PROP_POS_MSEC, tv * 1000); _, playf = capp.read()
        pl = cv2.resize(playf, (PW, PH))
        k2, d2 = sift.detectAndCompute(cv2.cvtColor(pl, cv2.COLOR_BGR2GRAY), None)
        # SIFT-init pan from homography, then optimize framing to their view
        def resid(x):
            r = match(render(rawf, *x), (k2, d2)); return r[1] if r else 1e3
        # crude pan init from full-frame homography
        k1r, d1r = sift.detectAndCompute(cv2.cvtColor(cv2.resize(rawf, (1920, 1080)), cv2.COLOR_BGR2GRAY), None)
        g = [a for a, b in bf.knnMatch(d2, d1r, k=2) if a.distance < 0.75 * b.distance]
        s2 = np.float32([[k2[x.queryIdx].pt] for x in g]); d2r = np.float32([[k1r[x.trainIdx].pt] for x in g])
        Hm, _ = cv2.findHomography(s2, d2r, cv2.RANSAC, 5.0)
        c = cv2.perspectiveTransform(np.float32([[[PW / 2, PH / 2]]]), Hm)[0, 0]
        pan0 = np.degrees(-1.0 * (c[0] / 1920 * W_ - CX) / F)
        res = minimize(resid, [pan0, -20, 32], method="Nelder-Mead", options=dict(xatol=0.05, fatol=0.02, maxiter=140))
        our = render(rawf, *res.x)
        M, rr = match(our, (k2, d2))
        aligned = cv2.warpAffine(our, M, (PW, PH))
        diff = cv2.absdiff(aligned, pl)
        diffx3 = np.clip(diff.astype(np.int32) * 3, 0, 255).astype(np.uint8)   # amplified for visibility
        rows.append(np.hstack([lab(aligned, f"OURS t={tv:.0f}s (sim {rr:.1f}px)"), lab(pl, "Spiideo"),
                               lab(diffx3, "|difference| x3  (black=identical; bright=moving players)")]))
    capr.release(); capp.release()
    cv2.imwrite("/tmp/imitation/diff_proof.png", np.vstack(rows))
    print("wrote /tmp/imitation/diff_proof.png")


if __name__ == "__main__":
    main()

"""Ultimate 'do they match' test: continuously optimize (pan,tilt,fov) so OUR mesh dewarp
best matches Spiideo under a SIMILARITY only (rot+scale+shift). If, at the optimal
framing, the similarity residual falls to the ~1px noise floor edge-to-edge and the edge
overlay is clean yellow, then OUR dewarp is the SAME flat pinhole as Spiideo and the only
thing that ever differed was framing. No homography allowed to hide anything.

  python3 fine_frame.py <raw.mp4> <play.mp4> <framing.json> --times 41,94
"""
from __future__ import annotations

import json
import sys
import numpy as np
import cv2
from scipy.optimize import minimize

import mesh_dewarp as MD

PW, PH = 960, 540
F, CX, W_PANO = 1158.15, 1820.72, 3840.0
projs, _ = MD.load_mesh("/tmp/follow-pair/mesh")
sift = cv2.SIFT_create(5000); bf = cv2.BFMatcher()


def render(rawf, pan, tilt, fov):
    u, v = MD.bake_uv_map(projs, np.radians(pan), np.radians(tilt), fov, PW, PH)
    th, tw = rawf.shape[:2]; m1 = (u * tw).astype("f4"); m2 = (v * th).astype("f4"); m1[u < 0] = -1; m2[u < 0] = -1
    return cv2.remap(rawf, m1, m2, cv2.INTER_LINEAR)


def sim_resid(our, d2k2, full=False):
    k2, d2 = d2k2
    k1, d1 = sift.detectAndCompute(cv2.cvtColor(our, cv2.COLOR_BGR2GRAY), None)
    if d1 is None:
        return (1e3, None, None, None) if full else 1e3
    good = [a for a, b in bf.knnMatch(d1, d2, k=2) if a.distance < 0.8 * b.distance]
    if len(good) < 25:
        return (1e3, None, None, None) if full else 1e3
    src = np.float32([k1[x.queryIdx].pt for x in good]).reshape(-1, 1, 2)
    dst = np.float32([k2[x.trainIdx].pt for x in good]).reshape(-1, 1, 2)
    M, inl = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=3.0)
    if M is None:
        return (1e3, None, None, None) if full else 1e3
    s = src.reshape(-1, 2)[inl.ravel() > 0]; d = dst.reshape(-1, 2)[inl.ravel() > 0]
    e = np.linalg.norm((M[:, :2] @ s.T).T + M[:, 2] - d, axis=1)
    r = float(np.median(e))
    return (r, M, s, e) if full else r


def main():
    raw, play, framingf = sys.argv[1:4]
    times = [float(x) for x in (sys.argv[sys.argv.index("--times") + 1] if "--times" in sys.argv else "41,94").split(",")]
    fr = json.load(open(framingf)); allrows = fr["rows"]
    capr = cv2.VideoCapture(raw); capp = cv2.VideoCapture(play)
    def lab(im, tx):
        im = im.copy(); cv2.rectangle(im, (0, 0), (PW, 26), (0, 0, 0), -1); cv2.putText(im, tx, (7, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1); return im
    panels = []
    for w in times:
        r0 = min(allrows, key=lambda r: abs(r["t"] - w)); t = r0["t"]
        capr.set(cv2.CAP_PROP_POS_MSEC, t * 1000); _, rawf = capr.read()
        capp.set(cv2.CAP_PROP_POS_MSEC, t * 1000); _, playf = capp.read()
        pl = cv2.resize(playf, (PW, PH))
        k2, d2 = sift.detectAndCompute(cv2.cvtColor(pl, cv2.COLOR_BGR2GRAY), None)
        def obj(x):
            return sim_resid(render(rawf, *x), (k2, d2))
        x0 = np.array([r0["pan"], r0["tilt"], r0["fov"]])
        res = minimize(obj, x0, method="Nelder-Mead",
                       options=dict(xatol=0.05, fatol=0.02, maxiter=120))
        pan, tilt, fov = res.x
        our = render(rawf, pan, tilt, fov)
        rr, M, s, e = sim_resid(our, (k2, d2), full=True)
        aligned = cv2.warpAffine(our, M, (PW, PH))
        # radial residual
        rad = np.linalg.norm(s - [PW / 2, PH / 2], axis=1) / (np.hypot(PW, PH) / 2)
        prof = [round(float(np.median(e[(rad >= lo) & (rad < hi)])), 2) if ((rad >= lo) & (rad < hi)).any() else None for lo, hi in [(0, .4), (.4, .7), (.7, 1.1)]]
        print(f"t={t:.0f}s  grid framing pan/tilt/fov={x0.round(1)} → optimized {res.x.round(2)}  "
              f"SIM residual {rr:.2f}px  by radius {prof}")
        eo = cv2.Canny(cv2.cvtColor(aligned, cv2.COLOR_BGR2GRAY), 60, 160); ep = cv2.Canny(cv2.cvtColor(pl, cv2.COLOR_BGR2GRAY), 60, 160)
        ov = np.zeros((PH, PW, 3), np.uint8); ov[..., 2] = eo; ov[..., 1] = ep
        blend = cv2.addWeighted(aligned, 0.5, pl, 0.5, 0)
        panels.append(np.hstack([lab(aligned, f"OURS optimized t={t:.0f}s (sim {rr:.1f}px)"), lab(pl, "Spiideo"),
                                 lab(blend, "50/50"), lab(ov, "edges red=ours green=Spiideo yellow=MATCH")]))
    capr.release(); capp.release()
    cv2.imwrite("/tmp/imitation/fine_frame.png", np.vstack(panels))
    print("wrote /tmp/imitation/fine_frame.png")


if __name__ == "__main__":
    main()

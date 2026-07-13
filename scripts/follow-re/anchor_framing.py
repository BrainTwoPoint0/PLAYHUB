"""Recover Spiideo's EXACT per-frame framing (pan,tilt,fov) by matching our (proven-flat)
mesh dewarp to Spiideo's own Play frames via SIFT, at a set of anchor frames. Emits the
table + fits tilt=f(pan) and fov=f(footw) so the whole clip can be rendered with correct
framing. This is the missing piece: geometry was always flat; the framing was the heuristic.

  python3 anchor_framing.py <raw.mp4> <play.mp4> <reg.json> <out.json> [--n 16]
"""
from __future__ import annotations

import json
import sys
import numpy as np
import cv2

import mesh_dewarp as MD

PW, PH = 960, 540
F, CX, W_PANO = 1158.15, 1820.72, 3840.0
projs, _ = MD.load_mesh("/tmp/follow-pair/mesh")
sift = cv2.SIFT_create(3000); bf = cv2.BFMatcher()


def best_framing(rawf, playf, pan_deg):
    pl = cv2.resize(playf, (PW, PH))
    k2, d2 = sift.detectAndCompute(cv2.cvtColor(pl, cv2.COLOR_BGR2GRAY), None)
    if d2 is None:
        return None
    best = (-1, None)
    for tilt in np.arange(-33, -7, 2):
        for fov in np.arange(22, 46, 2):
            u, v = MD.bake_uv_map(projs, np.radians(pan_deg), np.radians(tilt), fov, PW, PH)
            th, tw = rawf.shape[:2]; m1 = (u * tw).astype("f4"); m2 = (v * th).astype("f4"); m1[u < 0] = -1; m2[u < 0] = -1
            our = cv2.remap(rawf, m1, m2, cv2.INTER_LINEAR)
            k1, d1 = sift.detectAndCompute(cv2.cvtColor(our, cv2.COLOR_BGR2GRAY), None)
            if d1 is None:
                continue
            good = [a for a, b in bf.knnMatch(d1, d2, k=2) if a.distance < 0.75 * b.distance]
            if len(good) < 20:
                continue
            src = np.float32([k1[x.queryIdx].pt for x in good]).reshape(-1, 1, 2)
            dst = np.float32([k2[x.trainIdx].pt for x in good]).reshape(-1, 1, 2)
            M, inl = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=4.0)
            nin = int(inl.sum()) if inl is not None else 0
            if nin > best[0]:
                best = (nin, (float(tilt), float(fov)))
    return best


def main():
    raw, play, regf, out = sys.argv[1:5]
    N = int(sys.argv[sys.argv.index("--n") + 1]) if "--n" in sys.argv else 16
    reg = json.load(open(regf))
    rt = np.array(reg["t"]); rpx = np.array(reg["pano_x"]); rpy = np.array(reg["pano_y"]); rfw = np.array(reg["footw"])
    capr = cv2.VideoCapture(raw); capp = cv2.VideoCapture(play)
    dur = rt.max()
    rows = []
    for k in range(N):
        t = (k + 0.5) / N * dur
        capr.set(cv2.CAP_PROP_POS_MSEC, t * 1000); okr, rf = capr.read()
        capp.set(cv2.CAP_PROP_POS_MSEC, t * 1000); okp, pf = capp.read()
        if not (okr and okp):
            continue
        px = float(np.interp(t, rt, rpx)); py = float(np.interp(t, rt, rpy)); fw = float(np.interp(t, rt, rfw))
        pan = np.degrees(-1.0 * (px * W_PANO - CX) / F)
        b = best_framing(rf, pf, pan)
        if b and b[1]:
            tilt, fov = b[1]
            rows.append(dict(t=round(t, 2), pano_x=round(px, 4), pano_y=round(py, 4), footw=round(fw, 4),
                             pan=round(float(pan), 2), tilt=tilt, fov=fov, inliers=b[0]))
            print(f"  t={t:5.1f}s pan={pan:6.1f} → tilt={tilt:5.1f} fov={fov:4.1f} (inl {b[0]})", file=sys.stderr)
    capr.release(); capp.release()

    # global fits: tilt ~ a + b*|pan| ; fov ~ c + d*footw
    P = np.array([r["pan"] for r in rows]); T = np.array([r["tilt"] for r in rows])
    FW = np.array([r["footw"] for r in rows]); FO = np.array([r["fov"] for r in rows])
    tilt_fit = np.polyfit(np.abs(P), T, 1)
    fov_fit = np.polyfit(FW, FO, 1)
    tilt_res = float(np.std(T - np.polyval(tilt_fit, np.abs(P))))
    fov_res = float(np.std(FO - np.polyval(fov_fit, FW)))
    json.dump(dict(rows=rows, tilt_fit=list(map(float, tilt_fit)), fov_fit=list(map(float, fov_fit)),
                   tilt_resid=tilt_res, fov_resid=fov_res), open(out, "w"), indent=1)
    print(f"\ntilt = {tilt_fit[0]:.3f}*|pan| + {tilt_fit[1]:.2f}   (resid {tilt_res:.1f}°)")
    print(f"fov  = {fov_fit[0]:.1f}*footw + {fov_fit[1]:.1f}     (resid {fov_res:.1f}°)")
    print(f"→ {out}  ({len(rows)} anchors)")


if __name__ == "__main__":
    main()

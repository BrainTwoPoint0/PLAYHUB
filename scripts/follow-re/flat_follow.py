"""STEP 1 deliverable: a flat follow render that matches AutoFollow. The dewarp geometry
is proven flat; here we drive it with Spiideo's EXACT per-frame framing, recovered by
matching our dewarp to Spiideo's own Play frame (pan from SIFT registration; tilt+fov
refined per frame by local search seeded temporally). Output: 2-panel [OUR flat follow |
Spiideo AutoFollow] over the whole clip — should look near-identical.

  python3 flat_follow.py <raw.mp4> <play.mp4> <reg.json> <out.mp4> [--fps 5]
"""
from __future__ import annotations

import json
import sys
import numpy as np
import cv2

import mesh_dewarp as MD

OW, OH = 640, 360         # optimization + output panel size
F, CX, W_PANO = 1158.15, 1820.72, 3840.0
projs, _ = MD.load_mesh("/tmp/follow-pair/mesh")
sift = cv2.SIFT_create(2500); bf = cv2.BFMatcher()
_LUT = {}


def bake(pan, tilt, fov):
    key = (round(pan, 1), round(tilt, 1), round(fov, 1))
    m = _LUT.get(key)
    if m is None:
        u, v = MD.bake_uv_map(projs, np.radians(pan), np.radians(tilt), fov, OW, OH)
        m = (u, v); _LUT[key] = m
        if len(_LUT) > 6000:
            _LUT.clear()
    return m


def dewarp(rawf, pan, tilt, fov):
    u, v = bake(pan, tilt, fov)
    th, tw = rawf.shape[:2]; m1 = (u * tw).astype("f4"); m2 = (v * th).astype("f4"); m1[u < 0] = -1; m2[u < 0] = -1
    return cv2.remap(rawf, m1, m2, cv2.INTER_LINEAR)


def sim_resid(rawf, pan, tilt, fov, k2d2):
    k2, d2 = k2d2
    our = dewarp(rawf, pan, tilt, fov)
    k1, d1 = sift.detectAndCompute(cv2.cvtColor(our, cv2.COLOR_BGR2GRAY), None)
    if d1 is None:
        return 1e3
    good = [a for a, b in bf.knnMatch(d1, d2, k=2) if a.distance < 0.8 * b.distance]
    if len(good) < 18:
        return 1e3
    src = np.float32([k1[x.queryIdx].pt for x in good]).reshape(-1, 1, 2)
    dst = np.float32([k2[x.trainIdx].pt for x in good]).reshape(-1, 1, 2)
    M, inl = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=3.0)
    if M is None or inl.sum() < 25:              # need a real, spatially-spread match, not a tiny cluster
        return 1e3
    s = src.reshape(-1, 2)[inl.ravel() > 0]; d = dst.reshape(-1, 2)[inl.ravel() > 0]
    if np.ptp(s[:, 0]) < OW * 0.3 or np.ptp(s[:, 1]) < OH * 0.3:   # inliers must span the frame
        return 1e3
    return float(np.median(np.linalg.norm((M[:, :2] @ s.T).T + M[:, 2] - d, axis=1)))


TILT_LO, TILT_HI, FOV_LO, FOV_HI = -38.0, -8.0, 20.0, 44.0


def refine(rawf, pan, k2d2, tilt0, fov0, wide):
    if wide:
        trange = np.arange(TILT_LO, TILT_HI + 0.1, 3.0); frange = np.arange(FOV_LO, FOV_HI + 0.1, 3.0)
    else:
        trange = np.unique(np.clip(np.arange(tilt0 - 3, tilt0 + 3.1, 1.5), TILT_LO, TILT_HI))
        frange = np.unique(np.clip(np.arange(fov0 - 3, fov0 + 3.1, 1.5), FOV_LO, FOV_HI))
    best = (1e3, tilt0, fov0)
    for tilt in trange:
        for fov in frange:
            r = sim_resid(rawf, pan, tilt, fov, k2d2)
            if r < best[0]:
                best = (r, float(tilt), float(fov))
    return best


def main():
    raw, play, regf, out = sys.argv[1:5]
    reg = json.load(open(regf))
    rt = np.array(reg["t"]); rpx = np.array(reg["pano_x"])
    pans = np.degrees(-1.0 * (rpx * W_PANO - CX) / F)

    capr = cv2.VideoCapture(raw); capp = cv2.VideoCapture(play)
    fps = capp.get(cv2.CAP_PROP_FPS) or 25.0
    tilt, fov = -20.0, 32.0
    frames = []
    print(f"recovering framing at {len(rt)} sample times...", file=sys.stderr)
    for i, t in enumerate(rt):
        capr.set(cv2.CAP_PROP_POS_MSEC, t * 1000); okr, rf = capr.read()
        capp.set(cv2.CAP_PROP_POS_MSEC, t * 1000); okp, pf = capp.read()
        if not (okr and okp):
            frames.append((t, pans[i], tilt, fov, 1e3)); continue
        pl = cv2.resize(pf, (OW, OH))
        k2, d2 = sift.detectAndCompute(cv2.cvtColor(pl, cv2.COLOR_BGR2GRAY), None)
        wide = (i == 0) or (frames and frames[-1][4] > 6)
        r, tilt, fov = refine(rf, pans[i], (k2, d2), tilt, fov, wide)
        frames.append((t, float(pans[i]), tilt, fov, r))
        if i % 50 == 0:
            print(f"  {i}/{len(rt)} t={t:.0f}s pan={pans[i]:.0f} tilt={tilt:.0f} fov={fov:.0f} resid={r:.1f}", file=sys.stderr)

    A = np.array(frames)  # t, pan, tilt, fov, resid
    tt, pan_a, tilt_a, fov_a, res_a = A[:, 0], A[:, 1], A[:, 2], A[:, 3], A[:, 4]
    bad = res_a > 6
    for arr in (tilt_a, fov_a):                       # interpolate bad frames
        if bad.any() and (~bad).sum() > 2:
            arr[bad] = np.interp(tt[bad], tt[~bad], arr[~bad])
    k = 5
    tilt_s = np.convolve(tilt_a, np.ones(k) / k, "same")
    fov_s = np.convolve(fov_a, np.ones(k) / k, "same")
    json.dump(dict(t=list(tt), pan=list(pan_a), tilt=list(map(float, tilt_s)), fov=list(map(float, fov_s)),
                   resid=list(res_a), median_resid=float(np.median(res_a[res_a < 100]))),
              open(out.replace(".mp4", "_framing.json"), "w"))
    print(f"framing median residual {np.median(res_a[res_a<100]):.2f}px; {int(bad.sum())}/{len(A)} frames interpolated", file=sys.stderr)

    # render 25fps: interp framing to render times
    n = int(capr.get(cv2.CAP_PROP_FRAME_COUNT)) or int(tt.max() * fps)
    def lab(im, tx, c):
        cv2.rectangle(im, (0, 0), (OW, 24), (0, 0, 0), -1); cv2.putText(im, tx, (7, 17), cv2.FONT_HERSHEY_SIMPLEX, 0.5, c, 1); return im
    capr.set(cv2.CAP_PROP_POS_FRAMES, 0); capp.set(cv2.CAP_PROP_POS_FRAMES, 0)
    vw = cv2.VideoWriter(out, cv2.VideoWriter_fourcc(*"mp4v"), fps, (OW * 2, OH))
    i = 0
    while True:
        okr, rf = capr.read(); okp, pf = capp.read()
        if not okr or i >= n:
            break
        ct = i / fps
        pan = np.interp(ct, tt, pan_a); tilt = np.interp(ct, tt, tilt_s); fov = np.interp(ct, tt, fov_s)
        a = lab(dewarp(rf, pan, tilt, fov), "PLAYHUB flat follow (our dewarp, Spiideo framing)", (120, 255, 120))
        b = lab(cv2.resize(pf, (OW, OH)) if okp else np.zeros((OH, OW, 3), np.uint8), "Spiideo AutoFollow", (210, 210, 210))
        vw.write(np.hstack([a, b])); i += 1
        if i % 250 == 0:
            print(f"  render {i}/{n}", file=sys.stderr)
    capr.release(); capp.release(); vw.release()
    print(f"wrote {out} ({i} frames)")


if __name__ == "__main__":
    main()

"""Spatial+temporal label layer for imitation: recover the Spiideo AutoFollow camera's
ABSOLUTE framing per frame, in the panorama coordinate the raw-VP player features live
in — so targets are consistent WITHIN and ACROSS matches (all Nazwa matches share one
fixed camera → one pano-x frame).

Method (robust — SIFT homography, not parameter search): the Spiideo render is a dewarp
of the same static scene as the raw VP, so their backgrounds (goals, fence, cars, pitch
lines) match densely. Per frame: SIFT match render↔raw, RANSAC homography, then map the
render's center + horizontal edges through it into the raw panorama:
  pano_x   = render-center x / W_pano          (PAN target)
  pano_y   = render-center y / H_pano          (TILT target)
  footw    = render horizontal footprint / W   (ZOOM target; narrower = tighter)
60–130 inliers/frame on night footage. Low-inlier frames are dropped and interpolated.

  python3 register_render.py <raw.mp4> <play.mp4> <out.json> [--fps 5] [--min-inliers 25]
"""
from __future__ import annotations

import json
import sys

import numpy as np
import cv2

RW, RH = 1920, 1080          # raw working width for the pano_x mapping (full pano = 1.0)
PWp, PHp = 960, 540          # render working size


def register(raw, play, sample_fps=5.0, min_inliers=25):
    sift = cv2.SIFT_create(4000)
    bf = cv2.BFMatcher()
    capr = cv2.VideoCapture(raw); capp = cv2.VideoCapture(play)
    fps = capp.get(cv2.CAP_PROP_FPS) or 25.0
    n = int(capp.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
    vfps = capr.get(cv2.CAP_PROP_FPS) or 25.0
    nraw = int(capr.get(cv2.CAP_PROP_FRAME_COUNT)) or n
    step_ms = 1000.0 / sample_fps
    dur = n / fps

    rows = []
    t = 0.0
    while t < dur:
        capp.set(cv2.CAP_PROP_POS_MSEC, t * 1000); okp, fp = capp.read()
        capr.set(cv2.CAP_PROP_POS_MSEC, t * 1000); okr, fr = capr.read()
        if not (okp and okr):
            break
        pp = cv2.resize(fp, (PWp, PHp))
        rr = cv2.resize(fr, (RW, RH))
        k1, d1 = sift.detectAndCompute(cv2.cvtColor(pp, cv2.COLOR_BGR2GRAY), None)
        k2, d2 = sift.detectAndCompute(cv2.cvtColor(rr, cv2.COLOR_BGR2GRAY), None)
        row = dict(t=round(t, 3), frame=int(round(t * vfps)), inliers=0,
                   pano_x=np.nan, pano_y=np.nan, footw=np.nan)
        if d1 is not None and d2 is not None:
            m = bf.knnMatch(d1, d2, k=2)
            good = [a for a, b in m if a.distance < 0.75 * b.distance]
            if len(good) >= 12:
                src = np.float32([k1[x.queryIdx].pt for x in good]).reshape(-1, 1, 2)
                dst = np.float32([k2[x.trainIdx].pt for x in good]).reshape(-1, 1, 2)
                Hm, mask = cv2.findHomography(src, dst, cv2.RANSAC, 5.0)
                inl = int(mask.sum()) if mask is not None else 0
                if Hm is not None and inl >= min_inliers:
                    pts = np.float32([[[PWp / 2, PHp / 2]], [[0, PHp / 2]], [[PWp, PHp / 2]]])
                    c, l, r = cv2.perspectiveTransform(pts, Hm).reshape(-1, 2)
                    row.update(inliers=inl, pano_x=float(c[0] / RW), pano_y=float(c[1] / RH),
                               footw=float(abs(r[0] - l[0]) / RW))
        rows.append(row)
        t += step_ms / 1000.0
    capr.release(); capp.release()

    # interpolate dropped frames; report coverage
    tt = np.array([r["t"] for r in rows])
    out = {}
    for key in ("pano_x", "pano_y", "footw"):
        v = np.array([r[key] for r in rows]); ok = ~np.isnan(v)
        if ok.sum() >= 2:
            v = np.interp(tt, tt[ok], v[ok])
        out[key] = [round(float(x), 5) for x in v]
    cov = float(np.mean([r["inliers"] >= min_inliers for r in rows]))
    return dict(fps=fps, sample_fps=sample_fps, dur=dur, n=len(rows), coverage=round(cov, 3),
                median_inliers=float(np.median([r["inliers"] for r in rows])),
                t=[round(float(x), 3) for x in tt],
                frame=[r["frame"] for r in rows], inliers=[r["inliers"] for r in rows], **out)


def main():
    raw, play, out = sys.argv[1:4]
    fps = float(sys.argv[sys.argv.index("--fps") + 1]) if "--fps" in sys.argv else 5.0
    mi = int(sys.argv[sys.argv.index("--min-inliers") + 1]) if "--min-inliers" in sys.argv else 25
    r = register(raw, play, fps, mi)
    json.dump(r, open(out, "w"))
    px = np.array(r["pano_x"])
    print(f"registered {r['n']} frames @ {fps}fps  coverage {r['coverage']*100:.0f}% "
          f"(median {r['median_inliers']:.0f} inliers)  pano_x range {px.min():.3f}–{px.max():.3f} → {out}")


if __name__ == "__main__":
    main()

"""SIFT registration of the produced Play render against the raw VirtualPanorama.

Port of scripts/follow-re/register_render.py (the proven reg-SIFT ground-truth
instrument, AIM_RESUME.md §4.1): the Play render is a dewarp of the same static
scene as the raw VP, so their backgrounds (goals, fence, pitch lines) match
densely. Per sample: SIFT match render->raw, RANSAC homography, then map the
render's centre + horizontal edge midpoints into normalized panorama coords:

  pano_x = centre x / RW   (pan target, 0..1 across the full panorama width)
  pano_y = centre y / RH   (tilt target)
  footw  = |right - left| / RW  (horizontal footprint; zoom target)

Both streams are seeked by MILLISECONDS from t=0. The two inputs must share the
same t0 (all streams of a Spiideo game share startTime), and registering the
FULL Play mp4 makes t equal to the produced video's presentation time — the
exact clock the web player scrubs.

Low-inlier samples are recorded with inliers=0 and NaN coords; interpolation
happens in aim_convert (so the raw evidence survives into the output).
"""

from __future__ import annotations

import numpy as np
import cv2

RW, RH = 1920, 1080  # raw working size (pano_x/pano_y are normalized to this)
PWp, PHp = 960, 540  # render working size


def register(raw_path: str, play_path: str, sample_fps: float = 5.0,
             min_inliers: int = 25, log_every_s: float = 300.0):
    sift = cv2.SIFT_create(4000)
    bf = cv2.BFMatcher()
    capr = cv2.VideoCapture(raw_path)
    capp = cv2.VideoCapture(play_path)
    if not capr.isOpened() or not capp.isOpened():
        raise RuntimeError('could not open input video(s)')
    fps = capp.get(cv2.CAP_PROP_FPS) or 25.0
    n_play = int(capp.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
    dur = n_play / fps
    step = 1.0 / sample_fps

    rows = []
    t = 0.0
    next_log = 0.0
    while t < dur:
        capp.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        okp, fp = capp.read()
        capr.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        okr, fr = capr.read()
        if not (okp and okr):
            break
        pp = cv2.resize(fp, (PWp, PHp))
        rr = cv2.resize(fr, (RW, RH))
        k1, d1 = sift.detectAndCompute(cv2.cvtColor(pp, cv2.COLOR_BGR2GRAY), None)
        k2, d2 = sift.detectAndCompute(cv2.cvtColor(rr, cv2.COLOR_BGR2GRAY), None)
        row = dict(t=round(t, 3), inliers=0,
                   pano_x=np.nan, pano_y=np.nan, footw=np.nan)
        if d1 is not None and d2 is not None:
            m = bf.knnMatch(d1, d2, k=2)
            # knnMatch can return <2 entries per query on near-empty descriptor
            # sets (black pre-roll frames) — unpacking would raise.
            good = [p[0] for p in m
                    if len(p) == 2 and p[0].distance < 0.75 * p[1].distance]
            if len(good) >= 12:
                src = np.float32([k1[x.queryIdx].pt for x in good]).reshape(-1, 1, 2)
                dst = np.float32([k2[x.trainIdx].pt for x in good]).reshape(-1, 1, 2)
                Hm, mask = cv2.findHomography(src, dst, cv2.RANSAC, 5.0)
                inl = int(mask.sum()) if mask is not None else 0
                if Hm is not None and inl >= min_inliers:
                    pts = np.float32([[[PWp / 2, PHp / 2]],
                                      [[0, PHp / 2]],
                                      [[PWp, PHp / 2]]])
                    c, l, r = cv2.perspectiveTransform(pts, Hm).reshape(-1, 2)
                    row.update(inliers=inl,
                               pano_x=float(c[0] / RW),
                               pano_y=float(c[1] / RH),
                               footw=float(abs(r[0] - l[0]) / RW))
        rows.append(row)
        if t >= next_log:
            print(f'register: t={t:.0f}s/{dur:.0f}s inliers={row["inliers"]}',
                  flush=True)
            next_log = t + log_every_s
        t += step
    capr.release()
    capp.release()

    if not rows:
        raise RuntimeError('no frames registered (empty/zero-length inputs?)')
    inliers = np.array([r['inliers'] for r in rows])
    return dict(
        fps=float(fps),
        sample_fps=float(sample_fps),
        dur=float(dur),
        n=len(rows),
        min_inliers=int(min_inliers),
        coverage=round(float(np.mean(inliers >= min_inliers)), 4),
        median_inliers=float(np.median(inliers)),
        t=np.array([r['t'] for r in rows], np.float64),
        inliers=inliers,
        pano_x=np.array([r['pano_x'] for r in rows], np.float64),
        pano_y=np.array([r['pano_y'] for r in rows], np.float64),
        footw=np.array([r['footw'] for r in rows], np.float64),
    )

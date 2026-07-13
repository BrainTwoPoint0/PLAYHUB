"""Recover the ground-truth camera pan(t) directly from a follow-render — P1, the
leanest GT (prior-art: on a static panoramic background the render's own motion IS
the camera motion; 5+ papers validate homography/flow decomposition). No B1 render-
match, no raw panorama, no registration.

Method: sparse LK optical flow across the frame; the MEDIAN horizontal flow is the
global background pan (players/ball are a minority of features → outliers the median
rejects — the same camera-motion-compensation trick validated in mine_candidates.py).
Integrate the per-step median dx → relative pan(t) in pixels; convert to degrees if a
render FOV is supplied, else report normalized (fraction of frame width). Because the
camera pans, the background slides OPPOSITE to the pan, so pan_px = -cumulative(dx_bg).

  from gt_from_render import gt_pan
  pan_deg, meta = gt_pan("clip.mp4", render_fov_deg=None)  # normalized if fov None
"""
from __future__ import annotations

import numpy as np
import cv2


def gt_pan(video_path: str, render_fov_deg: float | None = None, max_frames: int = 0):
    """Returns (pan[N], meta). pan is cumulative camera pan per frame:
    - degrees if render_fov_deg given (deg/px = render_fov_deg / width)
    - else normalized (fraction of frame width) — fine for RELATIVE ball-vs-centroid.
    pan[0]=0 (relative reference). meta has fps, width, height, n, drift diagnostics."""
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or 1920
    H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 1080

    lk = dict(winSize=(21, 21), maxLevel=3,
              criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01))
    feat = dict(maxCorners=600, qualityLevel=0.01, minDistance=8, blockSize=7)

    ok, prev = cap.read()
    if not ok:
        raise RuntimeError(f"cannot read {video_path}")
    prev_g = cv2.cvtColor(prev, cv2.COLOR_BGR2GRAY)
    dx_bg = [0.0]  # per-step median background horizontal flow; frame 0 = 0
    ninliers = [0]
    idx = 1
    while True:
        ok, frame = cap.read()
        if not ok or (max_frames and idx >= max_frames):
            break
        g = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        p0 = cv2.goodFeaturesToTrack(prev_g, mask=None, **feat)
        step_dx, nin = 0.0, 0
        if p0 is not None and len(p0) >= 8:
            p1, st, _ = cv2.calcOpticalFlowPyrLK(prev_g, g, p0, None, **lk)
            st = st.reshape(-1).astype(bool)
            if st.sum() >= 8:
                flow = (p1 - p0).reshape(-1, 2)[st]
                # median horizontal flow = global background motion (player/ball
                # features are outliers the median rejects).
                step_dx = float(np.median(flow[:, 0]))
                nin = int(st.sum())
        dx_bg.append(step_dx)
        ninliers.append(nin)
        prev_g = g
        idx += 1
    cap.release()

    # Camera pan = -cumulative background slide.
    pan_px = -np.cumsum(np.array(dx_bg))
    if render_fov_deg is not None:
        pan = pan_px * (render_fov_deg / W)   # degrees
        unit = "deg"
    else:
        pan = pan_px / W                       # normalized (fraction of width)
        unit = "norm"
    meta = {
        "fps": fps, "width": W, "height": H, "n": len(pan), "unit": unit,
        "median_inliers": float(np.median(ninliers[1:]) if len(ninliers) > 1 else 0),
        "pan_range": float(pan.max() - pan.min()),
    }
    return pan, meta


if __name__ == "__main__":
    import sys
    pan, meta = gt_pan(sys.argv[1], render_fov_deg=(float(sys.argv[2]) if len(sys.argv) > 2 else None))
    print(f"pan(t): {meta['n']} frames, unit={meta['unit']}, range={meta['pan_range']:.4f}, "
          f"median LK inliers/frame={meta['median_inliers']:.0f}")

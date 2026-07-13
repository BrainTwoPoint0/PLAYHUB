"""[B] Follow re-targeting probe: is PLAYER-density a better follow target than the
deployed motion-centroid, on the RAW PANORAMA? (CV + prior-art: the follow is a
player-tracking problem, not a ball one — Spiideo/Deep-360-Pilot follow players.)

Fully-scored residual° vs Spiideo needs a paired Spiideo RENDER (gt_from_render) —
data-blocked tonight. This probe answers the cheaper prerequisite autonomously:
run YOLO PERSON detection on the panorama, form the player-cluster centroid, push
it (and the motion-centroid) through the deployed controller, and characterize:
  - target coverage (fraction of frames with a usable target)
  - smoothness (jerk P95 of the resulting follow) — lower = more watchable
  - agreement / spread of player-centroid (is the action a coherent point?)
A player-centroid that yields a smooth, well-covered, coherent follow ⇒ worth
wiring up + scoring vs Spiideo once the render is fetched.

  python3 follow_retarget.py <panorama.mp4> [--fps 5]
"""
from __future__ import annotations

import sys
import numpy as np
import cv2

from controller import FollowController

PLAYER_CLS = 0  # COCO person
CONF = 0.35


def player_centroids(video, sample_fps=5.0):
    from ultralytics import YOLO
    model = YOLO("yolov8m.pt")  # generic person detector — players are 30-100px, easy
    cap = cv2.VideoCapture(video)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or 1920
    H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 1080
    step = max(1, round(fps / sample_fps))
    cents, motion, spreads, nplayers = {}, {}, {}, []
    accum = np.zeros((108, 192), np.float32)
    prev = None
    idx = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        # motion-centroid (deployed baseline) — every frame
        small = cv2.resize(frame, (192, 108))
        luma = (0.299 * small[:, :, 2] + 0.587 * small[:, :, 1] + 0.114 * small[:, :, 0]).astype(np.float32)
        if prev is not None:
            diff = np.abs(luma - prev)
            accum[:] = accum * 0.9 + np.where(diff > 14, diff, 0)
            m = accum > 6
            if accum[m].sum() > 700 * 108 * 192 / (192 * 108):
                ys, xs = np.nonzero(m)
                w = accum[m]
                motion[idx] = float((w * xs).sum() / w.sum()) / 192
        prev = luma
        # player-cluster centroid — sampled (YOLO is the cost)
        if idx % step == 0:
            r = model.predict(frame, classes=[PLAYER_CLS], conf=CONF, imgsz=1280, verbose=False)[0]
            if r.boxes is not None and len(r.boxes) > 0:
                cx = ((r.boxes.xyxy[:, 0] + r.boxes.xyxy[:, 2]) / 2).cpu().numpy() / W
                cents[idx] = float(cx.mean())
                spreads[idx] = float(cx.std())
                nplayers.append(len(cx))
        idx += 1
    cap.release()
    return cents, motion, spreads, nplayers, fps, idx


def follow_and_score(targets_by_frame, n, fps):
    """Run targets (norm x) through the deployed controller (coast on gaps).
    Returns (coverage, jerk_p95) of the resulting follow."""
    ctl = FollowController(fps=fps)
    pan = []
    for fr in range(n):
        t = targets_by_frame.get(fr)
        pan.append(ctl.step({"pan": t, "tilt": 0.0, "fov": 40.0} if t is not None else None)["pan"])
    pan = np.array(pan)
    jerk = np.abs(np.diff(pan, 2)) if len(pan) > 2 else np.array([0.0])
    return len(targets_by_frame) / max(1, n), float(np.percentile(jerk, 95))


def main():
    video = sys.argv[1]
    sfps = float(sys.argv[sys.argv.index("--fps") + 1]) if "--fps" in sys.argv else 5.0
    print(f"=== [B] player-centroid vs motion-centroid on {video.split('/')[-1]} ===")
    cents, motion, spreads, nplayers, fps, n = player_centroids(video, sfps)
    print(f"frames={n} fps={fps:.1f}  players/frame median={np.median(nplayers) if nplayers else 0:.0f} "
          f"(many => panorama; few => render)")
    print(f"player-centroid spread median={np.median(list(spreads.values())) if spreads else 0:.3f} "
          f"(low => coherent action point)")
    pc_cov, pc_jerk = follow_and_score(cents, n, fps)
    mc_cov, mc_jerk = follow_and_score(motion, n, fps)
    print(f"\n{'target':16} coverage  jerkP95(follow)")
    print(f"{'player-centroid':16} {pc_cov*100:6.1f}%  {pc_jerk:.5f}")
    print(f"{'motion-centroid':16} {mc_cov*100:6.1f}%  {mc_jerk:.5f}")
    print("\nNOTE: residual° vs Spiideo needs the paired Spiideo render (gt_from_render) — data-blocked; "
          "this probe = does player-density give a smooth, well-covered follow target.")


if __name__ == "__main__":
    main()

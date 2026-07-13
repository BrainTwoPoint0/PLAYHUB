"""Cache YOLO person detections over a raw VP once, so follow-target signals
(mean / densest-cluster / motion-weighted) can be iterated in seconds instead of
re-running 4K detection each time. Also caches Spiideo's pan from the Play render.

  python3 cache_players.py <raw_vp.mp4> <play_render.mp4> <out.json> [--fps 5]
"""
from __future__ import annotations

import json
import sys

import numpy as np
import cv2

from gt_from_render import gt_pan

PLAYER_CLS = 0
CONF = 0.35


def cache(raw: str, play: str, out: str, sample_fps: float = 5.0):
    from ultralytics import YOLO
    model = YOLO("yolov8m.pt")
    cap = cv2.VideoCapture(raw)
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or 3840
    H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 2160
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
    step = max(1, round(fps / sample_fps))

    # per-sampled-frame: normalized player x-centers (+ y for later), and a global
    # motion-centroid x computed on EVERY frame (cheap frame-diff, like stepFollow).
    players = {}          # frame_idx -> [x_norm,...]
    motion = {}           # frame_idx -> x_norm
    mhist = {}            # frame_idx -> 32-bin motion-energy x-histogram (BALL PROXY)
    MB = 32               # motion histogram bins across pano width
    accum = np.zeros((108, 192), np.float32)
    prev = None
    idx = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        small = cv2.resize(frame, (192, 108))
        luma = (0.299 * small[:, :, 2] + 0.587 * small[:, :, 1] + 0.114 * small[:, :, 0]).astype(np.float32)
        if prev is not None:
            diff = np.abs(luma - prev)
            accum[:] = accum * 0.9 + np.where(diff > 14, diff, 0)
            m = accum > 6
            if accum[m].sum() > 700:
                ys, xs = np.nonzero(m)
                w = accum[m]
                motion[idx] = float((w * xs).sum() / w.sum()) / 192
        prev = luma
        if idx % step == 0:
            r = model.predict(frame, classes=[PLAYER_CLS], conf=CONF, imgsz=1280, verbose=False)[0]
            if r.boxes is not None and len(r.boxes) > 0:
                xy = r.boxes.xyxy.cpu().numpy()
                cx = (xy[:, 0] + xy[:, 2]) / 2 / W
                fy = xy[:, 3] / H  # FOOT point (bottom of box) — for on-pitch masking via homography
                players[idx] = [[round(float(x), 4), round(float(y), 4)] for x, y in zip(cx, fy)]
            # motion-energy x-histogram (ball proxy): column-sum the decayed frame-diff
            # accumulator, rebin 192→32, L1-normalize. Captures WHERE the action is.
            col = accum.sum(axis=0).reshape(MB, 192 // MB).sum(axis=1)
            s = col.sum()
            mhist[idx] = [round(float(v), 5) for v in (col / s)] if s > 1e-6 else [0.0] * MB
        idx += 1
        if idx % 250 == 0:
            print(f"  ...{idx}/{n} frames", file=sys.stderr)
    cap.release()

    print("  recovering Spiideo pan (optical flow)...", file=sys.stderr)
    pan_S, metaS = gt_pan(play, render_fov_deg=None)

    json.dump({
        "video_fps": fps, "video_frames": idx, "W": W, "H": H, "sample_fps": sample_fps,
        "mhist_bins": MB,
        "players": players, "motion": motion, "mhist": mhist,
        "spiideo_pan": [round(float(p), 5) for p in pan_S], "spiideo_fps": metaS["fps"],
        "spiideo_pan_range": metaS["pan_range"],
    }, open(out, "w"))
    print(f"cached → {out}: {len(players)} player-frames, {len(motion)} motion-frames, "
          f"Spiideo pan range {metaS['pan_range']:.3f}", file=sys.stderr)


if __name__ == "__main__":
    raw, play, out = sys.argv[1], sys.argv[2], sys.argv[3]
    sf = float(sys.argv[sys.argv.index("--fps") + 1]) if "--fps" in sys.argv else 5.0
    cache(raw, play, out, sf)

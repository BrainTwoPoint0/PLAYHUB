#!/usr/bin/env python3
"""Run a trained TrackNetV2 model over a clip and emit candidates in OUR pipeline
format (the same `_raw.json` schema as detect_ball.py), so oracle.mjs and the DP
can consume it identically to the YOLO path — the apples-to-apples gate wiring.

TrackNetV2 here is 3-in-3-out (3 RGB frames → 3 heatmaps, one per frame). For each
frame we extract the TOP-K heatmap peaks as candidates with **conf = peak height**
— the real calibrated confidence that raw motion lacked, which lets the Viterbi DP
prefer the ball over distractors. Coordinates are scaled from the network's imgsz
back to full frame.

Output JSON: {positions, scene_changes:[], all_candidates, frame_clusters:[]}
  all_candidates: [{time, x, y, conf, source:"temporal"}]   (consumed by oracle.mjs)

Usage:
  python detect_tracknet.py --source clip.mp4 --weights best.pt \
      --imgsz 288 512 --fps 25 --out clip_tracknet_raw.json
Run on the frozen-holdout goal clip, then: node ../eval-dataset/oracle.mjs <clip>
to read temporal-source oracle vs the YOLO baseline (the MVP gate).
"""
import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np
import torch
import torchvision

VENDOR = Path(__file__).resolve().parent / "vendor"
sys.path.insert(0, str(VENDOR))
from models.tracknet import TrackNet  # noqa: E402

PEAK_THRESH = 0.5   # heatmap value to seed a peak (vendor's operating point)
TOP_K = 5           # candidates kept per frame (one ball + a few alternates for the DP)


def heatmap_to_candidates(hm, fw, fh, topk=TOP_K, thresh=PEAK_THRESH):
    """HxW heatmap in [0,1] → up to topk candidates in FULL-frame coords.
    conf = peak height; center = intensity-weighted centroid (sub-pixel)."""
    H, W = hm.shape
    mask = (hm > thresh).astype(np.uint8)
    n, labels, _, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    cands = []
    for i in range(1, n):
        ys, xs = np.where(labels == i)
        if xs.size == 0:
            continue
        wts = hm[ys, xs]
        peak = float(wts.max())
        cx = float((xs * wts).sum() / wts.sum())
        cy = float((ys * wts).sum() / wts.sum())
        cands.append({"x": round(cx * fw / W, 1), "y": round(cy * fh / H, 1),
                      "conf": round(peak, 3), "source": "temporal"})
    cands.sort(key=lambda c: c["conf"], reverse=True)
    return cands[:topk]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True)
    ap.add_argument("--weights", required=True)
    ap.add_argument("--imgsz", nargs=2, type=int, default=[288, 512], help="h w (must match training)")
    ap.add_argument("--fps", type=float, default=25.0)
    ap.add_argument("--out", required=True)
    opt = ap.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = TrackNet().to(device)
    model.load_state_dict(torch.load(opt.weights, map_location=device))
    model.eval()

    cap = cv2.VideoCapture(opt.source)
    video_fps = cap.get(cv2.CAP_PROP_FPS)
    fw = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    fh = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    interval = max(1, round(video_fps / opt.fps))

    all_cands, positions = [], []
    buf, times, frame_idx = [], [], 0
    to_tensor = torchvision.transforms.ToTensor()

    def flush(triplet, ts):
        x = []
        for img in triplet:
            t = to_tensor(cv2.cvtColor(img, cv2.COLOR_BGR2RGB)).to(device)
            t = torchvision.transforms.functional.resize(t, opt.imgsz, antialias=True)
            x.append(t)
        with torch.no_grad():
            preds = model(torch.cat(x, dim=0).unsqueeze(0))[0].detach().cpu().numpy()  # (3,H,W)
        for j in range(3):
            cs = heatmap_to_candidates(preds[j], fw, fh)
            for c in cs:
                all_cands.append({"time": round(ts[j], 3), **c})
            best = cs[0] if cs else None
            positions.append({"time": round(ts[j], 3),
                              "x": best["x"] if best else None,
                              "y": best["y"] if best else None,
                              "source": "ball" if best else "none"})

    while True:
        ret, img = cap.read()
        if not ret:
            break
        if frame_idx % interval == 0:
            buf.append(img)
            times.append(frame_idx / video_fps)
            if len(buf) == 3:
                flush(buf, times)
                buf, times = [], []
        frame_idx += 1
    cap.release()

    out = {"positions": positions, "scene_changes": [], "all_candidates": all_cands, "frame_clusters": []}
    Path(opt.out).write_text(json.dumps(out))
    print(f"Wrote {opt.out}: {len(positions)} frames, {len(all_cands)} temporal candidates", file=sys.stderr)


if __name__ == "__main__":
    main()

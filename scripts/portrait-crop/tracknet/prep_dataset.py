#!/usr/bin/env python3
"""Build a TrackNetV2-pytorch dataset from our CVAT-derived labels + clip videos.

Output layout (matches vendor/ TrackNetV2-pytorch expectations):
  dataset/match/images/<clip>/<frame_num>.jpg
  dataset/match/labels/<clip>.csv      # frame_num,visible,x,y  (x,y normalized 0..1)
  dataset/match.yaml                    # train = labelled non-holdout; val = frozen_holdout

We emit only frames + normalized ball points; the vendor dataloader generates the
Gaussian heatmap targets on-the-fly (so we adopt its verified sigma/heatmap math,
per the ml-ops warning not to reconstruct it). Frames are extracted for the
contiguous labelled range of each clip (the airborne window). Split is BY CLIP and
the frozen-holdout clip is the only val entry (no frame leakage).

Usage: python prep_dataset.py
"""
import csv
import json
from pathlib import Path

import cv2

ROOT = Path(__file__).resolve().parent
ED = ROOT.parent / "eval-dataset"
CLIPS, LABELS = ED / "clips", ED / "labels"
OUT = ROOT / "dataset"

manifest = json.loads((ED / "manifest.json").read_text())
holdout = set(manifest.get("frozen_holdout", []))


def prep_clip(clip_id: str, split: str):
    gtp, vid = LABELS / f"{clip_id}.json", CLIPS / f"{clip_id}.mp4"
    if not gtp.exists() or not vid.exists():
        print(f"  skip {clip_id} (missing labels or video)")
        return None
    gt = json.loads(gtp.read_text())
    frames = {f["frame"]: f for f in gt["frames"]}
    fmin, fmax = min(frames), max(frames)
    img_dir = OUT / "match" / "images" / clip_id
    img_dir.mkdir(parents=True, exist_ok=True)
    cap = cv2.VideoCapture(str(vid))
    fw, fh = cap.get(cv2.CAP_PROP_FRAME_WIDTH), cap.get(cv2.CAP_PROP_FRAME_HEIGHT)
    rows, idx, vis = [], 0, 0
    while True:
        ret, fr = cap.read()
        if not ret or idx > fmax:
            break
        if fmin <= idx <= fmax:
            cv2.imwrite(str(img_dir / f"{idx}.jpg"), fr)
            f = frames.get(idx)
            if f and f["ball"]["visible"]:
                rows.append((idx, 1, round(f["ball"]["x"] / fw, 6), round(f["ball"]["y"] / fh, 6)))
                vis += 1
            else:
                rows.append((idx, 0, 0, 0))
        idx += 1
    cap.release()
    (OUT / "match" / "labels").mkdir(parents=True, exist_ok=True)
    with open(OUT / "match" / "labels" / f"{clip_id}.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["frame_num", "visible", "x", "y"])
        w.writerows(rows)
    print(f"  {clip_id} [{split}]: {len(rows)} frames ({vis} visible), range {fmin}-{fmax}, {int(fw)}x{int(fh)}")
    return clip_id


labeled = sorted(p.stem for p in LABELS.glob("*.json"))
train_ids = [c for c in labeled if c not in holdout]
val_ids = [c for c in labeled if c in holdout]
print(f"Building TrackNetV2 dataset → {OUT}\n(frozen_holdout = {sorted(holdout)})\n")
print("TRAIN:")
train = [c for c in (prep_clip(c, "train") for c in train_ids) if c]
print("VAL (frozen holdout):")
val = [c for c in (prep_clip(c, "val") for c in val_ids) if c]

yaml = (f"path: {OUT}\ntrain:\n" + "".join(f"  - match/images/{c}\n" for c in train)
        + "val:\n" + "".join(f"  - match/images/{c}\n" for c in val))
(OUT / "match.yaml").write_text(yaml)
print(f"\nWrote {OUT}/match.yaml  (train={len(train)} clips, val={len(val)} clips)")
print("NOTE: train needs AIRBORNE-goal clips to test the airborne gate — label 2-3 and re-run.")

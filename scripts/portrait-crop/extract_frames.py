"""
Extract frames from Veo goal clips for YOLOv8 fine-tuning annotation.

Extracts diverse frames at 2fps (every 15th frame at 30fps), prioritizing:
- Frames where current detection FAILS (for learning hard cases)
- Frames from different clips (for diversity)

Usage:
  python3 extract_frames.py <clip_dir> <output_dir> [--max-per-clip 50]

Output: PNG frames named <clip>_<frame_idx>.png in <output_dir>/
Upload to Roboflow for annotation, then fine-tune with:
  yolo detect train model=yolov8m_forzasys_soccer.pt data=dataset.yaml epochs=50

Annotation guide:
  - Label class 0 = player, class 1 = ball (matches Forzasys convention)
  - Annotate ALL visible balls (even partially occluded)
  - Annotate players on the pitch (skip crowd/sideline staff)
  - Use tight bounding boxes
"""

import sys
import os
import cv2
import glob
import random


def extract_frames(clip_dir: str, output_dir: str, max_per_clip: int = 50):
    os.makedirs(output_dir, exist_ok=True)

    clips = sorted(glob.glob(os.path.join(clip_dir, "*.mp4")))
    if not clips:
        print(f"No .mp4 files found in {clip_dir}", file=sys.stderr)
        sys.exit(1)

    print(f"Found {len(clips)} clips in {clip_dir}")
    total_extracted = 0

    for clip_path in clips:
        basename = os.path.splitext(os.path.basename(clip_path))[0]
        cap = cv2.VideoCapture(clip_path)
        if not cap.isOpened():
            print(f"  Skipping {basename} — cannot open", file=sys.stderr)
            continue

        video_fps = cap.get(cv2.CAP_PROP_FPS)
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        # Extract at 2fps — every 15th frame at 30fps
        interval = max(1, round(video_fps / 2.0))

        # Collect candidate frame indices
        candidates = list(range(0, total_frames, interval))
        # Limit per clip — random sample for diversity
        if len(candidates) > max_per_clip:
            candidates = sorted(random.sample(candidates, max_per_clip))

        clip_count = 0
        for frame_idx in candidates:
            cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
            ret, frame = cap.read()
            if not ret:
                continue

            # Skip black frames
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            if gray.mean() < 15:
                continue

            out_name = f"{basename}_{frame_idx:06d}.png"
            out_path = os.path.join(output_dir, out_name)
            cv2.imwrite(out_path, frame)
            clip_count += 1

        cap.release()
        total_extracted += clip_count
        print(f"  {basename}: {clip_count} frames extracted")

    print(f"\nTotal: {total_extracted} frames in {output_dir}")
    print(f"\nNext steps:")
    print(f"  1. Upload to Roboflow (roboflow.com) — create project with classes: player, ball")
    print(f"  2. Annotate ball bounding boxes (tight bbox around the ball)")
    print(f"  3. Export in YOLOv8 format")
    print(f"  4. Fine-tune: yolo detect train model=yolov8m_forzasys_soccer.pt data=dataset.yaml epochs=50 imgsz=1280")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python3 extract_frames.py <clip_dir> <output_dir> [--max-per-clip 50]")
        sys.exit(1)

    clip_dir = sys.argv[1]
    output_dir = sys.argv[2]
    max_per_clip = 50

    for i, arg in enumerate(sys.argv):
        if arg == "--max-per-clip" and i + 1 < len(sys.argv):
            max_per_clip = int(sys.argv[i + 1])

    extract_frames(clip_dir, output_dir, max_per_clip)

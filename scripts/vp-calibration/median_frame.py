#!/usr/bin/env python3
"""Temporal MEDIAN frame from a raw panorama video — the line-acquisition input.

Players, refs and flags move; pitch lines don't. The per-pixel median over N
frames spread across the match averages the moving bodies away and leaves clean
line paint for snap_lines.py corridors (no more occlusion gaps or a player's
white sock latching a corridor). Works straight off a presigned S3 URL — each
sampled frame is one ffmpeg seek (range requests), the 2+ GB file is never
downloaded whole.

Env: SRC (video URL or path), OUT (jpg path), N (frames, default 25),
     START_S / END_S (sample window in seconds; default 5%..95% of duration —
     skips lens wipes at kickoff and the empty pitch after full time),
     KEEP_FRAMES (dir to also keep the individual sampled frames, optional).
"""
import os
import subprocess
import sys
import tempfile

import cv2
import numpy as np

SRC = os.environ['SRC']
OUT = os.environ['OUT']
N = int(os.environ.get('N', 25))
KEEP = os.environ.get('KEEP_FRAMES')


def probe_duration(src: str) -> float:
    out = subprocess.run(
        ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
         '-of', 'csv=p=0', src],
        capture_output=True, text=True, check=True).stdout.strip()
    return float(out)


dur = probe_duration(SRC)
t0 = float(os.environ.get('START_S', 0.05 * dur))
t1 = float(os.environ.get('END_S', 0.95 * dur))
times = np.linspace(t0, t1, N)
print(f'duration {dur:.0f}s — sampling {N} frames over [{t0:.0f}, {t1:.0f}]s')

tmpdir = KEEP or tempfile.mkdtemp(prefix='median-frames-')
os.makedirs(tmpdir, exist_ok=True)
stack = None
kept = 0
for i, t in enumerate(times):
    path = os.path.join(tmpdir, f'f{i:03d}.png')
    # PNG (lossless) so jpeg block noise doesn't survive into the median
    r = subprocess.run(
        ['ffmpeg', '-v', 'error', '-ss', f'{t:.2f}', '-i', SRC,
         '-frames:v', '1', path, '-y'],
        capture_output=True, text=True)
    frame = cv2.imread(path) if r.returncode == 0 else None
    if frame is None:
        print(f'  frame {i} @ {t:.0f}s FAILED — skipping ({r.stderr.strip()[:120]})')
        continue
    if stack is None:
        stack = np.empty((N,) + frame.shape, np.uint8)
    stack[kept] = frame
    kept += 1
    if not KEEP:
        os.remove(path)
if stack is None or kept < max(5, N // 3):
    sys.exit(f'only {kept}/{N} frames decoded — refusing to median so few')

median = np.median(stack[:kept], axis=0).astype(np.uint8)
cv2.imwrite(OUT, median, [cv2.IMWRITE_JPEG_QUALITY, 97])
print(f'wrote {OUT} — median of {kept} frames, {median.shape[1]}x{median.shape[0]}')

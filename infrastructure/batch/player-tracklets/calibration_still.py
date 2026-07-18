"""Median calibration still — the marking surface for pitch calibration.

Players, refs and flags move; pitch lines don't. The per-pixel median over N
frames spread across the banked raw panorama averages the moving bodies away
and leaves clean line paint for the venue admin to mark corners on (same
technique as scripts/vp-calibration/median_frame.py). Works straight off a
presigned S3 URL — each sampled frame is one ffmpeg range-request seek; the
multi-GB file is never downloaded whole.
"""
import time

import cv2
import numpy as np

import validate_render

N_FRAMES = 15
# refuse to median so few frames that a single busy moment dominates
MIN_FRAMES = 5
JPEG_QUALITY = 95
# Wall-clock budget: the still is best-effort, but _grab_frame's 180s ffmpeg
# timeout x 15 seeks could otherwise eat ~46 min of the job's 60-min attempt
# cap on a hung S3 read path — converting a non-fatal feature into a burned
# TRACKLETS attempt. Bail and median what we have (if enough decoded).
BUDGET_S = 600


def render_median_still(url: str) -> bytes | None:
    """Median JPEG bytes from the video at `url`, or None when it can't be
    produced (unreadable video, too few decodable frames, budget blown)."""
    deadline = time.monotonic() + BUDGET_S
    dur = validate_render._video_duration_s(url)
    if not dur or dur <= 0:
        print('calibration still: could not probe duration', flush=True)
        return None
    # 5%..95%: skips lens wipes at kickoff and the empty pitch after full time
    times = np.linspace(0.05 * dur, 0.95 * dur, N_FRAMES)
    frames = []
    for t in times:
        if time.monotonic() > deadline:
            print(f'calibration still: budget ({BUDGET_S}s) blown after '
                  f'{len(frames)}/{N_FRAMES} frames — stopping seeks',
                  flush=True)
            break
        frame = validate_render._grab_frame(url, float(t))
        if frame is not None and (not frames or frame.shape == frames[0].shape):
            frames.append(frame)
    if len(frames) < MIN_FRAMES:
        print(f'calibration still: only {len(frames)}/{N_FRAMES} frames '
              'decoded — refusing to median so few', flush=True)
        return None
    # release the frame list before the median: np.stack copies, and a future
    # 3-camera stacked panorama would otherwise OOM (a Fargate OOM is a
    # SIGKILL the caller's best-effort except cannot catch)
    stack = np.stack(frames)
    frames = None  # noqa: F841
    median = np.median(stack, axis=0).astype(np.uint8)
    ok, buf = cv2.imencode('.jpg', median,
                           [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
    return buf.tobytes() if ok else None

"""Dots-on-raw-frame validation render — the un-gameable human check.

Extracts a few frames from the preserved raw panorama (presigned URL +
ffmpeg -ss seek, no full download) at detection timestamps inside the solve
window, then draws:
  green circles = detection feet at their OWN pano UV (ground truth — they
                  land on players iff the det stream/frame time base is sane)
  red dots      = tracklet positions interpolated at the same instant,
                  projected metric -> rayn (via H) -> mesh UV -> pixel

A correct solve puts red inside green on visible players. The PNG goes to
private provenance next to tracklets-solve.json; during the pilot phase a
human signs off per venue before spotlight is enabled.

Raw VP video time t maps to absolute time as start_time_us + t*1e6 — all
streams of a Spiideo game share startTime (the aim-track pipeline's
validated base).
"""

from __future__ import annotations

import os
import subprocess
import tempfile

import numpy as np
import cv2

PANEL_W = 1920
N_PANELS = 3
DOT_LIMIT = 60  # safety cap per overlay


def _grab_frame(url: str, tv: float) -> np.ndarray | None:
    with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tmp:
        path = tmp.name
    try:
        try:
            r = subprocess.run(
                ['ffmpeg', '-y', '-loglevel', 'error', '-ss', f'{tv:.3f}',
                 '-i', url, '-frames:v', '1', path],
                capture_output=True, timeout=180)
        except subprocess.TimeoutExpired:
            print(f'validate render: ffmpeg timed out at t={tv:.1f}s',
                  flush=True)
            return None
        if r.returncode != 0:
            print(f'validate render: ffmpeg failed at t={tv:.1f}s: '
                  f'{r.stderr.decode()[:200]}', flush=True)
            return None
        return cv2.imread(path)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def render_validation_png(url: str, start_time_us: int, det_frames: dict,
                          fragments: list, H: np.ndarray,
                          rayn_to_uv) -> bytes | None:
    """Stacked panels PNG as bytes, or None if no frame could be extracted."""
    spans = [(int(ts[0]), int(ts[-1]), ts.astype(np.float64), xy)
             for ts, xy in fragments]
    dts = sorted(det_frames)
    if not dts:
        return None
    picks = [dts[max(0, min(len(dts) - 1, int(len(dts) * f)))]
             for f in (0.2, 0.5, 0.8)][:N_PANELS]
    panels = []
    for dt in dict.fromkeys(picks):
        tv = (dt - start_time_us) / 1e6
        fr = _grab_frame(url, tv)
        if fr is None:
            continue
        hpx, wpx = fr.shape[:2]
        im = cv2.resize(fr, (PANEL_W, int(PANEL_W * hpx / wpx)))
        h, w = im.shape[:2]
        fuv, _ = det_frames[dt]
        for u, v in fuv[:DOT_LIMIT]:
            if 0 <= u <= 1 and 0 <= v <= 1:
                cv2.circle(im, (int(u * w), int(v * h)), 9, (0, 255, 0), 2)
        met = []
        for t0, t1, ts, xy in spans:
            if t0 <= dt <= t1:
                met.append([np.interp(dt, ts, xy[:, 0]),
                            np.interp(dt, ts, xy[:, 1])])
        if met:
            met = np.array(met[:DOT_LIMIT], np.float64)
            rn = cv2.perspectiveTransform(
                met[None], np.asarray(H, np.float64))[0]
            for u, v in rayn_to_uv(rn):
                if 0 <= u <= 1 and 0 <= v <= 1:
                    cv2.circle(im, (int(u * w), int(v * h)), 5, (0, 0, 255), -1)
        cv2.putText(im, f't={tv:.1f}s  green=detections  red=tracklets via H',
                    (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (255, 255, 255), 2)
        panels.append(im)
    if not panels:
        return None
    ok, buf = cv2.imencode('.png', np.vstack(panels))
    return buf.tobytes() if ok else None

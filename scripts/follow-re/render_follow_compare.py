"""Render a 3-panel side-by-side to DECIDE the player-centroid follow visually:
  [ our player-centroid | deployed motion-centroid | Spiideo AutoFollow ]
Both PLAYHUB panels are DE-WARPED from the raw fisheye VP (Kuwait calibration,
cv2.fisheye) at a YAW that follows the action — a flat, rectilinear view like the
production WebGL mesh dewarp (and like Spiideo), so the comparison is fair.

  python3 render_follow_compare.py <raw_vp.mp4> <play_render.mp4> <cache.json> <out.mp4>
"""
from __future__ import annotations

import json
import sys

import numpy as np
import cv2

from controller import FollowController

PANEL_W, PANEL_H = 640, 360
FONT = cv2.FONT_HERSHEY_SIMPLEX

# Kuwait fisheye calibration (scripts/vp-calibration/kuwait-fit.json) — Nazwa is a
# Kuwait venue. TILT/OUTF tuned to frame the action (see dewarp_test iterations).
F, CX, CY, K1 = 1158.15, 1820.72, 810.19, -0.005580739537927541
TILT_DEG, OUTF = 18.0, 400.0
K = np.array([[F, 0, CX], [0, F, CY], [0, 0, 1]], np.float64)
D = np.array([K1, 0, 0, 0], np.float64)
KNEW = np.array([[OUTF, 0, PANEL_W / 2], [0, OUTF, PANEL_H / 2], [0, 0, 1]], np.float64)
RX = cv2.Rodrigues(np.array([np.radians(TILT_DEG), 0, 0]))[0]

_MAP_CACHE: dict = {}


def dewarp_maps(yaw_deg):
    """Undistort-rectify maps for a given YAW (cached per 0.5°)."""
    key = round(yaw_deg * 2) / 2
    m = _MAP_CACHE.get(key)
    if m is None:
        Ry = cv2.Rodrigues(np.array([0, np.radians(key), 0]))[0]
        m = cv2.fisheye.initUndistortRectifyMap(K, D, Ry @ RX, KNEW, (PANEL_W, PANEL_H), cv2.CV_16SC2)
        _MAP_CACHE[key] = m
    return m


def pan_to_yaw(pan, W):
    """Follow pan (normalized VP x) → output camera YAW° (equidistant fisheye: θ≈(x-CX)/F)."""
    return float(np.degrees((np.clip(pan, 0, 1) * W - CX) / F))


def targets_mean(cache):
    return {int(k): float(np.mean(v)) for k, v in cache["players"].items() if v}


def targets_motion(cache):
    return {int(k): float(v) for k, v in cache["motion"].items()}


def run_ctl(targets, n, fps):
    ctl = FollowController(fps=fps)
    return [ctl.step({"pan": targets.get(fr), "tilt": 0.0, "fov": 40.0} if targets.get(fr) is not None else None)["pan"]
            for fr in range(n)]


def label(img, text, color=(255, 255, 255)):
    cv2.rectangle(img, (0, 0), (PANEL_W, 26), (0, 0, 0), -1)
    cv2.putText(img, text, (8, 18), FONT, 0.52, color, 1, cv2.LINE_AA)
    return img


def dewarp_panel(frame, pan, W):
    m1, m2 = dewarp_maps(pan_to_yaw(pan, W))
    return cv2.remap(frame, m1, m2, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)


def main():
    raw, play, cachef, out = sys.argv[1:5]
    cache = json.load(open(cachef))
    W, H, vfps, n = cache["W"], cache["H"], cache["video_fps"], cache["video_frames"]
    pan_P = run_ctl(targets_mean(cache), n, vfps)
    pan_M = run_ctl(targets_motion(cache), n, vfps)

    cap_r = cv2.VideoCapture(raw)
    cap_p = cv2.VideoCapture(play)
    vw = cv2.VideoWriter(out, cv2.VideoWriter_fourcc(*"mp4v"), 25.0, (PANEL_W * 3, PANEL_H))
    i = 0
    while True:
        okr, fr = cap_r.read()
        okp, fp = cap_p.read()
        if not okr or i >= n:
            break
        left = label(dewarp_panel(fr, pan_P[i] if i < len(pan_P) else 0.47, W), "PLAYHUB player-centroid (dewarped)", (120, 255, 120))
        mid = label(dewarp_panel(fr, pan_M[i] if i < len(pan_M) else 0.47, W), "PLAYHUB motion deployed (dewarped)", (120, 200, 255))
        right = label(cv2.resize(fp, (PANEL_W, PANEL_H)) if okp else np.zeros((PANEL_H, PANEL_W, 3), np.uint8),
                      "Spiideo AutoFollow", (200, 200, 200))
        vw.write(np.hstack([left, mid, right]))
        i += 1
        if i % 250 == 0:
            print(f"  ...{i}/{n} ({len(_MAP_CACHE)} maps cached)", file=sys.stderr)
    cap_r.release(); cap_p.release(); vw.release()
    print(f"wrote {out} ({i} frames, {i / 25:.0f}s, {len(_MAP_CACHE)} unique YAW maps)")


if __name__ == "__main__":
    main()

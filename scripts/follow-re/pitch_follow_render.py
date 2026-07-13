"""Pitch-aware follow prototype + 3-panel render:
  [ PLAYHUB pitch-aware | PLAYHUB motion (deployed) | Spiideo AutoFollow ]

Pitch-aware target: project on-pitch player FEET into pitch coordinates (fisheye
undistort → homography), drop sideline detections, commit to the densest cluster
along the pitch LENGTH (the action pack), pan the camera there. Contrast with the
image-space motion-centroid that drifts to frame-centre and includes the crowd.

  python3 pitch_follow_render.py <raw_vp.mp4> <play.mp4> <cache2.json> <out.mp4>
"""
from __future__ import annotations

import json
import sys

import numpy as np
import cv2

from controller import FollowController

# Kuwait fisheye model
F, CX, CY, K1 = 1158.15, 1820.72, 810.19, -0.005580739537927541
K = np.array([[F, 0, CX], [0, F, CY], [0, 0, 1]], np.float64)
D = np.array([K1, 0, 0, 0], np.float64)
PANEL_W, PANEL_H, TILT_DEG, OUTF = 640, 360, 18.0, 400.0
KNEW = np.array([[OUTF, 0, PANEL_W / 2], [0, OUTF, PANEL_H / 2], [0, 0, 1]], np.float64)
RX = cv2.Rodrigues(np.array([np.radians(TILT_DEG), 0, 0]))[0]
FONT = cv2.FONT_HERSHEY_SIMPLEX

Hj = json.load(open("/tmp/follow-pair/pitch_H.json"))
HMAT = np.array(Hj["H"]); HINV = np.array(Hj["Hinv"]); Lp, Wp = Hj["L"], Hj["W"]
POLY = np.array(json.load(open("/tmp/follow-pair/pitch_poly.json"))["poly_px"], np.int32)


def undistort_norm(px):
    return cv2.fisheye.undistortPoints(np.array(px, np.float64).reshape(-1, 1, 2), K, D).reshape(-1, 2)


def norm_to_px(norm):
    return cv2.fisheye.distortPoints(np.array(norm, np.float64).reshape(-1, 1, 2), K, D).reshape(-1, 2)


def feet_to_pitch(px_pts):
    norm = undistort_norm(px_pts)
    return cv2.perspectiveTransform(norm.reshape(-1, 1, 2), HINV).reshape(-1, 2)


def pitch_to_pan(pitch_xy, imgW):
    norm = cv2.perspectiveTransform(np.array([pitch_xy], np.float64).reshape(-1, 1, 2), HMAT).reshape(-1, 2)
    return float(norm_to_px(norm)[0][0]) / imgW


def kde_mode(xs, bw, grid):
    xs = np.asarray(xs)
    d = np.exp(-0.5 * ((grid[:, None] - xs[None, :]) / bw) ** 2).sum(1)
    return float(grid[int(d.argmax())])


def pitch_targets(cache, imgW, imgH):
    """Per player-frame → image-normalized pan of the on-pitch action cluster."""
    players = {int(k): v for k, v in cache["players"].items()}
    grid = np.linspace(0, Lp, 81)
    out = {}
    for fr, plist in players.items():
        if not plist:
            continue
        feet_px = [[cx * imgW, fy * imgH] for cx, fy in plist]
        # on-pitch filter (foot inside the green polygon)
        onp = [fp for fp in feet_px if cv2.pointPolygonTest(POLY, (float(fp[0]), float(fp[1])), False) >= 0]
        if len(onp) < 2:
            continue
        pitch = feet_to_pitch(onp)
        inb = pitch[(pitch[:, 0] > -3) & (pitch[:, 0] < Lp + 3) & (pitch[:, 1] > -3) & (pitch[:, 1] < Wp + 3)]
        if len(inb) < 2:
            continue
        ax = kde_mode(inb[:, 0], 5.0, grid)          # densest cluster along the LENGTH
        ay = float(np.median(inb[:, 1]))             # median width
        out[fr] = float(np.clip(pitch_to_pan((ax, ay), imgW), 0, 1))
    return out


def run_ctl(targets, n, fps):
    ctl = FollowController(fps=fps)
    return [ctl.step({"pan": targets.get(fr), "tilt": 0.0, "fov": 40.0} if targets.get(fr) is not None else None)["pan"]
            for fr in range(n)]


_MAPS: dict = {}


def dewarp(frame, pan, W):
    yaw = round(np.degrees((np.clip(pan, 0, 1) * W - CX) / F) * 2) / 2
    m = _MAPS.get(yaw)
    if m is None:
        Ry = cv2.Rodrigues(np.array([0, np.radians(yaw), 0]))[0]
        m = cv2.fisheye.initUndistortRectifyMap(K, D, Ry @ RX, KNEW, (PANEL_W, PANEL_H), cv2.CV_16SC2)
        _MAPS[yaw] = m
    return cv2.remap(frame, m[0], m[1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)


def label(img, text, color):
    cv2.rectangle(img, (0, 0), (PANEL_W, 26), (0, 0, 0), -1)
    cv2.putText(img, text, (8, 18), FONT, 0.5, color, 1, cv2.LINE_AA)
    return img


def main():
    raw, play, cachef, out = sys.argv[1:5]
    # Spiideo LEADS the raw VP by LAG frames (measured by pan cross-correlation) — pair
    # raw[k+LAG] with spiideo[k] so both panels show the SAME instant of play.
    LAG = int(sys.argv[sys.argv.index("--lag") + 1]) if "--lag" in sys.argv else 35
    cache = json.load(open(cachef))
    W, Him, vfps, n = cache["W"], cache["H"], cache["video_fps"], cache["video_frames"]
    pan_pitch = run_ctl(pitch_targets(cache, W, Him), n, vfps)
    pan_motion = run_ctl({int(k): float(v) for k, v in cache["motion"].items()}, n, vfps)

    cap_r, cap_p = cv2.VideoCapture(raw), cv2.VideoCapture(play)
    for _ in range(LAG):          # advance the raw feed to align with Spiideo
        cap_r.read()
    vw = cv2.VideoWriter(out, cv2.VideoWriter_fourcc(*"mp4v"), 25.0, (PANEL_W * 3, PANEL_H))
    i = LAG
    while True:
        okr, fr = cap_r.read(); okp, fp = cap_p.read()
        if not okr or i >= n:
            break
        a = label(dewarp(fr, pan_pitch[i] if i < len(pan_pitch) else 0.47, W), "PLAYHUB pitch-aware", (120, 255, 120))
        b = label(dewarp(fr, pan_motion[i] if i < len(pan_motion) else 0.47, W), "PLAYHUB motion (deployed)", (120, 200, 255))
        c = label(cv2.resize(fp, (PANEL_W, PANEL_H)) if okp else np.zeros((PANEL_H, PANEL_W, 3), np.uint8),
                  "Spiideo AutoFollow", (200, 200, 200))
        vw.write(np.hstack([a, b, c])); i += 1
        if i % 250 == 0:
            print(f"  ...{i}/{n}", file=sys.stderr)
    cap_r.release(); cap_p.release(); vw.release()
    print(f"wrote {out} ({i} frames)")


if __name__ == "__main__":
    main()

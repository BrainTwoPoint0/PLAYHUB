"""Preview the recovered ADAPTIVE ZOOM in action (no training). Renders 3 panels:
  [ ours + Spiideo's recovered zoom | Spiideo AutoFollow | ours, fixed zoom ]
Pan is our heuristic motion-centroid in all PLAYHUB panels (registering Spiideo's
exact aim needs the trained policy); the ONLY new thing here is that the left panel's
FOV breathes with Spiideo's recovered log-zoom — wide on build-up, tight on action.

  python3 oracle_zoom_render.py <raw_vp.mp4> <play.mp4> <cache.json> <out.mp4>
"""
from __future__ import annotations

import json
import sys

import numpy as np
import cv2

import recover_camera as RC

F, CX, CY, K1 = 1158.15, 1820.72, 810.19, -0.005580739537927541
K = np.array([[F, 0, CX], [0, F, CY], [0, 0, 1]], np.float64)
D = np.array([K1, 0, 0, 0], np.float64)
PANEL_W, PANEL_H, TILT_DEG = 640, 360, 18.0
RX = cv2.Rodrigues(np.array([np.radians(TILT_DEG), 0, 0]))[0]
OUTF_FIXED = 400.0
FONT = cv2.FONT_HERSHEY_SIMPLEX
_M: dict = {}


def dewarp(frame, pan, W, outf):
    yaw = round(np.degrees((np.clip(pan, 0, 1) * W - CX) / F) * 2) / 2
    of = round(outf / 10) * 10
    key = (yaw, of)
    m = _M.get(key)
    if m is None:
        Ry = cv2.Rodrigues(np.array([0, np.radians(yaw), 0]))[0]
        Knew = np.array([[of, 0, PANEL_W / 2], [0, of, PANEL_H / 2], [0, 0, 1]], np.float64)
        m = cv2.fisheye.initUndistortRectifyMap(K, D, Ry @ RX, Knew, (PANEL_W, PANEL_H), cv2.CV_16SC2)
        _M[key] = m
    return cv2.remap(frame, m[0], m[1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)


def lab(img, t, c):
    cv2.rectangle(img, (0, 0), (PANEL_W, 26), (0, 0, 0), -1)
    cv2.putText(img, t, (8, 18), FONT, 0.48, c, 1, cv2.LINE_AA); return img


def main():
    raw, play, cachef, out = sys.argv[1:5]
    cache = json.load(open(cachef))
    W, n = cache["W"], cache["video_frames"]
    mot = {int(k): float(v) for k, v in cache["motion"].items()}
    # heuristic pan (smoothed motion centroid), per frame
    pan = np.array([mot.get(i, np.nan) for i in range(n)])
    gi = np.arange(n); ok = ~np.isnan(pan); pan = np.interp(gi, gi[ok], pan[ok])
    pan = np.convolve(pan, np.ones(15) / 15, mode="same")

    # Spiideo's recovered zoom → our FOV. wider Spiideo (high logzoom) → lower OUTF (wider view).
    print("recovering Spiideo zoom...", file=sys.stderr)
    r = RC.recover(play)
    lz = r["logzoom"]; lz = np.interp(gi, np.linspace(0, n - 1, len(lz)), lz)
    outf = np.clip(OUTF_FIXED * np.exp(-(lz - np.median(lz)) * 1.6), 260, 600)

    cap_r, cap_p = cv2.VideoCapture(raw), cv2.VideoCapture(play)
    vw = cv2.VideoWriter(out, cv2.VideoWriter_fourcc(*"mp4v"), 25.0, (PANEL_W * 3, PANEL_H))
    i = 0
    while True:
        okr, fr = cap_r.read(); okp, fp = cap_p.read()
        if not okr or i >= n:
            break
        p = pan[i] if i < len(pan) else 0.47
        a = lab(dewarp(fr, p, W, outf[i] if i < len(outf) else OUTF_FIXED), "PLAYHUB + Spiideo's adaptive zoom", (120, 255, 120))
        b = lab(cv2.resize(fp, (PANEL_W, PANEL_H)) if okp else np.zeros((PANEL_H, PANEL_W, 3), np.uint8), "Spiideo AutoFollow", (200, 200, 200))
        c = lab(dewarp(fr, p, W, OUTF_FIXED), "PLAYHUB fixed zoom (current)", (120, 200, 255))
        vw.write(np.hstack([a, b, c])); i += 1
        if i % 300 == 0:
            print(f"  ...{i}/{n}", file=sys.stderr)
    cap_r.release(); cap_p.release(); vw.release()
    print(f"wrote {out} ({i} frames)")


if __name__ == "__main__":
    main()

"""Follow render with the MESH dewarp (flat everywhere) + Spiideo's recovered adaptive
zoom, next to Spiideo and our OLD fisheye dewarp. Shows the whole follow view flat.
  [ PLAYHUB mesh + adaptive zoom | Spiideo AutoFollow | PLAYHUB fisheye (old) ]

  python3 mesh_follow_render.py <raw.mp4> <play.mp4> <cache.json> <out.mp4>
"""
from __future__ import annotations

import json
import sys

import numpy as np
import cv2

import mesh_dewarp as MD
import recover_camera as RC

PW, PH = 640, 360
F, CX = 1158.15, 1820.72
PAN_SIGN = -1.0            # mesh pan is sign-flipped vs (x-CX)/F azimuth (verified on the goal view)


def tilt_for_pan(pan_deg):
    """Aim the camera at the pitch surface: central pans need more down-tilt, the
    goals (edge pans) sit higher in frame. Fit to two framing anchors: pan35°→−30°,
    pan52°→−11°."""
    return np.clip(-30.0 + 1.12 * (abs(pan_deg) - 35.0), -33.0, -9.0)
FONT = cv2.FONT_HERSHEY_SIMPLEX
_LUT: dict = {}
# fisheye (old) dewarp maps, cached by yaw
K = np.array([[F, 0, CX], [0, F, 810.19], [0, 0, 1]], np.float64)
D = np.array([-0.005580739537927541, 0, 0, 0], np.float64)
RXF = cv2.Rodrigues(np.array([np.radians(18.0), 0, 0]))[0]
KNEWF = np.array([[400, 0, PW / 2], [0, 400, PH / 2], [0, 0, 1]], np.float64)
_FMAP: dict = {}


def mesh_maps(projs, pan_rad, tilt_rad, fov_deg, tw, th):
    key = (round(np.degrees(pan_rad), 1), round(np.degrees(tilt_rad)), round(fov_deg))
    m = _LUT.get(key)
    if m is None:
        u, v = MD.bake_uv_map(projs, pan_rad, tilt_rad, fov_deg, PW, PH)
        m1 = (u * tw).astype("f4"); m2 = (v * th).astype("f4"); m1[u < 0] = -1; m2[u < 0] = -1
        m = (m1, m2); _LUT[key] = m
    return m


def fisheye_panel(frame, pan_norm, W):
    yaw = round(np.degrees((np.clip(pan_norm, 0, 1) * W - CX) / F) * 2) / 2
    m = _FMAP.get(yaw)
    if m is None:
        Ry = cv2.Rodrigues(np.array([0, np.radians(yaw), 0]))[0]
        m = cv2.fisheye.initUndistortRectifyMap(K, D, Ry @ RXF, KNEWF, (PW, PH), cv2.CV_16SC2)
        _FMAP[yaw] = m
    return cv2.remap(frame, m[0], m[1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)


def lab(img, t, c):
    cv2.rectangle(img, (0, 0), (PW, 24), (0, 0, 0), -1)
    cv2.putText(img, t, (7, 17), FONT, 0.46, c, 1, cv2.LINE_AA); return img


def main():
    raw, play, cachef, out = sys.argv[1:5]
    projs, _ = MD.load_mesh("/tmp/follow-pair/mesh")
    print(f"mesh: {sum(len(p['tris']) // 3 for p in projs)} tris", file=sys.stderr)
    cache = json.load(open(cachef)); W, n = cache["W"], cache["video_frames"]
    mot = {int(k): float(v) for k, v in cache["motion"].items()}
    pan = np.array([mot.get(i, np.nan) for i in range(n)]); gi = np.arange(n); ok = ~np.isnan(pan)
    pan = np.convolve(np.interp(gi, gi[ok], pan[ok]), np.ones(15) / 15, "same")
    mesh_pan = PAN_SIGN * (pan * W - CX) / F
    print("recovering Spiideo zoom for adaptive fov...", file=sys.stderr)
    r = RC.recover(play); lz = np.interp(gi, np.linspace(0, n - 1, len(r["logzoom"])), r["logzoom"])
    fov = np.clip(32.0 * np.exp((lz - np.median(lz)) * 0.7), 26, 44)
    tilt = np.radians(tilt_for_pan(np.degrees(mesh_pan)))

    cap_r, cap_p = cv2.VideoCapture(raw), cv2.VideoCapture(play)
    vw = cv2.VideoWriter(out, cv2.VideoWriter_fourcc(*"mp4v"), 25.0, (PW * 3, PH))
    i = 0
    while True:
        okr, fr = cap_r.read(); okp, fp = cap_p.read()
        if not okr or i >= n:
            break
        th, tw = fr.shape[:2]
        j = min(i, n - 1)
        m1, m2 = mesh_maps(projs, mesh_pan[j], tilt[j], fov[j], tw, th)
        a = lab(cv2.remap(fr, m1, m2, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT), "PLAYHUB mesh dewarp + adaptive zoom", (120, 255, 120))
        b = lab(cv2.resize(fp, (PW, PH)) if okp else np.zeros((PH, PW, 3), np.uint8), "Spiideo AutoFollow", (200, 200, 200))
        c = lab(fisheye_panel(fr, pan[min(i, len(pan) - 1)], W), "PLAYHUB fisheye (old, curved)", (120, 200, 255))
        vw.write(np.hstack([a, b, c])); i += 1
        if i % 250 == 0:
            print(f"  ...{i}/{n} ({len(_LUT)} mesh LUTs)", file=sys.stderr)
    cap_r.release(); cap_p.release(); vw.release()
    print(f"wrote {out} ({i} frames, {len(_LUT)} unique mesh views baked)")


if __name__ == "__main__":
    main()

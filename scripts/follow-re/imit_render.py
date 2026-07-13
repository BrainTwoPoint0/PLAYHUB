"""Visual proof for the imitation experiment: render the held-out match three ways —
  [ PLAYHUB LEARNED policy | Spiideo AutoFollow | player-mean heuristic (incumbent) ]
Both PLAYHUB panels use the exact mesh dewarp (flat) so only the AIM differs. The
learned + heuristic pans come from the trained policy's held-out prediction and the
player-centroid baseline respectively; framing (tilt/zoom) uses the proven heuristic so
the LEARNED PAN is the variable under test.

  python3 imit_render.py <raw.mp4> <play.mp4> <pred.npz> <out.mp4> [--mesh DIR]
"""
from __future__ import annotations

import sys

import numpy as np
import cv2

import mesh_dewarp as MD
import recover_camera as RC

PW, PH = 640, 360
F, CX, W_PANO = 1158.15, 1820.72, 3840.0
PAN_SIGN = -1.0
FONT = cv2.FONT_HERSHEY_SIMPLEX
_LUT: dict = {}


def panox_to_meshpan(px):
    return PAN_SIGN * (px * W_PANO - CX) / F


def tilt_for_pan(pan_deg):
    return np.clip(-30.0 + 1.12 * (abs(pan_deg) - 35.0), -33.0, -9.0)


def mesh_maps(projs, pan_rad, tilt_rad, fov_deg, tw, th):
    key = (round(np.degrees(pan_rad), 1), round(np.degrees(tilt_rad)), round(fov_deg))
    m = _LUT.get(key)
    if m is None:
        u, v = MD.bake_uv_map(projs, pan_rad, tilt_rad, fov_deg, PW, PH)
        m1 = (u * tw).astype("f4"); m2 = (v * th).astype("f4"); m1[u < 0] = -1; m2[u < 0] = -1
        m = (m1, m2); _LUT[key] = m
    return m


def lab(img, t, c):
    cv2.rectangle(img, (0, 0), (PW, 26), (0, 0, 0), -1)
    cv2.putText(img, t, (8, 18), FONT, 0.5, c, 1, cv2.LINE_AA); return img


def panel(projs, fr, px, fov_deg, tw, th):
    mp = panox_to_meshpan(px)
    tilt = np.radians(tilt_for_pan(np.degrees(mp)))
    m1, m2 = mesh_maps(projs, mp, tilt, fov_deg, tw, th)
    return cv2.remap(fr, m1, m2, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)


def main():
    raw, play, predf, out = sys.argv[1:5]
    mesh = sys.argv[sys.argv.index("--mesh") + 1] if "--mesh" in sys.argv else "/tmp/follow-pair/mesh"
    projs, _ = MD.load_mesh(mesh)
    d = np.load(predf)
    t = d["t"]; learned = d["pred"][:, 0]; heur = d["base_playermean"]

    cap_r, cap_p = cv2.VideoCapture(raw), cv2.VideoCapture(play)
    fps = cap_p.get(cv2.CAP_PROP_FPS) or 25.0
    n = int(cap_r.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
    # adaptive fov from Spiideo's recovered zoom (shared by both PLAYHUB panels)
    r = RC.recover(play)
    gi = np.arange(n)
    lz = np.interp(gi, np.linspace(0, n - 1, len(r["logzoom"])), r["logzoom"])
    fov_all = np.clip(32.0 * np.exp((lz - np.median(lz)) * 0.7), 26, 44)
    # per-render-frame pans (interp 5fps → 25fps)
    ft = gi / fps
    learned_f = np.interp(ft, t, learned)
    heur_f = np.interp(ft, t, heur)

    vw = cv2.VideoWriter(out, cv2.VideoWriter_fourcc(*"mp4v"), fps, (PW * 3, PH))
    i = 0
    while True:
        okr, fr = cap_r.read(); okp, fp = cap_p.read()
        if not okr or i >= n:
            break
        th, tw = fr.shape[:2]
        a = lab(panel(projs, fr, learned_f[i], fov_all[i], tw, th), "PLAYHUB LEARNED (imitation)", (120, 255, 120))
        b = lab(cv2.resize(fp, (PW, PH)) if okp else np.zeros((PH, PW, 3), np.uint8), "Spiideo AutoFollow", (210, 210, 210))
        c = lab(panel(projs, fr, heur_f[i], fov_all[i], tw, th), "player-mean heuristic (incumbent)", (120, 200, 255))
        vw.write(np.hstack([a, b, c])); i += 1
        if i % 250 == 0:
            print(f"  ...{i}/{n}", file=sys.stderr)
    cap_r.release(); cap_p.release(); vw.release()
    print(f"wrote {out} ({i} frames)")


if __name__ == "__main__":
    main()

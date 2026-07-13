"""Render a 2-panel [our flat follow | Spiideo] from a framing json (t,pan,tilt,fov),
with an optional constant tilt bias (calibrated to null the vertical framing offset).

  python3 render_from_framing.py <raw.mp4> <play.mp4> <framing.json> <out.mp4> [--tilt-bias -3.65]
"""
from __future__ import annotations

import json
import sys
import numpy as np
import cv2

import mesh_dewarp as MD

projs, _ = MD.load_mesh("/tmp/follow-pair/mesh")


def main():
    raw, play, framingf, out = sys.argv[1:5]
    bias = float(sys.argv[sys.argv.index("--tilt-bias") + 1]) if "--tilt-bias" in sys.argv else 0.0
    fr = json.load(open(framingf))
    t = np.array(fr["t"]); pan = np.array(fr["pan"]); tilt = np.array(fr["tilt"]) + bias; fov = np.array(fr["fov"])
    capr = cv2.VideoCapture(raw); capp = cv2.VideoCapture(play)
    fps = capp.get(cv2.CAP_PROP_FPS) or 25.0
    n = int(capr.get(cv2.CAP_PROP_FRAME_COUNT)) or int(t.max() * fps)
    def lab(im, tx, c):
        cv2.rectangle(im, (0, 0), (640, 24), (0, 0, 0), -1); cv2.putText(im, tx, (7, 17), cv2.FONT_HERSHEY_SIMPLEX, 0.5, c, 1); return im
    vw = cv2.VideoWriter(out, cv2.VideoWriter_fourcc(*"mp4v"), fps, (1280, 360))
    i = 0
    while True:
        okr, rf = capr.read(); okp, pf = capp.read()
        if not okr or i >= n:
            break
        ct = i / fps
        pn = np.interp(ct, t, pan); tl = np.interp(ct, t, tilt); fv = np.interp(ct, t, fov)
        a = lab(MD.dewarp(rf, projs, np.radians(pn), np.radians(tl), fv, 640, 360), "PLAYHUB flat follow", (120, 255, 120))
        b = lab(cv2.resize(pf, (640, 360)) if okp else np.zeros((360, 640, 3), np.uint8), "Spiideo AutoFollow", (210, 210, 210))
        vw.write(np.hstack([a, b])); i += 1
    capr.release(); capp.release(); vw.release()
    # write biased framing json for downstream checks
    json.dump(dict(t=list(t), pan=list(map(float, pan)), tilt=list(map(float, tilt)), fov=list(map(float, fov))),
              open(out.replace(".mp4", "_framing.json"), "w"))
    print(f"wrote {out} ({i} frames, tilt bias {bias:+.2f})")


if __name__ == "__main__":
    main()

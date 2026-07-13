"""Prove the mesh dewarp reproduces Spiideo's calibration: dewarp OUR raw VP frame and
find the (pan,tilt,fov) that best aligns it to SPIIDEO's actual render of the same
moment, then overlay. If the pitch lines coincide, we've reproduced their geometry.

Match on edge/gradient NCC (the pitch LINES dominate edges; robust to exposure diffs
and small player motion). Coarse→fine over pan/tilt/fov.

  python3 validate_vs_spiideo.py <raw.mp4> <play.mp4> --t 17
"""
from __future__ import annotations

import sys
import numpy as np
import cv2

import mesh_dewarp as MD

PW, PH = 640, 360


def grad(img):
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
    gx = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3); gy = cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)
    return cv2.magnitude(gx, gy)


def ncc(a, b, mask):
    a = a[mask]; b = b[mask]
    a = (a - a.mean()) / (a.std() + 1e-6); b = (b - b.mean()) / (b.std() + 1e-6)
    return float((a * b).mean())


def main():
    raw, play = sys.argv[1], sys.argv[2]
    t = float(sys.argv[sys.argv.index("--t") + 1]) if "--t" in sys.argv else 17.0
    cap = cv2.VideoCapture(raw); cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000); _, rawf = cap.read(); cap.release()
    cap = cv2.VideoCapture(play); cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000); _, spf = cap.read(); cap.release()
    sp = cv2.resize(spf, (PW, PH)); spg = grad(sp)
    projs, _ = MD.load_mesh("/tmp/follow-pair/mesh")

    def render(pan, tilt, fov):
        u, v = MD.bake_uv_map(projs, np.radians(pan), np.radians(tilt), fov, PW, PH)
        th, tw = rawf.shape[:2]; m1 = (u * tw).astype("f4"); m2 = (v * th).astype("f4"); m1[u < 0] = -1; m2[u < 0] = -1
        out = cv2.remap(rawf, m1, m2, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
        return out, (u >= 0)

    best = (-2, None, None, None)
    # coarse search
    for pan in range(-70, 71, 5):
        for tilt in range(-34, -5, 4):
            for fov in range(22, 46, 4):
                out, valid = render(pan, tilt, fov)
                m = valid & (grad(out) > 0)
                if m.sum() < PW * PH * 0.25:
                    continue
                s = ncc(grad(out), spg, m)
                if s > best[0]:
                    best = (s, pan, tilt, fov)
    _, p0, t0, f0 = best
    # fine
    for pan in np.arange(p0 - 4, p0 + 4.1, 1):
        for tilt in np.arange(t0 - 3, t0 + 3.1, 1):
            for fov in np.arange(f0 - 3, f0 + 3.1, 1):
                out, valid = render(pan, tilt, fov)
                m = valid & (grad(out) > 0)
                if m.sum() < PW * PH * 0.25:
                    continue
                s = ncc(grad(out), spg, m)
                if s > best[0]:
                    best = (s, pan, tilt, fov)
    s, pan, tilt, fov = best
    out, valid = render(pan, tilt, fov)
    print(f"best NCC(edges) = {s:.3f} at pan={pan:.0f} tilt={tilt:.0f} fov={fov:.0f}  (1.0=perfect line coincidence)")

    # overlays: side-by-side, 50/50 blend, and OUR line-edges (green) on Spiideo
    edges = (grad(out) > np.percentile(grad(out)[valid], 92)).astype(np.uint8)
    ov = sp.copy(); ov[edges > 0] = (0, 255, 0)
    blend = cv2.addWeighted(out, 0.5, sp, 0.5, 0)
    for im, tag in [(out, "OUR mesh dewarp"), (sp, "Spiideo render"), (blend, "50/50 blend"), (ov, "our lines (green) on Spiideo")]:
        cv2.rectangle(im, (0, 0), (PW, 22), (0, 0, 0), -1); cv2.putText(im, tag, (6, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 255), 1)
    cv2.imwrite("/tmp/follow-pair/validate_vs_spiideo.png", np.vstack([np.hstack([out, sp]), np.hstack([blend, ov])]))
    print("wrote validate_vs_spiideo.png")


if __name__ == "__main__":
    main()

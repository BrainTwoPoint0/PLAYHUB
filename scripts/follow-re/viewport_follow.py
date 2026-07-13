"""AIM payoff: drive our proven-flat dewarp from Spiideo's exact `viewport` aim (which
follows the ball) via the metric→pano calibration. viewport_v2 gives, per 0.5s, the 3D
frustum ground polygon (metric); its centroid = where AutoFollow points, its extent = zoom.
Map centroid metric → ray-plane (H) → pano → pan; extent → fov; render via mesh_dewarp.
2-panel vs Spiideo. Glitch-free by construction (no SIFT/interp gaps).

  python3 viewport_follow.py
"""
from __future__ import annotations

import json, glob
import numpy as np
import cv2
from scipy.spatial import cKDTree

import mesh_dewarp as MD
from framing_from_reg import invert   # geometric (pano_x,pano_y,footw)->(pan,tilt,fov)

G = "b923d40f-e5bc-4803-901b-d7412ba77043"
RAW = f"/tmp/follow-pair/raw_{G}_s900.mp4"
PLAY = f"/tmp/follow-pair/play_{G}_s900.mp4"
START = 1783537924240000; RAWABS0 = START + 900_000000
projs, _ = MD.load_mesh("/tmp/follow-pair/mesh")
UV = np.vstack([p["uv"] for p in projs]); WORLD = np.vstack([p["world"] for p in projs])
RAYN = WORLD[:, :2] / WORLD[:, 2:3]; rayn_tree = cKDTree(RAYN)
rayn_to_uv = lambda rn: UV[rayn_tree.query(rn, k=3)[1]].mean(1)
import os
H = np.load(os.environ.get("H_NPY", "/tmp/imitation/H_metric_to_rayn_refined.npy"))
F_, CX_, W_ = 1158.15, 1820.72, 3840.0


def load_viewports():
    out = []   # (abs_ts, center_metric xy, x_extent)
    for f in sorted(glob.glob("/tmp/imitation/vp/item_*.json")):
        for e in json.load(open(f)).get("viewportsPointCloud", []):
            pts = np.array(e["points"])
            g = pts[np.abs(pts[:, 2]) < 0.5][:, :2]        # ground (z≈0) polygon
            if len(g) >= 3:
                out.append((e["timestamp"], g.mean(0), float(g[:, 0].max() - g[:, 0].min())))
    out.sort(key=lambda x: x[0])
    return out


def main():
    vps = load_viewports()
    ts = np.array([v[0] for v in vps]); cen = np.array([v[1] for v in vps]); ext = np.array([v[2] for v in vps])
    print(f"{len(vps)} viewport samples, game {(ts.min()-START)/1e6:.0f}..{(ts.max()-START)/1e6:.0f}s")
    # metric center -> pano_x, pano_y
    rn = cv2.perspectiveTransform(cen[None].astype(np.float32), H)[0]
    uv = rayn_to_uv(rn)                                    # pano (u,v) normalized
    px, py = uv[:, 0], uv[:, 1]
    # extent (metric) -> footw (pano frac): map via the per-sample local scale (rough)
    fw = np.clip(ext / np.median(ext) * 0.28, 0.16, 0.45)
    # smooth
    def sm(a, k=7): return np.convolve(a, np.ones(k) / k, "same")
    px, py, fw = sm(px), sm(py), sm(fw)
    # invert each -> pan/tilt/fov (warm-started)
    pan = np.zeros(len(px)); tilt = np.zeros(len(px)); fov = np.zeros(len(px))
    pn, ti, fo = 0.0, -20.0, 30.0
    for i in range(len(px)):
        pn, ti, fo = invert(float(np.clip(px[i], .05, .95)), float(np.clip(py[i], .1, .8)), float(fw[i]), pn, ti, fo)
        pan[i], tilt[i], fov[i] = pn, ti, fo
    tilt = sm(tilt) - 3.65     # same vertical-framing correction found earlier
    fov = sm(fov)

    # render vs Spiideo, aligning viewport abs-ts to raw frames
    capr = cv2.VideoCapture(RAW); capp = cv2.VideoCapture(PLAY)
    fps = capp.get(cv2.CAP_PROP_FPS) or 25.0
    n = int(capr.get(cv2.CAP_PROP_FRAME_COUNT))
    vt = (ts - RAWABS0) / 1e6                              # viewport time in raw-window seconds
    def lab(im, t, c):
        cv2.rectangle(im, (0, 0), (640, 24), (0, 0, 0), -1); cv2.putText(im, t, (7, 17), cv2.FONT_HERSHEY_SIMPLEX, 0.5, c, 1); return im
    vw = cv2.VideoWriter("/tmp/imitation/viewport_follow.mp4", cv2.VideoWriter_fourcc(*"mp4v"), fps, (1280, 360))
    frames_out = []
    i = 0
    while True:
        okr, rf = capr.read(); okp, pf = capp.read()
        if not okr or i >= n: break
        ct = i / fps
        pn = np.interp(ct, vt, pan); tl = np.interp(ct, vt, tilt); fv = np.interp(ct, vt, fov)
        a = lab(MD.dewarp(rf, projs, np.radians(pn), np.radians(tl), fv, 640, 360), "PLAYHUB (viewport-driven aim)", (120, 255, 120))
        b = lab(cv2.resize(pf, (640, 360)) if okp else np.zeros((360, 640, 3), np.uint8), "Spiideo AutoFollow", (210, 210, 210))
        fr = np.hstack([a, b]); vw.write(fr); i += 1
        if i in (int(n*0.2), int(n*0.5), int(n*0.8)): frames_out.append(fr.copy())
    capr.release(); capp.release(); vw.release()
    if frames_out:
        cv2.imwrite("/tmp/imitation/viewport_follow_frames.png", np.vstack(frames_out))
    print(f"wrote viewport_follow.mp4 ({i} frames) + frames.png")


if __name__ == "__main__":
    main()

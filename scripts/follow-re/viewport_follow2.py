"""AIM payoff v2 — drive the proven-flat dewarp from Spiideo's viewport via a CLOSED-FORM
inversion of the dewarp's own camera model (no bisection, no SIFT, no invert()).

The dewarp forward axis (from mesh_dewarp.camera_basis) is exactly
    z(pan,tilt) = (-sin pan cos tilt, -sin tilt, cos pan cos tilt).
So for any target ray (rn_x, rn_y, 1) in the mesh world/ray frame:
    pan  = atan2(-rn_x, 1)
    tilt = -asin(rn_y / |(rn_x, rn_y, 1)|)
The viewport ground polygon (metric) -> ray-plane via H gives the aim ray (its centroid) and
the zoom (its horizontal angular span). Everything is geometric and glitch-free.

  H_NPY=/tmp/imitation/H_metric_to_rayn_refined.npy python3 viewport_follow2.py [tiltbias] [fovpad]
"""
from __future__ import annotations
import json, glob, os, sys
import numpy as np, cv2
import mesh_dewarp as MD

G = "b923d40f-e5bc-4803-901b-d7412ba77043"
RAW = f"/tmp/follow-pair/raw_{G}_s900.mp4"
PLAY = f"/tmp/follow-pair/play_{G}_s900.mp4"
START = 1783537924240000; RAWABS0 = START + 900_000000
projs, _ = MD.load_mesh("/tmp/follow-pair/mesh")
H = np.load(os.environ.get("H_NPY", "/tmp/imitation/H_metric_to_rayn_refined.npy"))
TILT_BIAS = float(sys.argv[1]) if len(sys.argv) > 1 else 4.0     # deg up (Spiideo aims above feet-centroid)
FOV_PAD = float(sys.argv[2]) if len(sys.argv) > 2 else 1.15      # vertical-span -> horizontal fov scale
PAN_BIAS = float(sys.argv[3]) if len(sys.argv) > 3 else 5.0      # deg right (systematic follow offset)
FAST = os.environ.get("FAST") == "1"                             # sample frames only (fast tuning)


def ray_to_pantilt(rn):
    """rn = (x,y) ray-plane -> (pan_deg, tilt_deg) in the dewarp's convention."""
    x, y = float(rn[0]), float(rn[1])
    n = np.sqrt(x * x + y * y + 1.0)
    pan = np.degrees(np.arctan2(-x, 1.0))
    tilt = np.degrees(-np.arcsin(y / n))
    return pan, tilt


def load_viewports():
    out = []
    for f in sorted(glob.glob("/tmp/imitation/vp/item_*.json")):
        for e in json.load(open(f)).get("viewportsPointCloud", []):
            pts = np.array(e["points"]); g = pts[np.abs(pts[:, 2]) < 0.5][:, :2]
            if len(g) >= 3:
                out.append((e["timestamp"], g.astype(np.float32)))
    out.sort(key=lambda x: x[0]); return out


def main():
    vps = load_viewports()
    ts = np.array([v[0] for v in vps], np.float64)
    pan = np.zeros(len(vps)); tilt = np.zeros(len(vps)); fov = np.zeros(len(vps))
    for i, (_, poly) in enumerate(vps):
        rn = cv2.perspectiveTransform(poly[None], H)[0]           # ROI footprint in ray-plane
        pan[i], tilt[i] = ray_to_pantilt(rn.mean(0))             # aim = ROI centroid (validated on-action)
        tilts = np.array([ray_to_pantilt(r)[1] for r in rn])     # per-vertex tilt (deg) = ROI depth extent
        vspan = np.percentile(tilts, 90) - np.percentile(tilts, 10)  # robust vertical angular extent
        fov[i] = vspan * (16 / 9) * FOV_PAD                       # 16:9 -> horizontal fov
    tilt += TILT_BIAS
    pan += PAN_BIAS
    fov = np.clip(fov, 20, 44)
    def sm(a, k=7): return np.convolve(a, np.ones(k) / k, "same")
    pan, tilt, fov = sm(pan), sm(tilt), sm(fov)
    print(f"{len(vps)} vp  pan {pan.min():.0f}..{pan.max():.0f}  tilt {tilt.min():.0f}..{tilt.max():.0f}  fov {fov.min():.0f}..{fov.max():.0f}")

    capr = cv2.VideoCapture(RAW); capp = cv2.VideoCapture(PLAY)
    fps = capp.get(cv2.CAP_PROP_FPS) or 25.0
    n = int(capr.get(cv2.CAP_PROP_FRAME_COUNT))
    vt = (ts - RAWABS0) / 1e6
    def lab(im, t, c):
        cv2.rectangle(im, (0, 0), (640, 24), (0, 0, 0), -1); cv2.putText(im, t, (7, 17), cv2.FONT_HERSHEY_SIMPLEX, 0.5, c, 1); return im

    if FAST:                                                       # sample frames only, for tuning
        rows = []
        for frac in (0.2, 0.4, 0.6, 0.8):
            fi = int(n * frac); ct = fi / fps
            capr.set(cv2.CAP_PROP_POS_FRAMES, fi); okr, rf = capr.read()
            capp.set(cv2.CAP_PROP_POS_FRAMES, fi); okp, pf = capp.read()
            pn = np.interp(ct, vt, pan); tl = np.interp(ct, vt, tilt); fv = np.interp(ct, vt, fov)
            a = lab(MD.dewarp(rf, projs, np.radians(pn), np.radians(tl), fv, 640, 360),
                    f"v2 t={ct:.0f}s pan{pn:.0f} tilt{tl:.0f} fov{fv:.0f}", (120, 255, 120))
            b = lab(cv2.resize(pf, (640, 360)) if okp else np.zeros((360, 640, 3), np.uint8), "Spiideo", (210, 210, 210))
            rows.append(np.hstack([a, b]))
        cv2.imwrite("/tmp/imitation/viewport_follow2_frames.png", np.vstack(rows))
        capr.release(); capp.release()
        print(f"FAST wrote frames.png  bias={TILT_BIAS} pad={FOV_PAD}"); return
    vw = cv2.VideoWriter("/tmp/imitation/viewport_follow2.mp4", cv2.VideoWriter_fourcc(*"mp4v"), fps, (1280, 360))
    frames_out = []; i = 0
    while True:
        okr, rf = capr.read(); okp, pf = capp.read()
        if not okr or i >= n: break
        ct = i / fps
        pn = np.interp(ct, vt, pan); tl = np.interp(ct, vt, tilt); fv = np.interp(ct, vt, fov)
        a = lab(MD.dewarp(rf, projs, np.radians(pn), np.radians(tl), fv, 640, 360), "PLAYHUB (viewport v2, closed-form)", (120, 255, 120))
        b = lab(cv2.resize(pf, (640, 360)) if okp else np.zeros((360, 640, 3), np.uint8), "Spiideo AutoFollow", (210, 210, 210))
        fr = np.hstack([a, b]); vw.write(fr); i += 1
        if i in (int(n * 0.2), int(n * 0.4), int(n * 0.6), int(n * 0.8)): frames_out.append(fr.copy())
    capr.release(); capp.release(); vw.release()
    if frames_out:
        cv2.imwrite("/tmp/imitation/viewport_follow2_frames.png", np.vstack(frames_out))
    print(f"wrote viewport_follow2.mp4 ({i} frames) + frames.png")


if __name__ == "__main__":
    main()

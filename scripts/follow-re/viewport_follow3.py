"""AIM payoff v3 — ACTION-WEIGHTED aim to close the far-goal framing gap.

v2 aimed at the ROI-polygon centroid, which sits back-of-action on far-goal plays (the 3m-
extruded footprint reaches toward the camera, dragging its geometric centre off the players).
v3 instead aims at the DENSITY-WEIGHTED centroid of the tracklets that fall INSIDE the ROI
polygon (metric space -> spectators, who are off-pitch, are excluded for free; density weight
pulls toward the player cluster / contest = a ball proxy). fov + closed-form pan/tilt as in v2.

  H_NPY=... FAST=1 python3 viewport_follow3.py [tiltbias] [fovpad] [panbias] [sigma_m]
"""
from __future__ import annotations
import json, glob, os, sys
import numpy as np, cv2
from matplotlib.path import Path
import mesh_dewarp as MD

G = "b923d40f-e5bc-4803-901b-d7412ba77043"
RAW = f"/tmp/follow-pair/raw_{G}_s900.mp4"
PLAY = f"/tmp/follow-pair/play_{G}_s900.mp4"
START = 1783537924240000; RAWABS0 = START + 900_000000
projs, _ = MD.load_mesh("/tmp/follow-pair/mesh")
H = np.load(os.environ.get("H_NPY", "/tmp/imitation/H_metric_to_rayn_refined.npy"))
TILT_BIAS = float(sys.argv[1]) if len(sys.argv) > 1 else 3.0
FOV_PAD = float(sys.argv[2]) if len(sys.argv) > 2 else 1.15
PAN_BIAS = float(sys.argv[3]) if len(sys.argv) > 3 else 0.0     # action-weight should remove the v2 need
SIGMA = float(sys.argv[4]) if len(sys.argv) > 4 else 6.0        # density-weight kernel (m)
FAST = os.environ.get("FAST") == "1"


def ray_to_pantilt(rn):
    x, y = float(rn[0]), float(rn[1])
    n = np.sqrt(x * x + y * y + 1.0)
    return np.degrees(np.arctan2(-x, 1.0)), np.degrees(-np.arcsin(y / n))


def load_viewports():
    out = []
    for f in sorted(glob.glob("/tmp/imitation/vp/item_*.json")):
        for e in json.load(open(f)).get("viewportsPointCloud", []):
            pts = np.array(e["points"]); g = pts[np.abs(pts[:, 2]) < 0.5][:, :2]
            if len(g) >= 3:
                out.append((e["timestamp"], g.astype(np.float32)))
    out.sort(key=lambda x: x[0]); return out


def load_tracklets():
    frames = {}
    for f in sorted(glob.glob("/tmp/imitation/trk/item_*.json")):
        base = int(f.split("item_")[1].split(".")[0]) * 10 * 1_000000
        for oid, pts in json.load(open(f)).items():
            for p in pts:
                ts = START + base + int(round(p["timeOffset"]))
                frames.setdefault(ts, []).append((p["x"], p["y"]))
    return {k: np.array(v, np.float32) for k, v in frames.items()}


def action_point(poly, pts):
    """Density-weighted centroid of the tracklet pts inside the ROI polygon (metric).
    Returns None if too few inside (caller falls back to the ROI centroid)."""
    if pts is None or len(pts) == 0:
        return None
    inside = Path(poly).contains_points(pts)
    P = pts[inside]
    if len(P) < 2:
        return None
    D = np.linalg.norm(P[:, None] - P[None], axis=2)          # pairwise
    w = np.exp(-(D ** 2) / (2 * SIGMA ** 2)).sum(1)           # local density per player
    return (P * w[:, None]).sum(0) / w.sum()


def main():
    vps = load_viewports(); trk = load_tracklets()
    tts = np.array(sorted(trk))
    ts = np.array([v[0] for v in vps], np.float64)
    pan = np.zeros(len(vps)); tilt = np.zeros(len(vps)); fov = np.zeros(len(vps))
    used_action = 0
    for i, (vt_abs, poly) in enumerate(vps):
        j = tts[np.argmin(np.abs(tts - vt_abs))]
        pts = trk[j] if abs(j - vt_abs) < 150_000 else None
        aim = action_point(poly, pts)
        if aim is None:
            aim = poly.mean(0)                                # fallback: ROI centroid
        else:
            used_action += 1
        rn_aim = cv2.perspectiveTransform(aim[None, None].astype(np.float32), H)[0, 0]
        pan[i], tilt[i] = ray_to_pantilt(rn_aim)
        rn = cv2.perspectiveTransform(poly[None], H)[0]        # zoom still from the ROI extent
        tilts = np.array([ray_to_pantilt(r)[1] for r in rn])
        vspan = np.percentile(tilts, 90) - np.percentile(tilts, 10)
        fov[i] = vspan * (16 / 9) * FOV_PAD
    tilt += TILT_BIAS; pan += PAN_BIAS
    fov = np.clip(fov, 20, 44)
    def sm(a, k=7): return np.convolve(a, np.ones(k) / k, "same")
    pan, tilt, fov = sm(pan), sm(tilt), sm(fov)
    print(f"{len(vps)} vp ({used_action} action-weighted, {len(vps)-used_action} ROI-fallback)  "
          f"pan {pan.min():.0f}..{pan.max():.0f}  tilt {tilt.min():.0f}..{tilt.max():.0f}  fov {fov.min():.0f}..{fov.max():.0f}")

    capr = cv2.VideoCapture(RAW); capp = cv2.VideoCapture(PLAY)
    fps = capp.get(cv2.CAP_PROP_FPS) or 25.0
    n = int(capr.get(cv2.CAP_PROP_FRAME_COUNT))
    vt = (ts - RAWABS0) / 1e6
    def lab(im, t, c):
        cv2.rectangle(im, (0, 0), (640, 24), (0, 0, 0), -1); cv2.putText(im, t, (7, 17), cv2.FONT_HERSHEY_SIMPLEX, 0.5, c, 1); return im

    if FAST:
        rows = []
        for frac in (0.2, 0.4, 0.6, 0.8):
            fi = int(n * frac); ct = fi / fps
            capr.set(cv2.CAP_PROP_POS_FRAMES, fi); okr, rf = capr.read()
            capp.set(cv2.CAP_PROP_POS_FRAMES, fi); okp, pf = capp.read()
            pn = np.interp(ct, vt, pan); tl = np.interp(ct, vt, tilt); fv = np.interp(ct, vt, fov)
            a = lab(MD.dewarp(rf, projs, np.radians(pn), np.radians(tl), fv, 640, 360),
                    f"v3 t={ct:.0f}s pan{pn:.0f} tilt{tl:.0f} fov{fv:.0f}", (120, 255, 120))
            b = lab(cv2.resize(pf, (640, 360)) if okp else np.zeros((360, 640, 3), np.uint8), "Spiideo", (210, 210, 210))
            rows.append(np.hstack([a, b]))
        cv2.imwrite("/tmp/imitation/viewport_follow3_frames.png", np.vstack(rows))
        capr.release(); capp.release()
        print(f"FAST wrote frames.png  bias={TILT_BIAS} pad={FOV_PAD} pan={PAN_BIAS} sigma={SIGMA}"); return

    vw = cv2.VideoWriter("/tmp/imitation/viewport_follow3.mp4", cv2.VideoWriter_fourcc(*"mp4v"), fps, (1280, 360))
    frames_out = []; i = 0
    while True:
        okr, rf = capr.read(); okp, pf = capp.read()
        if not okr or i >= n: break
        ct = i / fps
        pn = np.interp(ct, vt, pan); tl = np.interp(ct, vt, tilt); fv = np.interp(ct, vt, fov)
        a = lab(MD.dewarp(rf, projs, np.radians(pn), np.radians(tl), fv, 640, 360), "PLAYHUB (viewport v3, action-weighted)", (120, 255, 120))
        b = lab(cv2.resize(pf, (640, 360)) if okp else np.zeros((360, 640, 3), np.uint8), "Spiideo AutoFollow", (210, 210, 210))
        fr = np.hstack([a, b]); vw.write(fr); i += 1
        if i in (int(n * 0.2), int(n * 0.4), int(n * 0.6), int(n * 0.8)): frames_out.append(fr.copy())
    capr.release(); capp.release(); vw.release()
    if frames_out:
        cv2.imwrite("/tmp/imitation/viewport_follow3_frames.png", np.vstack(frames_out))
    print(f"wrote viewport_follow3.mp4 ({i} frames) + frames.png")


if __name__ == "__main__":
    main()

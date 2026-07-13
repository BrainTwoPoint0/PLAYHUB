"""AIM Step A: solve metric-pitch ↔ raw-panorama. The raw VP is fisheye so metric→pixel
is NOT a homography — but the mesh gives raw-UV ↔ ray direction, and metric-ground → ray
IS a homography (a pinhole imaging a plane). So:
  YOLO foot (raw UV, from cache_players) --mesh KDTree--> ray --(rx/rz, ry/rz)--> ray-plane
  tracklet (metric x,y) ---- fit homography H: metric → ray-plane ----
Association via ICP (seed by robust bbox + orientation search). VALIDATE by projecting
tracklets → ray-plane → ray → mesh raw-UV → overlay on the raw frame: dots must land on feet.

  python3 calibrate_pano.py
"""
from __future__ import annotations

import json, glob
import numpy as np
import cv2
from scipy.spatial import cKDTree

import mesh_dewarp as MD

G = "b923d40f-e5bc-4803-901b-d7412ba77043"
RAW = f"/tmp/follow-pair/raw_{G}_s900.mp4"
CACHE = "/tmp/imitation/cache_b923d40f.json"
STREAM_START_S = 900.0            # our s900 window starts 900s into the stream
projs, _ = MD.load_mesh("/tmp/follow-pair/mesh")

# mesh: raw-UV (f2,f3) ↔ world ray. Build both directions.
UV = np.vstack([p["uv"] for p in projs])                       # [N,2] in [0,1]
WORLD = np.vstack([p["world"] for p in projs])                 # [N,3] ray dirs
RAYN = WORLD[:, :2] / WORLD[:, 2:3]                            # ray-plane (rx/rz, ry/rz)
uv_tree = cKDTree(UV)
rayn_tree = cKDTree(RAYN)


def uv_to_rayn(uv):
    _, i = uv_tree.query(uv, k=3)
    return RAYN[i].mean(1)


def rayn_to_uv(rn):
    _, i = rayn_tree.query(rn, k=3)
    return UV[i].mean(1)


def load_tracklets():
    out = {}   # abs_time_s -> list[(x,y)]
    for f in sorted(glob.glob("/tmp/imitation/trk/item_*.json")):
        base = int(f.split("item_")[1].split(".")[0]) * 10.0
        for oid, pts in json.load(open(f)).items():
            for p in pts:
                t = round(base + p["timeOffset"] / 1e6, 1)
                out.setdefault(t, []).append((p["x"], p["y"]))
    return out


def load_yolo():
    c = json.load(open(CACHE)); vfps = c["video_fps"]
    out = {}   # abs_time_s -> list[(u,v ray-plane)]
    for k, feet in c["players"].items():
        t = round(STREAM_START_S + int(k) / vfps, 1)
        rn = uv_to_rayn(np.array([[cx, fy] for cx, fy in feet]))
        out[t] = rn
    return out, vfps


def robust_core(P, k=2.5):
    m = np.median(P, 0); mad = np.median(np.abs(P - m), 0) + 1e-6
    return P[np.all(np.abs(P - m) < k * mad * 1.4826, 1)]


def main():
    trk = load_tracklets(); yolo, vfps = load_yolo()
    # accumulate paired-time clouds
    times = sorted(set(trk) & set(round(t, 1) for t in yolo))
    print(f"{len(times)} paired timestamps")
    M = np.vstack([trk[t] for t in times if t in trk])                 # metric cloud
    R = np.vstack([yolo[t] for t in times if t in yolo])               # ray-plane cloud
    Mc, Rc = robust_core(M), robust_core(R)
    print(f"metric core {len(Mc)} pts bbox x[{Mc[:,0].min():.1f},{Mc[:,0].max():.1f}] y[{Mc[:,1].min():.1f},{Mc[:,1].max():.1f}]")
    print(f"ray-plane core {len(Rc)} pts bbox x[{Rc[:,0].min():.2f},{Rc[:,0].max():.2f}] y[{Rc[:,1].min():.2f},{Rc[:,1].max():.2f}]")

    # seed affine: map metric core bbox -> ray core bbox, try 4 flips, pick best ICP inliers
    def bbox_affine(src, dst, fx, fy):
        s0, s1 = src.min(0), src.max(0); d0, d1 = dst.min(0), dst.max(0)
        sc = (d1 - d0) / (s1 - s0 + 1e-9) * [fx, fy]
        H = np.eye(3); H[0, 0] = sc[0]; H[1, 1] = sc[1]
        c = (d0 + d1) / 2 - sc * (s0 + s1) / 2; H[0, 2] = c[0]; H[1, 2] = c[1]
        return H

    def icp(H0, iters=12):
        H = H0.copy()
        Mt = cKDTree(Rc)
        for _ in range(iters):
            proj = cv2.perspectiveTransform(Mc[None].astype(np.float32), H)[0]
            d, idx = Mt.query(proj)
            keep = d < np.percentile(d, 60)
            if keep.sum() < 12: break
            Hn, _ = cv2.findHomography(Mc[keep].astype(np.float32), Rc[idx[keep]].astype(np.float32), cv2.RANSAC, 0.03)
            if Hn is None: break
            H = Hn
        proj = cv2.perspectiveTransform(Mc[None].astype(np.float32), H)[0]
        d, _ = cKDTree(Rc).query(proj)
        return H, float(np.median(d))

    best = (1e9, None)
    for fx in (1, -1):
        for fy in (1, -1):
            H0 = bbox_affine(Mc, Rc, fx, fy)
            H, med = icp(H0)
            if med < best[0]: best = (med, H)
    med, H = best
    print(f"ICP best median chamfer (ray-plane units) = {med:.4f}")
    np.save("/tmp/imitation/H_metric_to_rayn.npy", H)

    # VALIDATE: project tracklets at a few times → raw pixels → overlay
    cap = cv2.VideoCapture(RAW); W = int(cap.get(3)); Hh = int(cap.get(4))
    panels = []
    for tv in [30.0, 60.0, 90.0]:
        at = round(STREAM_START_S + tv, 1)
        cand = [t for t in trk if abs(t - at) < 0.3]
        if not cand: continue
        pts = np.array(trk[min(cand, key=lambda t: abs(t - at))], np.float32)
        cap.set(cv2.CAP_PROP_POS_MSEC, tv * 1000); ok, fr = cap.read()
        if not ok: continue
        rn = cv2.perspectiveTransform(pts[None], H)[0]
        uv = rayn_to_uv(rn)
        im = cv2.resize(fr, (1280, 720))
        for u, v in uv:
            if 0 <= u <= 1 and 0 <= v <= 1:
                cv2.circle(im, (int(u * 1280), int(v * 720)), 7, (0, 0, 255), 2)
        cv2.putText(im, f"tracklets->raw t={tv:.0f}s (red=projected metric positions)", (8, 26), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 255), 2)
        panels.append(im)
    cap.release()
    if panels:
        cv2.imwrite("/tmp/imitation/calib_validate.png", np.vstack(panels))
        print("wrote /tmp/imitation/calib_validate.png")


if __name__ == "__main__":
    main()

"""AIM Step A (PRECISE): exact metric ↔ raw-panorama calibration from Spiideo's OWN
detections (raw-pano foot points, confirmed on-feet) matched 1:1 to tracklets (metric).
Both are Spiideo outputs at the same timestamps → clean 1:1 correspondence via Hungarian
assignment (bootstrapped by a rough homography, ICP-refined). Fit homography
metric → ray-plane (mesh handles fisheye: raw-UV ↔ ray). Validate by reprojection.

  python3 calibrate_precise.py
"""
from __future__ import annotations

import json, glob
import numpy as np
import cv2
from scipy.spatial import cKDTree
from scipy.optimize import linear_sum_assignment

import mesh_dewarp as MD

G = "b923d40f-e5bc-4803-901b-d7412ba77043"
RAW = f"/tmp/follow-pair/raw_{G}_s900.mp4"
START = 1783537924240000
RAWABS0 = START + 900_000000
projs, _ = MD.load_mesh("/tmp/follow-pair/mesh")
UV = np.vstack([p["uv"] for p in projs]); WORLD = np.vstack([p["world"] for p in projs])
RAYN = WORLD[:, :2] / WORLD[:, 2:3]
uv_tree = cKDTree(UV); rayn_tree = cKDTree(RAYN)
uv_to_rayn = lambda uv: RAYN[uv_tree.query(uv, k=3)[1]].mean(1)
rayn_to_uv = lambda rn: UV[rayn_tree.query(rn, k=3)[1]].mean(1)


def load_detections():
    frames = {}   # abs_ts -> ray-plane feet of label-1 (players)
    for f in sorted(glob.glob("/tmp/imitation/det/item_*.json")):
        for cr in json.load(open(f))["camera_results"]:
            for r in cr["results"]:
                feet = [[b["bounding_box"]["x"] + b["bounding_box"]["width"] / 2,
                         b["bounding_box"]["y"] + b["bounding_box"]["height"]]
                        for b in r["detections"] if b["label"] == 1]
                if feet:
                    frames[r["timestamp"]] = uv_to_rayn(np.array(feet, np.float32))
    return frames


def load_tracklets():
    frames = {}   # abs_ts (bin) -> metric xy (players; drop clear ball via z or leave)
    for f in sorted(glob.glob("/tmp/imitation/trk/item_*.json")):
        base = int(f.split("item_")[1].split(".")[0]) * 10 * 1_000000  # 10s items, game-relative us
        for oid, pts in json.load(open(f)).items():
            for p in pts:
                ts = START + base + int(round(p["timeOffset"]))
                frames.setdefault(ts, []).append((p["x"], p["y"]))
    return {k: np.array(v, np.float32) for k, v in frames.items()}


def main():
    det = load_detections(); trk = load_tracklets()
    dts = np.array(sorted(det)); tts = np.array(sorted(trk))
    print(f"detection frames {len(dts)} game {(dts.min()-START)/1e6:.0f}..{(dts.max()-START)/1e6:.0f}s")
    print(f"tracklet frames {len(tts)} game {(tts.min()-START)/1e6:.0f}..{(tts.max()-START)/1e6:.0f}s")

    # pair detection & tracklet frames by nearest abs time (<80ms)
    pairs = []
    for dt in dts:
        j = tts[np.argmin(np.abs(tts - dt))]
        if abs(j - dt) < 80_000:
            pairs.append((det[dt], trk[j]))
    print(f"{len(pairs)} time-matched det/trk frames")

    # ICP + Hungarian: bootstrap rough H, then per-frame optimal assignment, refit
    H = np.load("/tmp/imitation/H_metric_to_rayn.npy") if glob.glob("/tmp/imitation/H_metric_to_rayn.npy") else np.eye(3)
    for it in range(10):
        MM, RR = [], []
        for drn, met in pairs:
            proj = cv2.perspectiveTransform(met[None].astype(np.float32), H)[0]
            C = np.linalg.norm(proj[:, None] - drn[None], axis=2)   # metric_i vs det_j
            ri, ci = linear_sum_assignment(C)
            good = C[ri, ci] < 0.08
            MM.append(met[ri[good]]); RR.append(drn[ci[good]])
        MM = np.vstack(MM); RR = np.vstack(RR)
        Hn, inl = cv2.findHomography(MM, RR, cv2.RANSAC, 0.02)
        if Hn is None: break
        H = Hn
        res = np.linalg.norm(cv2.perspectiveTransform(MM[None], H)[0] - RR, axis=1)
        if it % 3 == 0 or it == 9:
            print(f"  iter {it}: {len(MM)} matches, median residual {np.median(res):.4f} rayn, inliers {int(inl.sum())}")
    np.save("/tmp/imitation/H_metric_to_rayn_precise.npy", H)

    # VALIDATE: project ALL tracklets at t=30/60/90 → raw, overlay
    cap = cv2.VideoCapture(RAW); panels = []
    for tv in [30, 60, 90]:
        tgt = RAWABS0 + tv * 1_000000
        j = tts[np.argmin(np.abs(tts - tgt))]
        met = trk[j]
        cap.set(cv2.CAP_PROP_POS_MSEC, tv * 1000); ok, fr = cap.read()
        im = cv2.resize(fr, (1280, 720))
        uv = rayn_to_uv(cv2.perspectiveTransform(met[None].astype(np.float32), H)[0])
        for u, v in uv:
            if 0 <= u <= 1 and 0 <= v <= 1:
                cv2.circle(im, (int(u * 1280), int(v * 720)), 7, (0, 0, 255), 2)
        cv2.putText(im, f"PRECISE calib: tracklets->raw t={tv}s (red on feet = success)", (8, 26), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 255), 2)
        panels.append(im)
    cap.release()
    cv2.imwrite("/tmp/imitation/calib_precise_validate.png", np.vstack(panels))
    print("wrote /tmp/imitation/calib_precise_validate.png")


if __name__ == "__main__":
    main()

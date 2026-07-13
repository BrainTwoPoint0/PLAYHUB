"""PRECISE metric↔pano calibration, spectator- and time-robust.
metric→ray-plane is a FIXED homography (static camera). Spectators + association noise
are handled by RANSAC over unknown correspondences (the transform most points agree on
is the players on the ground; spectators/mismatches are outliers). A δ time-scan first
locks the tracklet↔detection alignment. Validate by reprojection onto the raw frame.

  python3 calibrate_robust.py
"""
from __future__ import annotations

import json, glob
import numpy as np
import cv2
from scipy.spatial import cKDTree

import mesh_dewarp as MD

G = "b923d40f-e5bc-4803-901b-d7412ba77043"
RAW = f"/tmp/follow-pair/raw_{G}_s900.mp4"
START = 1783537924240000; RAWABS0 = START + 900_000000
projs, _ = MD.load_mesh("/tmp/follow-pair/mesh")
UV = np.vstack([p["uv"] for p in projs]); WORLD = np.vstack([p["world"] for p in projs])
RAYN = WORLD[:, :2] / WORLD[:, 2:3]
uv_tree = cKDTree(UV); rayn_tree = cKDTree(RAYN)
uv_to_rayn = lambda uv: RAYN[uv_tree.query(uv, k=1)[1]]
rayn_to_uv = lambda rn: UV[rayn_tree.query(rn, k=3)[1]].mean(1)
rng = np.random.default_rng(0)


def load():
    det = {}
    for f in sorted(glob.glob("/tmp/imitation/det/item_*.json")):
        for cr in json.load(open(f))["camera_results"]:
            for r in cr["results"]:
                feet = np.array([[b["bounding_box"]["x"] + b["bounding_box"]["width"] / 2, b["bounding_box"]["y"] + b["bounding_box"]["height"]]
                                 for b in r["detections"] if b["label"] == 1], np.float32)
                if len(feet):
                    det[r["timestamp"]] = uv_to_rayn(feet).astype(np.float32)
    trk = {}
    for f in sorted(glob.glob("/tmp/imitation/trk/item_*.json")):
        base = int(f.split("item_")[1].split(".")[0]) * 10 * 1_000000
        by = {}
        for oid, pts in json.load(open(f)).items():
            for p in pts:
                by.setdefault(START + base + int(round(p["timeOffset"])), []).append((p["x"], p["y"]))
        for ts, ps in by.items():
            trk[ts] = np.array(ps, np.float32)
    return det, trk


def main():
    det, trk = load()
    dts = np.array(sorted(det)); tts = np.array(sorted(trk))
    Hr = np.load("/tmp/imitation/H_metric_to_rayn.npy")

    from scipy.optimize import linear_sum_assignment
    # pair frames at offset δ; keep ALL frames with enough points (spectators OK → RANSAC rejects)
    def pairs_at(delta_us):
        out = []
        for dt in dts:
            j = tts[np.argmin(np.abs(tts - (dt - delta_us)))]
            if abs((dt - delta_us) - j) < 120_000 and len(det[dt]) >= 6 and len(trk[j]) >= 6:
                out.append((det[dt], trk[j]))
        return out

    def chamfer(H, prs):
        ds = []
        for drn, met in prs:
            proj = cv2.perspectiveTransform(met[None], H)[0]
            d, _ = cKDTree(drn).query(proj); ds.append(np.median(d))
        return float(np.mean(ds)) if ds else 9.9
    scan = [(dl, chamfer(Hr, pairs_at(dl * 1_000000))) for dl in np.arange(-12, 12.1, 0.5)]
    best_dl = min(scan, key=lambda x: x[1])[0]
    print(f"δ time-scan: best {best_dl:+.1f}s (chamfer {min(s[1] for s in scan):.4f} vs δ=0 {dict((round(a,1),b) for a,b in scan)[0.0]:.4f})")

    prs = pairs_at(best_dl * 1_000000)
    print(f"{len(prs)} paired frames at δ={best_dl:+.1f}s")

    # ICP + Hungarian over ALL frames; shrinking gate rejects spectators/mismatches
    H = Hr
    for it, thr in enumerate([0.10, 0.06, 0.04, 0.03, 0.025, 0.02, 0.02, 0.02]):
        MM, RR = [], []
        for drn, met in prs:
            proj = cv2.perspectiveTransform(met[None], H)[0]
            C = np.linalg.norm(proj[:, None] - drn[None], axis=2)
            ri, ci = linear_sum_assignment(C)
            good = C[ri, ci] < thr
            MM.append(met[ri[good]]); RR.append(drn[ci[good]])
        MM = np.vstack(MM); RR = np.vstack(RR)
        Hn, inl = cv2.findHomography(MM, RR, cv2.RANSAC, 0.015)
        if Hn is None: break
        H = Hn
    res = np.linalg.norm(cv2.perspectiveTransform(MM[None], H)[0] - RR, axis=1)
    print(f"fit on {len(MM)} correspondences over {len(prs)} frames: median residual {np.median(res):.4f} rayn, {int(inl.sum())} inliers")
    np.save("/tmp/imitation/H_metric_to_rayn_robust.npy", H)
    json.dump({"delta_s": float(best_dl)}, open("/tmp/imitation/calib_meta.json", "w"))

    # validate
    cap = cv2.VideoCapture(RAW); panels = []
    for tv in [30, 60, 90]:
        tgt = RAWABS0 + tv * 1_000000 - best_dl * 1_000000
        j = tts[np.argmin(np.abs(tts - tgt))]; met = trk[j]
        cap.set(cv2.CAP_PROP_POS_MSEC, tv * 1000); ok, fr = cap.read()
        im = cv2.resize(fr, (1280, 720))
        uv = rayn_to_uv(cv2.perspectiveTransform(met[None], H)[0])
        for u, v in uv:
            if 0 <= u <= 1 and 0 <= v <= 1: cv2.circle(im, (int(u * 1280), int(v * 720)), 7, (0, 0, 255), 2)
        cv2.putText(im, f"ROBUST calib tracklets->raw t={tv}s (red on feet=success)", (8, 26), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 255), 2)
        panels.append(im)
    cap.release(); cv2.imwrite("/tmp/imitation/calib_robust_validate.png", np.vstack(panels))
    print("wrote /tmp/imitation/calib_robust_validate.png")


if __name__ == "__main__":
    main()

"""AIM Step-1 refinement: tighten the metric->rayn homography from the PRECISE seed.

The precise fit plateaus at ~0.056 rayn / 68 inliers because ~14 spectators/frame pollute
the Hungarian assignment and the near-camera (bottom) points dominate the least-squares,
biasing the fit on the far/left half (visible as the left-collapse in the overlay and the
systematically-wrong follow aim).

This script, seeded from H_precise:
  - rejects spectators by masking BOTH sides to the pitch region (metric rect from tracklet
    density; pano region below the fence/horizon),
  - runs shrinking-gate ICP (Hungarian per frame),
  - spatially balances correspondences (grid-cell cap) so far/left points aren't drowned,
  - reports per-region residual (near/far, left/right) to expose any remaining bias.

  python3 calibrate_refine.py
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
START = 1783537924240000; RAWABS0 = START + 900_000000
projs, _ = MD.load_mesh("/tmp/follow-pair/mesh")
UV = np.vstack([p["uv"] for p in projs]); WORLD = np.vstack([p["world"] for p in projs])
RAYN = WORLD[:, :2] / WORLD[:, 2:3]
uv_tree = cKDTree(UV); rayn_tree = cKDTree(RAYN)
uv_to_rayn = lambda uv: RAYN[uv_tree.query(uv, k=3)[1]].mean(1)
rayn_to_uv = lambda rn: UV[rayn_tree.query(rn, k=3)[1]].mean(1)


def load_detections():
    frames = {}
    for f in sorted(glob.glob("/tmp/imitation/det/item_*.json")):
        for cr in json.load(open(f))["camera_results"]:
            for r in cr["results"]:
                feet = [[b["bounding_box"]["x"] + b["bounding_box"]["width"] / 2,
                         b["bounding_box"]["y"] + b["bounding_box"]["height"]]
                        for b in r["detections"] if b["label"] == 1]
                if feet:
                    fv = np.array(feet, np.float32)
                    frames[r["timestamp"]] = (fv, uv_to_rayn(fv))   # keep pano uv too (for mask)
    return frames


def load_tracklets():
    frames = {}
    for f in sorted(glob.glob("/tmp/imitation/trk/item_*.json")):
        base = int(f.split("item_")[1].split(".")[0]) * 10 * 1_000000
        for oid, pts in json.load(open(f)).items():
            for p in pts:
                ts = START + base + int(round(p["timeOffset"]))
                frames.setdefault(ts, []).append((p["x"], p["y"]))
    return {k: np.array(v, np.float32) for k, v in frames.items()}


def pitch_rect_metric(trk):
    """Robust metric pitch bounds: the central mass of all tracklet positions over the window
    (spectators are a sparse minority at fixed edge spots; players fill the pitch)."""
    allp = np.vstack(list(trk.values()))
    lo = np.percentile(allp, 3, axis=0); hi = np.percentile(allp, 97, axis=0)
    pad = 3.0
    return lo - pad, hi + pad


def main():
    det = load_detections(); trk = load_tracklets()
    dts = np.array(sorted(det)); tts = np.array(sorted(trk))
    lo, hi = pitch_rect_metric(trk)
    print(f"metric pitch rect x[{lo[0]:.0f},{hi[0]:.0f}] y[{lo[1]:.0f},{hi[1]:.0f}]")

    # time-match; pre-mask spectators (metric outside pitch rect; pano feet above fence line v<0.18)
    pairs = []
    for dt in dts:
        j = tts[np.argmin(np.abs(tts - dt))]
        if abs(j - dt) >= 80_000:
            continue
        fv, drn = det[dt]; met = trk[j]
        dm = (fv[:, 1] > 0.18)                                   # drop detections near top fence
        mm = (met[:, 0] > lo[0]) & (met[:, 0] < hi[0]) & (met[:, 1] > lo[1]) & (met[:, 1] < hi[1])
        if dm.sum() >= 4 and mm.sum() >= 4:
            pairs.append((drn[dm], met[mm]))
    print(f"{len(pairs)} time-matched frames after spectator pre-mask")

    H = np.load("/tmp/imitation/H_metric_to_rayn_precise.npy")

    def balance(MM, RR, cell=6.0, cap=8):
        """cap correspondences per metric grid cell so dense near-camera regions don't dominate."""
        keys = np.floor(MM / cell).astype(int)
        seen = {}; keep = []
        order = np.random.default_rng(0).permutation(len(MM))
        for i in order:
            k = (keys[i, 0], keys[i, 1])
            seen[k] = seen.get(k, 0)
            if seen[k] < cap:
                seen[k] += 1; keep.append(i)
        keep = np.array(keep)
        return MM[keep], RR[keep]

    for it, gate in enumerate([0.06, 0.045, 0.035, 0.028, 0.022, 0.018, 0.015, 0.013, 0.012, 0.012]):
        MM, RR = [], []
        for drn, met in pairs:
            proj = cv2.perspectiveTransform(met[None], H)[0]
            C = np.linalg.norm(proj[:, None] - drn[None], axis=2)
            ri, ci = linear_sum_assignment(C)
            good = C[ri, ci] < gate
            MM.append(met[ri[good]]); RR.append(drn[ci[good]])
        MM = np.vstack(MM); RR = np.vstack(RR)
        MMb, RRb = balance(MM, RR)
        Hn, inl = cv2.findHomography(MMb, RRb, cv2.RANSAC, 0.010)
        if Hn is None:
            print("  findHomography failed"); break
        H = Hn
        res = np.linalg.norm(cv2.perspectiveTransform(MM[None], H)[0] - RR, axis=1)
        if it % 2 == 0 or it >= 8:
            print(f"  iter {it} gate {gate:.3f}: {len(MM)} matches ({len(MMb)} balanced), "
                  f"median res {np.median(res):.4f} rayn, inliers {int(inl.sum())}")

    # per-region bias diagnostic (on final inlier matches)
    proj = cv2.perspectiveTransform(MM[None], H)[0]
    err = np.linalg.norm(proj - RR, axis=1)
    cx = np.median(MM[:, 0]); cy = np.median(MM[:, 1])
    for name, m in [("left (x<med)", MM[:, 0] < cx), ("right", MM[:, 0] >= cx),
                    ("far (y<med)", MM[:, 1] < cy), ("near", MM[:, 1] >= cy)]:
        if m.sum():
            print(f"    {name:14s} n={m.sum():4d} median res {np.median(err[m]):.4f}")

    np.save("/tmp/imitation/H_metric_to_rayn_refined.npy", H)
    print("saved H_metric_to_rayn_refined.npy")

    # validate overlay vs precise
    cap = cv2.VideoCapture(RAW); panels = []
    for tv in [30, 60, 90]:
        j = tts[np.argmin(np.abs(tts - (RAWABS0 + tv * 1_000000)))]; met = trk[j]
        cap.set(cv2.CAP_PROP_POS_MSEC, tv * 1000); ok, fr = cap.read()
        im = cv2.resize(fr, (1280, 720))
        uv = rayn_to_uv(cv2.perspectiveTransform(met[None], H)[0])
        for u, v in uv:
            if 0 <= u <= 1 and 0 <= v <= 1:
                cv2.circle(im, (int(u * 1280), int(v * 720)), 7, (0, 0, 255), 2)
        cv2.putText(im, f"REFINED calib tracklets->raw t={tv}s", (8, 26), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 255), 2)
        panels.append(im)
    cap.release(); cv2.imwrite("/tmp/imitation/calib_refined_validate.png", np.vstack(panels))
    print("wrote /tmp/imitation/calib_refined_validate.png")


if __name__ == "__main__":
    main()

"""Objective aim eval: compare viewport-derived aim (v2 ROI-centroid vs v3 action-weighted)
against Spiideo's ACTUAL crop centre (reg_b923d40f.json pano_x/y from SIFT, 100% coverage,
the reliable ground truth) — converted to pan/tilt through the SAME mesh as our pipeline.

  python3 aim_eval.py
"""
from __future__ import annotations
import json, glob
import numpy as np, cv2
from matplotlib.path import Path
from scipy.spatial import cKDTree
import mesh_dewarp as MD

START = 1783537924240000; RAWABS0 = START + 900_000000
projs, _ = MD.load_mesh("/tmp/follow-pair/mesh")
UV = np.vstack([p["uv"] for p in projs]); WORLD = np.vstack([p["world"] for p in projs])
RAYN = WORLD[:, :2] / WORLD[:, 2:3]; uv_tree = cKDTree(UV)
H = np.load("/tmp/imitation/H_metric_to_rayn_refined.npy")
SIGMA = 6.0


def r2pt(rn):
    x, y = float(rn[0]), float(rn[1]); n = np.sqrt(x * x + y * y + 1)
    return np.degrees(np.arctan2(-x, 1)), np.degrees(-np.arcsin(y / n))


def uv_to_pt(u, v):                                            # Spiideo pano crop-centre -> pan/tilt
    rn = RAYN[uv_tree.query([[u, v]])[1][0]]
    return r2pt(rn)


def load_vp():
    o = []
    for f in sorted(glob.glob("/tmp/imitation/vp/item_*.json")):
        for e in json.load(open(f)).get("viewportsPointCloud", []):
            p = np.array(e["points"]); g = p[np.abs(p[:, 2]) < 0.5][:, :2]
            if len(g) >= 3: o.append((e["timestamp"], g.astype(np.float32)))
    o.sort(key=lambda x: x[0]); return o


def load_trk():
    fr = {}
    for f in sorted(glob.glob("/tmp/imitation/trk/item_*.json")):
        base = int(f.split("item_")[1].split(".")[0]) * 10 * 1_000000
        for oid, pts in json.load(open(f)).items():
            for p in pts:
                fr.setdefault(START + base + int(round(p["timeOffset"])), []).append((p["x"], p["y"]))
    return {k: np.array(v, np.float32) for k, v in fr.items()}


def action_point(poly, pts):
    if pts is None or len(pts) == 0: return None
    P = pts[Path(poly).contains_points(pts)]
    if len(P) < 2: return None
    D = np.linalg.norm(P[:, None] - P[None], axis=2)
    w = np.exp(-(D ** 2) / (2 * SIGMA ** 2)).sum(1)
    return (P * w[:, None]).sum(0) / w.sum()


def main():
    reg = json.load(open("/tmp/imitation/reg_b923d40f.json"))
    rt = np.array(reg["t"]); rpx = np.array(reg["pano_x"]); rpy = np.array(reg["pano_y"])
    gt = np.array([uv_to_pt(rpx[i], rpy[i]) for i in range(len(rt))])   # Spiideo GT pan,tilt

    vps = load_vp(); trk = load_trk(); tts = np.array(sorted(trk))
    vtime = np.array([(v[0] - RAWABS0) / 1e6 for v in vps])
    v2 = np.zeros((len(vps), 2)); v3 = np.zeros((len(vps), 2))
    for i, (ts, poly) in enumerate(vps):
        v2[i] = r2pt(cv2.perspectiveTransform(poly.mean(0)[None, None].astype(np.float32), H)[0, 0])
        j = tts[np.argmin(np.abs(tts - ts))]
        pts = trk[j] if abs(j - ts) < 150_000 else None
        aim = action_point(poly, pts)
        v3[i] = v2[i] if aim is None else r2pt(cv2.perspectiveTransform(aim[None, None].astype(np.float32), H)[0, 0])

    # resample v2,v3 onto GT times (within window overlap)
    m = (rt >= vtime.min()) & (rt <= vtime.max())
    for name, arr in [("v2 ROI-centroid", v2), ("v3 action-weighted", v3)]:
        pan_i = np.interp(rt[m], vtime, arr[:, 0]); tilt_i = np.interp(rt[m], vtime, arr[:, 1])
        dp = np.abs(pan_i - gt[m, 0]); dt = np.abs(tilt_i - gt[m, 1])
        # allow a single global pan/tilt bias (follow-policy offset), report residual after removing it
        bp = np.median(pan_i - gt[m, 0]); bt = np.median(tilt_i - gt[m, 1])
        dpb = np.abs((pan_i - bp) - gt[m, 0])
        print(f"{name:20s}  pan |err| med {np.median(dp):.1f}deg (p90 {np.percentile(dp,90):.1f})  "
              f"| after debias(bias {bp:+.1f}): med {np.median(dpb):.1f} (p90 {np.percentile(dpb,90):.1f})  "
              f"| tilt med {np.median(dt):.1f}")
    print(f"\nGT pan range [{gt[m,0].min():.0f},{gt[m,0].max():.0f}]  v2 [{v2[:,0].min():.0f},{v2[:,0].max():.0f}]  v3 [{v3[:,0].min():.0f},{v3[:,0].max():.0f}]")


if __name__ == "__main__":
    main()

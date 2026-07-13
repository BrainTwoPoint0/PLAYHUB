"""Isolate the follow error: map Spiideo's viewport CENTROID (metric) through H onto the raw
frame, and separately show what pan-angle invert() derives. If the centroid dot lands on the
action, H is good and any follow error is downstream (invert/pan/fov). Compares H variants.

  python3 aim_diag.py
"""
from __future__ import annotations
import json, glob, os
import numpy as np, cv2
from scipy.spatial import cKDTree
import mesh_dewarp as MD

G = "b923d40f-e5bc-4803-901b-d7412ba77043"
RAW = f"/tmp/follow-pair/raw_{G}_s900.mp4"
START = 1783537924240000; RAWABS0 = START + 900_000000
projs, _ = MD.load_mesh("/tmp/follow-pair/mesh")
UV = np.vstack([p["uv"] for p in projs]); WORLD = np.vstack([p["world"] for p in projs])
RAYN = WORLD[:, :2] / WORLD[:, 2:3]; rayn_tree = cKDTree(RAYN)
rayn_to_uv = lambda rn: UV[rayn_tree.query(rn, k=3)[1]].mean(1)

Hs = {"precise": np.load("/tmp/imitation/H_metric_to_rayn_precise.npy"),
      "refined": np.load("/tmp/imitation/H_metric_to_rayn_refined.npy")}


def load_vp():
    out = []
    for f in sorted(glob.glob("/tmp/imitation/vp/item_*.json")):
        for e in json.load(open(f)).get("viewportsPointCloud", []):
            pts = np.array(e["points"]); g = pts[np.abs(pts[:, 2]) < 0.5][:, :2]
            if len(g) >= 3:
                out.append((e["timestamp"], g))
    out.sort(key=lambda x: x[0]); return out


def main():
    vps = load_vp()
    vts = np.array([v[0] for v in vps])
    cap = cv2.VideoCapture(RAW); panels = []
    for tv in [20, 40, 60, 80, 100]:
        tgt = RAWABS0 + tv * 1_000000
        k = int(np.argmin(np.abs(vts - tgt))); _, poly = vps[k]
        cen = poly.mean(0, keepdims=True).astype(np.float32)
        cap.set(cv2.CAP_PROP_POS_MSEC, tv * 1000); ok, fr = cap.read()
        if not ok: continue
        im = cv2.resize(fr, (1280, 720))
        colors = {"precise": (0, 165, 255), "refined": (0, 0, 255)}
        for name, H in Hs.items():
            # centroid -> pano
            uv = rayn_to_uv(cv2.perspectiveTransform(cen[None], H)[0])[0]
            u, v = int(uv[0] * 1280), int(uv[1] * 720)
            cv2.drawMarker(im, (u, v), colors[name], cv2.MARKER_CROSS, 40, 3)
            cv2.circle(im, (u, v), 22, colors[name], 2)
            # also project the whole viewport ground polygon (refined only, thin)
            if name == "refined":
                puv = rayn_to_uv(cv2.perspectiveTransform(poly[None].astype(np.float32), H)[0])
                pp = np.clip((puv * [1280, 720]).astype(int), -5000, 5000)
                cv2.polylines(im, [pp], True, (0, 255, 0), 2)
        cv2.putText(im, f"t={tv}s  orange=precise centroid  red=refined centroid  green=refined viewport poly",
                    (8, 26), cv2.FONT_HERSHEY_SIMPLEX, 0.62, (0, 255, 255), 2)
        panels.append(im)
    cap.release()
    cv2.imwrite("/tmp/imitation/aim_diag.png", np.vstack(panels))
    print("wrote /tmp/imitation/aim_diag.png")


if __name__ == "__main__":
    main()

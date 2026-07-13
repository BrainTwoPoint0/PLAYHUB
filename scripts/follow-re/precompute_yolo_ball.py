"""Precompute adapted-YOLO ball candidates over a clip's raw VP (both flat tiles) at the
detection-stream timestamps, mapped back to pano uv. Output JSON feeds ball_follow as an extra
candidate source (fused with label-0). Run with the current adapted weights; rerun when v2 lands.

  WEIGHTS_PATH=/tmp/imitation/yolov8m_nazwa_adapt.pt CLIP=424e420a python3 precompute_yolo_ball.py
Writes /tmp/imitation/yolo_ball_<clip>.json: [{"ts": abs_us, "cands": [[u,v,conf],...]}, ...]
"""
from __future__ import annotations
import os, json, glob
import numpy as np, cv2
import mesh_dewarp as MD

CLIPS = {"b923d40f": (1783537924240000, 900), "22776d6c": (1783267984191000, 600),
         "d9fee1fc": (1783703644213000, 677),
         "424e420a": (1783523284388000, 600), "48e16a16": (1783098124784000, 600),
         "986c7896": (1783527004801000, 600)}
G8 = os.environ.get("CLIP", "424e420a")
START, WOFF = CLIPS[G8]; RAWABS0 = START + WOFF * 1_000000
RAW = glob.glob(f"/tmp/follow-pair/raw_{G8}*_s{WOFF}.mp4")[0]
DET_DIR = "/tmp/imitation/det" if G8 == "b923d40f" else f"/tmp/imitation/det_{G8}"
WEIGHTS = os.environ.get("WEIGHTS_PATH", "/tmp/imitation/yolov8m_nazwa_adapt.pt")
OUT = f"/tmp/imitation/yolo_ball_{G8}.json"
projs, _ = MD.load_mesh("/tmp/follow-pair/mesh")
TILES = [(-30.0, -22.0, 78.0), (28.0, -22.0, 78.0)]
TW, TH = 1536, 864
MIN_A, MAX_A = 12, 3000; CONF = 0.20        # keep low-conf too; the tracker gates


def main():
    from ultralytics import YOLO
    import torch
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    model = YOLO(WEIGHTS)
    bc = next((i for i, n in model.names.items() if n.lower() == "ball"), 0)
    maps = [MD.bake_uv_map(projs, np.radians(p), np.radians(t), f, TW, TH) for p, t, f in TILES]

    # detection timestamps (5 Hz) within the raw window
    dts = set()
    for f in sorted(glob.glob(f"{DET_DIR}/item_*.json")):
        for cr in json.load(open(f))["camera_results"]:
            for r in cr["results"]:
                dts.add(r["timestamp"])
    dts = np.array(sorted(t for t in dts if 0 <= (t - RAWABS0) / 1e6 <= 155))
    print(f"{G8}: {len(dts)} det timestamps, weights={os.path.basename(WEIGHTS)}")

    cap = cv2.VideoCapture(RAW)
    out = []
    for n, t in enumerate(dts):
        tsec = (t - RAWABS0) / 1e6
        cap.set(cv2.CAP_PROP_POS_MSEC, tsec * 1000); ok, fr = cap.read()
        if not ok:
            continue
        cands = []
        for (u, v) in maps:
            m1 = (u * fr.shape[1]).astype("f4"); m2 = (v * fr.shape[0]).astype("f4")
            m1[u < 0] = -1; m2[u < 0] = -1
            tile = cv2.remap(fr, m1, m2, cv2.INTER_LINEAR)
            r = model.predict(tile, imgsz=TW, conf=CONF, verbose=False, device=dev)[0]
            if r.boxes is None:
                continue
            for b in r.boxes:
                if int(b.cls[0]) != bc:
                    continue
                x1, y1, x2, y2 = (float(z) for z in b.xyxy[0]); w, h = x2 - x1, y2 - y1
                if not (MIN_A <= w * h <= MAX_A):
                    continue
                px, py = int((x1 + x2) / 2), int((y1 + y2) / 2)
                if 0 <= px < TW and 0 <= py < TH and u[py, px] >= 0:
                    cands.append([round(float(u[py, px]), 5), round(float(v[py, px]), 5),
                                  round(float(b.conf[0]), 3)])
        out.append({"ts": int(t), "cands": cands})
        if n % 100 == 0:
            print(f"  {n}/{len(dts)}  ({sum(1 for o in out if o['cands'])} frames with cands)", flush=True)
    cap.release()
    json.dump(out, open(OUT, "w"))
    n_with = sum(1 for o in out if o["cands"])
    print(f"wrote {OUT}: {len(out)} frames, {n_with} with >=1 cand ({100*n_with/max(1,len(out)):.0f}%)")


if __name__ == "__main__":
    main()

"""Phase-0 transfer test: does the existing Veo-finetuned YOLO detect the Nazwa raw-panorama
ball — especially at GOALMOUTHS where Spiideo's label-0 fails? Aim-independent surface: two
fixed FLAT tiles (mesh dewarp) covering the pitch, high-res so the ~6px ball survives. YOLO
full-frame (imgsz=tile width) + SAHI-640 fallback. Map best-ball back to pano via the tile's
uv-map, score vs reg ground truth, stratified goalmouth vs midfield.

  python3 phase0_yolo_test.py [stride]
"""
from __future__ import annotations
import sys, json, os, glob
import numpy as np, cv2
import mesh_dewarp as MD

CLIPS = {"b923d40f": (1783537924240000, 900), "22776d6c": (1783267984191000, 600),
         "d9fee1fc": (1783703644213000, 677),
         "424e420a": (1783523284388000, 600)}
G8 = os.environ.get("CLIP", "b923d40f")
START, WOFF = CLIPS[G8]; RAWABS0 = START + WOFF * 1_000000
RAW = glob_raw = __import__("glob").glob(f"/tmp/follow-pair/raw_{G8}*_s{WOFF}.mp4")[0]
DET_DIR = "/tmp/imitation/det" if G8 == "b923d40f" else f"/tmp/imitation/det_{G8}"
REG = f"/tmp/imitation/reg_{G8}.json"
WEIGHTS = os.environ.get("WEIGHTS_PATH",
    "/Users/karimfawaz/Dev Projects/PLAYBACK Workspace/PLAYHUB/scripts/portrait-crop/yolov8m_veo_finetuned.pt")
projs, _ = MD.load_mesh("/tmp/follow-pair/mesh")

TILES = [(-30.0, -22.0, 78.0), (28.0, -22.0, 78.0)]   # (pan,tilt,fov) two flat tiles over the pitch
TW, TH = 1536, 864
MIN_A, MAX_A = 12, 3000; FF_CONF = 0.12; PICK_CONF = 0.30
STRIDE = int(sys.argv[1]) if len(sys.argv) > 1 else 4


def tile_maps():
    maps = []
    for pan, tilt, fov in TILES:
        u, v = MD.bake_uv_map(projs, np.radians(pan), np.radians(tilt), fov, TW, TH)
        maps.append((u, v))
    return maps


def main():
    from ultralytics import YOLO
    import torch
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    model = YOLO(WEIGHTS)
    ball_cls = next((i for i, n in model.names.items() if n.lower() == "ball"), 0)
    try:
        from sahi import AutoDetectionModel
        from sahi.predict import get_sliced_prediction
        sahi_model = AutoDetectionModel.from_pretrained(model_type="ultralytics", model=model, confidence_threshold=0.1, device=dev)
    except Exception as e:
        print("SAHI unavailable:", e); sahi_model = None
    maps = tile_maps()

    reg = json.load(open(REG))
    rt = np.array(reg["t"]); rpx = np.array(reg["pano_x"]); rpy = np.array(reg["pano_y"])

    # label-0 presence per reg frame (to compare gap-filling)
    import glob
    det = {}
    for f in sorted(glob.glob(f"{DET_DIR}/item_*.json")):
        for cr in json.load(open(f))["camera_results"]:
            for r in cr["results"]:
                det[r["timestamp"]] = sum(1 for d in r["detections"] if d["label"] == 0 and d.get("confidence", 0) >= 0.4)
    dts = np.array(sorted(det))

    cap = cv2.VideoCapture(RAW); fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    idxs = list(range(0, len(rt), STRIDE))
    rows = []  # (t, goalmouth?, label0_present?, yolo_found?, yolo_err_pano_x, conf)
    for n, i in enumerate(idxs):
        cap.set(cv2.CAP_PROP_POS_MSEC, rt[i] * 1000); ok, fr = cap.read()
        if not ok: continue
        gm = abs(rpx[i] - 0.5) > 0.18
        l0 = det[dts[np.argmin(np.abs(dts - (RAWABS0 + rt[i] * 1e6)))]] > 0
        best = None
        for (u, v), (pan, tilt, fov) in zip(maps, TILES):
            m1 = (u * fr.shape[1]).astype("f4"); m2 = (v * fr.shape[0]).astype("f4")
            m1[u < 0] = -1; m2[u < 0] = -1
            tile = cv2.remap(fr, m1, m2, cv2.INTER_LINEAR)
            r = model.predict(tile, imgsz=TW, conf=FF_CONF, verbose=False, device=dev)[0]
            cands = []
            if r.boxes is not None:
                for b in r.boxes:
                    if int(b.cls[0]) != ball_cls: continue
                    x1, y1, x2, y2 = (float(z) for z in b.xyxy[0]); w, h = x2 - x1, y2 - y1
                    if MIN_A <= w * h <= MAX_A:
                        cands.append(((x1 + x2) / 2, (y1 + y2) / 2, float(b.conf[0])))
            if not any(c[2] >= PICK_CONF for c in cands) and sahi_model is not None:
                res = get_sliced_prediction(tile, sahi_model, slice_height=640, slice_width=640,
                                            overlap_height_ratio=0.2, overlap_width_ratio=0.2, verbose=0)
                for p in res.object_prediction_list:
                    if p.category.id != ball_cls: continue
                    bb = p.bbox; w, h = bb.maxx - bb.minx, bb.maxy - bb.miny
                    if MIN_A <= w * h <= MAX_A:
                        cands.append(((bb.minx + bb.maxx) / 2, (bb.miny + bb.maxy) / 2, p.score.value))
            for cx, cy, cf in cands:
                if cf < PICK_CONF: continue
                px = int(round(cx)); py = int(round(cy))
                if 0 <= px < TW and 0 <= py < TH and u[py, px] >= 0:      # map tile px -> pano uv
                    pano_u = float(u[py, px])
                    if best is None or cf > best[2]:
                        best = (pano_u, float(v[py, px]), cf)
        found = best is not None
        err = abs(best[0] - rpx[i]) if found else np.nan
        rows.append((rt[i], gm, l0, found, err, best[2] if found else 0))
        if n % 25 == 0: print(f"  {n}/{len(idxs)} frames...", flush=True)
    cap.release()
    R = rows
    LOC = 0.06                                                # a det counts only if within 0.06 of the true ball
    def rate(sub): return 100 * np.mean([r[3] for r in sub]) if sub else 0
    def locrate(sub): return 100 * np.mean([r[3] and r[4] < LOC for r in sub]) if sub else 0
    gm = [r for r in R if r[1]]; mid = [r for r in R if not r[1]]
    gm_gap = [r for r in R if r[1] and not r[2]]             # goalmouth AND label-0 absent = the gap
    print(f"\n{len(R)} frames (stride {STRIDE}). 'any-pick' vs LOCALIZED (<{LOC} of true ball) detection:")
    print(f"  midfield:  any {rate(mid):3.0f}%  localized {locrate(mid):3.0f}%")
    print(f"  goalmouth: any {rate(gm):3.0f}%  localized {locrate(gm):3.0f}%")
    print(f"  >>> goalmouth GAP (label-0 absent): any {rate(gm_gap):3.0f}%  LOCALIZED {locrate(gm_gap):3.0f}%  (n={len(gm_gap)})")
    e = [r[4] for r in R if r[3] and r[4] < 0.12]
    print(f"localization |err| median {np.median(e):.3f} over {len(e)} dets<0.12")
    print("=> LOCALIZED gap rate is the honest 'found the real ball' number (any-pick counts FPs).")


if __name__ == "__main__":
    main()

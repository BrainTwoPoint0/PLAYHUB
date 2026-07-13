"""Raw-panorama ball-detection dataset generator (auto-labeled by the fusion tracker).
For each CONFIDENT ball detection (label-0 present, not held/interpolated), render the flat tile
that contains the ball and emit a YOLO-format (image, ball-box) label. This adapts the Veo
detector to the night/fisheye raw-panorama appearance. Confident frames only — never train on
held/filled guesses. Characterises the set (count, goalmouth vs midfield) + a labeled montage.

  python3 make_ballset.py <gameId> [out_dir]   # gameId short (b923d40f); needs det/ for that game
"""
from __future__ import annotations
import sys, json, glob, os
import numpy as np, cv2
import mesh_dewarp as MD
import ball_follow as BF

# clip registry: short id -> (START abs us, window-offset s)
CLIPS = {
    "b923d40f": (1783537924240000, 900),
    "22776d6c": (1783267984191000, 600),
    "424e420a": (1783523284388000, 600),
    "48e16a16": (1783098124784000, 600),
    "986c7896": (1783527004801000, 600),
}
G8 = sys.argv[1] if len(sys.argv) > 1 else "b923d40f"
OUT = sys.argv[2] if len(sys.argv) > 2 else f"/tmp/imitation/ballset/{G8}"
START, WOFF = CLIPS[G8]
RAWABS0 = START + WOFF * 1_000000
RAW = glob.glob(f"/tmp/follow-pair/raw_{G8}*_s{WOFF}.mp4")[0]
os.environ["DET_DIR"] = f"/tmp/imitation/det" if G8 == "b923d40f" else f"/tmp/imitation/det_{G8}"
projs, _ = MD.load_mesh("/tmp/follow-pair/mesh")
TILES = [(-30.0, -22.0, 78.0), (28.0, -22.0, 78.0)]
TW, TH = 1536, 864
BOX = 22                        # ball box side (px) in tile — ~ball+margin at this res
GOAL_L, GOAL_R = 0.26, 0.73


def main():
    os.makedirs(f"{OUT}/images", exist_ok=True); os.makedirs(f"{OUT}/labels", exist_ok=True)
    frames = BF.load_frames()
    ts, xy = BF.track_centroid(frames)                          # confident = non-nan (label-0 present)
    conf = ~np.isnan(xy[:, 0])
    maps = [(MD.bake_uv_map(projs, np.radians(p), np.radians(t), f, TW, TH)) for p, t, f in TILES]
    # pano uv -> tile pixel: nearest tile pixel whose (u,v) matches
    tile_trees = []
    from scipy.spatial import cKDTree
    for u, v in maps:
        m = u >= 0
        pts = np.column_stack([u[m], v[m]]); ij = np.column_stack(np.where(m))
        tile_trees.append((cKDTree(pts), ij))

    cap = cv2.VideoCapture(RAW); fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    n_pos = 0; gm = 0; montage = []
    for i in np.where(conf)[0]:
        tsec = (ts[i] - RAWABS0) / 1e6
        if tsec < 0 or tsec > 200: continue
        bx, by = xy[i]
        cap.set(cv2.CAP_PROP_POS_MSEC, tsec * 1000); ok, fr = cap.read()
        if not ok: continue
        for ti, ((u, v), (tree, ij)) in enumerate(zip(maps, tile_trees)):
            d, k = tree.query([bx, by])
            if d > 0.004: continue                              # ball not in this tile
            py, px = ij[k]
            if px < BOX or px > TW - BOX or py < BOX or py > TH - BOX: continue
            m1 = (u * fr.shape[1]).astype("f4"); m2 = (v * fr.shape[0]).astype("f4"); m1[u < 0] = -1; m2[u < 0] = -1
            tile = cv2.remap(fr, m1, m2, cv2.INTER_LINEAR)
            name = f"{G8}_{i:04d}_t{ti}"
            cv2.imwrite(f"{OUT}/images/{name}.jpg", tile)
            cxn, cyn, wn, hn = px / TW, py / TH, BOX / TW, BOX / TH
            open(f"{OUT}/labels/{name}.txt", "w").write(f"0 {cxn:.6f} {cyn:.6f} {wn:.6f} {hn:.6f}\n")
            n_pos += 1
            if abs(bx - GOAL_L) < 0.12 or abs(bx - GOAL_R) < 0.12: gm += 1
            if len(montage) < 8 and i % 20 == 0:
                crop = tile[max(0, py - 60):py + 60, max(0, px - 90):px + 90].copy()
                cv2.rectangle(crop, (crop.shape[1] // 2 - BOX // 2, crop.shape[0] // 2 - BOX // 2),
                              (crop.shape[1] // 2 + BOX // 2, crop.shape[0] // 2 + BOX // 2), (0, 0, 255), 2)
                if crop.size: montage.append(cv2.resize(crop, (240, 160)))
    cap.release()
    if montage:
        while len(montage) % 4: montage.append(np.zeros_like(montage[0]))
        cv2.imwrite(f"{OUT}/labeled_montage.png", np.vstack([np.hstack(montage[i:i+4]) for i in range(0, len(montage), 4)]))
    print(f"{G8}: {n_pos} positive labels ({gm} goalmouth, {n_pos-gm} midfield) -> {OUT}")
    print(f"  confident detection frames: {conf.sum()}/{len(conf)}  ({100*conf.mean():.0f}%)")
    print(f"  labeled montage: {OUT}/labeled_montage.png (eyeball box-on-ball quality)")


if __name__ == "__main__":
    main()

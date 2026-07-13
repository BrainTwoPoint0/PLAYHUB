"""Ball-proxy step 0c: CROSS-VOTE the two independent Spiideo signals (no reg). The ball
tracklet is the one whose pano position most often has a label-0 detection nearby. Score each
tracklet by label-0 support; then check whether the label-0-selected ball correlates with reg.
This tells us if fusing the two weak signals recovers the ball WITHOUT using ground truth.

  python3 ball_fuse_probe.py
"""
from __future__ import annotations
import json, glob
import numpy as np, cv2
from scipy.spatial import cKDTree
import mesh_dewarp as MD

START = 1783537924240000; RAWABS0 = START + 900_000000
projs, _ = MD.load_mesh("/tmp/follow-pair/mesh")
UV = np.vstack([p["uv"] for p in projs]); WORLD = np.vstack([p["world"] for p in projs])
RAYN = WORLD[:, :2] / WORLD[:, 2:3]; rayn_tree = cKDTree(RAYN)
rayn_to_uv = lambda rn: UV[rayn_tree.query(rn, k=3)[1]].mean(1)
H = np.load("/tmp/imitation/H_metric_to_rayn_refined.npy")
SUPPORT_R = 0.04                                                # pano radius for label-0 "support"


def load_ball_dets():
    frames = {}
    for f in sorted(glob.glob("/tmp/imitation/det/item_*.json")):
        for cr in json.load(open(f))["camera_results"]:
            for r in cr["results"]:
                b = [[d["bounding_box"]["x"] + d["bounding_box"]["width"] / 2,
                      d["bounding_box"]["y"] + d["bounding_box"]["height"] / 2]
                     for d in r["detections"] if d["label"] == 0]
                if b:
                    frames[r["timestamp"]] = np.array(b, float)
    return frames


def load_tracklets_by_id():
    out = []
    for f in sorted(glob.glob("/tmp/imitation/trk/item_*.json")):
        base = int(f.split("item_")[1].split(".")[0]) * 10 * 1_000000
        for oid, pts in json.load(open(f)).items():
            ts = np.array([START + base + int(round(p["timeOffset"])) for p in pts])
            xy = np.array([[p["x"], p["y"]] for p in pts], float)
            if len(ts) >= 8:
                out.append((oid, ts, xy))
    return out


def main():
    balld = load_ball_dets(); bts = np.array(sorted(balld))
    trks = load_tracklets_by_id()
    reg = json.load(open("/tmp/imitation/reg_b923d40f.json"))
    rt_abs = RAWABS0 + np.array(reg["t"]) * 1e6; rpx = np.array(reg["pano_x"])

    # per tracklet: label-0 support fraction (its pano pos has a ball det within R at its frames)
    scored = []
    for oid, ts, xy in trks:
        uv = rayn_to_uv(cv2.perspectiveTransform(xy[None].astype(np.float32), H)[0])
        sup = 0; nchk = 0
        for k, t in enumerate(ts):
            j = int(np.argmin(np.abs(bts - t)))
            if abs(bts[j] - t) < 120_000:
                nchk += 1
                if np.linalg.norm(balld[bts[j]] - uv[k], axis=1).min() < SUPPORT_R:
                    sup += 1
        if nchk >= 6:
            frac = sup / nchk
            reg_at = np.interp(ts, rt_abs, rpx)
            c = np.corrcoef(uv[:, 0], reg_at)[0, 1] if np.std(uv[:, 0]) > 1e-3 else 0
            scored.append((oid[:8], frac, nchk, c, float(np.abs(uv[:, 0] - reg_at).mean()),
                           (ts[-1] - ts[0]) / 1e6))
    scored.sort(key=lambda r: -r[1])
    print(f"{len(scored)} tracklets. Top 15 by label-0 SUPPORT (cross-vote ball score):")
    print(f"{'id':8} {'support':>7} {'nchk':>4} {'regcorr':>7} {'|dpx|':>6} {'dur':>5}")
    for r in scored[:15]:
        print(f"{r[0]:8} {r[1]:7.2f} {r[2]:4d} {r[3]:+7.2f} {r[4]:6.3f} {r[5]:5.1f}")

    # BUILD a ball track: at each reg time, pick the tracklet (alive then) with best support, use its pano_x
    # (greedy, support-weighted). Then correlate the assembled ball_x with reg.
    reg_t = np.array(reg["t"]); ball_x = np.full(len(reg_t), np.nan)
    sup_map = {oid: fr for oid, fr, *_ in scored}
    trk_uv = {}
    for oid, ts, xy in trks:
        trk_uv[oid[:8]] = (ts, rayn_to_uv(cv2.perspectiveTransform(xy[None].astype(np.float32), H)[0])[:, 0])
    for i, t in enumerate(reg_t):
        tabs = RAWABS0 + t * 1e6; best = None
        for oid, ts, xy in trks:
            k = oid[:8]
            if ts[0] - 1e5 <= tabs <= ts[-1] + 1e5 and sup_map.get(k, 0) > 0.25:
                w = sup_map[k]
                if best is None or w > best[0]:
                    j = int(np.argmin(np.abs(trk_uv[k][0] - tabs)))
                    best = (w, trk_uv[k][1][j])
        if best is not None:
            ball_x[i] = best[1]
    ok = ~np.isnan(ball_x)
    if ok.sum() > 30:
        c = np.corrcoef(ball_x[ok], rpx[ok])[0, 1]
        print(f"\nassembled label-0-supported ball track: covers {ok.mean()*100:.0f}% of frames, "
              f"corr with reg {c:+.2f}, median |Δpano_x| {np.median(np.abs(ball_x[ok]-rpx[ok])):.3f}")
        print("(compare: viewport ROI centroid corr was -0.10)")


if __name__ == "__main__":
    main()

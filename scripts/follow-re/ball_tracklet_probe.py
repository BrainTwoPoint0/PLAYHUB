"""Ball-proxy step 0b: is the BALL among Spiideo's metric tracklets? For each tracklet (keeping
its UUID across an item), map its metric path -> pano_x via refined H, and correlate with reg's
aim pano_x over the tracklet's lifetime. If the best-correlating tracklet per window tracks reg
tightly AND is identifiable by motion (fast, long path), the ball-follow is a tracklet-selection
problem. Also reports whether a MOTION-selected tracklet (fastest) matches the reg-selected one.

  python3 ball_tracklet_probe.py
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
rayn_to_u = lambda rn: UV[rayn_tree.query(rn, k=3)[1]].mean(1)[:, 0]
H = np.load("/tmp/imitation/H_metric_to_rayn_refined.npy")


def load_tracklets_by_id():
    """list of (uuid, ts_array, xy_array) per continuous tracklet within each 10s item."""
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
    reg = json.load(open("/tmp/imitation/reg_b923d40f.json"))
    rt_abs = RAWABS0 + np.array(reg["t"]) * 1e6; rpx = np.array(reg["pano_x"])
    trks = load_tracklets_by_id()

    # score every tracklet: correlation of its pano_x vs reg over its lifetime, + motion stats
    rows = []
    for oid, ts, xy in trks:
        rn = cv2.perspectiveTransform(xy[None].astype(np.float32), H)[0]
        ux = rayn_to_u(rn)                                       # tracklet pano_x
        reg_at = np.interp(ts, rt_abs, rpx)
        if np.std(ux) < 1e-3 or np.std(reg_at) < 1e-3:
            continue
        c = np.corrcoef(ux, reg_at)[0, 1]
        dur = (ts[-1] - ts[0]) / 1e6
        step = np.linalg.norm(np.diff(xy, axis=0), axis=1) / np.clip(np.diff(ts) / 1e6, 1e-3, None)
        rows.append((oid[:8], c, dur, float(np.median(step)), float(np.percentile(step, 90)), len(ts),
                     float(np.abs(ux - reg_at).mean())))
    rows.sort(key=lambda r: -abs(r[1]))
    print(f"{len(rows)} tracklets (>=8 pts). Top 12 by |corr with reg pano_x|:")
    print(f"{'id':8} {'corr':>6} {'dur_s':>6} {'spd_med':>7} {'spd_p90':>7} {'n':>4} {'|Δpano_x|':>9}")
    for r in rows[:12]:
        print(f"{r[0]:8} {r[1]:+6.2f} {r[2]:6.1f} {r[3]:7.2f} {r[4]:7.2f} {r[5]:4d} {r[6]:9.3f}")

    # does MOTION pick the same tracklet as reg-correlation? rank by speed_p90, see its corr
    by_speed = sorted(rows, key=lambda r: -r[4])
    print("\nTop 6 by speed_p90 (motion-based ball guess) and their reg-corr:")
    for r in by_speed[:6]:
        print(f"{r[0]:8} spd_p90 {r[4]:6.2f}  corr {r[1]:+.2f}  dur {r[2]:.1f}s")
    hi = [r for r in rows if abs(r[1]) > 0.7]
    print(f"\n{len(hi)} tracklets corr>0.7 (would be a strong ball signal if motion-identifiable)")


if __name__ == "__main__":
    main()

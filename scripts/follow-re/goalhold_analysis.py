"""GOAL-HOLD premise check + goal localisation. Recompute the ball-follow track, find the p90
tail (|pan err|>30 deg vs reg), and characterise: are the big misses 'we sit at goal A while reg
is at goal B' (wrong-goal drift during a ball gap)? Also locate the two goal pano_x zones from
the reg aim distribution (Spiideo dwells at the goals) so GOAL-HOLD has its regions.

  python3 goalhold_analysis.py
"""
from __future__ import annotations
import json, glob
import numpy as np, cv2
from scipy.spatial import cKDTree
import mesh_dewarp as MD
import ball_follow as BF

G = "b923d40f-e5bc-4803-901b-d7412ba77043"
START = 1783537924240000; RAWABS0 = START + 900_000000
projs, _ = MD.load_mesh("/tmp/follow-pair/mesh")
UV = np.vstack([p["uv"] for p in projs]); WORLD = np.vstack([p["world"] for p in projs])
RAYN = WORLD[:, :2] / WORLD[:, 2:3]; uv_tree = cKDTree(UV)


def u_to_pan(u, v=0.45):
    rn = RAYN[uv_tree.query([[u, v]])[1][0]]; return np.degrees(np.arctan2(-rn[0], 1))


def main():
    frames = BF.load_frames()
    ts, xy = BF.track_centroid(frames)
    bx, by = BF.fill_smooth(ts, xy)
    present = ~np.isnan(xy[:, 0])                                    # frames with a real detection

    reg = json.load(open(f"/tmp/imitation/reg_{G[:8]}.json"))
    rt = np.array(reg["t"]); rpx = np.array(reg["pano_x"]); rabs = RAWABS0 + rt * 1e6
    # our ball pano_x interp to reg times + whether a detection was present near each reg time
    bxi = np.interp(rabs, ts, bx)
    pres_i = np.interp(rabs, ts, present.astype(float)) > 0.5

    our_pan = np.array([u_to_pan(x) for x in bxi]); reg_pan = np.array([u_to_pan(x) for x in rpx])
    err = np.abs(our_pan - reg_pan)

    # goal zones from reg dwell (histogram peaks near the extremes)
    print("reg pano_x distribution (goals = dwell peaks near extremes):")
    h, edges = np.histogram(rpx, bins=12, range=(0.15, 0.85))
    for k in range(12):
        print(f"  px {edges[k]:.2f}-{edges[k+1]:.2f}: {'#'*h[k]} {h[k]}")
    LEFT_GOAL = float(np.median(rpx[rpx < 0.4])); RIGHT_GOAL = float(np.median(rpx[rpx > 0.6]))
    print(f"goal zones (pano_x): LEFT~{LEFT_GOAL:.2f}  RIGHT~{RIGHT_GOAL:.2f}")

    # p90 tail analysis
    tail = err > 30
    print(f"\np90 tail: {tail.sum()}/{len(err)} frames >30deg (median err {np.median(err):.1f})")
    # for tail frames: is our aim at the OPPOSITE goal from reg? and were we in a detection gap?
    def near(px, g): return abs(px - g) < 0.14
    wrong_goal = 0; in_gap = 0; reg_at_goal = 0
    for i in np.where(tail)[0]:
        ourpx = bxi[i]; regpx = rpx[i]
        reg_goal = near(regpx, LEFT_GOAL) or near(regpx, RIGHT_GOAL)
        if reg_goal: reg_at_goal += 1
        # opposite side of pitch center
        if (ourpx - 0.5) * (regpx - 0.5) < 0 and abs(ourpx - regpx) > 0.2:
            wrong_goal += 1
        if not pres_i[i]:
            in_gap += 1
    print(f"  of tail frames: reg-at-a-goal {reg_at_goal} ({100*reg_at_goal/max(1,tail.sum()):.0f}%), "
          f"we're OPPOSITE-side {wrong_goal} ({100*wrong_goal/max(1,tail.sum()):.0f}%), "
          f"in a detection GAP {in_gap} ({100*in_gap/max(1,tail.sum()):.0f}%)")
    print("=> if reg-at-goal + opposite-side + in-gap are all high, GOAL-HOLD (hold the goal, reject "
          "far re-acquire) directly cuts the tail.")


if __name__ == "__main__":
    main()

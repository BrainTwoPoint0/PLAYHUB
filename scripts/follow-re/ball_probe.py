"""Ball-proxy step 0: characterise Spiideo's label-0 ("ball-ish") detections against reg-SIFT
ground truth (reg aim ~ ball position for a tight follow). Answers: how often does label-0
fire, and when it does, how close is the BEST label-0 box to Spiideo's actual crop centre?

If label-0 is usably close, a motion-gated track over it -> closed-form aim is the path.

  python3 ball_probe.py
"""
from __future__ import annotations
import json, glob
import numpy as np

START = 1783537924240000; RAWABS0 = START + 900_000000


def load_dets():
    """abs_ts -> dict(ball=Nx3 [u,v,conf], person=Mx2 [u,v] feet)."""
    out = {}
    for f in sorted(glob.glob("/tmp/imitation/det/item_*.json")):
        for cr in json.load(open(f))["camera_results"]:
            for r in cr["results"]:
                ball, person = [], []
                for b in r["detections"]:
                    bb = b["bounding_box"]
                    cx = bb["x"] + bb["width"] / 2
                    if b["label"] == 0:
                        ball.append([cx, bb["y"] + bb["height"] / 2, b.get("confidence", 0)])
                    elif b["label"] == 1:
                        person.append([cx, bb["y"] + bb["height"]])
                out[r["timestamp"]] = dict(ball=np.array(ball, float).reshape(-1, 3),
                                           person=np.array(person, float).reshape(-1, 2))
    return out


def main():
    reg = json.load(open("/tmp/imitation/reg_b923d40f.json"))
    rt = np.array(reg["t"]); rpx = np.array(reg["pano_x"]); rpy = np.array(reg["pano_y"])
    det = load_dets()
    dts = np.array(sorted(det))
    reg_abs = RAWABS0 + rt * 1e6

    n_frames = len(det)
    n_with_ball = sum(1 for t in det if len(det[t]["ball"]))
    ball_counts = [len(det[t]["ball"]) for t in det]
    print(f"detection frames: {n_frames}, game {(dts.min()-START)/1e6:.0f}..{(dts.max()-START)/1e6:.0f}s")
    print(f"frames with >=1 label-0: {n_with_ball} ({100*n_with_ball/n_frames:.0f}%)  "
          f"mean {np.mean(ball_counts):.2f}/frame, max {max(ball_counts)}")

    # for each detection frame with a ball, distance of BEST label-0 to reg aim (nearest reg time)
    d_best, d_nearest_reg_gap, confs = [], [], []
    person_dist = []
    for t in dts:
        b = det[t]["ball"]
        ri = int(np.argmin(np.abs(reg_abs - t))); gap = abs(reg_abs[ri] - t) / 1e6
        if gap > 0.15:
            continue
        aim = np.array([rpx[ri], rpy[ri]])
        # person centroid distance to aim (baseline: how good is 'just the players' as a ball proxy?)
        if len(det[t]["person"]):
            person_dist.append(np.linalg.norm(det[t]["person"][:, :2].mean(0) - aim))
        if len(b) == 0:
            continue
        d = np.linalg.norm(b[:, :2] - aim, axis=1)
        d_best.append(d.min()); confs.append(b[np.argmin(d), 2])
    d_best = np.array(d_best); person_dist = np.array(person_dist)
    print(f"\nlabel-0 BEST-box distance to reg aim (normalised pano units, 1.0 = full width):")
    print(f"  median {np.median(d_best):.3f}  p25 {np.percentile(d_best,25):.3f}  p75 {np.percentile(d_best,75):.3f}  "
          f"frac<0.05 {np.mean(d_best<0.05):.2f}  frac<0.10 {np.mean(d_best<0.10):.2f}")
    print(f"  (best-box conf: median {np.median(confs):.2f})")
    print(f"person-centroid distance to reg aim: median {np.median(person_dist):.3f}  frac<0.10 {np.mean(person_dist<0.10):.2f}")
    print(f"\n=> if label-0 frac<0.10 >> person frac<0.10, the ball detection carries real aim signal.")


if __name__ == "__main__":
    main()

"""Follow-quality gate — A/B of TARGET SOURCE (motion-centroid vs ball-driven)
through the deployed controller (controller.py), scored against where the ball
ACTUALLY is (hand labels). Render-only proxy: everything in render-normalized
horizontal position x∈[0,1] (a perfect follow points at the ball; the ball moves
±17-34% within the render, so tracking it is discriminating).

Per clip, per source we produce a smoothed pointing pan_ours(t) and measure vs the
GT ball position ball_gt(t):
  - ball-in-frame %  : |pan_ours - ball_gt| < HALF_WINDOW  (the true downstream signal)
  - residual RMS/P95 : |pan_ours - ball_gt|
  - jerk P95         : 2nd diff of pan_ours (smoothness guardrail)
  - false-whips      : |Δpan_ours| > WHIP_STEP within WHIP_FRAMES (precision-failure signature)

Sources:
  - centroid : deployed motion-heatmap centroid (ported from stepFollow)
  - baseline / vnext : detect_ball ball picks, with WHIP-SAFETY (conf gate + velocity
    gate + HOLD-on-miss + post-controller slew clamp).

  python3 follow_gate.py            # all 4 val clips, baseline vs vnext vs centroid
"""
from __future__ import annotations

import glob
import json
import math
import os
import statistics as st

import numpy as np
import cv2

from controller import FollowController

PC = "/Users/karimfawaz/Dev Projects/PLAYBACK Workspace/PLAYHUB/scripts/portrait-crop"
LABELS = f"{PC}/eval-dataset/labels"
DETS = "/tmp/ab"  # /tmp/ab/{baseline,vnext}/<clip>.json
CLIPS = [
    "veo_20260501_ncfe_goal_01", "veo_20260502b_passage_01",
    "veo_20260505_hb_matchday1_passage_01", "veo_20260506_hb_cupfinal_passage_01",
]

HALF_WINDOW = 0.16      # virtual crop half-width (≈0.32 of frame) — ball-in-frame test
CONF_GATE = 0.40        # accept a ball target only above this confidence (whip-safety)
MAX_TARGET_JUMP = 0.25  # velocity gate: reject a detection this far from last accepted (norm/frame)
SLEW_CLAMP = 0.05       # hard cap on |Δpan_ours| per frame (last-line whip guarantee, norm)
WHIP_STEP = 0.15        # false-whip: pan moves this far...
WHIP_FRAMES = 6         # ...within this many frames


def load_gt(clip):
    """GT ball horizontal position per source frame, normalized. Returns dict
    frame->x_norm (only visible frames)."""
    d = json.load(open(f"{LABELS}/{clip}.json"))
    W = 1920.0
    return {int(f["frame"]): f["ball"]["x"] / W
            for f in d["frames"] if f["ball"].get("visible")}, d["source_fps"]


def ball_targets(clip, model):
    """Ball-driven per-frame target (normalized x) with whip-safety. None = no
    trusted target this frame (miss/gated) -> controller coasts. Keyed by frame idx."""
    d = json.load(open(f"{DETS}/{model}/{clip}.json"))
    fps = 30.0
    W = 1920.0
    by_frame = {}
    for p in d.get("positions", []):
        if p.get("source") == "ball" and p.get("x", -1) >= 0 and p.get("conf", 0) >= CONF_GATE:
            by_frame[round(p["time"] * fps)] = p["x"] / W
    # velocity gate: drop a pick that jumps too far from the last ACCEPTED one
    out, last = {}, None
    for fr in sorted(by_frame):
        x = by_frame[fr]
        if last is None or abs(x - last) <= MAX_TARGET_JUMP:
            out[fr] = x
            last = x
        # else: reject (a physically-impossible jump = a false positive) -> coast
    return out, fps


def centroid_targets(clip):
    """Deployed motion-heatmap centroid per frame (normalized x). Port of stepFollow's
    accum heatmap: decaying frame-difference, centroid of accumulated motion."""
    cap = cv2.VideoCapture(f"{PC}/eval-dataset/clips/{clip}.mp4")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or 1920
    H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 1080
    # downscale for speed (matches the TSX offscreen canvas being small)
    Wc, Hc = 192, 108
    accum = np.zeros(Wc * Hc, np.float32)
    prev = None
    out, idx = {}, 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        small = cv2.resize(frame, (Wc, Hc))
        luma = (0.299 * small[:, :, 2] + 0.587 * small[:, :, 1] + 0.114 * small[:, :, 0]).astype(np.float32).ravel()
        if prev is not None:
            diff = np.abs(luma - prev)
            accum[:] = accum * 0.9 + np.where(diff > 14, diff, 0)
            m = accum > 6
            sw = accum[m].sum()
            if sw > 700 * (Wc * Hc) / (192 * 108):  # scaled gate
                xs = np.tile(np.arange(Wc), Hc)[m]
                mx = float((accum[m] * xs).sum() / sw)
                out[idx] = mx / Wc
        prev = luma
        idx += 1
    cap.release()
    return out, fps


def run_source(targets_by_frame, n_frames, fps):
    """Feed per-frame targets through the controller (None where absent -> coast),
    then apply a hard slew clamp on the output. Returns pan_ours[n_frames] (norm)."""
    ctl = FollowController(fps=fps)
    pan = []
    last = None
    for fr in range(n_frames):
        t = targets_by_frame.get(fr)
        tgt = {"pan": t, "tilt": 0.0, "fov": 40.0} if t is not None else None
        v = ctl.step(tgt)["pan"]
        if last is not None:  # slew clamp (last-line whip guard)
            v = last + max(-SLEW_CLAMP, min(SLEW_CLAMP, v - last))
            ctl.view["pan"] = v  # keep controller state consistent with clamped output
        pan.append(v)
        last = v
    return np.array(pan)


def metrics(pan, gt_by_frame, fps):
    frames = sorted(gt_by_frame)
    res = np.array([abs(pan[f] - gt_by_frame[f]) for f in frames if f < len(pan)])
    in_frame = float((res < HALF_WINDOW).mean()) if len(res) else 0.0
    rms = float(np.sqrt((res ** 2).mean())) if len(res) else 0.0
    p95 = float(np.percentile(res, 95)) if len(res) else 0.0
    jerk = np.abs(np.diff(pan, 2)) if len(pan) > 2 else np.array([0.0])
    jerk_p95 = float(np.percentile(jerk, 95))
    whips = 0
    for i in range(len(pan) - WHIP_FRAMES):
        if abs(pan[i + WHIP_FRAMES] - pan[i]) > WHIP_STEP:
            whips += 1
    return dict(in_frame=in_frame, rms=rms, p95=p95, jerk_p95=jerk_p95, whips=whips)


def main():
    sources = ["centroid", "baseline", "vnext"]
    agg = {s: {k: [] for k in ("in_frame", "rms", "p95", "jerk_p95", "whips")} for s in sources}
    print(f"{'clip':26} {'source':9} in-frame  rms    p95   jerkP95  whips")
    for clip in CLIPS:
        gt, fps = load_gt(clip)
        n = max(gt) + 2 if gt else 0
        for s in sources:
            if s == "centroid":
                tg, f2 = centroid_targets(clip)
            else:
                if not os.path.exists(f"{DETS}/{s}/{clip}.json"):
                    continue
                tg, f2 = ball_targets(clip, s)
            pan = run_source(tg, n, fps)
            m = metrics(pan, gt, fps)
            for k in agg[s]:
                agg[s][k].append(m[k])
            print(f"{clip[:26]:26} {s:9} {m['in_frame']*100:6.1f}% {m['rms']:.3f} {m['p95']:.3f}  {m['jerk_p95']:.4f}  {m['whips']}")
    print("\n=== MEAN over clips ===")
    print(f"{'source':9} in-frame  rms    p95   jerkP95  whips")
    for s in sources:
        a = agg[s]
        mean = lambda k: (sum(a[k]) / len(a[k])) if a[k] else 0
        print(f"{s:9} {mean('in_frame')*100:6.1f}% {mean('rms'):.3f} {mean('p95'):.3f}  {mean('jerk_p95'):.4f}  {mean('whips'):.1f}")


if __name__ == "__main__":
    main()

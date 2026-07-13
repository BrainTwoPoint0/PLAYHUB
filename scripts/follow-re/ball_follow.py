"""Ball-driven follow (computer-vision-specialist item-1 design). Greedy single-target ball
tracker over Spiideo's label-0 detections in PANO space, hold-on-miss (no velocity coast),
gap-aware fill + Savitzky-Golay, then closed-form ray->pan/tilt. Scores pan vs reg ground
truth (all 5 cached reg clips share the same b923 mesh only for b923; others need their own H —
here we score b923, and report the others' pan corr using each clip's own reg + this clip's
detector geometry is per-clip so we only fully score b923).

  python3 ball_follow.py [--render]
Scores b923d40f inline; with --render writes /tmp/imitation/ball_follow.mp4 vs Spiideo.
"""
from __future__ import annotations
import json, glob, sys
import numpy as np, cv2
from scipy.spatial import cKDTree
from scipy.signal import savgol_filter
import mesh_dewarp as MD

import os
CLIPS = {"b923d40f": (1783537924240000, 900), "22776d6c": (1783267984191000, 600),
         "d9fee1fc": (1783703644213000, 677),
         "424e420a": (1783523284388000, 600), "48e16a16": (1783098124784000, 600),
         "986c7896": (1783527004801000, 600)}
G8 = os.environ.get("CLIP", "b923d40f")
START, WOFF = CLIPS[G8]; RAWABS0 = START + WOFF * 1_000000
RAW = glob.glob(f"/tmp/follow-pair/raw_{G8}*_s{WOFF}.mp4")[0]
_play = glob.glob(f"/tmp/follow-pair/play_{G8}*_s{WOFF}.mp4") or glob.glob(f"/tmp/imitation/play_{G8}*_s{WOFF}.mp4")
PLAY = _play[0] if _play else None
if G8 != "b923d40f":
    os.environ.setdefault("DET_DIR", f"/tmp/imitation/det_{G8}")
projs, _ = MD.load_mesh(os.environ.get("MESH", "/tmp/follow-pair/mesh-fixed"))  # 4-proj fixed mesh (80% cov)
UV = np.vstack([p["uv"] for p in projs]); WORLD = np.vstack([p["world"] for p in projs])
RAYN = WORLD[:, :2] / WORLD[:, 2:3]; uv_tree = cKDTree(UV)

CONF = 0.40           # label-0 confidence floor
GATE = 0.08           # max pano move/frame (assoc gate, greedy tracker)
OUTLIER = 0.20        # centroid mode: drop boxes this far from last estimate
HOLD = 6              # max frames to hold on miss
NEAR_PLAYER = 0.05    # init: ball must be near a person (reject bg FPs)
import os
MODE = os.environ.get("MODE", "antiteleport")  # "antiteleport" (best) | "centroid" | "greedy" | "goalhold"


def ray_to_pantilt_uv(u, v):
    rn = RAYN[uv_tree.query([[u, v]])[1][0]]
    x, y = float(rn[0]), float(rn[1]); n = np.sqrt(x * x + y * y + 1)
    return np.degrees(np.arctan2(-x, 1)), np.degrees(-np.arcsin(y / n))


def load_frames(det_dir=None):
    """sorted list of (abs_ts, ball Nx3[u,v,conf], person Mx2[u,v])."""
    det_dir = det_dir or os.environ.get("DET_DIR", "/tmp/imitation/det")
    agg = {}
    for f in sorted(glob.glob(f"{det_dir}/item_*.json")):
        for cr in json.load(open(f))["camera_results"]:
            for r in cr["results"]:
                b, p = [], []
                for d in r["detections"]:
                    bb = d["bounding_box"]; cx = bb["x"] + bb["width"] / 2
                    if d["label"] == 0:
                        b.append([cx, bb["y"] + bb["height"] / 2, d.get("confidence", 0)])
                    elif d["label"] == 1:
                        p.append([cx, bb["y"] + bb["height"]])
                ts = r["timestamp"]
                agg.setdefault(ts, [[], []])
                agg[ts][0] += b; agg[ts][1] += p
    # FUSION: merge precomputed adapted-YOLO ball candidates (precompute_yolo_ball.py) as extra
    # [u,v,conf] rows — the raw-panorama detector fills frames where label-0 is blind.
    yolo_json = os.environ.get("YOLO_BALL", f"/tmp/imitation/yolo_ball_{G8}.json")
    YCONF = float(os.environ.get("YOLO_CONF", "0.35"))
    FUSE = os.environ.get("FUSE_YOLO")   # "1"=pool | "gap"=gap-fill-only | "gapc"=gap-fill+temporal-consistency
    if FUSE in ("1", "gap", "gapc") and os.path.exists(yolo_json):
        ye = json.load(open(yolo_json))
        if FUSE == "gapc":
            # keep only cands with a neighbor cand within R pano in >=K of the 4 adjacent YOLO
            # frames — a real ball persists frame-to-frame, random FPs don't.
            R, K = 0.05, 2
            for i, e in enumerate(ye):
                kept = []
                for c in e["cands"]:
                    if c[2] < YCONF:
                        continue
                    support = 0
                    for j in (i - 2, i - 1, i + 1, i + 2):
                        if 0 <= j < len(ye) and any(abs(c[0] - o[0]) < R and abs(c[1] - o[1]) < R
                                                    for o in ye[j]["cands"]):
                            support += 1
                    if support >= K:
                        kept.append(c)
                e["cands"] = kept
        n_add = n_skip = 0
        for e in ye:
            cs = [c for c in e["cands"] if c[2] >= YCONF]
            if not cs:
                continue
            agg.setdefault(e["ts"], [[], []])
            if FUSE in ("gap", "gapc") and any(b[2] >= CONF for b in agg[e["ts"]][0]):
                n_skip += len(cs); continue        # label-0 already has a confident pick — don't pollute
            agg[e["ts"]][0] += cs; n_add += len(cs)
        print(f"fused {n_add} YOLO cands (conf>={YCONF}, mode={FUSE}, skipped {n_skip} on label-0 frames)")
    out = []
    for ts in sorted(agg):
        b = np.array(agg[ts][0], float).reshape(-1, 3); p = np.array(agg[ts][1], float).reshape(-1, 2)
        out.append((ts, b, p))
    return out


def track_centroid(frames):
    """Ungated per-frame conf-weighted centroid of present label-0 (>=CONF), with a light
    consistency gate vs the last estimate to drop lone far outliers. NaN where no label-0."""
    ts = np.array([f[0] for f in frames]); N = len(frames)
    xy = np.full((N, 2), np.nan); prev = None
    for i, (_, ball, person) in enumerate(frames):
        cand = ball[ball[:, 2] >= CONF] if len(ball) else ball
        if not len(cand):
            continue
        if prev is not None:                                   # soft gate: prefer boxes near prev
            d = np.linalg.norm(cand[:, :2] - prev, axis=1)
            keep = cand[d < OUTLIER] if (d < OUTLIER).any() else cand
        else:
            keep = cand
        w = keep[:, 2]; m = (keep[:, :2] * w[:, None]).sum(0) / w.sum()
        xy[i] = m; prev = m
    return ts, xy


GOAL_L, GOAL_R = 0.26, 0.73   # goal pano_x centers (from reg dwell)
GOAL_HW = 0.12                # goal-zone half width
BREAK_K = 4                   # consecutive far detections needed to break a hold
HOLD_MAX = 12                 # max frames to hold a goal before releasing (~2.4s) — caps leak
ARM_K = 3                     # consecutive goal-zone detections to ARM a hold (siege, not pass-through)


def track_goalhold(frames):
    """Centroid tracker + GOAL-HOLD: once the ball was last seen in a goal zone and detection
    is lost, HOLD the aim on that goal and REJECT re-acquisitions far from it (suppress the
    wrong-goal jump) until a sustained (BREAK_K) far ball proves the play has cleared out."""
    ts = np.array([f[0] for f in frames]); N = len(frames)
    xy = np.full((N, 2), np.nan); prev = None; hold = None; far_run = 0; far_pos = None; held = 0
    zrun = 0; zlast = None                                     # goal-zone persistence to arm a hold
    def zone(px):
        if abs(px - GOAL_L) < GOAL_HW: return GOAL_L
        if abs(px - GOAL_R) < GOAL_HW: return GOAL_R
        return None
    for i, (_, ball, person) in enumerate(frames):
        cand = ball[ball[:, 2] >= CONF] if len(ball) else ball
        meas = None
        if prev is not None and len(cand):
            d = np.linalg.norm(cand[:, :2] - prev, axis=1)
            keep = cand[d < OUTLIER] if (d < OUTLIER).any() else cand
            w = keep[:, 2]; meas = (keep[:, :2] * w[:, None]).sum(0) / w.sum()
        elif len(cand):
            w = cand[:, 2]; meas = (cand[:, :2] * w[:, None]).sum(0) / w.sum()
        if hold is not None and meas is not None and abs(meas[0] - hold) > GOAL_HW:
            # candidate far from the held goal — require a SUSTAINED far cluster to break hold
            far_run = far_run + 1 if (far_pos is not None and abs(meas[0] - far_pos[0]) < OUTLIER) else 1
            far_pos = meas.copy()
            if far_run >= BREAK_K or held >= HOLD_MAX:
                hold = None; far_run = 0; held = 0            # play cleared, or hold timed out
            else:
                xy[i] = [hold, prev[1] if prev is not None else 0.45]; held += 1; continue
        else:
            far_run = 0
        if meas is not None:
            xy[i] = meas; prev = meas
            z = zone(meas[0])
            zrun = zrun + 1 if (z is not None and z == zlast) else (1 if z is not None else 0)
            zlast = z
            if z is not None and zrun >= ARM_K and hold != z:    # arm only on a persistent siege
                hold = z; held = 0
        elif hold is not None and held < HOLD_MAX:
            xy[i] = [hold, prev[1] if prev is not None else 0.45]; held += 1   # bounded HOLD
        else:
            hold = None                                       # release; normal short hold via fill
            if prev is not None: xy[i] = prev
    return ts, xy


TELE = 0.33          # a jump this far from prev is a "teleport" — must persist to be accepted
TELE_K = 4           # frames a far cluster must persist before we accept the teleport


def track_antiteleport(frames):
    """Winning centroid tracker + teleport suppression: when the only detections are FAR from
    prev (would yank the aim across the pitch, e.g. a spurious label-0 at the other goal), HOLD
    prev and require the far cluster to persist TELE_K frames before committing. Targets the
    wrong-goal jump specifically; no goal-zone planting, so it doesn't leak on normal play."""
    ts = np.array([f[0] for f in frames]); N = len(frames)
    xy = np.full((N, 2), np.nan); prev = None; far_run = 0; far_pos = None; held = 0
    for i, (_, ball, person) in enumerate(frames):
        cand = ball[ball[:, 2] >= CONF] if len(ball) else ball
        if not len(cand):
            if prev is not None and held < HOLD_MAX: xy[i] = prev; held += 1
            continue
        near = cand[np.linalg.norm(cand[:, :2] - prev, axis=1) < OUTLIER] if prev is not None else cand
        if len(near):                                            # normal: ball where expected
            w = near[:, 2]; m = (near[:, :2] * w[:, None]).sum(0) / w.sum()
            xy[i] = m; prev = m; far_run = 0; held = 0; continue
        # only FAR detections exist
        w = cand[:, 2]; m = (cand[:, :2] * w[:, None]).sum(0) / w.sum()
        if prev is None or abs(m[0] - prev[0]) < TELE:           # small jump or no history: accept
            xy[i] = m; prev = m; far_run = 0; held = 0; continue
        far_run = far_run + 1 if (far_pos is not None and abs(m[0] - far_pos[0]) < OUTLIER) else 1
        far_pos = m.copy()
        if far_run >= TELE_K or held >= HOLD_MAX:                # far ball confirmed (or held out)
            xy[i] = m; prev = m; far_run = 0; held = 0
        else:
            xy[i] = prev; held += 1                              # suppress the teleport, hold
    return ts, xy


def track(frames):
    """greedy pano ball track; returns ts[], xy[](nan where unfilled)."""
    ts = np.array([f[0] for f in frames]); N = len(frames)
    xy = np.full((N, 2), np.nan); prev = None; miss = 0
    for i, (_, ball, person) in enumerate(frames):
        cand = ball[ball[:, 2] >= CONF] if len(ball) else ball
        meas = None
        if prev is not None and len(cand):
            d = np.linalg.norm(cand[:, :2] - prev, axis=1); ing = d < GATE
            if ing.any():
                c = cand[ing]; w = c[:, 2]
                meas = (c[:, :2] * w[:, None]).sum(0) / w.sum()
        if meas is None and prev is None and len(cand) and len(person):
            # init/reacquire: highest-conf ball near a person
            order = np.argsort(-cand[:, 2])
            for k in order:
                if np.linalg.norm(person - cand[k, :2], axis=1).min() < NEAR_PLAYER:
                    meas = cand[k, :2]; break
        if meas is not None:
            xy[i] = meas; prev = meas; miss = 0
        else:
            miss += 1
            if prev is not None and miss <= HOLD:
                xy[i] = prev                       # HOLD (no extrapolation)
            else:
                prev = None                        # give up -> allow re-acquire
    return ts, xy


def fill_smooth(ts, xy):
    x, y = xy[:, 0].copy(), xy[:, 1].copy()
    for a in (x, y):
        idx = np.where(~np.isnan(a))[0]
        if len(idx) == 0:
            continue
        a[:idx[0]] = a[idx[0]]; a[idx[-1] + 1:] = a[idx[-1]]        # edge hold
        nan = np.isnan(a); a[nan] = np.interp(np.where(nan)[0], np.where(~nan)[0], a[~nan])
    w = 15 if len(x) >= 15 else (len(x) // 2 * 2 - 1)
    if w >= 5:
        x = savgol_filter(x, w, 2); y = savgol_filter(y, w, 2)
    return x, y


def score(ts, bx, by):
    reg = json.load(open(f"/tmp/imitation/reg_{G8}.json"))
    rt_abs = RAWABS0 + np.array(reg["t"]) * 1e6; rpx = np.array(reg["pano_x"]); rpy = np.array(reg["pano_y"])
    gtp = np.array([ray_to_pantilt_uv(rpx[i], rpy[i]) for i in range(len(rpx))])
    bxi = np.interp(rt_abs, ts, bx); byi = np.interp(rt_abs, ts, by)
    ourp = np.array([ray_to_pantilt_uv(bxi[i], byi[i]) for i in range(len(bxi))])
    dpan = np.abs(ourp[:, 0] - gtp[:, 0]); c = np.corrcoef(ourp[:, 0], gtp[:, 0])[0, 1]
    cov = np.mean(~np.isnan(bx))
    print(f"{G8}: pan corr {c:+.2f}  |pan err| med {np.median(dpan):.1f} p90 {np.percentile(dpan,90):.1f}  "
          f"raw-track coverage {cov*100:.0f}%")
    print("  (baselines: viewport ROI centroid corr -0.10 / 25.3deg;  target corr>=0.65 med<=20)")
    return ourp, rt_abs


def main():
    frames = load_frames()
    ts, xy = {"centroid": track_centroid, "goalhold": track_goalhold,
              "antiteleport": track_antiteleport}.get(MODE, track)(frames)
    bx, by = fill_smooth(ts, xy)
    ourp, _ = score(ts, bx, by)
    if "--render" not in sys.argv:
        return
    # render: pan/tilt from smoothed ball; simple gentle fov
    tsec = (ts - RAWABS0) / 1e6
    pan = np.array([ray_to_pantilt_uv(bx[i], by[i])[0] for i in range(len(bx))])
    tilt = np.array([ray_to_pantilt_uv(bx[i], by[i])[1] for i in range(len(bx))])
    fov = np.full(len(bx), 34.0)
    capr = cv2.VideoCapture(RAW); capp = cv2.VideoCapture(PLAY); fps = capp.get(5) or 25
    n = int(capr.get(7))
    def lab(im, t, c):
        cv2.rectangle(im, (0, 0), (640, 24), (0, 0, 0), -1); cv2.putText(im, t, (7, 17), cv2.FONT_HERSHEY_SIMPLEX, 0.5, c, 1); return im
    vw = cv2.VideoWriter("/tmp/imitation/ball_follow.mp4", cv2.VideoWriter_fourcc(*"mp4v"), fps, (1280, 360))
    frames_out = []; i = 0
    while True:
        okr, rf = capr.read(); okp, pf = capp.read()
        if not okr or i >= n: break
        ct = i / fps
        pn = np.interp(ct, tsec, pan); tl = np.interp(ct, tsec, tilt); fv = np.interp(ct, tsec, fov)
        a = lab(MD.dewarp(rf, projs, np.radians(pn), np.radians(tl), fv, 640, 360), "PLAYHUB (ball-follow)", (120, 255, 120))
        b = lab(cv2.resize(pf, (640, 360)) if okp else np.zeros((360, 640, 3), np.uint8), "Spiideo AutoFollow", (210, 210, 210))
        fr = np.hstack([a, b]); vw.write(fr); i += 1
        if i in (int(n * 0.2), int(n * 0.4), int(n * 0.6), int(n * 0.8)): frames_out.append(fr.copy())
    capr.release(); capp.release(); vw.release()
    if frames_out: cv2.imwrite("/tmp/imitation/ball_follow_frames.png", np.vstack(frames_out))
    print(f"wrote ball_follow.mp4 ({i} frames) + frames.png")


if __name__ == "__main__":
    main()

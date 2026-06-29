"""
Ball detection using Forzasys soccer-specific YOLOv8m + Norfair Kalman tracker.
Single model detects both ball (class 1) and players (class 0).
Norfair tracks the ball through occlusion via Kalman velocity prediction.

Usage: python3 detect_ball.py <video.mp4> [--fps 5]

Outputs JSON to stdout:
  {
    "positions": [{"time": 0.0, "x": 850, "y": 400, "w": 15, "h": 15, "conf": 0.6, "source": "ball"}, ...],
    "scene_changes": [2.5, 8.3, ...],
    "all_candidates": []
  }

source field: "ball" = YOLO detection, "tracked" = Kalman prediction, "cluster" = player centroid
"""

import sys
import json
import os
import math
import cv2
import numpy as np
import supervision as sv
from ultralytics import YOLO
from norfair import Detection, Tracker
from norfair.filter import OptimizedKalmanFilterFactory

SCENE_CHANGE_THRESHOLD = 0.4
MAX_BALL_AREA = 3000
MIN_BALL_AREA = 20
SKY_CUTOFF_FRAC = 0.0   # discard ball candidates above this frame fraction. 0 = OFF.
                        # (was 0.15 — it deleted the AIRBORNE ball, which flies in the
                        #  top band, before the DP could select it. See engine-plan 2026-06-27.)

# Motion proposals: recover the airborne/blurred ball that appearance-based YOLO
# can't see (it's the one thing MOVING vs a near-static background). Double-frame
# differencing → small moving blobs → extra candidates the Viterbi DP can select.
MOTION_PROPOSALS = False    # DISABLED 2026-06-27: raw motion is high-recall/zero-precision —
                            # makes the airborne ball present (oracle 10%→100%) but every moving
                            # thing gets the same conf, so the DP picks slow distractors over the
                            # fast ball AND it regressed working clips (hero goal 86→61). Proved the
                            # thesis (airborne ball = motion-recoverable); the real fix is a LEARNED
                            # temporal detector (TOTNet/TrackNet). Code kept for gated/future use.
MOTION_DIFF_THRESH = 35     # per-pixel intensity delta (0-255) counted as motion
MOTION_CONF = 0.25          # modest — only wins where YOLO is absent; DP arbitrates
MOTION_MIN_AREA = 8         # blob PIXEL count (airborne ball is tiny/distant)
MOTION_MAX_AREA = 500       # blob PIXEL count (reject player/limb-sized motion)
MOTION_EXTENT_MIN = 0.5     # filled-px / bbox-area — ball is a compact disk; rejects sparse grass/speckle
MOTION_AR_MAX = 2.5         # max aspect ratio (symmetric); rejects elongated limb streaks
MOTION_MAX_PER_FRAME = 80   # cap (keep largest blobs) to bound DP cost on busy clips
BALL_CLUSTER_BOOST_DIST = 400
MIN_BALL_CONFIDENCE = 0.35         # Below this = likely false positive, ignore detection

# Class IDs — detected dynamically from model at runtime
CLASS_BALL = None  # Set in detect_ball() after loading model
CLASS_PLAYER = None

# Norfair tracker config
TRACKER_DISTANCE_THRESHOLD = 200   # Max pixels between prediction and detection to match
TRACKER_HIT_COUNTER_MAX = 50       # Survive 50 missed frames (~5s at 10fps) via Kalman prediction
TRACKER_INIT_DELAY = 2             # Confirm track after 2 detections (avoids false starts at higher fps)

# Kalman filter noise — tunable via --params
KALMAN_R = 4.0     # measurement noise — lower = trust detections more
KALMAN_Q = 0.8     # process noise — higher = allow faster direction changes
ADAPTIVE_KALMAN = False      # Auto-adjust R based on detection rate (disabled — helps some clips, hurts others)
ADAPTIVE_R_LOW = 1.0         # R value for low-detection clips (<40% ball frames)
ADAPTIVE_R_THRESHOLD = 0.40  # Detection rate below this triggers low R

# IQR outlier filter
IQR_MULTIPLIER = 2.0   # Higher = keep more "outlier" detections
IQR_MIN_SPREAD = 100   # Minimum IQR floor in pixels

# Bidirectional interpolation
BIDIR_MAX_GAP_TIME = 3.0     # seconds — max gap to interpolate across
BIDIR_MAX_GAP_DISTANCE = 300  # px — max distance to interpolate across
BIDIR_MIN_CONFIDENCE = 0.45   # both endpoints must have this confidence
BIDIR_KALMAN_RATIO = 0.5      # if >50% of gap is tracked, keep Kalman

# Early confidence gate
EARLY_CONF_GATE = 0.5   # Min confidence for first 5 detections

# Recenter-on-loss (Phase 1.1): when the ball is lost, hold the last known
# position briefly, then ease the crop back toward frame center so it doesn't
# stay pinned to an edge (e.g. the ball vanishing into the net after a goal).
# last_valid_pos is preserved untouched so re-acquisition is unaffected.
HOLD_GRACE_SEC = 1.0       # hold the last position this long before recentering
RECENTER_DUR_SEC = 2.0     # ease to frame center over this duration

# Post-goal hold (Phase 1.2): if the ball is lost right after a fast shot toward
# the goal it's nearest, hold on that spot (ball in the net + celebration) for a
# few seconds before the recenter above kicks in.
POSTGOAL_HOLD_SEC = 4.0    # hold on the goal location this long after a shot
# NOTE: px/s threshold is calibrated for the current ~1080p detection width; it
# scales with frame width, so re-tune (ideally express as a fraction of frame_w)
# if the pipeline input resolution changes.
POSTGOAL_SHOT_VEL = 350.0  # px/s — min ball speed toward goal to count as a shot
REAL_GAP_MAX_SEC = 0.2     # max gap between consecutive real frames to trust velocity


def recentered_hold_x(held_x, lost_dur, frame_w):
    """Held ball x eased toward frame center as the lost duration grows."""
    center = frame_w / 2.0
    if lost_dur <= HOLD_GRACE_SEC:
        return held_x
    u = min(1.0, (lost_dur - HOLD_GRACE_SEC) / max(1e-6, RECENTER_DUR_SEC))
    s = u * u * (3.0 - 2.0 * u)  # smoothstep ease
    return held_x + (center - held_x) * s


def maybe_goal_hold_until(last_valid_pos, last_real_vx, lost_start, frame_w):
    """Hold deadline if the ball was lost just after a fast shot toward the goal
    it's nearest; else None so the recenter ease applies.

    Predicate is "lost in the outer half while moving outward" — a conservative
    proxy for "heading into the nearest goal." A dead-center loss (x == frame_w/2)
    or a ball still in its own half won't trigger; that's intentional (only hold
    when the ball is lost near the goal it's attacking)."""
    if last_valid_pos is None or abs(last_real_vx) < POSTGOAL_SHOT_VEL:
        return None
    toward_right = last_real_vx > 0 and last_valid_pos["x"] > frame_w / 2
    toward_left = last_real_vx < 0 and last_valid_pos["x"] < frame_w / 2
    if toward_right or toward_left:
        return lost_start + POSTGOAL_HOLD_SEC
    return None


def hold_position_x(last_valid_pos, time_sec, lost_start, goal_hold_until, frame_w):
    """Held x: pure hold on the goal spot during a post-goal window, else ease
    toward frame center (Phase 1.1)."""
    if goal_hold_until is not None and time_sec < goal_hold_until:
        return last_valid_pos["x"]
    return recentered_hold_x(last_valid_pos["x"], time_sec - lost_start, frame_w)


def _extract_candidates(dets, frame_w, frame_h):
    """Apply pitch-geometry filters to sv.Detections → (ball_candidates, person_xs).

    Parses the full-frame YOLO pass via supervision. Coordinates are widened to
    float before any arithmetic so results are bit-identical to the prior
    tolist()-based loop.
    """
    ball_candidates = []
    person_xs = []
    person_ys = []
    for xyxy, conf, cls in zip(dets.xyxy, dets.confidence, dets.class_id):
        x1, y1, x2, y2 = (float(c) for c in xyxy)
        conf = float(conf)
        cls = int(cls)
        cx = (x1 + x2) / 2
        cy = (y1 + y2) / 2
        w = x2 - x1
        h = y2 - y1

        if cls == CLASS_PLAYER:
            if 200 < cy < 900:  # On the pitch
                person_xs.append(cx)
                person_ys.append(cy)

        elif cls == CLASS_BALL:
            area = w * h
            if not (MIN_BALL_AREA <= area <= MAX_BALL_AREA):
                continue
            if cy < frame_h * SKY_CUTOFF_FRAC:
                continue
            if cx <= 10 or cx >= frame_w - 10:
                continue  # Edge detection — likely false positive
            ball_candidates.append({"x": cx, "y": cy, "w": w, "h": h, "conf": conf})

    return ball_candidates, person_xs, person_ys


def run_sahi_fallback(model, frame, frame_h):
    """Run SAHI sliced inference when full-frame detection finds no ball.

    Uses 640x640 slices with 0.2 overlap to detect small balls that get
    lost when the full 1920x1080 frame is downscaled to 640x640.
    Only called on frames where standard detection fails.
    """
    from sahi.predict import get_sliced_prediction
    from sahi import AutoDetectionModel

    # Wrap YOLO model for SAHI (cached on first call)
    if not hasattr(run_sahi_fallback, "_sahi_model"):
        run_sahi_fallback._sahi_model = AutoDetectionModel.from_pretrained(
            model_type="yolov8",
            model=model,
            confidence_threshold=0.1,
        )

    # 640x640 matches YOLOv8 training resolution — per v5 analysis, 320x320
    # slices pushed ball-to-slice ratios below the model's confidence calibration
    # range. NMS params made explicit so cross-slice duplicate merging on seam
    # overlaps is visible in the diff, not dependent on SAHI defaults.
    result = get_sliced_prediction(
        image=frame,
        detection_model=run_sahi_fallback._sahi_model,
        slice_height=640,
        slice_width=640,
        overlap_height_ratio=0.2,
        overlap_width_ratio=0.2,
        postprocess_type="GREEDYNMM",
        postprocess_match_metric="IOS",
        postprocess_match_threshold=0.5,
        verbose=0,
    )

    candidates = []
    for pred in result.object_prediction_list:
        if pred.category.id != CLASS_BALL:
            continue
        bbox = pred.bbox
        cx = (bbox.minx + bbox.maxx) / 2
        cy = (bbox.miny + bbox.maxy) / 2
        w = bbox.maxx - bbox.minx
        h = bbox.maxy - bbox.miny
        area = w * h
        conf = pred.score.value
        frame_w = frame.shape[1]
        if MIN_BALL_AREA <= area <= MAX_BALL_AREA and cy >= frame_h * SKY_CUTOFF_FRAC and conf >= MIN_BALL_CONFIDENCE and 10 < cx < frame_w - 10:
            candidates.append({"x": cx, "y": cy, "w": w, "h": h, "conf": conf})

    return candidates


_MOTION_KERNEL = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))


def motion_candidates(gray2, gray1, gray0, frame_w, frame_h):
    """Double-difference ball proposals. A blob that moved CONSISTENTLY across 3
    consecutive frames (gray2→gray1→gray0) is localized at the middle frame
    (gray1) by AND-ing the two abs-diffs (removes ghost trails). This recovers
    the airborne/motion-blurred ball that appearance YOLO misses — against a
    near-static background, the moving ball is the signal even when its texture
    is invisible (white-on-white). Returns candidates in full-frame coords with a
    modest conf; the DP only selects them where they form a consistent arc, and
    its trajectory cost rejects off-arc motion noise (limbs, grass, shadows)."""
    g2 = cv2.GaussianBlur(gray2, (3, 3), 0)
    g1 = cv2.GaussianBlur(gray1, (3, 3), 0)
    g0 = cv2.GaussianBlur(gray0, (3, 3), 0)
    m = cv2.bitwise_and((cv2.absdiff(g1, g2) > MOTION_DIFF_THRESH).astype(np.uint8),
                        (cv2.absdiff(g0, g1) > MOTION_DIFF_THRESH).astype(np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, _MOTION_KERNEL)
    n, _, stats, centroids = cv2.connectedComponentsWithStats(m, connectivity=8)
    cands = []
    for i in range(1, n):
        w = int(stats[i, cv2.CC_STAT_WIDTH])
        h = int(stats[i, cv2.CC_STAT_HEIGHT])
        pix = int(stats[i, cv2.CC_STAT_AREA])
        if not (MOTION_MIN_AREA <= pix <= MOTION_MAX_AREA):
            continue
        if pix / max(w * h, 1) < MOTION_EXTENT_MIN:   # extent: ball is a compact disk
            continue
        ar = w / max(h, 1)
        if ar < 1.0 / MOTION_AR_MAX or ar > MOTION_AR_MAX:
            continue
        cx, cy = float(centroids[i][0]), float(centroids[i][1])
        if cx <= 10 or cx >= frame_w - 10 or cy < frame_h * SKY_CUTOFF_FRAC:
            continue
        cands.append({"x": cx, "y": cy, "w": float(w), "h": float(h),
                      "pix": pix, "conf": MOTION_CONF, "source": "motion"})
    if len(cands) > MOTION_MAX_PER_FRAME:
        cands.sort(key=lambda c: c["pix"], reverse=True)
        cands = cands[:MOTION_MAX_PER_FRAME]
    for c in cands:
        del c["pix"]
    return cands


def detect_ball(video_path: str, output_fps: float = 25.0) -> dict:
    """Detect ball using Forzasys YOLO + Norfair Kalman tracker.

    Two-phase approach:
    1. YOLO inference + candidate scoring (expensive, runs once)
    2. Norfair tracking (cheap, may re-run with adaptive R)
    """

    script_dir = os.path.dirname(os.path.abspath(__file__))
    # BALL_WEIGHTS env overrides the weights file (for benchmarking fine-tunes).
    weights = os.environ.get("BALL_WEIGHTS", "yolov8m_forzasys_soccer.pt")
    model_path = weights if os.path.isabs(weights) else os.path.join(script_dir, weights)

    if not os.path.exists(model_path):
        print(f"Error: model not found at {model_path}", file=sys.stderr)
        print("Download from: https://github.com/forzasys-students/SportsVision-YOLO", file=sys.stderr)
        sys.exit(1)

    model = YOLO(model_path)

    # Detect class IDs from model (handles both Forzasys and fine-tuned class orders)
    global CLASS_BALL, CLASS_PLAYER
    for idx, name in model.names.items():
        if name.lower() == "ball":
            CLASS_BALL = idx
        elif name.lower() == "player":
            CLASS_PLAYER = idx
    print(f"Model classes: ball={CLASS_BALL}, player={CLASS_PLAYER}", file=sys.stderr)

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"Error: Cannot open {video_path}", file=sys.stderr)
        sys.exit(1)

    video_fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    frame_interval = max(1, round(video_fps / output_fps))

    print(f"Video: {video_fps:.0f}fps, {total_frames} frames, sampling every {frame_interval} frames ({output_fps}fps)", file=sys.stderr)
    print(f"Model: Forzasys YOLOv8m + Norfair Kalman tracker", file=sys.stderr)

    # --- Phase 1: YOLO inference + candidate scoring (expensive, cached) ---
    per_frame_data = []  # List of {time_sec, best_ball, frame_w, frame_h}
    scene_changes = []
    all_cands = []  # raw YOLO ball candidates per frame (diagnostic: filter vs detector)
    prev_hist = None
    recent_ball_xs = []
    consecutive_misses = 0
    frame_idx = 0
    yolo_ball_count = 0
    prev_gray = None    # for motion proposals (double-difference 3-frame window)
    prev2_gray = None
    motion_count = 0

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        if frame_idx % frame_interval != 0:
            frame_idx += 1
            continue

        time_sec = frame_idx / video_fps

        # Skip black frames (Veo download artifact)
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        if gray.mean() < 15:
            frame_idx += 1
            continue

        # Scene change detection
        hist = cv2.calcHist([gray], [0], None, [64], [0, 256])
        cv2.normalize(hist, hist)
        if prev_hist is not None:
            correlation = cv2.compareHist(prev_hist, hist, cv2.HISTCMP_CORREL)
            if correlation < SCENE_CHANGE_THRESHOLD:
                scene_changes.append(round(time_sec, 3))
        prev_hist = hist

        # --- Motion proposals for the PREVIOUS frame (double-diff localizes the
        # moving ball at the middle of the 3-frame window). Attach to the last
        # appended entry (t-1); modest conf so the DP only takes them on a real arc.
        if MOTION_PROPOSALS and prev_gray is not None and prev2_gray is not None and per_frame_data:
            mcands = motion_candidates(prev2_gray, prev_gray, gray, frame.shape[1], frame.shape[0])
            if mcands:
                per_frame_data[-1]["candidates"].extend(mcands)
                motion_count += len(mcands)
                mt = round(per_frame_data[-1]["time_sec"], 3)
                for _m in mcands:
                    all_cands.append({"time": mt, "x": round(_m["x"]), "y": round(_m["y"]), "conf": _m["conf"], "source": "motion"})

        # Single inference for both ball and players
        result = model.predict(frame, conf=0.1, imgsz=1280, verbose=False)

        frame_h = frame.shape[0]
        frame_w = frame.shape[1]
        dets = sv.Detections.from_ultralytics(result[0])
        ball_candidates, person_xs, person_ys = _extract_candidates(dets, frame_w, frame_h)
        for _b in ball_candidates:  # diagnostic: capture every raw candidate pre-filter
            all_cands.append({"time": round(time_sec, 3), "x": round(_b["x"]), "y": round(_b["y"]), "conf": round(_b["conf"], 3)})

        # --- Conditional SAHI fallback ---
        if not ball_candidates:
            consecutive_misses += 1
            use_sahi = (time_sec < 5.0) or (consecutive_misses % 3 == 0)
            if use_sahi:
                sahi_candidates = run_sahi_fallback(model, frame, frame_h)
                if sahi_candidates:
                    ball_candidates = sahi_candidates
                    consecutive_misses = 0
        else:
            consecutive_misses = 0

        # Player cluster centroid (for the DP region prior — which match is ours)
        cluster_x = -1
        cluster_y = -1
        if len(person_xs) >= 3:
            cluster_x = sum(person_xs) / len(person_xs)
            cluster_y = sum(person_ys) / len(person_ys)

        # --- Select best candidate (Step-1 validation: anti-signal filters
        # removed — cluster-proximity boost, MIN_BALL_CONFIDENCE, early-conf gate,
        # and IQR-on-x all suppressed hard-mode true positives (the IQR literally
        # rejected the fast shot). Trajectory selection (Viterbi DP) replaces them
        # next. See engine-improvement-plan 2026-06-27). ---
        best_ball = max(ball_candidates, key=lambda b: b["conf"]) if ball_candidates else None

        if best_ball:
            recent_ball_xs.append(best_ball["x"])
            if len(recent_ball_xs) > 15:
                recent_ball_xs.pop(0)
            yolo_ball_count += 1

        per_frame_data.append({
            "time_sec": time_sec,
            "best_ball": best_ball,
            "candidates": list(ball_candidates),
            "cluster_x": cluster_x,
            "cluster_y": cluster_y,
            "frame_w": frame_w,
            "frame_h": frame_h,
        })

        total_so_far = len(per_frame_data)
        if total_so_far % 5 == 0 or total_so_far <= 5:
            print(f"\r  YOLO: {total_so_far} frames, {yolo_ball_count} ball detections ({100*yolo_ball_count/max(total_so_far,1):.0f}%)", end="", file=sys.stderr)

        prev2_gray = prev_gray
        prev_gray = gray
        frame_idx += 1

    cap.release()

    total_frames_sampled = len(per_frame_data)
    detection_rate = yolo_ball_count / max(total_frames_sampled, 1)
    print(f"\n  YOLO complete: {total_frames_sampled} frames, {yolo_ball_count} ball ({100*detection_rate:.0f}%)", file=sys.stderr)

    # --- Phase 2: Norfair tracking (cheap, uses cached YOLO results) ---
    # Adaptive Kalman R: if detection rate is low, trust detections more (lower R)
    kalman_r = KALMAN_R
    if ADAPTIVE_KALMAN and detection_rate < ADAPTIVE_R_THRESHOLD:
        kalman_r = ADAPTIVE_R_LOW
        print(f"  Adaptive Kalman: detection rate {100*detection_rate:.0f}% < {100*ADAPTIVE_R_THRESHOLD:.0f}% → R={kalman_r} (trust detections more)", file=sys.stderr)
    else:
        print(f"  Kalman R={kalman_r} (detection rate {100*detection_rate:.0f}%)", file=sys.stderr)

    per_frame_data = select_trajectory(per_frame_data)
    positions, stats = _run_tracking(per_frame_data, kalman_r)

    total = len(positions)
    print(f"Result: {total} frames — {stats['ball']} ball ({100*stats['ball']/max(total,1):.0f}%), "
          f"{stats['tracked']} tracked ({100*stats['tracked']/max(total,1):.0f}%), "
          f"{stats['hold']} hold ({100*stats['hold']/max(total,1):.0f}%), "
          f"{stats['cluster']} cluster ({100*stats['cluster']/max(total,1):.0f}%)",
          file=sys.stderr)

    # Post-processing
    positions = filter_false_locks(positions)
    positions = bidirectional_interpolate(positions)
    frame_w = per_frame_data[0]["frame_w"] if per_frame_data else 1920
    positions = ballistic_fill(positions, frame_w)

    frame_clusters = [{"time": round(fd["time_sec"], 3), "cx": fd.get("cluster_x", -1), "cy": fd.get("cluster_y", -1)} for fd in per_frame_data]
    return {"positions": positions, "scene_changes": scene_changes, "all_candidates": all_cands, "frame_clusters": frame_clusters}


# --- Trajectory selection (Viterbi DP over per-frame candidates) ----------------
DP_SIGMA = 60.0            # px tolerance on the constant-velocity prediction, per nominal frame
DP_OCCLUSION_COST = 3.0    # cost of routing through the miss/coast node (per frame)
DP_REGION_WEIGHT = 0.0     # soft penalty for candidates far OUTSIDE the play region (region prior)
DP_REGION_RADIUS = 700.0   # px — deadband: candidates within this of the player cluster pay nothing
DP_REGION_SCALE = 500.0    # px — distance beyond the radius at which the penalty = DP_REGION_WEIGHT
DP_REGION_CAP = 3.0        # max region penalty (a long clearance isn't punished into a miss)


def select_trajectory(per_frame_data: list) -> list:
    """Pick the globally most-consistent ball trajectory from the per-frame
    candidates via a Viterbi min-cost path (track-before-detect). State per frame
    = each ball candidate + a MISS node. The MISS node is a *coast* node: it
    carries the last REAL observation (position, velocity, time) so a short
    occlusion / airborne gap is bridged by the constant-velocity prediction
    instead of re-acquiring any candidate for free. Node cost = -log(conf) (+ a
    soft region penalty for candidates far outside the play region; miss = OCC).
    Transition cost = squared deviation from the predicted position, with the
    tolerance growing with the elapsed gap (so it is fps-robust and forgiving
    across occlusions). Writes the chosen candidate (or None) to each frame's
    "best_ball"."""
    n = len(per_frame_data)
    if n == 0:
        return per_frame_data

    # states[t] = candidate dicts followed by a MISS sentinel (None)
    states = [list(fd.get("candidates") or []) + [None] for fd in per_frame_data]
    clusters = [(fd.get("cluster_x", -1), fd.get("cluster_y", -1)) for fd in per_frame_data]
    times = [fd["time_sec"] for fd in per_frame_data]
    base_dt = max((times[-1] - times[0]) / (n - 1), 1e-3) if n > 1 else 0.04

    def node_cost(s, t):
        if s is None:
            return DP_OCCLUSION_COST
        c = -math.log(max(s["conf"], 1e-3))
        cx, cy = clusters[t]
        if DP_REGION_WEIGHT and cx >= 0:
            d = math.hypot(s["x"] - cx, s["y"] - cy)
            if d > DP_REGION_RADIUS:
                c += DP_REGION_WEIGHT * min((d - DP_REGION_RADIUS) / DP_REGION_SCALE, DP_REGION_CAP)
        return c

    INF = float("inf")
    # dp[t][j] = (cost, prev_i, vx, vy, lrx, lry, lrt)  — lr* = last REAL observation
    dp = [[(INF, -1, 0.0, 0.0, -1.0, -1.0, 0.0) for _ in st] for st in states]
    for j, s in enumerate(states[0]):
        lx, ly = (-1.0, -1.0) if s is None else (s["x"], s["y"])
        dp[0][j] = (node_cost(s, 0), -1, 0.0, 0.0, lx, ly, times[0])

    for t in range(1, n):
        tj = times[t]
        prev = dp[t - 1]
        for j, sj in enumerate(states[t]):
            ncj = node_cost(sj, t)
            best = (INF, -1, 0.0, 0.0, -1.0, -1.0, tj)
            for i in range(len(prev)):
                pc, _, vx, vy, lrx, lry, lrt = prev[i]
                if pc >= INF:
                    continue
                if sj is None:
                    # coast — carry the last real observation forward unchanged
                    cand = (pc + ncj, i, vx, vy, lrx, lry, lrt)
                elif lrx < 0:
                    cand = (pc + ncj, i, 0.0, 0.0, sj["x"], sj["y"], tj)  # first acquisition — free
                else:
                    elapsed = max(tj - lrt, 1e-3)
                    px, py = lrx + vx * elapsed, lry + vy * elapsed
                    sig = DP_SIGMA * (elapsed / base_dt)          # tolerance grows with the gap
                    trans = ((sj["x"] - px) ** 2 + (sj["y"] - py) ** 2) / (2.0 * sig * sig)
                    nvx, nvy = (sj["x"] - lrx) / elapsed, (sj["y"] - lry) / elapsed
                    cand = (pc + trans + ncj, i, nvx, nvy, sj["x"], sj["y"], tj)
                if cand[0] < best[0]:
                    best = cand
            dp[t][j] = best

    j = min(range(len(states[n - 1])), key=lambda k: dp[n - 1][k][0])
    chosen = [None] * n
    for t in range(n - 1, -1, -1):
        s = states[t][j]
        chosen[t] = None if s is None else s
        j = dp[t][j][1]
        if j < 0 and t > 0:
            print(f"  Trajectory DP: WARNING backtrack broke at t={t}", file=sys.stderr)
            break

    miss = sum(1 for c in chosen if c is None)
    for t in range(n):
        per_frame_data[t]["best_ball"] = chosen[t]
    print(f"  Trajectory DP: {n - miss}/{n} frames selected, {miss} miss", file=sys.stderr)
    return per_frame_data


def _run_tracking(per_frame_data: list, kalman_r: float) -> tuple:
    """Run Norfair Kalman tracking over cached YOLO results. Cheap — no video I/O."""

    tracker = Tracker(
        distance_function="euclidean",
        distance_threshold=TRACKER_DISTANCE_THRESHOLD,
        hit_counter_max=TRACKER_HIT_COUNTER_MAX,
        initialization_delay=TRACKER_INIT_DELAY,
        filter_factory=OptimizedKalmanFilterFactory(
            R=kalman_r,
            Q=KALMAN_Q,
        ),
    )

    positions = []
    stats = {"ball": 0, "tracked": 0, "cluster": 0, "hold": 0, "none": 0}
    last_valid_pos = None
    lost_start = None        # time the current lost-ball run began (for recenter easing)
    prev_real_x = None       # previous real (ball/tracked) x — for shot velocity
    prev_real_t = None
    last_real_vx = 0.0       # signed px/s of the most recent real ball motion
    goal_hold_until = None   # hold on the goal spot (no recenter) until this time

    for fd in per_frame_data:
        time_sec = fd["time_sec"]
        best_ball = fd["best_ball"]
        frame_w = fd["frame_w"]
        frame_h = fd["frame_h"]

        # Feed best ball detection to Norfair tracker
        norfair_dets = []
        if best_ball:
            norfair_dets.append(Detection(
                points=np.array([[best_ball["x"], best_ball["y"]]]),
                scores=np.array([best_ball["conf"]]),
            ))

        tracked_objects = tracker.update(detections=norfair_dets)

        # Determine output position
        if best_ball and tracked_objects:
            tx, ty = tracked_objects[0].estimate[0]
            if 0 <= tx <= frame_w:
                pos = {
                    "time": round(time_sec, 3),
                    "x": round(float(tx)),
                    "y": round(float(ty)),
                    "w": round(best_ball["w"]),
                    "h": round(best_ball["h"]),
                    "conf": round(best_ball["conf"], 3),
                    "source": "ball"
                }
            else:
                pos = {
                    "time": round(time_sec, 3),
                    "x": round(max(0, min(frame_w, best_ball["x"]))),
                    "y": round(best_ball["y"]),
                    "w": round(best_ball["w"]),
                    "h": round(best_ball["h"]),
                    "conf": round(best_ball["conf"], 3),
                    "source": "ball"
                }
            positions.append(pos)
            last_valid_pos = pos
            stats["ball"] += 1

        elif best_ball and not tracked_objects:
            if last_valid_pos and abs(best_ball["x"] - last_valid_pos["x"]) > 500:
                if lost_start is None:
                    lost_start = time_sec
                    goal_hold_until = maybe_goal_hold_until(last_valid_pos, last_real_vx, lost_start, frame_w)
                positions.append({
                    "time": round(time_sec, 3),
                    "x": round(hold_position_x(last_valid_pos, time_sec, lost_start, goal_hold_until, frame_w)),
                    "y": last_valid_pos["y"],
                    "w": 0, "h": 0,
                    "conf": 0.3,
                    "source": "cluster"
                })
                stats["hold"] += 1
            else:
                pos = {
                    "time": round(time_sec, 3),
                    "x": round(max(0, min(frame_w, best_ball["x"]))),
                    "y": round(best_ball["y"]),
                    "w": round(best_ball["w"]),
                    "h": round(best_ball["h"]),
                    "conf": round(best_ball["conf"], 3),
                    "source": "ball"
                }
                positions.append(pos)
                last_valid_pos = pos
                stats["ball"] += 1

        elif not best_ball and tracked_objects:
            tx, ty = tracked_objects[0].estimate[0]
            if 0 <= tx <= frame_w:
                pos = {
                    "time": round(time_sec, 3),
                    "x": round(float(tx)),
                    "y": round(float(ty)),
                    "w": 0, "h": 0,
                    "conf": 0.5,
                    "source": "tracked"
                }
                positions.append(pos)
                last_valid_pos = pos
                stats["tracked"] += 1
            elif last_valid_pos is not None:
                if lost_start is None:
                    lost_start = time_sec
                    goal_hold_until = maybe_goal_hold_until(last_valid_pos, last_real_vx, lost_start, frame_w)
                positions.append({
                    "time": round(time_sec, 3),
                    "x": round(hold_position_x(last_valid_pos, time_sec, lost_start, goal_hold_until, frame_w)),
                    "y": last_valid_pos["y"],
                    "w": 0, "h": 0,
                    "conf": 0.3,
                    "source": "cluster"
                })
                stats["hold"] += 1
            else:
                positions.append({
                    "time": round(time_sec, 3),
                    "x": -1, "y": -1,
                    "w": 0, "h": 0,
                    "conf": 0,
                    "source": "none"
                })
                stats["none"] += 1

        elif last_valid_pos is not None:
            if lost_start is None:
                lost_start = time_sec
                goal_hold_until = maybe_goal_hold_until(last_valid_pos, last_real_vx, lost_start, frame_w)
            positions.append({
                "time": round(time_sec, 3),
                "x": round(hold_position_x(last_valid_pos, time_sec, lost_start, goal_hold_until, frame_w)),
                "y": last_valid_pos["y"],
                "w": 0, "h": 0,
                "conf": 0.3,
                "source": "cluster"
            })
            stats["hold"] += 1

        else:
            positions.append({
                "time": round(time_sec, 3),
                "x": frame_w // 2,
                "y": frame_h // 2,
                "w": 0, "h": 0,
                "conf": 0.3,
                "source": "cluster"
            })
            stats["cluster"] += 1

        # Real-emit bookkeeping (single reset point for lost/goal state). Shot
        # velocity is only trusted across genuinely *consecutive* real frames: a
        # non-real frame breaks the run (resets prev_real) so the next
        # re-acquisition can't compute a bogus cross-gap velocity (review B1).
        p = positions[-1]
        if p["source"] in ("ball", "tracked"):
            if prev_real_t is not None and 0 < (p["time"] - prev_real_t) <= REAL_GAP_MAX_SEC:
                last_real_vx = (p["x"] - prev_real_x) / (p["time"] - prev_real_t)
            else:
                last_real_vx = 0.0
            prev_real_x, prev_real_t = p["x"], p["time"]
            lost_start = None
            goal_hold_until = None
        else:
            prev_real_x, prev_real_t = None, None  # break the velocity run on loss

    return positions, stats


def bidirectional_interpolate(positions: list) -> list:
    """Fill detection gaps using ease-in-out interpolation between ball detections.

    When the ball is lost (cluster/hold positions) but later re-acquired,
    replace the gap with smoothstep interpolation. Three guard rails based on
    industry research (SmartCrop ease-in-out, StrongSORT GSI, AutoFlip):

    1. Only interpolate PURE hold/cluster gaps — if Kalman tracker already
       produced reasonable 'tracked' positions, don't override them
    2. Use smoothstep (ease-in-out) instead of linear to avoid velocity
       discontinuities at gap boundaries that confuse downstream smoothing
    3. Conservative distance threshold to avoid interpolating across scene changes
    """
    if len(positions) < 3:
        return positions

    MAX_GAP_TIME = BIDIR_MAX_GAP_TIME
    MAX_GAP_DISTANCE = BIDIR_MAX_GAP_DISTANCE
    MIN_CONFIDENCE = BIDIR_MIN_CONFIDENCE
    KALMAN_RATIO_THRESHOLD = BIDIR_KALMAN_RATIO
    MIN_GAP_DIST_FOR_BLEND = 30   # px — don't override Kalman for near-static gaps

    result = list(positions)

    i = 0
    while i < len(result) - 1:
        if result[i]["source"] == "ball":
            # Look for next ball detection after any non-ball gap
            j = i + 1
            while j < len(result) and result[j]["source"] != "ball":
                j += 1

            gap_len = j - i - 1
            if gap_len > 0 and j < len(result):
                # Kalman is the sole authority for its output. If ANY frame
                # in this gap was filled by the tracker ("tracked" source),
                # the Kalman filter had momentum data — leave the gap alone.
                # Mixing bidirectional smoothstep with tracked frames yields a
                # hybrid trajectory worse than either on its own.
                tracked_count = sum(
                    1 for k in range(i + 1, j)
                    if result[k]["source"] == "tracked"
                )
                if tracked_count > 0:
                    i = j
                    continue

                # Pure cluster/hold gap — Kalman failed to span it. Use
                # bidirectional smoothstep if both anchor detections are
                # confident enough.
                gap_time = result[j]["time"] - result[i]["time"]
                gap_dist = abs(result[j]["x"] - result[i]["x"])
                both_confident = result[i]["conf"] >= MIN_CONFIDENCE and result[j]["conf"] >= MIN_CONFIDENCE

                if gap_time <= MAX_GAP_TIME and gap_dist <= MAX_GAP_DISTANCE and both_confident:
                    sx, sy = float(result[i]["x"]), float(result[i]["y"])
                    ex, ey = float(result[j]["x"]), float(result[j]["y"])

                    for k in range(i + 1, j):
                        t = (result[k]["time"] - result[i]["time"]) / gap_time
                        t_smooth = t * t * (3.0 - 2.0 * t)
                        conf = round(0.4 + 0.1 * min(t, 1 - t) * 4, 3)
                        result[k] = {
                            "time": result[k]["time"],
                            "x": round(sx + (ex - sx) * t_smooth),
                            "y": round(sy + (ey - sy) * t_smooth),
                            "w": 0, "h": 0,
                            "conf": conf,
                            "source": "tracked"
                        }

                    print(f"  Bidir interp: {gap_len} frames ({result[i]['time']:.1f}s → {result[j]['time']:.1f}s, Δ{gap_dist:.0f}px, pure cluster/hold gap)", file=sys.stderr)

                i = j
            else:
                i = j if j < len(result) else i + 1
        else:
            i += 1

    return result


def filter_false_locks(positions: list) -> list:
    """Detect and remove false lock-ons: big jump followed by static detections.

    Pattern: ball jumps >500px then stays within stddev<50px for >2 seconds.
    This indicates the detector locked onto a stationary false target (ball boy,
    logo, spare ball) rather than the real game ball. Replace the false lock
    period with hold at the pre-jump position.
    """
    if len(positions) < 20:
        return positions

    MIN_JUMP = 500       # px — minimum jump to consider
    MAX_STDDEV = 50      # px — static threshold
    MIN_STATIC_TIME = 2.0  # seconds — must be static for at least this long

    # Tracked positions downstream of a false lock are just Kalman absorbing
    # the bad measurement and extrapolating from it — they carry the same
    # false-lock signal as the ball detections themselves. Treat ball and
    # tracked as a single trajectory for this check.
    VALID_SOURCES = ("ball", "tracked")

    result = list(positions)
    i = 1
    while i < len(result):
        if (
            result[i]["source"] not in VALID_SOURCES
            or result[i - 1]["source"] not in VALID_SOURCES
        ):
            i += 1
            continue

        jump = abs(result[i]["x"] - result[i - 1]["x"])
        if jump < MIN_JUMP:
            i += 1
            continue

        # Found a big jump — check if post-jump positions stay static
        static_xs = [result[i]["x"]]
        static_end = i

        for j in range(i + 1, len(result)):
            if result[j]["source"] not in VALID_SOURCES:
                break
            static_xs.append(result[j]["x"])
            static_end = j

        if len(static_xs) < 5:
            i += 1
            continue

        static_duration = result[static_end]["time"] - result[i]["time"]
        if static_duration < MIN_STATIC_TIME:
            i += 1
            continue

        # Calculate stddev
        mean_x = sum(static_xs) / len(static_xs)
        variance = sum((x - mean_x) ** 2 for x in static_xs) / len(static_xs)
        stddev = variance ** 0.5

        if stddev < MAX_STDDEV:
            # False lock confirmed — revert to hold at pre-jump position
            hold_pos = result[i - 1]
            for j in range(i, static_end + 1):
                result[j] = {
                    "time": result[j]["time"],
                    "x": hold_pos["x"],
                    "y": hold_pos["y"],
                    "w": 0, "h": 0,
                    "conf": 0.3,
                    "source": "cluster"
                }
            i = static_end + 1
        else:
            i += 1

    return result


def ballistic_fill(positions: list, frame_w: int) -> list:
    """Fill detection gaps with ballistic trajectory when ball was fast."""
    if len(positions) < 5:
        return positions

    MIN_VELOCITY = 300     # px/s — only extrapolate if ball was this fast
    MAX_EXTRAP_TIME = 2.0  # seconds — don't extrapolate beyond this
    DECEL_FACTOR = 0.85    # Per-frame velocity decay (simulates friction/gravity)

    result = list(positions)

    # Find gap starts: transition from ball → non-ball
    i = 0
    while i < len(result) - 1:
        if result[i]["source"] == "ball" and result[i + 1]["source"] != "ball":
            # Found a gap start — check velocity from last 2-3 ball detections
            ball_run = []
            for j in range(max(0, i - 4), i + 1):
                if result[j]["source"] == "ball":
                    ball_run.append(result[j])

            if len(ball_run) >= 2:
                # Average velocity from last few ball detections
                vx_sum, vy_sum, count = 0.0, 0.0, 0
                for k in range(1, len(ball_run)):
                    dt = ball_run[k]["time"] - ball_run[k - 1]["time"]
                    if dt > 0:
                        vx_sum += (ball_run[k]["x"] - ball_run[k - 1]["x"]) / dt
                        vy_sum += (ball_run[k]["y"] - ball_run[k - 1]["y"]) / dt
                        count += 1

                if count > 0:
                    vx = vx_sum / count
                    vy = vy_sum / count
                    speed = (vx ** 2 + vy ** 2) ** 0.5

                    if speed >= MIN_VELOCITY:
                        # Extrapolate through the gap
                        last_ball = result[i]
                        cx, cy = float(last_ball["x"]), float(last_ball["y"])

                        for j in range(i + 1, len(result)):
                            if result[j]["source"] == "ball":
                                break  # Gap ended, ball re-acquired
                            dt = result[j]["time"] - last_ball["time"]
                            if dt > MAX_EXTRAP_TIME:
                                break  # Don't extrapolate too far

                            # Decelerate velocity each step
                            frames_elapsed = j - i
                            decay = DECEL_FACTOR ** frames_elapsed
                            ex = cx + vx * dt * decay
                            ey = cy + vy * dt * decay

                            # Clamp to frame
                            ex = max(0, min(frame_w, ex))

                            result[j] = {
                                "time": result[j]["time"],
                                "x": round(ex),
                                "y": round(ey),
                                "w": 0, "h": 0,
                                "conf": round(max(0.2, 0.5 * decay), 3),
                                "source": "tracked"
                            }
        i += 1

    return result


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 detect_ball.py <video.mp4> [--fps 5] [--params '{...}']", file=sys.stderr)
        sys.exit(1)

    video_path = sys.argv[1]
    fps = 25.0
    param_overrides = {}

    for i, arg in enumerate(sys.argv):
        if arg == "--fps" and i + 1 < len(sys.argv):
            fps = float(sys.argv[i + 1])
        elif arg == "--params" and i + 1 < len(sys.argv):
            param_overrides = json.loads(sys.argv[i + 1])

    # Apply parameter overrides
    if param_overrides:
        g = globals()
        for key, val in param_overrides.items():
            if key in g:
                g[key] = type(g[key])(val)
                print(f"  Override: {key} = {g[key]}", file=sys.stderr)

    result = detect_ball(video_path, fps)
    print(json.dumps(result))

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
import cv2
import numpy as np
from ultralytics import YOLO
from norfair import Detection, Tracker
from norfair.filter import OptimizedKalmanFilterFactory

SCENE_CHANGE_THRESHOLD = 0.4
MAX_BALL_AREA = 3000
MIN_BALL_AREA = 20
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

    result = get_sliced_prediction(
        image=frame,
        detection_model=run_sahi_fallback._sahi_model,
        slice_height=320,
        slice_width=320,
        overlap_height_ratio=0.2,
        overlap_width_ratio=0.2,
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
        if MIN_BALL_AREA <= area <= MAX_BALL_AREA and cy >= frame_h * 0.15 and conf >= MIN_BALL_CONFIDENCE and 10 < cx < frame_w - 10:
            candidates.append({"x": cx, "y": cy, "w": w, "h": h, "conf": conf})

    return candidates


def detect_ball(video_path: str, output_fps: float = 5.0) -> dict:
    """Detect ball using Forzasys YOLO + Norfair Kalman tracker.

    Two-phase approach:
    1. YOLO inference + candidate scoring (expensive, runs once)
    2. Norfair tracking (cheap, may re-run with adaptive R)
    """

    script_dir = os.path.dirname(os.path.abspath(__file__))
    model_path = os.path.join(script_dir, "yolov8m_forzasys_soccer.pt")

    if not os.path.exists(model_path):
        print(f"Error: Forzasys model not found at {model_path}", file=sys.stderr)
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
    prev_hist = None
    recent_ball_xs = []
    consecutive_misses = 0
    frame_idx = 0
    yolo_ball_count = 0

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

        # Single inference for both ball and players
        result = model.predict(frame, conf=0.1, imgsz=1280, verbose=False)

        frame_h = frame.shape[0]
        frame_w = frame.shape[1]
        ball_candidates = []
        person_xs = []

        for i in range(len(result[0].boxes)):
            cls = int(result[0].boxes.cls[i])
            conf = float(result[0].boxes.conf[i])
            x1, y1, x2, y2 = result[0].boxes.xyxy[i].tolist()
            cx = (x1 + x2) / 2
            cy = (y1 + y2) / 2
            w = x2 - x1
            h = y2 - y1

            if cls == CLASS_PLAYER:
                if 200 < cy < 900:  # On the pitch
                    person_xs.append(cx)

            elif cls == CLASS_BALL:
                area = w * h
                if MIN_BALL_AREA <= area <= MAX_BALL_AREA:
                    if cy < frame_h * 0.15:
                        continue
                    if cx <= 10 or cx >= frame_w - 10:
                        continue  # Edge detection — likely false positive
                    ball_candidates.append({
                        "x": cx, "y": cy, "w": w, "h": h, "conf": conf
                    })

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

        # Player cluster centroid (for ball scoring)
        cluster_x = -1
        if len(person_xs) >= 3:
            cluster_x = sum(person_xs) / len(person_xs)

        # --- Score ball candidates ---
        best_ball = None
        if ball_candidates:
            for b in ball_candidates:
                score = b["conf"]
                if cluster_x >= 0:
                    dist = abs(b["x"] - cluster_x)
                    if dist <= BALL_CLUSTER_BOOST_DIST:
                        proximity_bonus = 0.15 * (1.0 - dist / BALL_CLUSTER_BOOST_DIST)
                        score += proximity_bonus
                b["score"] = score

            valid = [b for b in ball_candidates if b["score"] > 0.2 and b["conf"] >= MIN_BALL_CONFIDENCE]
            if valid:
                best_ball = max(valid, key=lambda b: b["score"])

        # --- Early confidence gate ---
        if best_ball and len(recent_ball_xs) < 5 and best_ball["conf"] < EARLY_CONF_GATE:
            best_ball = None

        # --- IQR outlier filter ---
        if best_ball and len(recent_ball_xs) >= 5:
            sorted_xs = sorted(recent_ball_xs)
            q1 = sorted_xs[len(sorted_xs) // 4]
            q3 = sorted_xs[3 * len(sorted_xs) // 4]
            iqr = q3 - q1
            lower = q1 - IQR_MULTIPLIER * max(iqr, IQR_MIN_SPREAD)
            upper = q3 + IQR_MULTIPLIER * max(iqr, IQR_MIN_SPREAD)
            if best_ball["x"] < lower or best_ball["x"] > upper:
                best_ball = None

        if best_ball:
            recent_ball_xs.append(best_ball["x"])
            if len(recent_ball_xs) > 15:
                recent_ball_xs.pop(0)
            yolo_ball_count += 1

        per_frame_data.append({
            "time_sec": time_sec,
            "best_ball": best_ball,
            "frame_w": frame_w,
            "frame_h": frame_h,
        })

        total_so_far = len(per_frame_data)
        if total_so_far % 5 == 0 or total_so_far <= 5:
            print(f"\r  YOLO: {total_so_far} frames, {yolo_ball_count} ball detections ({100*yolo_ball_count/max(total_so_far,1):.0f}%)", end="", file=sys.stderr)

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

    return {"positions": positions, "scene_changes": scene_changes, "all_candidates": []}


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
                positions.append({
                    "time": round(time_sec, 3),
                    "x": last_valid_pos["x"],
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
                positions.append({
                    "time": round(time_sec, 3),
                    "x": last_valid_pos["x"],
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
            positions.append({
                "time": round(time_sec, 3),
                "x": last_valid_pos["x"],
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
                # Confidence-weighted blend: instead of binary skip, use ratio
                # of tracked frames to decide. High ratio = Kalman had good
                # momentum data, keep it. Low ratio = mostly hold/cluster,
                # bidirectional interpolation is better.
                tracked_count = sum(
                    1 for k in range(i + 1, j)
                    if result[k]["source"] == "tracked"
                )
                kalman_ratio = tracked_count / gap_len
                gap_dist_raw = abs(result[j]["x"] - result[i]["x"])

                # Skip if Kalman dominated this gap OR gap has no meaningful movement
                # (near-static gaps: Kalman and bidir produce ~same result, but
                # changing positions subtly alters downstream simplification)
                if kalman_ratio > KALMAN_RATIO_THRESHOLD or (tracked_count > 0 and gap_dist_raw < MIN_GAP_DIST_FOR_BLEND):
                    i = j
                    continue

                gap_time = result[j]["time"] - result[i]["time"]
                gap_dist = abs(result[j]["x"] - result[i]["x"])
                both_confident = result[i]["conf"] >= MIN_CONFIDENCE and result[j]["conf"] >= MIN_CONFIDENCE

                if gap_time <= MAX_GAP_TIME and gap_dist <= MAX_GAP_DISTANCE and both_confident:
                    sx, sy = float(result[i]["x"]), float(result[i]["y"])
                    ex, ey = float(result[j]["x"]), float(result[j]["y"])

                    for k in range(i + 1, j):
                        t = (result[k]["time"] - result[i]["time"]) / gap_time
                        # Smoothstep (ease-in-out): avoids abrupt velocity changes
                        # at gap boundaries. Used by Forzasys SmartCrop.
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

                    mode = "blend" if tracked_count > 0 else "pure"
                    print(f"  Bidir interp ({mode}): {gap_len} frames ({result[i]['time']:.1f}s → {result[j]['time']:.1f}s, Δ{gap_dist:.0f}px, kalman={kalman_ratio:.0%})", file=sys.stderr)

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

    result = list(positions)
    i = 1
    while i < len(result):
        if result[i]["source"] != "ball" or result[i - 1]["source"] != "ball":
            i += 1
            continue

        jump = abs(result[i]["x"] - result[i - 1]["x"])
        if jump < MIN_JUMP:
            i += 1
            continue

        # Found a big jump — check if post-jump detections are static
        static_xs = [result[i]["x"]]
        static_end = i

        for j in range(i + 1, len(result)):
            if result[j]["source"] != "ball":
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
    fps = 5.0
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

#!/usr/bin/env python3
"""Transition-hold post-pass (P1) — makes the offline crop path non-causal.

Replaces the causal hold->recenter fallback. Over the full positions[], each maximal
run of NON-(confident-ball) frames between two confident 'ball' anchors is re-filled:
  - BRIDGE (smoothstep ease last->next) if the next anchor is physically reachable
    (implied pan <= MAX_PAN_PX_S and gap <= GAP_MAX_S); marks frame['bridged']=True.
  - else HOLD the last anchor x (NO recenter to frame-center) with a velocity-capped
    LEAD-IN ease onto the next anchor (kills the hold->distant-anchor whip; safe because
    the crop lands on the real next anchor at that frame regardless).
Confident anchor = source=='ball' AND conf >= ANCHOR_CONF. Low-conf 'ball' spikes are
re-filled like gaps (discards the false net-side detections). Ball anchors are never
modified. Output source labels stay in the existing vocab (bridge->'tracked', hold->'cluster').

Guards (from CV review): no-ops on non-monotonic time, and on too-sparse clips (would
only add whip, can't help) — so a reject clip is never made worse than the causal path.
"""
import math

MAX_PAN_PX_S = 450.0   # implied |Δx|/gap above this = not the same ball, don't bridge (also caps lead-in)
GAP_MAX_S = 2.5        # bridge (straight-line ease) is only valid for SHORT occlusions. Beyond this a
                       # stationary-then-moving ball makes a linear bridge drift into empty space too
                       # early (eyes-on: 0.65 secs 7-13) — so longer gaps HOLD last-x + lead-in instead.
                       # 2.5s matches the tracklet-stitcher ceiling (same "how long can you interpolate
                       # a ball gap" question). The 0.65 goal still holds ON the net (342≈366, 24px).
ANCHOR_CONF = 0.55     # trust floor: false spikes cluster <=0.51, real re-acquisitions >=0.56 on this
                       # ladder. NOTE (P2): a fixed global scalar is distribution-shift-fragile — replace
                       # with temporal-spatial anchor support before running on new venues.
MIN_ANCHOR_FRAC = 0.02 # below this confident-ball coverage the pass no-ops (reject clips: don't degrade)
# Spine / anchor-trust (MOTION-AWARE temporal support): a confident 'ball' frame is a TRUSTED anchor
# only if >=SUPPORT_MIN other confident 'ball' frames within +/-SUPPORT_WIN_S corroborate it — where a
# neighbour corroborates iff it is REACHABLE at plausible ball speed (|Δx| <= MAX_BALL_PX_S·|Δt| + BASE_R).
# Motion-aware, NOT a fixed radius, so a fast SHOT (0.65: net anchors moving >200px between frames) is
# kept while a lone confident SPIKE amid low-conf noise (0.20: x=119 conf .60, ZERO confident neighbours)
# is rejected — so the crop holds toward the real high-conf spine instead of chasing an early wrong ball.
SUPPORT_WIN_S = 1.0
MAX_BALL_PX_S = 1500.0   # a hard shot in the 1920px master can move this fast; generous on purpose
BASE_R = 60.0            # jitter tolerance for near-simultaneous confident detections
SUPPORT_MIN = 2          # a wrong PAIR can't self-validate (each sees only 1) -> min viable spine = 3
# DISTRIBUTION-SHIFT CAVEAT (P2): ANCHOR_CONF (0.55), MAX_BALL_PX_S, SUPPORT_WIN_S, SUPPORT_MIN are
# tuned/validated on this CFA ladder (n small). Re-validate before running on a NEW venue — different
# lighting/pitch shifts the conf distribution and the plausible ball speed. min_support=2 is principled
# (the exact minimum a wrong pair can't defeat); the others are defensible round numbers, not proven.


def trusted_anchor_mask(positions, anchor_conf=ANCHOR_CONF, win_s=SUPPORT_WIN_S,
                        max_ball_px_s=MAX_BALL_PX_S, base_r=BASE_R, min_support=SUPPORT_MIN):
    """Bool per frame: source=='ball' AND conf>=anchor_conf AND supported by >=min_support other
    confident-ball frames that are motion-reachable within +/-win_s (the 'spine'). Lone spikes -> False.

    PRECONDITION: `positions` is sorted by non-decreasing `time` (the two-pointer relies on it).
    bridge_and_hold guards this before calling; a standalone caller MUST ensure it or support is wrong.
    DELIBERATE MISS: a temporally-isolated single TRUE confident detection (min viable spine = 3 frames
    within ~1s) is dropped — the bet is that a lone confident frame amid noise is more often a wrong ball
    than the only clear frame of a fast break; it degrades to a hold/bridge, never a corruption."""
    n = len(positions)
    conf_ball = [i for i in range(n)
                 if positions[i].get("source") == "ball" and positions[i].get("conf", 0.0) >= anchor_conf]
    mask = [False] * n
    lo = 0; hi = 0
    for i in conf_ball:
        ti = positions[i]["time"]; xi = positions[i]["x"]
        while lo < len(conf_ball) and positions[conf_ball[lo]]["time"] < ti - win_s:
            lo += 1
        while hi < len(conf_ball) and positions[conf_ball[hi]]["time"] <= ti + win_s:
            hi += 1
        support = 0
        for j in range(lo, hi):
            k = conf_ball[j]
            if k == i:
                continue
            dt = abs(positions[k]["time"] - ti)
            if abs(positions[k]["x"] - xi) <= max_ball_px_s * dt + base_r:
                support += 1
        mask[i] = support >= min_support
    return mask


def _smoothstep(u):
    u = 0.0 if u < 0 else (1.0 if u > 1 else u)
    return u * u * (3.0 - 2.0 * u)


def _median(xs):
    s = sorted(xs); m = len(s)
    if m == 0:
        return float("inf")
    return s[m // 2] if m % 2 else 0.5 * (s[m // 2 - 1] + s[m // 2])


def bridge_and_hold(positions, max_pan_px_s=MAX_PAN_PX_S, gap_max_s=GAP_MAX_S,
                    anchor_conf=ANCHOR_CONF, min_anchor_frac=MIN_ANCHOR_FRAC):
    """Return a NEW positions list with non-(confident-ball) runs re-filled. Pure; input untouched."""
    n = len(positions)
    out = [dict(p) for p in positions]
    if n == 0:
        return out
    # Guard 1: time must be strictly non-decreasing (bridge math assumes it). No-op if not.
    for i in range(1, n):
        if positions[i]["time"] < positions[i - 1]["time"]:
            return out

    # trusted anchors = confident ball WITH temporal-spatial support (spine); lone spikes rejected.
    is_ball = trusted_anchor_mask(positions, anchor_conf)
    ball_idx = [i for i in range(n) if is_ball[i]]
    if not ball_idx:
        return out

    # Guard 2: too-sparse clips — the pass can only add hold->anchor whip, so no-op.
    frac = len(ball_idx) / n
    med_gap = _median([positions[ball_idx[k]]["time"] - positions[ball_idx[k - 1]]["time"]
                       for k in range(1, len(ball_idx))]) if len(ball_idx) > 1 else float("inf")
    if frac < min_anchor_frac or med_gap > gap_max_s:
        return out

    i = 0
    while i < n:
        if is_ball[i]:
            i += 1
            continue
        start = i
        while i < n and not is_ball[i]:
            i += 1
        end = i - 1
        prev = start - 1 if start - 1 >= 0 and is_ball[start - 1] else None
        nxt = i if i < n and is_ball[i] else None

        if prev is not None and nxt is not None:
            A, B = out[prev], out[nxt]
            gap = B["time"] - A["time"]
            speed = abs(B["x"] - A["x"]) / gap if gap > 1e-6 else float("inf")
            if gap <= gap_max_s and speed <= max_pan_px_s:
                for k in range(start, end + 1):
                    u = (out[k]["time"] - A["time"]) / gap if gap > 1e-6 else 1.0
                    _set_eased(out[k], A, B, _smoothstep(u), bridged=True)
                continue
            # unreachable. Too-LONG gap (reachable speed): hold A + short capped lead-in onto B.
            # Too-FAST gap (speed > max_pan): B moved implausibly fast => likely a false anchor;
            # flat-hold A and take the 1-frame jump, don't ease toward a probable false spot.
            if speed <= max_pan_px_s:
                _hold_with_leadin(out, start, end, A, B, max_pan_px_s)
            else:
                _hold_flat(out, start, end, A)
        elif prev is not None:
            _hold_flat(out, start, end, out[prev])                  # clip-end loss: flat hold last anchor
        elif nxt is not None:
            _hold_flat(out, start, end, out[nxt])                   # clip-start loss: flat hold first anchor
        # else: no anchors bounding this run — leave as-is
    return out


def _set_eased(frame, A, B, s, bridged):
    frame["x"] = round(A["x"] + (B["x"] - A["x"]) * s)
    frame["y"] = round(A["y"] + (B["y"] - A["y"]) * s)
    frame["source"] = "tracked" if bridged else "cluster"
    frame["conf"] = 0.5 if bridged else 0.3
    if bridged:
        frame["bridged"] = True
    else:
        frame.pop("bridged", None)


def _hold_flat(out, start, end, anchor):
    for k in range(start, end + 1):
        out[k]["x"] = anchor["x"]; out[k]["y"] = anchor["y"]
        out[k]["source"] = "cluster"; out[k]["conf"] = 0.3
        out[k].pop("bridged", None)


def _hold_with_leadin(out, start, end, A, B, max_pan_px_s):
    """Flat-hold A.x, then ease A.x->B.x over the last `lead` frames so the step onto the
    real anchor B is <= max_pan_px_s per frame. Safe: the crop lands on B.x at frame end+1
    regardless, so easing the approach never adds a wrong-location frame."""
    run_len = end - start + 1
    dt = (out[end]["time"] - out[start]["time"]) / max(run_len - 1, 1)
    step_px = max(max_pan_px_s * dt, 1e-6)
    lead = min(run_len, math.ceil(abs(B["x"] - A["x"]) / step_px))
    ramp_start = end - lead + 1
    for k in range(start, end + 1):
        if k >= ramp_start and lead > 0:
            frac = (k - ramp_start + 1) / lead   # -> 1.0 at k==end so it meets B.x
            out[k]["x"] = round(A["x"] + (B["x"] - A["x"]) * frac)
            out[k]["y"] = round(A["y"] + (B["y"] - A["y"]) * frac)
        else:
            out[k]["x"] = A["x"]; out[k]["y"] = A["y"]
        out[k]["source"] = "cluster"; out[k]["conf"] = 0.3
        out[k].pop("bridged", None)

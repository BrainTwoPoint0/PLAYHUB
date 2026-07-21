"""Player-only kinematic features for the STOPPAGE model (ball-dead/in-play).

Spiideo-conditions discipline (the whole point of this spike):
  - NO ball (role 6 never read)
  - NO Veo speedKmh column (col 6) -- speeds come from position deltas
  - NO jersey (col 4)
  - NO GK-vs-outfield distinction (Spiideo has no roles; role-free-12 lesson)
  - Team side IS allowed as "two kit clusters" (proven derivable on Spiideo via
    kit-colour, pilot v2). We use Veo roles {0,1} vs {2,3} purely as the two-team
    partition, side-agnostic (features symmetric under L/R swap).

Per-frame base channels are assembled into multi-scale temporal context vectors
(trailing/leading window means + deltas) -- offline batch, non-causal is fine.
Labels and evaluation live in stoppage_model.py.
"""
from __future__ import annotations

import numpy as np

TEAM_A_ROLES = (0, 1)
TEAM_B_ROLES = (2, 3)
PLAYER_ROLES = (0, 1, 2, 3)

# per-frame base channels, in order.
#
# DOMAIN-ALIGNMENT (measured on the first Nazwa transfer attempt, 2026-07-21):
# raw 1-frame metric speeds do NOT transfer -- Spiideo artifact tracks are
# Kalman-smoothed 5 Hz (0.2s displacements crushed ~3x vs Veo 2.5 Hz), and
# fragment churn (16s-median chains) jerks a naive centroid. Therefore:
#   - speeds use a ~1s displacement BASELINE (smoothing/rate robust),
#   - centroid speed uses the MATCHED player subset only,
#   - motion channels are RELATIVE to the match's own median play speed v0
#     (dead = slowdown relative to THIS match's play; also format-invariant),
#   - spreads are pitch-fraction; taker distances stay metric (physical).
CHANNELS = [
    "n",              # players tracked
    "med_speed_r",    # median matched-player 1s-baseline speed / v0
    "p75_speed_r",
    "max_speed_r",
    "frac_slow",      # fraction of matched players below 0.5*v0
    "centroid_speed_r",
    "spread_xf", "spread_yf",  # pitch-fraction spreads
    "dist_center",    # nearest player to the centre spot (m)
    "min_dtl",        # nearest player to a touchline (m)  (throw-in taker)
    "min_dgl",        # nearest player to a goal-line (m)  (goal-kick/corner taker)
    "half_sep",       # side-agnostic two-team half separation (kickoff reset)
    "team_dxf",       # |centroid_x(A) - centroid_x(B)| / L
    "pitch_len", "pitch_w",   # static format context (m)
    "v0",             # the match's median play speed (m/s) -- activity scale
]
# Channels computable on Spiideo tracklets WITHOUT per-frame team assignment
# (kit-team is per-instant YOLO -- too heavy at 5 Hz). The transfer model
# trains on this subset only.
SPIIDEO_SAFE = [c for c in CHANNELS if c not in ("half_sep", "team_dxf")]
SPEED_BASE_S = 1.0      # displacement baseline for speeds
SPEED_BASE_TOL = 0.45   # accept a reference frame within +/- this of the baseline
MAX_PAIR_DT = 1.6       # keep candidate reference frames this far back
V0_FLOOR = 0.2          # m/s


DEFAULT_DIMS = (68.0, 46.0)   # fallback when the match schema lacks dims


def frame_channels(m):
    """Return (ts, X) with X[i] = base channel vector at frame ts[i].

    Two passes: pass 1 computes per-frame raw speed arrays (1s-baseline,
    matched-subset centroid) + geometry; pass 2 sets v0 = the match's median
    play speed and emits relative motion channels. Frames with <6 players
    yield NaN rows (masked later).
    """
    L = m.length_m or DEFAULT_DIMS[0]
    W = m.width_m or DEFAULT_DIMS[1]
    ft = m.frame_times
    hist = []               # (t, {id: (x, y)}) within MAX_PAIR_DT
    raw = []                # per-frame dicts
    for t in ft:
        players = [r for r in m.frames[t] if r[1] in PLAYER_ROLES]
        cur = {r[0]: (r[2] * L, r[3] * W) for r in players}
        hist.append((t, cur))
        while hist and t - hist[0][0] > MAX_PAIR_DT:
            hist.pop(0)
        n = len(players)
        if n < 6:
            raw.append(None)
            continue
        xs = np.array([x for x, _ in cur.values()])
        ys = np.array([y for _, y in cur.values()])
        # reference frame nearest t-SPEED_BASE_S
        ref = None
        best = SPEED_BASE_TOL
        for ht, hcur in hist[:-1]:
            d = abs((t - ht) - SPEED_BASE_S)
            if d <= best:
                best, ref = d, (ht, hcur)
        sp = np.array([])
        cent_sp = np.nan
        if ref is not None:
            ht, hcur = ref
            dt = t - ht
            common = [i for i in cur if i in hcur]
            if len(common) >= 4:
                sp = np.array([np.hypot(cur[i][0] - hcur[i][0],
                                        cur[i][1] - hcur[i][1]) / dt
                               for i in common])
                cx0 = np.mean([hcur[i][0] for i in common])
                cy0 = np.mean([hcur[i][1] for i in common])
                cx1 = np.mean([cur[i][0] for i in common])
                cy1 = np.mean([cur[i][1] for i in common])
                cent_sp = float(np.hypot(cx1 - cx0, cy1 - cy0) / dt)
        ax = np.array([r[2] * L for r in players if r[1] in TEAM_A_ROLES])
        bx = np.array([r[2] * L for r in players if r[1] in TEAM_B_ROLES])
        if len(ax) >= 3 and len(bx) >= 3:
            fa = float((ax < L / 2).mean())
            fb = float((bx < L / 2).mean())
            half_sep = (max(fa, 1 - fa) + max(fb, 1 - fb)) / 2.0
            team_dxf = abs(float(ax.mean()) - float(bx.mean())) / L
        else:
            half_sep = team_dxf = np.nan
        raw.append(dict(
            n=n, sp=sp, cent_sp=cent_sp,
            spread_xf=float(xs.std()) / L, spread_yf=float(ys.std()) / W,
            dist_center=float(np.min(np.hypot(xs - L / 2, ys - W / 2))),
            min_dtl=float(np.min(np.minimum(ys, W - ys))),
            min_dgl=float(np.min(np.minimum(xs, L - xs))),
            half_sep=half_sep, team_dxf=team_dxf))
    # pass 2: v0 = median of per-frame median speeds (the match's play pace)
    meds = [float(np.median(r["sp"])) for r in raw
            if r is not None and len(r["sp"]) >= 4]
    v0 = max(float(np.median(meds)) if meds else V0_FLOOR, V0_FLOOR)
    ts, rows = [], []
    for t, r in zip(ft, raw):
        ts.append(t)
        if r is None:
            rows.append([np.nan] * len(CHANNELS))
            continue
        if len(r["sp"]) >= 4:
            sp = r["sp"]
            med_r = float(np.median(sp)) / v0
            p75_r = float(np.percentile(sp, 75)) / v0
            max_r = float(sp.max()) / v0
            frac_slow = float((sp < 0.5 * v0).mean())
        else:
            med_r = p75_r = max_r = frac_slow = np.nan
        cent_r = r["cent_sp"] / v0 if np.isfinite(r["cent_sp"]) else np.nan
        rows.append([r["n"], med_r, p75_r, max_r, frac_slow, cent_r,
                     r["spread_xf"], r["spread_yf"], r["dist_center"],
                     r["min_dtl"], r["min_dgl"], r["half_sep"], r["team_dxf"],
                     L, W, v0])
    return np.array(ts), np.array(rows, dtype=float)


def _win_mean(v, half, side):
    """NaN-tolerant trailing (-1) / leading (+1) rolling mean over `half` frames."""
    n = len(v)
    ok = np.isfinite(v)
    cs = np.concatenate([[0.0], np.cumsum(np.where(ok, v, 0.0))])
    cn = np.concatenate([[0.0], np.cumsum(ok.astype(float))])
    i = np.arange(n)
    if side < 0:
        lo, hi = np.maximum(0, i - half), i + 1
    else:
        lo, hi = i, np.minimum(n, i + half + 1)
    s, c = cs[hi] - cs[lo], cn[hi] - cn[lo]
    return np.where(c > 0, s / np.maximum(c, 1), np.nan)


# context windows in SECONDS (converted to frames at the match cadence)
CONTEXT_WINDOWS_S = (4.0, 12.0)


def context_matrix(ts, X):
    """Per-frame classifier input: for each channel -> [now, trail/lead mean at
    each window, lead-trail delta at the short window]. Shape (n, C*(2W+2))."""
    if len(ts) < 5:
        return np.zeros((len(ts), 0))
    step = float(np.median(np.diff(ts))) or 0.4
    blocks = [X]
    for w in CONTEXT_WINDOWS_S:
        half = max(1, int(round(w / step)))
        trail = np.column_stack([_win_mean(X[:, c], half, -1) for c in range(X.shape[1])])
        lead = np.column_stack([_win_mean(X[:, c], half, +1) for c in range(X.shape[1])])
        blocks += [trail, lead]
        if w == CONTEXT_WINDOWS_S[0]:
            blocks.append(lead - trail)
    return np.column_stack(blocks)


def feature_names():
    names = list(CHANNELS)
    for w in CONTEXT_WINDOWS_S:
        names += [f"{c}_tr{w:g}" for c in CHANNELS]
        names += [f"{c}_ld{w:g}" for c in CHANNELS]
        if w == CONTEXT_WINDOWS_S[0]:
            names += [f"{c}_d{w:g}" for c in CHANNELS]
    return names

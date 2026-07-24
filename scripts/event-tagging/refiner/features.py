"""Team-free refiner features — SHARED between the Veo dataset builder and
the Spiideo stamp evaluator (one implementation, two callers; producer/
consumer drift is this workstream's documented bug class).

Inputs are the frozen chain's own artifacts only: the 1s grid series (pko,
dctx, ev), the frame-time channels (ts, med=med_speed_r, nch=n), the
envelope (env0, env1), production detect() episodes (ts/ps/sub_anchors/
sub_anchor_pko + p_period on survivors), med-based dead spells
(period_gap activity_dead_spells), and an optional geom12_at(t) callback
returning the rolefree12 geometry vector (NaN-safe).

BANNED by protocol (team-free arm): half_sep / hs_grid, roles, kit, any
team channel.
"""
from __future__ import annotations

import numpy as np

GEOM12_KEYS = [  # restart FEATURE_KEYS minus the GK (role) features
    "n", "min_dtl", "min_dgl", "corner_dgl", "corner_dtl", "tl_gl",
    "frac_left", "cx", "cy", "spread_x", "spread_y", "dist_center",
]

GAP_CAP_S = 600.0
DEAD_THR = 0.5              # dctx dead/live midpoint (chain SPLIT_LIVE_THR)
ONSET_BACK_S = 120.0


def _wmean(ts, x, a, b):
    lo, hi = np.searchsorted(ts, a), np.searchsorted(ts, b, side="right")
    if hi <= lo:
        return np.nan
    w = x[lo:hi]
    return float(np.nanmean(w)) if np.isfinite(w).any() else np.nan


def _gidx(grid, t):
    return int(np.clip(round(t - grid[0]), 0, len(grid) - 1))


def _gval(grid, arr, t):
    v = arr[_gidx(grid, t)]
    return float(v) if np.isfinite(v) else np.nan


def dead_run_start(grid, dctx, s):
    """Start time of the contiguous dctx>=DEAD_THR run ending at s (NaN
    counts as dead-continuation, mirroring _sub_anchors' 'NaN is not live
    evidence'). If dctx at s reads live, walks back to the nearest dead
    point first. Returns np.nan if no dead point within ONSET_BACK_S."""
    i = _gidx(grid, s)
    lo = _gidx(grid, s - ONSET_BACK_S)
    while i > lo and not (np.isfinite(dctx[i]) and dctx[i] >= DEAD_THR):
        i -= 1
    if not (np.isfinite(dctx[i]) and dctx[i] >= DEAD_THR):
        return np.nan
    while i > lo:
        v = dctx[i - 1]
        if np.isfinite(v) and v < DEAD_THR:
            break
        i -= 1
    return float(grid[i])


def _trailing_spell(spells, t, back=60.0, fwd=0.0):
    """Latest med-dead spell (a, b) with b in [t-back, t+fwd]."""
    best = None
    for a, b in spells:
        if t - back <= b <= t + fwd and (best is None or b > best[1]):
            best = (a, b)
    return best


def _q(sorted_vals, v):
    """Percentile of v within the match's finite dctx distribution — the
    transfer-safe form (the stoppage model's absolute calibration is known
    NOT to transfer to Spiideo small-sided; its within-match ranking does)."""
    if not np.isfinite(v) or not len(sorted_vals):
        return np.nan
    return float(np.searchsorted(sorted_vals, v) / len(sorted_vals))


EP_KEYS = (
    ["span", "n_peaks", "n_cycles", "pko_max", "pko_anchor",
     "cyc_pko_mean", "cyc_pko_max", "ev_max", "p_period",
     "dctx_mean_ep", "dctx_max_ep", "dctx_frac_high", "dctx_post",
     "dctx_pre",
     "spell_dur", "spell_gap", "spell_max_dur",
     "med_pre", "med_in", "med_med",
     "n_in_ratio",
     "pos_frac", "t_from_env0", "t_to_env1",
     "gap_prev", "gap_next", "neighbors_120",
     "intercycle_max", "intercycle_mean",
     "dctx_mean_ep_q", "dctx_post_q", "dctx_pre_q", "ev_max_q"]
    + [f"g_{k}" for k in GEOM12_KEYS]
)

# absolute stoppage-calibration features — the NORM-ONLY variant drops these
EP_ABS_DCTX = ["ev_max", "dctx_mean_ep", "dctx_max_ep", "dctx_frac_high",
               "dctx_post", "dctx_pre"]


def episode_features(e, grid, pko, dctx, ev, ts, med, nch, env0, env1,
                     spells, all_eps, n_med, med_med, dctx_sorted,
                     geom12_at=None):
    t0, t1, anchor = e["t0"], e["t1"], e["anchor"]
    subs = e.get("sub_anchors") or [anchor]
    spks = e.get("sub_anchor_pko") or [e["pko"]]
    gi0, gi1 = _gidx(grid, t0 - 45.0), _gidx(grid, t1) + 1
    seg = dctx[gi0:gi1]
    fin = np.isfinite(seg)
    sp = _trailing_spell(spells, anchor)
    sp_over = [b - a for a, b in spells if a <= t1 and b >= t0 - 90.0]
    others = [o for o in all_eps if o is not e]
    prevs = [o["t1"] for o in others if o["t1"] <= t0]
    nexts = [o["t0"] for o in others if o["t0"] >= t1]
    icg = np.diff(subs) if len(subs) > 1 else np.array([0.0])
    dur = max(env1 - env0, 1.0)
    vals = [
        t1 - t0, len(e.get("ps") or e["ts"]), len(subs), e["pko"],
        (e.get("ps") or [e["pko"]])[0],
        float(np.mean(spks)), float(np.max(spks)), e["ev"],
        float(e.get("p_period", np.nan)),
        float(np.nanmean(seg)) if fin.any() else np.nan,
        float(np.nanmax(seg)) if fin.any() else np.nan,
        float((seg[fin] >= 0.8).mean()) if fin.any() else np.nan,
        _wmean(grid, dctx, t1 + 5.0, t1 + 35.0),
        _wmean(grid, dctx, t0 - 90.0, t0 - 45.0),
        (sp[1] - sp[0]) if sp else 0.0,
        (anchor - sp[1]) if sp else np.nan,
        max(sp_over) if sp_over else 0.0,
        _wmean(ts, med, t0 - 60.0, t0 - 10.0),
        _wmean(ts, med, t0, t1 + 1.0),
        med_med,
        (_wmean(ts, nch, t0 - 30.0, t1 + 1.0) / n_med) if n_med else np.nan,
        (anchor - env0) / dur, anchor - env0, env1 - anchor,
        min(t0 - max(prevs), GAP_CAP_S) if prevs else GAP_CAP_S,
        min(min(nexts) - t1, GAP_CAP_S) if nexts else GAP_CAP_S,
        float(sum(1 for o in others if abs(o["anchor"] - anchor) <= 120.0)),
        float(np.max(icg)), float(np.mean(icg)),
    ]
    vals += [_q(dctx_sorted, vals[EP_KEYS.index("dctx_mean_ep")]),
             _q(dctx_sorted, vals[EP_KEYS.index("dctx_post")]),
             _q(dctx_sorted, vals[EP_KEYS.index("dctx_pre")]),
             _q(dctx_sorted, e["ev"])]
    g = geom12_at(anchor) if geom12_at else None
    vals += list(g) if g is not None else [np.nan] * len(GEOM12_KEYS)
    return np.array(vals, dtype=np.float64)


CY_KEYS = (
    ["cyc_idx", "n_cycles", "is_first", "from_t0", "to_t1", "cyc_pko",
     "pko_at_s", "delta_onset",
     "dctx_m5", "dctx_m10", "dctx_m20", "dctx_m30", "dctx_m45", "dctx_m60",
     "ev_at_s",
     "spell_dur", "spell_start_gap", "spell_end_gap",
     "med_w45_30", "med_w30_15", "med_w15_5", "med_w5_p5",
     "t_minmed", "n_trail_ratio",
     "prev_cycle_gap", "span", "ep_pko_max",
     "dctx_m5_q", "dctx_m10_q", "dctx_m20_q", "dctx_m30_q", "dctx_m45_q",
     "dctx_m60_q", "ev_at_s_q"]
    + [f"g_{k}" for k in GEOM12_KEYS]
)

CY_ABS_DCTX = ["dctx_m5", "dctx_m10", "dctx_m20", "dctx_m30", "dctx_m45",
               "dctx_m60", "ev_at_s"]


def cycle_features(e, ci, grid, pko, dctx, ev, ts, med, nch,
                   spells, n_med, dctx_sorted, geom12_at=None):
    subs = e.get("sub_anchors") or [e["anchor"]]
    spks = e.get("sub_anchor_pko") or [e["pko"]]
    s = subs[ci]
    t0, t1 = e["t0"], e["t1"]
    onset = dead_run_start(grid, dctx, s)
    sp = _trailing_spell(spells, s, back=60.0, fwd=5.0)
    lo, hi = np.searchsorted(ts, s - 75.0), np.searchsorted(ts, s,
                                                           side="right")
    if hi > lo and np.isfinite(med[lo:hi]).any():
        t_minmed = s - float(ts[lo + int(np.nanargmin(med[lo:hi]))])
    else:
        t_minmed = np.nan
    ntr = _wmean(ts, nch, s - 30.0, s)
    vals = [
        float(ci), float(len(subs)), float(ci == 0), s - t0, t1 - s,
        float(spks[ci]), _gval(grid, pko, s),
        (s - onset) if np.isfinite(onset) else np.nan,
        _gval(grid, dctx, s - 5), _gval(grid, dctx, s - 10),
        _gval(grid, dctx, s - 20), _gval(grid, dctx, s - 30),
        _gval(grid, dctx, s - 45), _gval(grid, dctx, s - 60),
        _gval(grid, ev, s),
        (sp[1] - sp[0]) if sp else 0.0,
        (s - sp[0]) if sp else np.nan,
        (s - sp[1]) if sp else np.nan,
        _wmean(ts, med, s - 45.0, s - 30.0),
        _wmean(ts, med, s - 30.0, s - 15.0),
        _wmean(ts, med, s - 15.0, s - 5.0),
        _wmean(ts, med, s - 5.0, s + 5.0),
        t_minmed,
        (ntr / n_med) if n_med else np.nan,
        (s - subs[ci - 1]) if ci > 0 else np.nan,
        t1 - t0, e["pko"],
    ]
    for k in ("dctx_m5", "dctx_m10", "dctx_m20", "dctx_m30", "dctx_m45",
              "dctx_m60", "ev_at_s"):
        vals.append(_q(dctx_sorted, vals[CY_KEYS.index(k)]))
    g = geom12_at(s) if geom12_at else None
    vals += list(g) if g is not None else [np.nan] * len(GEOM12_KEYS)
    return np.array(vals, dtype=np.float64)


def extract_match(survivors, all_eps, grid, pko, dctx, ev, ts, med, nch,
                  env0, env1, spells, n_med, med_med, geom12_at=None):
    """(ep_X, cy_X, cy_map) for one match — THE single feature extractor
    for both the Veo dataset builder and the Spiideo evaluator.

    survivors: dicts with t0/t1/anchor/ps (or ts)/pko/ev/p_period/
    sub_anchors/sub_anchor_pko. all_eps: dicts with t0/t1/anchor.
    cy_map[i] = cycle row indices of survivors[i]."""
    dctx_sorted = np.sort(dctx[np.isfinite(dctx)])
    ep_rows, cy_rows, cy_map = [], [], []
    for e in survivors:
        ep_rows.append(episode_features(e, grid, pko, dctx, ev, ts, med,
                                        nch, env0, env1, spells, all_eps,
                                        n_med, med_med, dctx_sorted,
                                        geom12_at))
        subs = e.get("sub_anchors") or [e["anchor"]]
        idxs = []
        for ci in range(len(subs)):
            idxs.append(len(cy_rows))
            cy_rows.append(cycle_features(e, ci, grid, pko, dctx, ev, ts,
                                          med, nch, spells, n_med,
                                          dctx_sorted, geom12_at))
        cy_map.append(idxs)
    ep_X = (np.array(ep_rows, np.float64) if ep_rows
            else np.zeros((0, len(EP_KEYS))))
    cy_X = (np.array(cy_rows, np.float64) if cy_rows
            else np.zeros((0, len(CY_KEYS))))
    return ep_X, cy_X, cy_map


def match_goal(g, survivors):
    """(episode, sub_anchor) for goal g — the spiideo_split_check rule:
    earliest covering card (45s pre-window, widened to 90), then earliest
    qualifying sub-anchor (same widening), fallback card anchor. Returns
    (None, None) if no covering card. Identical for baseline and refiner."""
    covs = [e for e in survivors if e["t0"] - 45.0 <= g <= e["t1"]] or \
           [e for e in survivors if e["t0"] - 90.0 <= g <= e["t1"]]
    if not covs:
        return None, None
    e = min(covs, key=lambda e: e["t0"])
    subs = e.get("sub_anchors") or [e["anchor"]]
    cands = [s for s in subs if s - 45.0 <= g <= s] or \
            [s for s in subs if s - 90.0 <= g <= s]
    return e, (min(cands) if cands else e["anchor"])

"""Refiner confidence scoring — vendored inference-only port.

FROZEN source: scripts/event-tagging/refiner/features.py (the EPISODE
half: episode_features + _q quantile normalizer + spell/window helpers).
The cycle/localizer half is deliberately NOT ported — the localizer
failed its timing gate and nothing timing-related wires to production.
test_refiner_score.py pins numeric parity against the source module, so
edits here must land there first.

The confidence value is a HINT (strip badge + provenance): a per-episode
numeric failure degrades that episode to None and never aborts the
detection money path. A structural skew between this module's feature
order and the banked model's expectation would silently NULL every row
forever (the silently-inert trap), so load_model FAILS CLOSED on it.
"""
from __future__ import annotations

import bisect

import numpy as np

from period_gap import activity_dead_spells
from restart_geometry import feats, FEATURE_KEYS
from stoppage_features import CHANNELS

GEOM12_KEYS = [  # restart FEATURE_KEYS minus the GK (role) features
    "n", "min_dtl", "min_dgl", "corner_dgl", "corner_dtl", "tl_gl",
    "frac_left", "cx", "cy", "spread_x", "spread_y", "dist_center",
]
G12_COLS = [i for i, k in enumerate(FEATURE_KEYS) if k not in
            {"gk_min_dgl", "gk_cy"}]
assert [FEATURE_KEYS[i] for i in G12_COLS] == GEOM12_KEYS

GAP_CAP_S = 600.0
FRAME_TOL_S = 0.4           # chain FRAME_TOL_S (kept literal: no import
MIN_PLAYERS = 6             # cycle) — pinned by test against chain.py
I_MED = CHANNELS.index("med_speed_r")
I_N = CHANNELS.index("n")

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

# absolute stoppage-calibration features — the shipped norm_only variant
# drops these (covariate rule, refiner PROTOCOL.md)
EP_ABS_DCTX = ["ev_max", "dctx_mean_ep", "dctx_max_ep", "dctx_frac_high",
               "dctx_post", "dctx_pre"]
NORM_ONLY_KEYS = [k for k in EP_KEYS if k not in EP_ABS_DCTX]


def _wmean(ts, x, a, b):
    lo, hi = np.searchsorted(ts, a), np.searchsorted(ts, b, side="right")
    if hi <= lo:
        return np.nan
    w = x[lo:hi]
    return float(np.nanmean(w)) if np.isfinite(w).any() else np.nan


def _gidx(grid, t):
    return int(np.clip(round(t - grid[0]), 0, len(grid) - 1))


def _q(sorted_vals, v):
    if not np.isfinite(v) or not len(sorted_vals):
        return np.nan
    return float(np.searchsorted(sorted_vals, v) / len(sorted_vals))


def _trailing_spell(spells, t, back=60.0, fwd=0.0):
    best = None
    for a, b in spells:
        if t - back <= b <= t + fwd and (best is None or b > best[1]):
            best = (a, b)
    return best


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


class SkewError(ValueError):
    """Image/pickle feature-order mismatch — self-authored message, the
    ONLY refiner exception entrypoint surfaces verbatim (security L1: a
    bare ValueError catch would also forward pickle-internal messages to
    the outside-engineering-readable error column)."""


def load_model(path):
    """joblib-load the banked confidence pickle; FAIL CLOSED on feature
    skew (entrypoint wraps SkewError into JobError; any other load error
    degrades to its type name per the job's error contract)."""
    import joblib
    art = joblib.load(path)
    if list(art.get("ep_keys") or []) != NORM_ONLY_KEYS:
        raise SkewError(
            "refiner_confidence.pkl feature skew: banked model expects "
            f"{len(art.get('ep_keys') or [])} keys, image computes "
            f"{len(NORM_ONLY_KEYS)} — image/pickle deploy mismatch")
    # the gate must cover everything the job later assumes (senior #3):
    # a keys-correct pickle missing clf/variant would otherwise die later
    # with a generic degraded error instead of a loud self-authored one
    missing = [k for k in ("clf", "variant") if k not in art]
    if missing:
        raise SkewError(
            f"refiner_confidence.pkl malformed: missing {missing}")
    return art


def geom12_from_shim(shim):
    """geom12_at(t): rolefree12 geometry from the shim's frames (same
    frame pick as chain.series' P_ko loop)."""
    ft = shim.frame_times

    def geom12_at(t):
        j = bisect.bisect_left(ft, t)
        best = None
        for k in (j - 1, j):
            if 0 <= k < len(ft) and abs(ft[k] - t) <= FRAME_TOL_S:
                rows = shim.frames[ft[k]]
                if best is None or len(rows) > len(best):
                    best = rows
        if not best or len(best) < MIN_PLAYERS:
            return np.full(len(GEOM12_KEYS), np.nan)
        f = feats([[i, 1, float(r[2]), float(r[3])]
                   for i, r in enumerate(best)])
        if f is None:
            return np.full(len(GEOM12_KEYS), np.nan)
        return np.array([f[FEATURE_KEYS[i]] for i in G12_COLS], np.float64)
    return geom12_at


NORM_COLS = [i for i, k in enumerate(EP_KEYS) if k not in EP_ABS_DCTX]


def score_episodes(art, survivors, all_eps, env0, env1, series, geom12_at):
    """{survivor anchor: confidence | None}. Per-episode numeric failures
    degrade to None (printed) — the badge is a hint, never a job killer."""
    grid, pko, dctx, ev, ts, X = series
    med = X[:, I_MED].astype(np.float64)
    nch = X[:, I_N].astype(np.float64)
    spells = activity_dead_spells(ts, med)
    n_med = float(np.nanmedian(nch)) or 1.0
    med_med = float(np.nanmedian(med))
    dctx_sorted = np.sort(dctx[np.isfinite(dctx)])
    clf = art["clf"]
    out = {}
    for e in survivors:
        try:
            x = episode_features(e, grid, pko, dctx, ev, ts, med, nch,
                                 env0, env1, spells, all_eps, n_med,
                                 med_med, dctx_sorted, geom12_at)
            v = float(clf.predict_proba(x[NORM_COLS][None])[0, 1])
            # non-finite would serialize as invalid JSON and abort the
            # candidate-write sequence mid-flight (senior #2) — degrade
            if not np.isfinite(v):
                print(f'refiner score non-finite @{e["anchor"]:.0f}',
                      flush=True)
                v = None
            out[e["anchor"]] = v
        except Exception as err:      # noqa: BLE001 — hint path degrades
            print(f'refiner score failed @{e["anchor"]:.0f}: {err}',
                  flush=True)
            out[e["anchor"]] = None
    return out

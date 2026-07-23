"""The FROZEN goal-detection decode (steps 1-5 of the validated chain).

Source of truth: scripts/event-tagging/stoppage_veo_freeze.py — every
constant here is the shipped value that passed the VEO FREEZE ship gate
(236 matches, 5-fold OOF: medium recall90 0.812 / precision 0.309 /
shortlist med 18 at DCTX_FLOOR=0.80, the floor adopted by the
precision-measured re-decode; RESULTS.md §"VEO FREEZE" + §"FLOOR 0.80
RE-DECODE"). Do NOT tune anything here against a single venue.

The ranking stage (step 6) is deliberately absent: measured
non-concentrating on Veo held-out, and it is the only stage that needs
kit-teams/YOLO. Candidates are surfaced chronologically.

`earliest_confident_kickoff` has NO dead-evidence floor BY DESIGN — warm-up
motion reads live, so the true opening kickoff rarely carries trailing dead
evidence; requiring it mislabels post-goal kickoffs as the opening and eats
early goals (the fold-1 port bug, fixed 2026-07-21).
"""
from __future__ import annotations

import bisect

import numpy as np

from envelope import blocks_from_activity
from kickoff import p_kickoff
from period_gap import activity_dead_spells, kickoff_features
from stoppage_features import CHANNELS, context_matrix, frame_channels

# ── frozen constants (stoppage_veo_freeze.py) ──────────────────────────────
TAU = 0.5                   # opening-scan + diagnosis threshold (unchanged —
                            # the 07-22 opening measurement: any strictness
                            # change on the opening eats early goals)
TAU_PEAK = 0.45             # candidate-peak gate (freeze-adopted 2026-07-23:
                            # +2.5pp medium recall90 @ precision 0.302,
                            # +1 card/match; 0.40/0.35 breach the 0.30
                            # precision floor — locked bar, do not lower
                            # without a new freeze round. Spiideo spot-check:
                            # 0 stamped goals lose coverage; lower τ also
                            # BRIDGES adjacent episodes — sub-anchor chips
                            # absorb the longer spans.)
DCTX_FLOOR = 0.80           # trailing dead-evidence floor (adopted 07-21)
MERGE_S = 45.0              # episode merge radius
PRE_WIN = (6.0, 1.0)        # deadctx window [t-6, t-1]
EV_WIN = (30.0, 5.0)        # trailing-evidence window [t-30, t-5]
PEAK_HALF = 5               # local-max half window on the 1s grid
OPEN_TOL_S = 60.0           # opening-kickoff drop radius
POST_TOL_S = 30.0           # post-match drop margin
PERIOD_THR = 0.5            # period-gap filter threshold
GRID_STEP = 1.0             # P_ko scoring grid
MIN_PLAYERS = 6             # trackko n>=6 rule
FRAME_TOL_S = 0.4           # nearest-frame tolerance on the P_ko grid
SPLIT_LIVE_THR = 0.5        # dead->live cycle boundary for sub-anchors: the
                            # stoppage model's probability midpoint (same
                            # convention as TAU/PERIOD_THR). Adopted from the
                            # episode-split measurement — RESULTS.md
                            # §"EPISODE SPLIT MEASURED". Sub-anchors are
                            # review HINTS; they never change episode
                            # boundaries, merge, or filtering.
SUB_ANCHORS_ROW_CAP = 8     # candidate-row hint cap: anchor cycle + top-7
                            # rest by per-cycle max P_ko (within-EPISODE
                            # cycle ranking separates, unlike the
                            # cross-episode ranking). K=8 measured: 99.9%
                            # goal-cycle retention on the 236-match freeze
                            # corpus AND zero stamped-goal-cycle losses on
                            # both labeled Spiideo matches (K=5 dropped the
                            # pilot 512-card's stamped-531 cycle — do not
                            # lower without re-measuring); worst Nazwa
                            # flurry card 15 -> 8 chips. Full list stays in
                            # provenance.
KICKOFF_VARIANT = "rolefree12"
DETECTOR_VERSION = "freeze-2026-07-23-tau045"

I_MED = CHANNELS.index("med_speed_r")
I_N = CHANNELS.index("n")


class ChainError(ValueError):
    """Self-authored message, safe to surface in the error column."""


def series(shim, stoppage_art, ko_models):
    """(grid, pko, dctx, ev, ts, X) for the whole match."""
    ts, X = frame_channels(shim)
    if len(ts) < 100:
        raise ChainError(f'too few scored frames ({len(ts)})')
    med = np.nanmedian(X, axis=0)
    if not np.isfinite(med[[I_MED, I_N]]).all():
        raise ChainError('non-finite channel medians — projection unusable')

    clf, cmask = stoppage_art["clf"], stoppage_art["cmask"]
    Xc = context_matrix(ts, X)[:, cmask]
    fin = np.isfinite(Xc).all(axis=1)
    p = np.zeros(len(ts))
    if fin.any():
        p[fin] = clf.predict_proba(Xc[fin])[:, 1]

    grid = np.arange(0.0, float(ts[-1]) + GRID_STEP / 2, GRID_STEP)
    # deadctx per grid point: mean p over frames in [t-6, t-1]
    cs = np.concatenate([[0.0], np.cumsum(p)])
    lo = np.searchsorted(ts, grid - PRE_WIN[0])
    hi = np.searchsorted(ts, grid - PRE_WIN[1], side="right")
    cnt = np.maximum(hi - lo, 0)
    dctx = np.where(cnt > 0, (cs[hi] - cs[lo]) / np.maximum(cnt, 1), np.nan)
    # trailing evidence: max dctx over [t-30, t-5] (1s grid -> index slices)
    ev = np.full(len(grid), np.nan)
    a, b = int(EV_WIN[0]), int(EV_WIN[1])
    for i in range(len(grid)):
        w = dctx[max(0, i - a):max(0, i - b + 1)]
        if len(w) and np.isfinite(w).any():
            ev[i] = np.nanmax(w)

    # P_ko on the grid from the shim's frames (trackko: best of the two
    # neighbor frames within FRAME_TOL_S by player count, n >= MIN_PLAYERS)
    ft = shim.frame_times
    pko = np.full(len(grid), np.nan)
    for i, t in enumerate(grid):
        j = bisect.bisect_left(ft, t)
        best = None
        for k in (j - 1, j):
            if 0 <= k < len(ft) and abs(ft[k] - t) <= FRAME_TOL_S:
                rows = shim.frames[ft[k]]
                if best is None or len(rows) > len(best):
                    best = rows
        if best and len(best) >= MIN_PLAYERS:
            pko[i] = p_kickoff([(r[2], r[3]) for r in best], ko_models,
                               KICKOFF_VARIANT)
    return grid, pko, dctx, ev, ts, X


def earliest_confident_kickoff(grid, pko):
    """Envelope opening, v2/v3 semantics: earliest P_ko>=TAU local max, NO
    dead-evidence floor (see module docstring)."""
    for i in range(1, len(grid) - 1):
        if not np.isfinite(pko[i]) or pko[i] < TAU:
            continue
        w = pko[max(0, i - PEAK_HALF):i + PEAK_HALF + 1]
        if pko[i] >= np.nanmax(w) - 1e-9:
            return float(grid[i])
    return None


def _sub_anchors(peaks, peak_pkos, grid, dctx):
    """(cycle anchors, per-cycle max P_ko) for one episode's peak run: a new
    cycle starts at peak t when dctx dipped below SPLIT_LIVE_THR between the
    immediately preceding peak and t (NaN dctx is not live evidence); peaks
    that don't start a cycle fold their P_ko into the current cycle's max.
    Without a dctx series this degrades to one cycle — the pre-hybrid
    shape."""
    subs = [peaks[0]]
    pks = [peak_pkos[0]]
    for (prev, t), p in zip(zip(peaks, peaks[1:]), peak_pkos[1:]):
        split = False
        if dctx is not None:
            i0 = int(np.searchsorted(grid, prev, side="right"))
            i1 = int(np.searchsorted(grid, t, side="left"))
            seg = dctx[i0:i1]
            split = bool((np.isfinite(seg) & (seg < SPLIT_LIVE_THR)).any())
        if split:
            subs.append(t)
            pks.append(p)
        else:
            pks[-1] = max(pks[-1], p)
    return subs, pks


def cap_sub_anchors(subs, pkos, cap=SUB_ANCHORS_ROW_CAP):
    """Row-write hint cap: the anchor cycle is ALWAYS kept (its estimate is
    the approve default and `[0] = anchor_s` must hold) + the top-(cap-1)
    remaining cycles by per-cycle max P_ko, returned in time order. See the
    SUB_ANCHORS_ROW_CAP comment before changing the cap."""
    if len(subs) <= cap:
        return list(subs)
    if len(pkos) != len(subs):
        # Defensive degrade (unreachable from detect(), which always sets
        # both in lockstep): a mismatched pko list must not silently zip-
        # truncate the offers down to [anchor] — keep the earliest `cap`
        # cycles instead. Hints-only surface, so degrade beats loud-fail.
        return list(subs)[:cap]
    rest = sorted(zip(subs[1:], pkos[1:]), key=lambda sp: -sp[1])[:cap - 1]
    return sorted([subs[0]] + [s for s, _ in rest])


def detect(grid, pko, ev, dctx=None):
    """trackko peaks + 45s merge -> episodes (dicts with ts/pko/ev/anchor).

    dctx (optional) only feeds the additive sub_anchors metadata — episode
    boundaries, merge radius, and per-peak gating are byte-identical with or
    without it."""
    cand = []
    for i in range(1, len(grid) - 1):
        if not np.isfinite(pko[i]) or pko[i] < TAU_PEAK:
            continue
        w = pko[max(0, i - PEAK_HALF):i + PEAK_HALF + 1]
        if pko[i] >= np.nanmax(w) - 1e-9 and np.isfinite(ev[i]) \
                and ev[i] >= DCTX_FLOOR:
            cand.append((float(grid[i]), float(pko[i]), float(ev[i])))
    eps = []
    for t, p, d in cand:
        if eps and t - eps[-1]["ts"][-1] <= MERGE_S:
            e = eps[-1]
            e["ts"].append(t)
            e["ps"].append(p)
            e["pko"] = max(e["pko"], p)
            e["ev"] = max(e["ev"], d)
        else:
            eps.append(dict(ts=[t], ps=[p], pko=p, ev=d))
    for e in eps:
        e["anchor"] = e["ts"][0]
        e["t0"] = e["ts"][0]
        e["t1"] = e["ts"][-1]
        e["sub_anchors"], e["sub_anchor_pko"] = _sub_anchors(
            e["ts"], e["ps"], grid, dctx)
    return eps


def run_chain(shim, stoppage_art, ko_models, period_art):
    """Full frozen decode. Returns (episodes, survivors, env0, env1) where
    episodes carry drop annotations for provenance and survivors are the
    chronological candidate list."""
    grid, pko, dctx, ev, ts, X = series(shim, stoppage_art, ko_models)
    eps = detect(grid, pko, ev, dctx=dctx)

    med = X[:, I_MED].astype(np.float64)
    nch = X[:, I_N].astype(np.float64)
    blocks = blocks_from_activity(ts, med)
    env1 = blocks[-1][1] if blocks else float(ts[-1])
    e0 = earliest_confident_kickoff(grid, pko)
    env0 = e0 if e0 is not None else (blocks[0][0] if blocks else 0.0)

    spells = activity_dead_spells(ts, med)
    n_med = float(np.nanmedian(nch)) or 1.0
    clf_pg = period_art["clf"]

    survivors = []
    for e in eps:
        c = e["anchor"]
        if abs(c - env0) <= OPEN_TOL_S:
            e["drop"] = "opening"
            continue
        if c > env1 + POST_TOL_S:
            e["drop"] = "post_match"
            continue
        f = kickoff_features(c, ts, med, nch, spells, env0, env1, n_med)
        e["p_period"] = float(clf_pg.predict_proba([f])[0, 1])
        if e["p_period"] >= PERIOD_THR:
            e["drop"] = "period_filter"
            continue
        survivors.append(e)
    survivors.sort(key=lambda e: e["anchor"])
    return eps, survivors, float(env0), float(env1)

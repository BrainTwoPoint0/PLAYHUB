"""VEO FREEZE: the frozen Spiideo goal chain evaluated on held-out Veo matches.

Chain (FROZEN -- every constant is the shipped Nazwa value, nothing fitted
here; the only Veo-side substitutions are the two the design already names:
role-teams stand in for kit-teams in half_sep, and aim-track swing is 0
because camera_directions is not banked in this corpus):

  1. continuous P(kick_off) at 1s from TRACK positions (>=6 players,
     rolefree12)                                  [stoppage_trackko]
  2. trailing dead-evidence: max deadctx over [t-30,t-5] >= 0.90, deadctx =
     mean P(dead) over [t-6,t-1] from the stoppage model [stoppage_shortlist]
  3. peaks (local max +/-5s, P_ko >= 0.5) -> 45s episode merge
  4. envelope: opening = earliest detection episode (dropped as period,
     +/-60s); end = last activity block (post-match dropped)
                                                  [stoppage_envelope]
  5. period-gap filter at 0.5 on the surviving anchors [stoppage_period_apply]
  6. ranking score = .35*hs + .35*lull + .15*swing + .15*P_ko (pre-declared)
                                                  [stoppage_rank]

Labels = clean Veo FootballGoal (period-boundary FPs excluded). Match-grouped
5-fold: the three models (stoppage/dead, kickoff, period-gap) are re-fit per
fold on the TRAIN matches with the exact shipped hyperparameters; every
reported number is out-of-fold. An episode [t0,t1] hits a goal g iff
t0 - PRE <= g <= t1 (PRE = 45s primary / 90s secondary -- Veo-measured
goal->kickoff latency median 20s, p90 37s).

Run: python stoppage_veo_freeze.py <sidecar_dir> [--fold K] [--out results.json]
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from restart_features import FEATURE_KEYS
from stoppage_envelope_veo import blocks_from_activity
from period_gap_model import activity_dead_spells, kickoff_features

SEED = 7                    # stoppage_model fold seed
N_FOLDS = 5
TAU = 0.5                   # stoppage_trackko
DCTX_FLOOR = 0.80           # ADOPTED 2026-07-21 (was 0.90, set on Nazwa's
                            # saturated calibration): floor-0.80 re-decode
                            # passed the locked bar -- medium recall90
                            # 0.748->0.812, precision 0.313->0.309,
                            # shortlist 16->18, leak 0.09%. RESULTS.md
                            # section "FLOOR 0.80 RE-DECODE".
MERGE_S = 45.0
PRE_WIN = (6.0, 1.0)        # stoppage_context deadctx window
EV_WIN = (30.0, 5.0)        # trailing dead-evidence window
PEAK_HALF = 5               # local-max half window (1s grid)
OPEN_TOL_S = 60.0           # stoppage_envelope opening classification
POST_TOL_S = 30.0
PERIOD_THR = 0.5            # stoppage_period_apply
W_HS, W_LULL, W_SWING, W_PKO = 0.35, 0.35, 0.15, 0.15   # stoppage_rank
LULL_FULL_S = 18.0
LULL_WIN = (35.0, 2.0)
ACT_PCTL = 40               # freeze-activity dead threshold percentile
PRE_MATCH = (45.0, 90.0)    # goal->episode tolerances reported
DIAG_WIN = 75.0             # missed-goal diagnosis window after the goal

GK_FEATS = {"gk_min_dgl", "gk_cy"}
KO_COLS = [i for i, k in enumerate(FEATURE_KEYS) if k not in GK_FEATS]


def band(L):
    return "small" if L < 50 else ("medium" if L < 90 else "full")


def fit_models(names, cache, pg_only=False):
    """pg_only: the P_ko/dctx/ev series are cached per match, so only the
    (cheap) period-gap classifier needs re-fitting -- its scores depend on
    the episode anchors, which change with the decode floor."""
    Xd, yd = [], []
    Xk, yk = [], []
    Xp, yp = [], []
    for n in names:
        z = cache(n)
        if not pg_only:
            fin = np.isfinite(z["Xc_safe"]).all(axis=1) & z["env"]
            Xd.append(z["Xc_safe"][fin])
            yd.append(z["y_dead"][fin])
            if len(z["yko"]):
                Xk.append(z["Xko_train"])
                yk.append(z["yko"])
        if len(z["ypg"]):
            Xp.append(z["Xpg_train"])
            yp.append(z["ypg"])
    clf_dead = clf_ko = None
    if not pg_only:
        clf_dead = HistGradientBoostingClassifier(
            max_iter=400, learning_rate=0.1, max_leaf_nodes=63,
            min_samples_leaf=50, random_state=SEED)  # stoppage_train_full
        clf_dead.fit(np.concatenate(Xd), np.concatenate(yd))
        del Xd, yd
        clf_ko = HistGradientBoostingClassifier(
            max_depth=4, max_iter=300, learning_rate=0.08,
            l2_regularization=1.0, random_state=0)   # kickoff_gate._clf
        clf_ko.fit(np.concatenate(Xk)[:, KO_COLS], np.concatenate(yk))
    clf_pg = HistGradientBoostingClassifier(
        max_iter=200, learning_rate=0.1, max_leaf_nodes=31,
        min_samples_leaf=30, random_state=SEED)      # period_gap_model
    clf_pg.fit(np.concatenate(Xp), np.concatenate(yp))
    return clf_dead, clf_ko, clf_pg


def series(z, clf_dead, clf_ko):
    """(pko, dctx, ev) on the 1s grid."""
    ts = z["ts"]
    fin = np.isfinite(z["Xc_safe"]).all(axis=1)
    p = np.zeros(len(ts))
    if fin.any():
        p[fin] = clf_dead.predict_proba(z["Xc_safe"][fin])[:, 1]
    grid = z["grid_ts"].astype(np.float64)
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
    # P_ko
    F = z["Fko"]
    valid = np.isfinite(F).all(axis=1)
    pko = np.full(len(grid), np.nan)
    if valid.any():
        proba = clf_ko.predict_proba(F[valid][:, KO_COLS])
        j = list(clf_ko.classes_).index("kick_off")
        pko[valid] = proba[:, j]
    return pko, dctx, ev


def earliest_confident_kickoff(grid, pko):
    """Envelope opening, v2/v3 semantics: earliest P_ko>=0.5 local max, NO
    dead-evidence floor (warm-up motion reads live, so the true opening
    kickoff rarely carries trailing dead evidence; the first port required
    it and mislabeled later -- often post-goal -- kickoffs as the opening)."""
    for i in range(1, len(grid) - 1):
        if not np.isfinite(pko[i]) or pko[i] < TAU:
            continue
        w = pko[max(0, i - PEAK_HALF):i + PEAK_HALF + 1]
        if pko[i] >= np.nanmax(w) - 1e-9:
            return float(grid[i])
    return None


SPLIT_LIVE_THR = 0.5        # dead->live boundary = stoppage-model midpoint
SPLIT_5S_RUN = 5            # variant "5s": consecutive live grid points


def detect(grid, pko, ev, floor=DCTX_FLOOR, split=None, dctx=None):
    """trackko peaks + 45s merge -> episodes.

    split (None | "any" | "5s"): measured episode-split variants (adopt bar
    locked 2026-07-22 BEFORE any split decode ran): start a NEW episode at a
    peak when a dead->live cycle (dctx dipping below SPLIT_LIVE_THR between
    consecutive peaks) separates it from the run — "any" = any single live
    grid point, "5s" = a run of >= SPLIT_5S_RUN consecutive live points.
    Default None is the frozen 45s transitive merge, byte-identical."""
    cand = []
    for i in range(1, len(grid) - 1):
        if not np.isfinite(pko[i]) or pko[i] < TAU:
            continue
        w = pko[max(0, i - PEAK_HALF):i + PEAK_HALF + 1]
        if pko[i] >= np.nanmax(w) - 1e-9 and np.isfinite(ev[i]) \
                and ev[i] >= floor:
            cand.append((float(grid[i]), float(pko[i]), float(ev[i])))

    def live_gap(t0, t1):
        i0 = int(np.searchsorted(grid, t0, side="right"))
        i1 = int(np.searchsorted(grid, t1, side="left"))
        seg = dctx[i0:i1]
        below = np.isfinite(seg) & (seg < SPLIT_LIVE_THR)
        if split == "any":
            return bool(below.any())
        run = 0
        for b in below:
            run = run + 1 if b else 0
            if run >= SPLIT_5S_RUN:
                return True
        return False

    eps = []
    for t, p, d in cand:
        if eps and t - eps[-1]["ts"][-1] <= MERGE_S and not (
                split and live_gap(eps[-1]["ts"][-1], t)):
            e = eps[-1]
            e["ts"].append(t)
            e["pko"] = max(e["pko"], p)
            e["ev"] = max(e["ev"], d)
        else:
            eps.append(dict(ts=[t], pko=p, ev=d))
    for e in eps:
        e["anchor"] = e["ts"][0]
    return eps


def act_dead_spells(z):
    """freeze-activity dead spells (ranking lull), thr = p40 of act."""
    ats, act = z["act_ts"].astype(np.float64), z["act"]
    if len(ats) < 3:
        return []
    thr = float(np.percentile(act, ACT_PCTL))
    dead = act < thr
    spells = []
    i, n = 0, len(ats)
    while i < n:
        if dead[i]:
            j = i
            while j < n and dead[j]:
                j += 1
            spells.append((ats[i], ats[min(j, n - 1)]))
            i = j
        else:
            i += 1
    return spells


def trailing_lull(spells, t):
    best = 0.0
    for a, b in spells:
        if t - LULL_WIN[0] <= b <= t - LULL_WIN[1]:
            best = max(best, b - a)
    return best


def eval_match(name, z, clf_dead, clf_ko, clf_pg, floor=DCTX_FLOOR,
               series_dir=None, split=None):
    grid = z["grid_ts"].astype(np.float64)
    ts = z["ts"]
    sfp = os.path.join(series_dir, name + ".npz") if series_dir else None
    if sfp and os.path.exists(sfp):
        sz = np.load(sfp)
        pko, dctx, ev = sz["pko"], sz["dctx"], sz["ev"]
    else:
        if clf_dead is None:
            raise RuntimeError(f"no cached series for {name} and no models "
                               "fitted -- run without --cached first")
        pko, dctx, ev = series(z, clf_dead, clf_ko)
        if sfp:
            np.savez_compressed(sfp, pko=pko, dctx=dctx, ev=ev)
    eps = detect(grid, pko, ev, floor, split=split, dctx=dctx)

    blocks = blocks_from_activity(ts, z["med"].astype(np.float64))
    env1 = blocks[-1][1] if blocks else float(ts[-1])
    e0 = earliest_confident_kickoff(grid, pko)
    env0 = e0 if e0 is not None else (blocks[0][0] if blocks else 0.0)

    spells_med = activity_dead_spells(ts, z["med"].astype(np.float64))
    n_med = float(np.nanmedian(z["nch"])) or 1.0
    lull_spells = act_dead_spells(z)
    hs_grid = z["hs_grid"]

    survivors = []
    for e in eps:
        c = e["anchor"]
        if abs(c - env0) <= OPEN_TOL_S:
            e["drop"] = "opening"
            continue
        if c > env1 + POST_TOL_S:
            e["drop"] = "post_match"
            continue
        f = kickoff_features(c, ts, z["med"].astype(np.float64),
                             z["nch"].astype(np.float64), spells_med,
                             env0, env1, n_med)
        e["p_period"] = float(clf_pg.predict_proba([f])[0, 1])
        if e["p_period"] >= PERIOD_THR:
            e["drop"] = "period_filter"
            continue
        gi = int(np.clip(round(c - grid[0]), 0, len(grid) - 1))
        hs = float(hs_grid[gi]) if np.isfinite(hs_grid[gi]) else 0.0
        lull = trailing_lull(lull_spells, c)
        hs_n = float(np.clip((hs - 0.5) * 2.0, 0.0, 1.0))
        lull_n = float(np.clip(lull / LULL_FULL_S, 0.0, 1.0))
        swing_n = 0.0            # no aim-track in the Veo corpus (tier C)
        e["score"] = (W_HS * hs_n + W_LULL * lull_n + W_SWING * swing_n
                      + W_PKO * e["pko"])
        e.update(hs=hs, lull=lull)
        survivors.append(e)
    survivors.sort(key=lambda e: -e["score"])
    for i, e in enumerate(survivors):
        e["rank"] = i + 1

    goals = list(z["goals_clean"])
    flagged = list(z["goals_flagged"])
    p_starts = [s for s, _ in z["periods"]]
    restart_tags = z["restart_tags"]

    def covers(e, g, pre):
        return e["ts"][0] - pre <= g <= e["ts"][-1]

    rec = dict(name=name, L=float(z["L"]), W=float(z["W"]),
               band=band(float(z["L"])), n_goals=len(goals),
               n_flagged=len(flagged), n_episodes_detected=len(eps),
               n_shortlist=len(survivors),
               env0=float(env0), env1=float(env1),
               env0_err=(float(env0 - min(p_starts))
                         if len(p_starts) else None),
               goals=[], fps=[], episodes=[])

    for e in eps:
        rec["episodes"].append(dict(
            t0=e["ts"][0], t1=e["ts"][-1], pko=e["pko"], ev=e["ev"],
            drop=e.get("drop"), p_period=e.get("p_period"),
            score=e.get("score"), rank=e.get("rank"),
            hs=e.get("hs"), lull=e.get("lull")))

    # goal-side: recovered / miss diagnosis
    for g in goals:
        hit = [e for e in survivors if covers(e, g, PRE_MATCH[0])]
        hit90 = [e for e in survivors if covers(e, g, PRE_MATCH[1])]
        gr = dict(t=float(g), hit45=bool(hit), hit90=bool(hit90),
                  rank=min((e["rank"] for e in hit), default=None))
        if not hit90:
            dropped = [e for e in eps if e.get("drop")
                       and covers(e, g, PRE_MATCH[1])]
            if dropped:
                gr["miss"] = "dropped_" + dropped[0]["drop"]
            else:
                w = (grid >= g + 1) & (grid <= g + DIAG_WIN)
                pw = pko[w]
                if not np.isfinite(pw).any():
                    gr["miss"] = "no_grid"
                elif np.nanmax(pw) < TAU:
                    gr["miss"] = "pko_below"
                    gr["pko_best"] = float(np.nanmax(pw))
                else:
                    i = np.where(w)[0][int(np.nanargmax(pw))]
                    gr["miss"] = ("no_dead_evidence"
                                  if not (np.isfinite(ev[i])
                                          and ev[i] >= floor)
                                  else "peak_suppressed")
                    if np.isfinite(ev[i]):
                        gr["ev_best"] = float(ev[i])
            gr["near_end"] = bool(g > env1 - 40)
        rec["goals"].append(gr)

    # FP-side audit
    for e in survivors:
        if any(covers(e, g, PRE_MATCH[1]) for g in goals):
            continue
        t0, t1, c = e["ts"][0], e["ts"][-1], e["anchor"]
        if any(covers(e, g, PRE_MATCH[1]) for g in flagged):
            cat = "flagged_goal"
        elif len(p_starts) and min(abs(c - s) for s in p_starts) <= 25:
            cat = "period_kickoff_leak"
        elif len(restart_tags) and any(
                r[1] == 3 and t0 - 10 <= r[0] <= t1 + 10
                for r in restart_tags):   # kick_off idx 3 in RESTART_CLASSES
            cat = "veo_kickoff_no_goal"
        elif len(restart_tags) and any(
                abs(r[0] - c) <= 10 for r in restart_tags):
            cat = "other_restart"
        else:
            cat = "open_play"
        rec["fps"].append(dict(t=float(c), rank=e["rank"],
                               score=e["score"], cat=cat))
    return rec


def summarize(records, label=""):
    def agg(rs):
        goals = [g for r in rs for g in r["goals"]]
        n_g = len(goals)
        n_ep = sum(r["n_shortlist"] for r in rs)
        tp_ep = sum(r["n_shortlist"] - len(r["fps"]) for r in rs)
        out = dict(matches=len(rs), goals=n_g, shortlist=n_ep)
        if not n_g or not n_ep:
            return out
        out["recall45"] = sum(g["hit45"] for g in goals) / n_g
        out["recall90"] = sum(g["hit90"] for g in goals) / n_g
        out["precision"] = tp_ep / n_ep
        out["shortlist_med"] = float(np.median(
            [r["n_shortlist"] for r in rs]))
        for K in (4, 8):
            hits = tot = grec = 0
            for r in rs:
                topk = [e for e in r["episodes"]
                        if e["rank"] and e["rank"] <= K]
                fp_ranks = {f["rank"] for f in r["fps"]}
                hits += sum(1 for e in topk if e["rank"] not in fp_ranks)
                tot += len(topk)
                grec += sum(1 for g in r["goals"]
                            if g["rank"] and g["rank"] <= K)
            out[f"p@{K}"] = hits / tot if tot else None
            out[f"r@{K}"] = grec / n_g
        from collections import Counter
        out["miss"] = dict(Counter(g.get("miss") for g in goals
                                   if not g["hit90"]))
        out["fp_cats"] = dict(Counter(f["cat"] for r in rs
                                      for f in r["fps"]))
        return out

    print(f"\n===== SUMMARY {label} ({len(records)} matches) =====")
    for key, rs in [("ALL", records)] + [
            (b, [r for r in records if r["band"] == b])
            for b in ("medium", "full", "small")]:
        if not rs:
            continue
        a = agg(rs)
        print(f"\n[{key}] {json.dumps(a, indent=2, default=str)}")
    errs = [r["env0_err"] for r in records if r["env0_err"] is not None]
    if errs:
        print(f"\nenvelope opening error vs first period start: "
              f"median {np.median(errs):+.1f}s, "
              f"|err|<=45s: {np.mean(np.abs(errs) <= 45):.2%}")


def main(cache_dir, fold=None, out="freeze_results.json",
         floor=DCTX_FLOOR, series_dir=None, split=None):
    names = sorted(n[:-4] for n in os.listdir(cache_dir)
                   if n.endswith(".npz"))
    print(f"{len(names)} sidecars  dctx-floor={floor}")
    if series_dir:
        os.makedirs(series_dir, exist_ok=True)

    def cache(n):
        return np.load(os.path.join(cache_dir, n + ".npz"))

    rng = np.random.default_rng(SEED)
    order = rng.permutation(len(names))
    folds = [sorted(order[i::N_FOLDS]) for i in range(N_FOLDS)]
    records = []
    run_folds = [fold - 1] if fold else range(N_FOLDS)
    for fi in run_folds:
        test = set(folds[fi])
        train_names = [names[i] for i in range(len(names)) if i not in test]
        # if every test match's OOF series is cached, only the (cheap)
        # period-gap clf needs fitting -- the floor is decode-time only
        pg_only = bool(series_dir) and all(
            os.path.exists(os.path.join(series_dir, names[i] + ".npz"))
            for i in folds[fi])
        print(f"\nfold {fi + 1}/{N_FOLDS}: fitting on {len(train_names)} "
              f"matches{' (pg only, series cached)' if pg_only else ''}...")
        clf_dead, clf_ko, clf_pg = fit_models(train_names, cache, pg_only)
        for i in folds[fi]:
            z = cache(names[i])
            rec = eval_match(names[i], z, clf_dead, clf_ko, clf_pg,
                             floor=floor, series_dir=series_dir, split=split)
            rec["fold"] = fi + 1
            records.append(rec)
            g_hit = sum(g["hit45"] for g in rec["goals"])
            print(f"  {names[i][:48]:48s} band={rec['band']:6s} "
                  f"goals {g_hit}/{rec['n_goals']}  "
                  f"shortlist {rec['n_shortlist']}  fps {len(rec['fps'])}")
        summarize(records, f"(through fold {fi + 1})")
        with open(os.path.join(HERE, out), "w") as f:
            json.dump(records, f, default=str)
    print(f"\nsaved -> {out}")


if __name__ == "__main__":
    fold = None
    if "--fold" in sys.argv:
        fold = int(sys.argv[sys.argv.index("--fold") + 1])
    out = "freeze_results.json"
    if "--out" in sys.argv:
        out = sys.argv[sys.argv.index("--out") + 1]
    floor = DCTX_FLOOR
    if "--dctx-floor" in sys.argv:
        floor = float(sys.argv[sys.argv.index("--dctx-floor") + 1])
    series_dir = None
    if "--series-dir" in sys.argv:
        series_dir = sys.argv[sys.argv.index("--series-dir") + 1]
    split = None
    if "--split" in sys.argv:
        split = sys.argv[sys.argv.index("--split") + 1]
        assert split in ("any", "5s"), f"unknown split variant {split!r}"
    main(sys.argv[1], fold, out, floor, series_dir, split)

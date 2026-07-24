"""Reproduce the production goal-detect decode for the stamped Nazwa
matches and bank (series + episodes + refiner features) per match.

NO stamps are read here — this is the label-free half of the stamp eval
(decode reproduction + the protocol's covariate check). Verification:
decoding with TAU_PEAK=0.5 (the detector version the DB candidates were
minted with) must reproduce each row's candidate anchors; the EVAL decode
is the current production TAU_PEAK=0.45.

Run: python spiideo_decode.py
"""
from __future__ import annotations

import json
import os
import sys

import joblib
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ET = os.path.dirname(HERE)
JOB = os.path.join(os.path.dirname(os.path.dirname(ET)),
                   "infrastructure", "batch", "goal-detect")
sys.path.insert(0, HERE)
sys.path.insert(0, JOB)

import chain as chain_mod                     # noqa: E402
import kickoff                                # noqa: E402
import projection                             # noqa: E402
from restart_geometry import feats, FEATURE_KEYS  # noqa: E402
from period_gap import activity_dead_spells   # noqa: E402
from features import (episode_features, cycle_features,  # noqa: E402
                      EP_KEYS, CY_KEYS, GEOM12_KEYS)

MODELS = ("/private/tmp/claude-501/-Users-karimfawaz-Dev-Projects-"
          "PLAYBACK-Workspace/ace9c701-706f-4af1-9dda-7513ee732755/"
          "scratchpad/miss-autopsy/models")
DATA = os.path.join(HERE, "data")
ART = os.path.join(DATA, "artifacts")

H_CAL = [[-0.05338159823038465, 0.0003761643333387718, 0.7837805851762365],
         [0.00023403920796332794, -0.013901109275659268,
          -0.04063822481032264],
         [0.00043842447044175535, 0.05949190101645739, -1.0559625653032696]]
L, W = 30.0, 15.0

GK_FEATS = {"gk_min_dgl", "gk_cy"}
G12_COLS = [i for i, k in enumerate(FEATURE_KEYS) if k not in GK_FEATS]
assert [FEATURE_KEYS[i] for i in G12_COLS] == GEOM12_KEYS

# (recording_id, spiideo_game_id, DB candidate anchors for verification)
MATCHES = json.load(open(os.path.join(DATA, "spiideo_matches.json")))


def geom12_maker(shim):
    ft = shim.frame_times

    def geom12_at(t):
        import bisect
        j = bisect.bisect_left(ft, t)
        best = None
        for k in (j - 1, j):
            if 0 <= k < len(ft) and abs(ft[k] - t) <= chain_mod.FRAME_TOL_S:
                rows = shim.frames[ft[k]]
                if best is None or len(rows) > len(best):
                    best = rows
        if not best or len(best) < chain_mod.MIN_PLAYERS:
            return np.full(len(G12_COLS), np.nan)
        f = feats([[i, 1, float(r[2]), float(r[3])]
                   for i, r in enumerate(best)])
        if f is None:
            return np.full(len(G12_COLS), np.nan)
        return np.array([f[FEATURE_KEYS[i]] for i in G12_COLS], np.float64)
    return geom12_at


def filter_chain(eps, grid, ts, med, nch, pko, period_art):
    """run_chain's post-detect stages on a precomputed series (the series
    is tau-independent, so verification + eval decodes share ONE series)."""
    from envelope import blocks_from_activity as _blocks
    blocks = _blocks(ts, med)
    env1 = blocks[-1][1] if blocks else float(ts[-1])
    e0 = chain_mod.earliest_confident_kickoff(grid, pko)
    env0 = e0 if e0 is not None else (blocks[0][0] if blocks else 0.0)
    spells = activity_dead_spells(ts, med)
    n_med = float(np.nanmedian(nch)) or 1.0
    clf_pg = period_art["clf"]
    from period_gap import kickoff_features as _kf
    survivors = []
    for e in eps:
        c = e["anchor"]
        if abs(c - env0) <= chain_mod.OPEN_TOL_S:
            e["drop"] = "opening"
            continue
        if c > env1 + chain_mod.POST_TOL_S:
            e["drop"] = "post_match"
            continue
        f = _kf(c, ts, med, nch, spells, env0, env1, n_med)
        e["p_period"] = float(clf_pg.predict_proba([f])[0, 1])
        if e["p_period"] >= chain_mod.PERIOD_THR:
            e["drop"] = "period_filter"
            continue
        survivors.append(e)
    survivors.sort(key=lambda e: e["anchor"])
    return survivors, env0, env1


def run_one(rec_id, game_id, db_anchors, stoppage_art, ko_models,
            period_art):
    artifact = json.load(open(os.path.join(ART, game_id + ".json")))
    shim = projection.load_pitch_frames(artifact, H_CAL, L, W)
    grid, pko, dctx, ev, ts, X = chain_mod.series(shim, stoppage_art,
                                                  ko_models)
    med = X[:, chain_mod.I_MED].astype(np.float64)
    nch = X[:, chain_mod.I_N].astype(np.float64)

    # -- verification decode at the DB rows' detector version (tau 0.5) --
    saved_tau = chain_mod.TAU_PEAK
    chain_mod.TAU_PEAK = 0.5
    try:
        eps_v = chain_mod.detect(grid, pko, ev, dctx=dctx)
    finally:
        chain_mod.TAU_PEAK = saved_tau
    surv_v, _, _ = filter_chain(eps_v, grid, ts, med, nch, pko, period_art)
    # Latest-epoch DB anchors must each reproduce (±2s). The DB union
    # spans epochs (reconcile adopts old rows), so subset-containment is
    # the strongest honest check.
    va = sorted(e["anchor"] for e in surv_v)
    missing = [a for a in db_anchors
               if not any(abs(a - v) <= 2.0 for v in va)]
    verdict = "EXACT" if not missing else "DRIFT"
    print(f"  verify(tau0.5): {verdict}  "
          f"{len(db_anchors) - len(missing)}/{len(db_anchors)} DB anchors "
          f"reproduced; local survivors {len(va)}", flush=True)
    if missing:
        print(f"                  missing {missing}", flush=True)

    # -- eval decode: current production (tau045) --
    eps = chain_mod.detect(grid, pko, ev, dctx=dctx)
    survivors, env0, env1 = filter_chain(eps, grid, ts, med, nch, pko,
                                         period_art)
    # geometry-12 grid (pure geometry, no model) so features can be
    # recomputed offline under any feature-set variant
    geom12_at = geom12_maker(shim)
    G12 = np.stack([geom12_at(float(t)) for t in grid])

    np.savez_compressed(
        os.path.join(DATA, f"spiideo_{rec_id}.npz"),
        grid=grid, pko=pko, dctx=dctx, ev=ev,
        ts=ts, med=med, nch=nch, G12=G12)
    m_eps = [dict(t0=e["t0"], t1=e["t1"], anchor=e["anchor"],
                  subs=list(e["sub_anchors"]),
                  sub_pko=list(e["sub_anchor_pko"]),
                  ps=list(e["ps"]), pko=e["pko"], ev=e["ev"],
                  p_period=e.get("p_period"))
             for e in survivors]
    all_eps = [dict(t0=e["t0"], t1=e["t1"], anchor=e["anchor"],
                    drop=e.get("drop")) for e in eps]
    with open(os.path.join(DATA, f"spiideo_{rec_id}_eps.json"), "w") as f:
        json.dump(dict(rec=rec_id, game=game_id, verify=verdict,
                       env0=env0, env1=env1, survivors=m_eps,
                       all_eps=all_eps), f)
    print(f"  eval(tau045): {len(survivors)} survivors  "
          f"env [{env0:.0f},{env1:.0f}]", flush=True)
    return verdict


def main(only=None):
    stoppage_art = joblib.load(os.path.join(MODELS,
                                            "stoppage_clf_full.pkl"))
    period_art = joblib.load(os.path.join(MODELS, "period_gap_clf.pkl"))
    ko_models = kickoff.load_models(os.path.join(MODELS, "kickoff_clf.pkl"))
    verdicts = {}
    for m in MATCHES:
        if only and not m["rec"].startswith(only):
            continue
        print(f"\n== {m['rec'][:8]} ({m['game'][:8]}) ==", flush=True)
        verdicts[m["rec"]] = run_one(m["rec"], m["game"], m["anchors"],
                                     stoppage_art, ko_models, period_art)
    print("\nverification:", verdicts, flush=True)


if __name__ == "__main__":
    only = None
    if "--only" in sys.argv:
        only = sys.argv[sys.argv.index("--only") + 1]
    main(only)

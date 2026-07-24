"""Veo refiner dataset: production decode (chain.py detect + sub-anchors,
TAU_PEAK 0.45 / floor 0.80) over the 236 freeze sidecars + cached OOF
series, verified against freeze_results_tau045.json, then team-free
episode/cycle features.

The chain models are NOT refit — the cached series are the freeze's OOF
series. Only the (cheap) period-gap classifier is refit per fold, exactly
as the freeze's pg_only path does.

Run: python dataset.py <sidecar_dir> <series_dir> [--out data]
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ET = os.path.dirname(HERE)
JOB = os.path.join(os.path.dirname(os.path.dirname(ET)),
                   "infrastructure", "batch", "goal-detect")
sys.path.insert(0, ET)
sys.path.insert(0, HERE)
sys.path.insert(0, JOB)

import chain as chain_mod                          # noqa: E402  (production)
from period_gap import (activity_dead_spells,      # noqa: E402  (vendored,
                        kickoff_features)          # zero-drift vs scripts)
from envelope import blocks_from_activity          # noqa: E402
from stoppage_veo_freeze import fit_models, band, SEED, N_FOLDS  # noqa: E402
from restart_features import FEATURE_KEYS          # noqa: E402
from features import (extract_match, match_goal,  # noqa: E402
                      EP_KEYS, CY_KEYS, GEOM12_KEYS)

GK_FEATS = {"gk_min_dgl", "gk_cy"}
G12_COLS = [i for i, k in enumerate(FEATURE_KEYS) if k not in GK_FEATS]
assert [FEATURE_KEYS[i] for i in G12_COLS] == GEOM12_KEYS

REC_TOL = 1.5   # seconds tolerance vs the freeze record's episode bounds


def decode_match(z, sz, clf_pg):
    """Production-semantics decode from cached series. Returns
    (all_eps, survivors, env0, env1, arrays...)."""
    grid = z["grid_ts"].astype(np.float64)
    ts = z["ts"].astype(np.float64)
    med = z["med"].astype(np.float64)
    nch = z["nch"].astype(np.float64)
    pko, dctx, ev = sz["pko"], sz["dctx"], sz["ev"]

    eps = chain_mod.detect(grid, pko, ev, dctx=dctx)

    blocks = blocks_from_activity(ts, med)
    env1 = blocks[-1][1] if blocks else float(ts[-1])
    e0 = chain_mod.earliest_confident_kickoff(grid, pko)
    env0 = e0 if e0 is not None else (blocks[0][0] if blocks else 0.0)

    spells = activity_dead_spells(ts, med)
    n_med = float(np.nanmedian(nch)) or 1.0

    survivors = []
    for e in eps:
        c = e["anchor"]
        if abs(c - env0) <= chain_mod.OPEN_TOL_S:
            e["drop"] = "opening"
            continue
        if c > env1 + chain_mod.POST_TOL_S:
            e["drop"] = "post_match"
            continue
        f = kickoff_features(c, ts, med, nch, spells, env0, env1, n_med)
        e["p_period"] = float(clf_pg.predict_proba([f])[0, 1])
        if e["p_period"] >= chain_mod.PERIOD_THR:
            e["drop"] = "period_filter"
            continue
        survivors.append(e)
    survivors.sort(key=lambda e: e["anchor"])
    return eps, survivors, env0, env1, grid, ts, med, nch, pko, dctx, ev, \
        spells, n_med


def verify_vs_record(name, eps, survivors, rec_eps):
    """Episode boundaries + drop labels must reproduce the tau045 record."""
    if len(eps) != len(rec_eps):
        return f"{name}: episode count {len(eps)} != record {len(rec_eps)}"
    for e, r in zip(sorted(eps, key=lambda e: e["t0"]),
                    sorted(rec_eps, key=lambda r: r["t0"])):
        if abs(e["t0"] - r["t0"]) > REC_TOL or abs(e["t1"] - r["t1"]) > REC_TOL:
            return f"{name}: bounds drift {e['t0']:.0f}/{e['t1']:.0f} vs " \
                   f"{r['t0']:.0f}/{r['t1']:.0f}"
        if e.get("drop") != r.get("drop"):
            return f"{name}: drop drift @{e['t0']:.0f} " \
                   f"{e.get('drop')} vs {r.get('drop')}"
    n_surv_rec = sum(1 for r in rec_eps if not r.get("drop"))
    if len(survivors) != n_surv_rec:
        return f"{name}: survivor count {len(survivors)} != {n_surv_rec}"
    return None


def main(cache_dir, series_dir, out_dir="data"):
    out_dir = os.path.join(HERE, out_dir)
    os.makedirs(out_dir, exist_ok=True)
    names = sorted(n[:-4] for n in os.listdir(cache_dir)
                   if n.endswith(".npz"))
    print(f"{len(names)} sidecars")

    rec_fp = os.path.join(ET, "freeze_results_tau045.json")
    record = {r["name"]: r for r in json.load(open(rec_fp))}

    def cache(n):
        return np.load(os.path.join(cache_dir, n + ".npz"))

    rng = np.random.default_rng(SEED)
    order = rng.permutation(len(names))
    folds = [sorted(order[i::N_FOLDS]) for i in range(N_FOLDS)]

    ep_rows, ep_y, ep_match, ep_meta = [], [], [], []
    cy_rows, cy_match, cy_meta = [], [], []
    matches = []
    drift = []

    for fi in range(N_FOLDS):
        test = set(folds[fi])
        train_names = [names[i] for i in range(len(names)) if i not in test]
        print(f"fold {fi + 1}/{N_FOLDS}: fitting period-gap clf on "
              f"{len(train_names)} matches...")
        _, _, clf_pg = fit_models(train_names, cache, pg_only=True)
        for i in folds[fi]:
            name = names[i]
            z = cache(name)
            sfp = os.path.join(series_dir, name + ".npz")
            sz = np.load(sfp)
            (eps, survivors, env0, env1, grid, ts, med, nch, pko, dctx,
             ev, spells, n_med) = decode_match(z, sz, clf_pg)

            err = verify_vs_record(name, eps, survivors,
                                   record[name]["episodes"])
            if err:
                drift.append(err)

            med_med = float(np.nanmedian(med))
            Fko = z["Fko"]

            def geom12_at(t, grid=grid, Fko=Fko):
                gi = int(np.clip(round(t - grid[0]), 0, len(Fko) - 1))
                return Fko[gi][G12_COLS].astype(np.float64)

            goals = [float(g) for g in z["goals_clean"]]
            mi = len(matches)
            ep_X_m, cy_X_m, cy_map = extract_match(
                survivors, eps, grid, pko, dctx, ev, ts, med, nch,
                env0, env1, spells, n_med, med_med, geom12_at)
            m_eps = []
            ep_base, cy_base = len(ep_rows), len(cy_rows)
            for j, e in enumerate(survivors):
                tp = any(e["t0"] - 90.0 <= g <= e["t1"] for g in goals)
                ep_idx = ep_base + j
                ep_rows.append(ep_X_m[j])
                ep_y.append(int(tp))
                ep_match.append(mi)
                ep_meta.append(dict(t0=e["t0"], t1=e["t1"],
                                    anchor=e["anchor"]))
                subs = e["sub_anchors"]
                cyc_idx = []
                for ci, r in enumerate(cy_map[j]):
                    cyc_idx.append(cy_base + r)
                    cy_match.append(mi)
                    cy_meta.append(dict(ep=ep_idx, ci=ci, s=subs[ci]))
                m_eps.append(dict(ep_idx=ep_idx, t0=e["t0"], t1=e["t1"],
                                  anchor=e["anchor"], subs=list(subs),
                                  cy_idx=cyc_idx, tp=int(tp)))
            cy_rows.extend(cy_X_m)
            matches.append(dict(name=name, fold=fi + 1,
                                band=band(float(z["L"])),
                                L=float(z["L"]), W=float(z["W"]),
                                goals=goals, survivors=m_eps))
        print(f"  fold {fi + 1} done ({len(matches)} matches total, "
              f"{len(ep_rows)} episodes, {len(cy_rows)} cycles)")

    print(f"\ndecode verification vs freeze_results_tau045.json: "
          f"{len(drift)} matches drifted")
    for d in drift[:10]:
        print("  DRIFT:", d)

    np.savez_compressed(
        os.path.join(out_dir, "veo_dataset.npz"),
        ep_X=np.array(ep_rows, np.float64), ep_y=np.array(ep_y, np.int8),
        ep_match=np.array(ep_match, np.int32),
        cy_X=np.array(cy_rows, np.float64),
        cy_match=np.array(cy_match, np.int32),
        cy_s=np.array([c["s"] for c in cy_meta], np.float64),
        cy_ep=np.array([c["ep"] for c in cy_meta], np.int32),
        cy_ci=np.array([c["ci"] for c in cy_meta], np.int32),
    )
    with open(os.path.join(out_dir, "veo_matches.json"), "w") as f:
        json.dump(dict(matches=matches, drift=drift, ep_keys=EP_KEYS,
                       cy_keys=CY_KEYS), f)
    print(f"saved -> {out_dir}/veo_dataset.npz + veo_matches.json")
    print(f"episodes {len(ep_rows)} (TP {sum(ep_y)}), cycles {len(cy_rows)}")


if __name__ == "__main__":
    out = "data"
    if "--out" in sys.argv:
        out = sys.argv[sys.argv.index("--out") + 1]
    main(sys.argv[1], sys.argv[2], out)

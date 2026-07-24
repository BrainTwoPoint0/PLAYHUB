"""Refiner train + OOF eval on the Veo dataset (team-free arm).

Confidence: per-episode P(TP90), match-grouped 5-fold OOF (the freeze's
fold assignment, stored in the dataset) -> re-rank survivors -> P@4/R@8
vs span-alone (the live baseline: 0.492 locked / 0.497 same-decode).

Localizer: per-cycle goal-offset regression (delta = sub_anchor - goal),
OOF -> per-goal |err| vs the shipped sub-anchor-20 estimator.

Run: python train_eval.py [--data data] [--save-final]
--save-final also fits both models on ALL 236 matches and pickles them
(the Spiideo stamp evaluator's models — lock step).
"""
from __future__ import annotations

import hashlib
import json
import os
import sys

import joblib
import numpy as np
from sklearn.ensemble import (HistGradientBoostingClassifier,
                              HistGradientBoostingRegressor)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from features import match_goal, EP_ABS_DCTX, CY_ABS_DCTX  # noqa: E402

SEED = 7
CLF_PARAMS = dict(max_iter=300, learning_rate=0.06, max_leaf_nodes=31,
                  min_samples_leaf=40, random_state=SEED)
REG_PARAMS = dict(loss="absolute_error", max_iter=400, learning_rate=0.06,
                  max_leaf_nodes=31, min_samples_leaf=30, random_state=SEED)
PRED_CLIP = (-30.0, 90.0)
BASE_DELTA = 20.0


def load(data_dir):
    d = np.load(os.path.join(HERE, data_dir, "veo_dataset.npz"))
    meta = json.load(open(os.path.join(HERE, data_dir, "veo_matches.json")))
    return d, meta


def variant_cols(meta, variant):
    """Column indices for a feature variant. 'full' = everything;
    'norm_only' drops the absolute stoppage-calibration features (the
    protocol addendum's transfer-safe form)."""
    ep_keys, cy_keys = meta["ep_keys"], meta["cy_keys"]
    if variant == "full":
        return list(range(len(ep_keys))), list(range(len(cy_keys)))
    ep = [i for i, k in enumerate(ep_keys) if k not in EP_ABS_DCTX]
    cy = [i for i, k in enumerate(cy_keys) if k not in CY_ABS_DCTX]
    return ep, cy


def rank_eval(matches, ep_score, label, ks=(4, 8)):
    """P@K / R@K under score-desc ranking (freeze summarize semantics:
    P@K over top-K survivors not-FP by the 90s rule; R@K per-goal min rank
    of a hit45 episode)."""
    out = {}
    for key in ("ALL", "medium", "full", "small"):
        rs = [m for m in matches if key == "ALL" or m["band"] == key]
        if not rs:
            continue
        res = {}
        for K in ks:
            hits = tot = grec = n_g = 0
            for m in rs:
                surv = sorted(m["survivors"],
                              key=lambda e: -ep_score[e["ep_idx"]])
                topk = surv[:K]
                hits += sum(e["tp"] for e in topk)
                tot += len(topk)
                rank = {e["ep_idx"]: i + 1 for i, e in enumerate(surv)}
                n_g += len(m["goals"])
                for g in m["goals"]:
                    r45 = [rank[e["ep_idx"]] for e in m["survivors"]
                           if e["t0"] - 45.0 <= g <= e["t1"]]
                    if r45 and min(r45) <= K:
                        grec += 1
            res[f"p@{K}"] = round(hits / tot, 4) if tot else None
            res[f"r@{K}"] = round(grec / n_g, 4) if n_g else None
        res["matches"] = len(rs)
        out[key] = res
    print(f"\n== {label} ==")
    for k, v in out.items():
        print(f"  {k:7s} {v}")
    return out


def confidence(d, meta, ep_cols, label=""):
    matches = meta["matches"]
    ep_X, ep_y, ep_match = d["ep_X"][:, ep_cols], d["ep_y"], d["ep_match"]
    fold_of = np.array([matches[mi]["fold"] for mi in ep_match])
    oof = np.full(len(ep_y), np.nan)
    for f in range(1, 6):
        tr, te = fold_of != f, fold_of == f
        clf = HistGradientBoostingClassifier(**CLF_PARAMS)
        clf.fit(ep_X[tr], ep_y[tr])
        oof[te] = clf.predict_proba(ep_X[te])[:, 1]
    assert np.isfinite(oof).all()

    span = np.array([e["t1"] - e["t0"] for m in matches
                     for e in m["survivors"]])
    # ep rows were appended in match order -> ep_idx aligns with this flat
    # ordering; assert it.
    flat_idx = [e["ep_idx"] for m in matches for e in m["survivors"]]
    assert flat_idx == sorted(flat_idx) == list(range(len(span)))

    r_span = rank_eval(matches, span, "span-alone (baseline, same decode)")
    r_ref = rank_eval(matches, oof,
                      f"refiner confidence (team-free, OOF{label})")
    return oof, r_span, r_ref


def localizer_pairs(matches, d):
    """(goal, cycle-row, delta) pairs via the shared matching rule."""
    cy_ep, cy_ci, cy_s = d["cy_ep"], d["cy_ci"], d["cy_s"]
    row_of = {(int(e), int(c)): i for i, (e, c) in enumerate(zip(cy_ep,
                                                                 cy_ci))}
    pairs = []       # (match_i, goal_t, cy_row, s)
    for mi, m in enumerate(matches):
        # rebuild survivor dicts for match_goal
        surv = [dict(t0=e["t0"], t1=e["t1"], anchor=e["anchor"],
                     sub_anchors=e["subs"], ep_idx=e["ep_idx"])
                for e in m["survivors"]]
        for g in m["goals"]:
            e, s = match_goal(g, surv)
            if e is None:
                continue
            ci = e["sub_anchors"].index(s) if s in e["sub_anchors"] else 0
            pairs.append((mi, g, row_of[(e["ep_idx"], ci)], s))
    return pairs


def localizer(d, meta, cy_cols, label=""):
    matches = meta["matches"]
    pairs = localizer_pairs(matches, d)
    cy_X = d["cy_X"][:, cy_cols]
    print(f"\nlocalizer: {len(pairs)} matched (goal, cycle) pairs "
          f"of {sum(len(m['goals']) for m in matches)} clean goals")

    # training rows: unique cycles, min delta (the kickoff belongs to the
    # LATEST goal before it in a compressed flurry)
    by_row = {}
    for mi, g, r, s in pairs:
        delta = s - g
        if r not in by_row or delta < by_row[r][1]:
            by_row[r] = (mi, delta)
    rows = np.array(sorted(by_row), np.int64)
    deltas = np.array([by_row[r][1] for r in rows])
    row_mi = np.array([by_row[r][0] for r in rows])
    fold_of = np.array([matches[mi]["fold"] for mi in row_mi])

    oof_delta = np.full(len(rows), np.nan)
    for f in range(1, 6):
        tr, te = fold_of != f, fold_of == f
        reg = HistGradientBoostingRegressor(**REG_PARAMS)
        reg.fit(cy_X[rows[tr]], deltas[tr])
        oof_delta[te] = np.clip(reg.predict(cy_X[rows[te]]), *PRED_CLIP)
    pred_of_row = dict(zip(rows.tolist(), oof_delta.tolist()))

    err_b, err_r = [], []
    for mi, g, r, s in pairs:
        err_b.append(abs((s - BASE_DELTA) - g))
        err_r.append(abs((s - pred_of_row[r]) - g))
    err_b, err_r = np.array(err_b), np.array(err_r)
    res = dict(n=len(err_b),
               base_med=float(np.median(err_b)),
               base_p90=float(np.percentile(err_b, 90)),
               ref_med=float(np.median(err_r)),
               ref_p90=float(np.percentile(err_r, 90)),
               delta_med=float(np.median(deltas)))
    print(f"per-goal |err| (Veo OOF{label}): sub-anchor-20 med "
          f"{res['base_med']:.2f}s p90 {res['base_p90']:.2f}s  |  refiner "
          f"med {res['ref_med']:.2f}s p90 {res['ref_p90']:.2f}s  "
          f"(true delta med {res['delta_med']:.1f}s)")
    return res


def save_final(d, meta, ep_cols, cy_cols, variant, out="models_final.pkl"):
    ep_X, ep_y = d["ep_X"][:, ep_cols], d["ep_y"]
    clf = HistGradientBoostingClassifier(**CLF_PARAMS).fit(ep_X, ep_y)
    matches = meta["matches"]
    pairs = localizer_pairs(matches, d)
    by_row = {}
    for mi, g, r, s in pairs:
        delta = s - g
        if r not in by_row or delta < by_row[r][1]:
            by_row[r] = (mi, delta)
    rows = np.array(sorted(by_row), np.int64)
    deltas = np.array([by_row[r][1] for r in rows])
    reg = HistGradientBoostingRegressor(**REG_PARAMS).fit(
        d["cy_X"][np.ix_(rows, cy_cols)], deltas)
    fp = os.path.join(HERE, out)
    joblib.dump(dict(clf=clf, reg=reg, clf_params=CLF_PARAMS,
                     reg_params=REG_PARAMS, pred_clip=PRED_CLIP,
                     base_delta=BASE_DELTA, variant=variant,
                     ep_cols=ep_cols, cy_cols=cy_cols,
                     ep_keys=meta["ep_keys"], cy_keys=meta["cy_keys"]), fp)
    sha = hashlib.sha256(open(fp, "rb").read()).hexdigest()
    print(f"\nfinal models -> {fp}\nsha256 {sha}")


def main(data_dir="data", do_save=False, variant="full"):
    d, meta = load(data_dir)
    if meta["drift"]:
        print(f"WARNING: dataset built with {len(meta['drift'])} decode "
              "drifts")
    out = {}
    for v in (("full", "norm_only") if variant == "both" else (variant,)):
        ep_cols, cy_cols = variant_cols(meta, v)
        print(f"\n########## variant: {v} (ep {len(ep_cols)} cols, "
              f"cy {len(cy_cols)} cols) ##########")
        oof, r_span, r_ref = confidence(d, meta, ep_cols, f", {v}")
        loc = localizer(d, meta, cy_cols, f", {v}")
        out[v] = dict(span=r_span, refiner=r_ref, localizer=loc)
    with open(os.path.join(HERE, "veo_oof_results.json"), "w") as f:
        json.dump(out, f, indent=2)
    if do_save:
        ep_cols, cy_cols = variant_cols(meta, variant)
        save_final(d, meta, ep_cols, cy_cols, variant)


if __name__ == "__main__":
    data_dir = "data"
    if "--data" in sys.argv:
        data_dir = sys.argv[sys.argv.index("--data") + 1]
    variant = "both"
    if "--variant" in sys.argv:
        variant = sys.argv[sys.argv.index("--variant") + 1]
    main(data_dir, "--save-final" in sys.argv, variant)

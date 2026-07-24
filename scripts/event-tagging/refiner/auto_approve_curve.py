"""Auto-approve precision curve for the PASSED confidence model (Veo
freeze OOF, norm_only variant): at confidence >= X, what precision, what
goal coverage, how many cards/match — plus the per-fold precision spread.

Product framing: auto-approve would mint a marker for every card at or
above the floor; precision = TP90 fraction of those cards, coverage =
fraction of clean goals covered (90s and 45s pre-windows) by a qualifying
card. Veo OOF only — no stamps involved.

Run: python auto_approve_curve.py
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from train_eval import load, variant_cols, CLF_PARAMS  # noqa: E402

THRESHOLDS = [0.50, 0.60, 0.70, 0.80, 0.85, 0.90, 0.95]


def oof_scores(d, meta, ep_cols):
    matches = meta["matches"]
    ep_X, ep_y = d["ep_X"][:, ep_cols], d["ep_y"]
    fold_of = np.array([matches[mi]["fold"] for mi in d["ep_match"]])
    oof = np.full(len(ep_y), np.nan)
    for f in range(1, 6):
        tr, te = fold_of != f, fold_of == f
        clf = HistGradientBoostingClassifier(**CLF_PARAMS)
        clf.fit(ep_X[tr], ep_y[tr])
        oof[te] = clf.predict_proba(ep_X[te])[:, 1]
    return oof, fold_of


def curve(matches, oof, band=None):
    rows = []
    ms = [m for m in matches if band is None or m["band"] == band]
    n_goals = sum(len(m["goals"]) for m in ms)
    n_matches = len(ms)
    for thr in THRESHOLDS:
        n_cards = tp = cov90 = cov45 = 0
        fold_tp = {f: [0, 0] for f in range(1, 6)}
        for m in ms:
            qual = [e for e in m["survivors"] if oof[e["ep_idx"]] >= thr]
            n_cards += len(qual)
            tp += sum(e["tp"] for e in qual)
            fold_tp[m["fold"]][0] += sum(e["tp"] for e in qual)
            fold_tp[m["fold"]][1] += len(qual)
            for g in m["goals"]:
                if any(e["t0"] - 90.0 <= g <= e["t1"] for e in qual):
                    cov90 += 1
                if any(e["t0"] - 45.0 <= g <= e["t1"] for e in qual):
                    cov45 += 1
        per_fold = [h / t for h, t in fold_tp.values() if t]
        rows.append(dict(
            thr=thr, cards=n_cards,
            cards_per_match=round(n_cards / n_matches, 2),
            precision=round(tp / n_cards, 3) if n_cards else None,
            fold_min=round(min(per_fold), 3) if per_fold else None,
            fold_max=round(max(per_fold), 3) if per_fold else None,
            coverage90=round(cov90 / n_goals, 3),
            coverage45=round(cov45 / n_goals, 3)))
    return rows


def main():
    d, meta = load("data")
    ep_cols, _ = variant_cols(meta, "norm_only")
    oof, _ = oof_scores(d, meta, ep_cols)
    out = {}
    for band, label in ((None, "ALL"), ("medium", "medium"),
                        ("full", "full"), ("small", "small")):
        rows = curve(meta["matches"], oof, band)
        out[label] = rows
        print(f"\n== {label} ==")
        print("  thr   cards  c/match  precision  fold-spread   cov90  "
              "cov45")
        for r in rows:
            spread = (f"{r['fold_min']}-{r['fold_max']}"
                      if r["fold_min"] is not None else "-")
            print(f"  {r['thr']:.2f}  {r['cards']:5d}  "
                  f"{r['cards_per_match']:7.2f}  "
                  f"{str(r['precision']):>9s}  {spread:>11s}  "
                  f"{r['coverage90']:.3f}  {r['coverage45']:.3f}")
    with open(os.path.join(HERE, "auto_approve_curve.json"), "w") as f:
        json.dump(out, f, indent=2)
    print("\nsaved -> auto_approve_curve.json")


if __name__ == "__main__":
    main()

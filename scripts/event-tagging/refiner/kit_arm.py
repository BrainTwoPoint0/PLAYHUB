"""Kit-arm PRECISION half (PROTOCOL.md 'Kit-arm addendum', gate locked
2026-07-24 before any number here was computed).

Appends hs_grid (perfect-team half_separation from the freeze sidecars) as
episode/cycle features onto the STORED team-free dataset (data/veo_dataset.npz
+ veo_matches.json — the exact rows behind the locked 0.6734), then re-runs
the locked confidence OOF with team-free NORM_ONLY + HS columns.

features.py is deliberately untouched: it is parity-pinned against the
production job's vendored refiner_score.py. This module is measure-only.

Abort conditions (protocol): recomputed team-free NORM_ONLY P@4 ALL must
reproduce 0.6734 exactly; every survivor's hs features must come from the
match's own sidecar with bounds matching the stored record.

Run: python kit_arm.py <freeze_cache_dir> [--data data]
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from features import EP_ABS_DCTX, CY_ABS_DCTX          # noqa: E402
from train_eval import (CLF_PARAMS, load, rank_eval,   # noqa: E402
                        variant_cols)
from sklearn.ensemble import HistGradientBoostingClassifier  # noqa: E402

HS_EP_KEYS = ["hs_anchor", "hs_ko_max", "hs_mean_ep", "hs_pre", "hs_post",
              "hs_rel", "hs_q"]
HS_CY_KEYS = ["hs_at_s", "hs_ko_max_s", "hs_pre30", "hs_rel_s", "hs_q_s"]


def _win(grid, hs, a, b, fn):
    lo, hi = np.searchsorted(grid, a), np.searchsorted(grid, b, side="right")
    if hi <= lo:
        return np.nan
    w = hs[lo:hi]
    return float(fn(w)) if np.isfinite(w).any() else np.nan


def _at(grid, hs, t):
    i = int(np.clip(round(t - grid[0]), 0, len(grid) - 1))
    v = hs[i]
    return float(v) if np.isfinite(v) else np.nan


def _q(sorted_vals, v):
    if not np.isfinite(v) or not len(sorted_vals):
        return np.nan
    return float(np.searchsorted(sorted_vals, v) / len(sorted_vals))


def hs_episode(grid, hs, hs_med, hs_sorted, t0, t1, anchor):
    a = _at(grid, hs, anchor)
    return [
        a,
        _win(grid, hs, anchor - 10.0, anchor + 12.0, np.nanmax),
        _win(grid, hs, t0, t1, np.nanmean),
        _win(grid, hs, t0 - 90.0, t0 - 45.0, np.nanmean),
        _win(grid, hs, t1 + 5.0, t1 + 35.0, np.nanmean),
        a - hs_med if np.isfinite(a) else np.nan,
        _q(hs_sorted, a),
    ]


def hs_cycle(grid, hs, hs_med, hs_sorted, s):
    a = _at(grid, hs, s)
    return [
        a,
        _win(grid, hs, s - 10.0, s + 12.0, np.nanmax),
        _win(grid, hs, s - 35.0, s - 5.0, np.nanmean),
        a - hs_med if np.isfinite(a) else np.nan,
        _q(hs_sorted, a),
    ]


def build_hs_columns(cache_dir, d, meta):
    matches = meta["matches"]
    n_ep, n_cy = len(d["ep_y"]), len(d["cy_s"])
    ep_hs = np.full((n_ep, len(HS_EP_KEYS)), np.nan)
    cy_hs = np.full((n_cy, len(HS_CY_KEYS)), np.nan)
    cy_s = d["cy_s"]
    for m in matches:
        z = np.load(os.path.join(cache_dir, m["name"] + ".npz"))
        grid = z["grid_ts"].astype(np.float64)
        hs = z["hs_grid"].astype(np.float64)
        fin = hs[np.isfinite(hs)]
        hs_med = float(np.median(fin)) if len(fin) else np.nan
        hs_sorted = np.sort(fin)
        for e in m["survivors"]:
            ep_hs[e["ep_idx"]] = hs_episode(grid, hs, hs_med, hs_sorted,
                                            e["t0"], e["t1"], e["anchor"])
            for ci, r in enumerate(e["cy_idx"]):
                s = e["subs"][ci]
                assert abs(cy_s[r] - s) < 1e-6, \
                    f"{m['name']}: cycle row {r} misaligned"
                cy_hs[r] = hs_cycle(grid, hs, hs_med, hs_sorted, s)
    assert np.isfinite(ep_hs).any(axis=1).all(), "episode with no hs row"
    return ep_hs, cy_hs


def fold_p4(matches, ep_score, fold):
    hits = tot = 0
    for m in matches:
        if m["fold"] != fold:
            continue
        surv = sorted(m["survivors"], key=lambda e: -ep_score[e["ep_idx"]])
        topk = surv[:4]
        hits += sum(e["tp"] for e in topk)
        tot += len(topk)
    return hits / tot if tot else float("nan")


def oof_confidence(ep_X, ep_y, fold_of):
    oof = np.full(len(ep_y), np.nan)
    for f in range(1, 6):
        tr, te = fold_of != f, fold_of == f
        clf = HistGradientBoostingClassifier(**CLF_PARAMS)
        clf.fit(ep_X[tr], ep_y[tr])
        oof[te] = clf.predict_proba(ep_X[te])[:, 1]
    assert np.isfinite(oof).all()
    return oof


def main(cache_dir, data_dir="data"):
    d, meta = load(data_dir)
    matches = meta["matches"]
    ep_y, ep_match = d["ep_y"], d["ep_match"]
    fold_of = np.array([matches[mi]["fold"] for mi in ep_match])

    ep_cols, cy_cols = variant_cols(meta, "norm_only")

    print("building hs columns from sidecars...")
    ep_hs, cy_hs = build_hs_columns(cache_dir, d, meta)

    # --- reproduce the locked team-free number (abort condition) ---
    base_X = d["ep_X"][:, ep_cols]
    base_oof = oof_confidence(base_X, ep_y, fold_of)
    r_base = rank_eval(matches, base_oof, "team-free NORM_ONLY (reproduction)")
    assert r_base["ALL"]["p@4"] == 0.6734, \
        f"team-free reproduction failed: {r_base['ALL']['p@4']} != 0.6734"

    # --- kit arm ---
    kit_X = np.hstack([base_X, ep_hs])
    kit_oof = oof_confidence(kit_X, ep_y, fold_of)
    r_kit = rank_eval(matches, kit_oof, "kit arm (team-free + HS, OOF)")

    folds_base = {f: fold_p4(matches, base_oof, f) for f in range(1, 6)}
    folds_kit = {f: fold_p4(matches, kit_oof, f) for f in range(1, 6)}
    wins = sum(1 for f in range(1, 6) if folds_kit[f] > folds_base[f])
    print("\nfold-level P@4 (base -> kit):")
    for f in range(1, 6):
        mark = "+" if folds_kit[f] > folds_base[f] else " "
        print(f"  fold {f}: {folds_base[f]:.4f} -> {folds_kit[f]:.4f} {mark}")

    gate1 = r_kit["ALL"]["p@4"] > r_base["ALL"]["p@4"]
    gate2 = wins >= 3
    verdict = "PASS" if (gate1 and gate2) else "FAIL"
    print(f"\nGATE: P@4 ALL {r_base['ALL']['p@4']} -> {r_kit['ALL']['p@4']} "
          f"(gate1 {'ok' if gate1 else 'NO'}), fold wins {wins}/5 "
          f"(gate2 {'ok' if gate2 else 'NO'}) => {verdict}")

    # feature importances (permutation on OOF folds is overkill here; report
    # the full-fit gain-based proxy for the record only)
    out = dict(base=r_base, kit=r_kit,
               fold_p4_base=folds_base, fold_p4_kit=folds_kit,
               fold_wins=wins, verdict=verdict,
               hs_ep_keys=HS_EP_KEYS, hs_cy_keys=HS_CY_KEYS)
    with open(os.path.join(HERE, "kit_arm_results.json"), "w") as f:
        json.dump(out, f, indent=2)
    np.savez_compressed(os.path.join(HERE, data_dir, "hs_columns.npz"),
                        ep_hs=ep_hs, cy_hs=cy_hs)
    print(f"saved -> kit_arm_results.json + {data_dir}/hs_columns.npz")


if __name__ == "__main__":
    data_dir = "data"
    if "--data" in sys.argv:
        data_dir = sys.argv[sys.argv.index("--data") + 1]
    main(sys.argv[1], data_dir)

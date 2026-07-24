"""THE ONE-LOOK stamp eval (protocol: run once, after model lock).

Scores the locked refiner localizer vs the shipped sub-anchor-20 estimator
on the human_scrub goal-moment stamps, on the SAME reproduced production
decode, paired per stamp. Primary set = the locked-131 corpus (the 8
matches named in the 2026-07-23 plan); the newer 9th match is reported as
a sensitivity superset. Pre-locked paired bootstrap (B=10k, rng(7), 95%
percentile CI on median(|err_base|) - median(|err_ref|)); secondary
by-match cluster bootstrap. Gate: refiner med < 5s AND CI low > 0.

Run: python stamp_eval.py   (expects data/stamps.json + models_final.pkl)
"""
from __future__ import annotations

import json
import os
import sys

import joblib
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from features import match_goal  # noqa: E402
from spiideo_features import load_match_features  # noqa: E402

DATA = os.path.join(HERE, "data")
B = 10_000


def boot_ci(err_b, err_r, groups=None):
    rng = np.random.default_rng(7)
    n = len(err_b)
    deltas = np.empty(B)
    if groups is None:
        for i in range(B):
            idx = rng.integers(0, n, n)
            deltas[i] = np.median(err_b[idx]) - np.median(err_r[idx])
    else:
        uniq = sorted(set(groups))
        by_g = {g: np.where(np.array(groups) == g)[0] for g in uniq}
        for i in range(B):
            gs = rng.choice(uniq, len(uniq), replace=True)
            idx = np.concatenate([by_g[g] for g in gs])
            deltas[i] = np.median(err_b[idx]) - np.median(err_r[idx])
    return float(np.percentile(deltas, 2.5)), float(np.percentile(deltas,
                                                                  97.5))


def main():
    art = joblib.load(os.path.join(HERE, "models_final.pkl"))
    reg, cy_cols = art["reg"], art["cy_cols"]
    clip = art["pred_clip"]
    base_delta = art["base_delta"]
    print(f"locked model variant: {art['variant']}")

    stamps = json.load(open(os.path.join(DATA, "stamps.json")))
    manifest = {m["rec"]: m for m in
                json.load(open(os.path.join(DATA, "spiideo_matches.json")))}

    rows = []      # (rec, stamp, err_base, err_ref, locked131)
    excluded = 0
    for rec, g_list in stamps.items():
        ep_X, cy_X, survivors, meta = load_match_features(rec)
        locked = manifest[rec]["locked131"]
        for g in g_list:
            e, s = match_goal(g, survivors)
            if e is None:
                excluded += 1
                continue
            ci = (e["sub_anchors"].index(s) if s in e["sub_anchors"]
                  else 0)
            x = cy_X[e["cy_rows"][ci]][cy_cols]
            dh = float(np.clip(reg.predict(x[None])[0], *clip))
            rows.append((rec, g, abs((s - base_delta) - g),
                         abs((s - dh) - g), locked))

    def report(label, rs):
        eb = np.array([r[2] for r in rs])
        er = np.array([r[3] for r in rs])
        gr = [r[0] for r in rs]
        lo, hi = boot_ci(eb, er)
        clo, chi = boot_ci(eb, er, groups=gr)
        med_r = float(np.median(er))
        print(f"\n== {label} (n={len(rs)}, "
              f"{len(set(gr))} matches) ==")
        print(f"  sub-anchor-20 |err|: med {np.median(eb):.2f}s  "
              f"p90 {np.percentile(eb, 90):.2f}s")
        print(f"  refiner       |err|: med {med_r:.2f}s  "
              f"p90 {np.percentile(er, 90):.2f}s")
        print(f"  paired bootstrap dMedian 95% CI: [{lo:.2f}, {hi:.2f}]  "
              f"(cluster-by-match: [{clo:.2f}, {chi:.2f}])")
        gate = med_r < 5.0 and lo > 0.0
        print(f"  GATE (med<5s AND CI low>0): {'PASS' if gate else 'FAIL'}")
        return dict(n=len(rs), base_med=float(np.median(eb)),
                    base_p90=float(np.percentile(eb, 90)),
                    ref_med=med_r, ref_p90=float(np.percentile(er, 90)),
                    ci=[lo, hi], cluster_ci=[clo, chi],
                    gate="PASS" if gate else "FAIL")

    out = {}
    out["locked131"] = report("PRIMARY: locked-131 corpus",
                              [r for r in rows if r[4]])
    out["all"] = report("SENSITIVITY: all stamped matches", rows)
    out["excluded_no_card"] = excluded
    print(f"\nstamps with no covering survivor card (excluded from both "
          f"arms): {excluded}")
    with open(os.path.join(HERE, "stamp_eval_results.json"), "w") as f:
        json.dump(out, f, indent=2)
    print("saved -> stamp_eval_results.json")


if __name__ == "__main__":
    main()

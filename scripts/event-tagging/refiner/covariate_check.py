"""Label-free covariate check (protocol addendum, rule pre-declared):

If the Spiideo per-match MEDIAN of the absolute dctx level features
(cycle dctx_m30; episode dctx_mean_ep) falls outside the Veo training
[q05, q95] on >= half of the stamped matches -> ship NORM-ONLY.
No stamps are read here.

Run: python covariate_check.py
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from features import EP_KEYS, CY_KEYS  # noqa: E402
from spiideo_features import load_match_features  # noqa: E402

DATA = os.path.join(HERE, "data")


def main():
    d = np.load(os.path.join(DATA, "veo_dataset.npz"))
    i_ep = EP_KEYS.index("dctx_mean_ep")
    i_cy = CY_KEYS.index("dctx_m30")
    veo_ep = d["ep_X"][:, i_ep]
    veo_cy = d["cy_X"][:, i_cy]
    ep_lo, ep_hi = np.nanpercentile(veo_ep, [5, 95])
    cy_lo, cy_hi = np.nanpercentile(veo_cy, [5, 95])
    print(f"Veo train bands: dctx_mean_ep [{ep_lo:.3f}, {ep_hi:.3f}]  "
          f"dctx_m30 [{cy_lo:.3f}, {cy_hi:.3f}]")

    manifest = json.load(open(os.path.join(DATA, "spiideo_matches.json")))
    out_ep = out_cy = n = 0
    for m in manifest:
        try:
            ep_X, cy_X, _, _ = load_match_features(m["rec"])
        except FileNotFoundError:
            print(f"  {m['rec'][:8]}: decode missing, skipped")
            continue
        n += 1
        me = float(np.nanmedian(ep_X[:, i_ep])) if len(ep_X) else np.nan
        mc = float(np.nanmedian(cy_X[:, i_cy])) if len(cy_X) else np.nan
        oe = not (ep_lo <= me <= ep_hi)
        oc = not (cy_lo <= mc <= cy_hi)
        out_ep += oe
        out_cy += oc
        print(f"  {m['rec'][:8]}: ep med {me:.3f} {'OUT' if oe else 'in'}  "
              f"cy med {mc:.3f} {'OUT' if oc else 'in'}")
    trip = (out_ep >= n / 2) or (out_cy >= n / 2)
    print(f"\nout-of-band matches: episode {out_ep}/{n}, cycle {out_cy}/{n}")
    print(f"DECISION (pre-declared rule): "
          f"{'NORM_ONLY' if trip else 'FULL (abs+norm)'}")


if __name__ == "__main__":
    main()

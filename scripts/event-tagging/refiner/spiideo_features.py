"""Spiideo-side feature loading — recomputes refiner features from a
banked decode (spiideo_<rec>.npz raw series + _eps.json) through the SAME
features.extract_match as the Veo dataset builder.
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
sys.path.insert(0, HERE)
sys.path.insert(0, JOB)

from period_gap import activity_dead_spells  # noqa: E402
from features import extract_match           # noqa: E402

DATA = os.path.join(HERE, "data")


def load_match_features(rec_id):
    """(ep_X, cy_X, survivors, meta) for one banked Spiideo decode.
    survivors carry sub_anchors/sub_anchor_pko/ps keys as extract_match
    and features.match_goal expect."""
    z = np.load(os.path.join(DATA, f"spiideo_{rec_id}.npz"))
    meta = json.load(open(os.path.join(DATA, f"spiideo_{rec_id}_eps.json")))
    grid = z["grid"].astype(np.float64)
    ts = z["ts"].astype(np.float64)
    med = z["med"].astype(np.float64)
    nch = z["nch"].astype(np.float64)
    pko, dctx, ev = z["pko"], z["dctx"], z["ev"]
    G12 = z["G12"]

    survivors = [dict(t0=e["t0"], t1=e["t1"], anchor=e["anchor"],
                      ps=e["ps"], pko=e["pko"], ev=e["ev"],
                      p_period=e["p_period"],
                      sub_anchors=e["subs"], sub_anchor_pko=e["sub_pko"])
                 for e in meta["survivors"]]
    all_eps = meta["all_eps"]
    spells = activity_dead_spells(ts, med)
    n_med = float(np.nanmedian(nch)) or 1.0
    med_med = float(np.nanmedian(med))

    def geom12_at(t):
        gi = int(np.clip(round(t - grid[0]), 0, len(G12) - 1))
        return G12[gi]

    ep_X, cy_X, cy_map = extract_match(
        survivors, all_eps, grid, pko, dctx, ev, ts, med, nch,
        meta["env0"], meta["env1"], spells, n_med, med_med, geom12_at)
    for i, e in enumerate(survivors):
        e["cy_rows"] = cy_map[i]
    return ep_X, cy_X, survivors, meta

"""Kickoff-classifier scoring — vendored inference-only copy.

FROZEN source: scripts/event-tagging/spiideo-goal-pilot-v2/kickoff_gate.py
(VARIANTS / rows_from_norm / feat_subset / p_kickoff), minus training and
corpus imports. kickoff_clf.pkl is a plain-pickle dict of per-variant
HistGradientBoostingClassifier; production uses 'rolefree12' (the model is
trained on the 12-col subset directly — no column slicing at predict time).
"""
from __future__ import annotations

import pickle

import numpy as np

from restart_geometry import feats, FEATURE_KEYS

GK_FEATS = {"gk_min_dgl", "gk_cy"}
VARIANTS = {
    "full14": [k for k in FEATURE_KEYS],
    "rolefree12": [k for k in FEATURE_KEYS if k not in GK_FEATS],
    "rolefree11_non": [k for k in FEATURE_KEYS
                       if k not in GK_FEATS and k != "n"],
}


def load_models(path: str):
    with open(path, "rb") as fh:
        return pickle.load(fh)


def rows_from_norm(pts_xy):
    """[(xn, yn), ...] in [0,1] -> Veo player-row layout [id, role, x, y] with
    a synthetic outfield role (Spiideo detections are outfield-only)."""
    return [[i, 1, float(x), float(y)] for i, (x, y) in enumerate(pts_xy)]


def feat_subset(players, keys):
    f = feats(players)
    if f is None:
        return None
    return [f[k] for k in keys]


def p_kickoff(pts_xy, models, variant="rolefree12"):
    """P(kick_off) for a candidate's normalized outfield positions."""
    keys = VARIANTS[variant]
    v = feat_subset(rows_from_norm(pts_xy), keys)
    if v is None:
        return 0.0
    clf = models[variant]
    proba = clf.predict_proba(np.asarray(v, float)[None])[0]
    j = list(clf.classes_).index("kick_off")
    return float(proba[j])

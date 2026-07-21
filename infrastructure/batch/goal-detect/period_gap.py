"""Period-kickoff filter features — vendored inference-only copy.

FROZEN source: scripts/event-tagging/period_gap_model.py
(activity_dead_spells + kickoff_features + FEATS), minus training and corpus
imports. period_gap_clf.pkl (joblib {clf, feats}) was trained on exactly
these features (held-out Veo GT: period recall 0.95 @ precision 0.96, kills
1% of post-goal kickoffs) — do not edit.
"""
from __future__ import annotations

import numpy as np

ROLL_S = 20.0
ACT_PCTL = 40
FEATS = ["dead_dur", "since_live", "pos", "n_trail", "n_min"]


def activity_dead_spells(ts, med):
    step = float(np.median(np.diff(ts))) or 0.4
    k = max(1, int(round(ROLL_S / step)))
    a = np.where(np.isfinite(med), med, np.nanmedian(med))
    roll = np.convolve(a, np.ones(k) / k, mode="same")
    thr = float(np.nanpercentile(roll, ACT_PCTL))
    dead = roll < thr
    spells = []
    i, n = 0, len(ts)
    while i < n:
        if dead[i]:
            j = i
            while j < n and dead[j]:
                j += 1
            spells.append((ts[i], ts[min(j, n - 1)]))
            i = j
        else:
            i += 1
    return spells


def kickoff_features(t, ts, med, nch, spells, env0, env1, n_med):
    dead_dur = 0.0
    since_live = 0.0
    for a, b in spells:
        if t - 240.0 <= b <= t - 2.0:
            dead_dur = max(dead_dur, b - a)
        if a <= t <= b + 2.0:          # kickoff still inside the dead spell
            dead_dur = max(dead_dur, t - a)
            since_live = t - a
    pos = float(np.clip((t - env0) / max(env1 - env0, 1.0), 0.0, 1.0))
    w60 = (ts >= t - 60) & (ts <= t - 2)
    w120 = (ts >= t - 120) & (ts <= t - 2)
    n_trail = float(np.nanmean(nch[w60]) / n_med) if w60.any() else 1.0
    n_min = float(np.nanmin(nch[w120]) / n_med) if w120.any() else 1.0
    return [min(dead_dur, 300.0), min(since_live, 300.0), pos,
            n_trail, n_min]

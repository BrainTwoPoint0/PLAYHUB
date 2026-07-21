"""Restart-geometry features — vendored inference-only copy.

FROZEN source: scripts/event-tagging/restart_features.py (feats +
FEATURE_KEYS, minus the veo_corpus import and the analysis main). The
kickoff classifier (kickoff_clf.pkl, variant 'rolefree12') was trained on
vectors produced by exactly this function — do not edit; a drift here
silently mis-scores every candidate.
"""
from __future__ import annotations

import statistics as st

GK_ROLES = (0, 2)


def feats(players):
    """Geometry features from player rows (normalized xNorm,yNorm at cols 2,3;
    role at col 1). Role-aware keys are computed but unused by rolefree12."""
    if len(players) < 4:
        return None
    xs = [r[2] for r in players]
    ys = [r[3] for r in players]
    gks = [(r[2], r[3]) for r in players if r[1] in GK_ROLES]
    gk_min_dgl = min((min(x, 1 - x) for x, y in gks), default=0.5)
    gk_cy = min(gks, key=lambda p: min(p[0], 1 - p[0]))[1] if gks else 0.5
    dgl = [min(x, 1 - x) for x in xs]
    dtl = [min(y, 1 - y) for y in ys]
    i_tl = min(range(len(players)), key=lambda i: dtl[i])
    i_corner = min(range(len(players)), key=lambda i: dgl[i] + dtl[i])
    cx, cy = st.mean(xs), st.mean(ys)
    dist_center = min(((x - 0.5) ** 2 + (y - 0.5) ** 2) ** 0.5
                      for x, y in zip(xs, ys))
    return {
        "n": len(players),
        "min_dtl": min(dtl),
        "min_dgl": min(dgl),
        "corner_dgl": dgl[i_corner],
        "corner_dtl": dtl[i_corner],
        "tl_gl": dgl[i_tl],
        "frac_left": sum(1 for x in xs if x < 0.5) / len(xs),
        "cx": cx, "cy": cy,
        "spread_x": st.pstdev(xs), "spread_y": st.pstdev(ys),
        "gk_min_dgl": gk_min_dgl,
        "gk_cy": gk_cy,
        "dist_center": dist_center,
    }


FEATURE_KEYS = [
    "n", "min_dtl", "min_dgl", "corner_dgl", "corner_dtl", "tl_gl",
    "frac_left", "cx", "cy", "spread_x", "spread_y",
    "gk_min_dgl", "gk_cy", "dist_center",
]

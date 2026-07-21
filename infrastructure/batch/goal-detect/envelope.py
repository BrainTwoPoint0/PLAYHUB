"""Match-envelope play blocks — vendored inference-only copy.

FROZEN source: scripts/event-tagging/stoppage_envelope_veo.py
(blocks_from_activity + constants), validated on Veo `match_ongoing` GT.
The envelope END (last block) is used; the longest-gap-halftime rule was
FALSIFIED at scale (35%) and is deliberately absent — period kickoffs are
handled by the trained period-gap classifier instead.
"""
from __future__ import annotations

import numpy as np

BLOCK_WIN_S = 20.0
MERGE_GAP_S = 90.0
MIN_BLOCK_S = 120.0


def blocks_from_activity(ts, act):
    step = float(np.median(np.diff(ts))) or 0.4
    k = max(1, int(round(BLOCK_WIN_S / step)))
    a = np.where(np.isfinite(act), act, np.nanmedian(act))
    roll = np.convolve(a, np.ones(k) / k, mode="same")
    thr = float(np.nanpercentile(roll, 40))
    live = roll > thr
    blocks = []
    i, n = 0, len(ts)
    while i < n:
        if live[i]:
            j = i
            while j < n and live[j]:
                j += 1
            blocks.append([ts[i], ts[j - 1]])
            i = j
        else:
            i += 1
    merged = []
    for b in blocks:
        if merged and b[0] - merged[-1][1] <= MERGE_GAP_S:
            merged[-1][1] = b[1]
        else:
            merged.append(b)
    return [b for b in merged if b[1] - b[0] >= MIN_BLOCK_S]

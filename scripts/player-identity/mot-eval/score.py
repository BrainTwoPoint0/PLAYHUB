"""Score stitched chains against Veo GT: HOTA/CLEAR/Identity + the
per-T identity-persistence curve.

Uses ONLY trackers.eval's in-memory metric functions (similarity-
agnostic, TrackEval-parity). The file-based evaluate_mot_* path is
IoU-on-boxes with MOTChallenge pedestrian-class filtering — never used.

Similarity: Euclidean, sim = max(0, 1 - d / (2*gate_m)) so the 0.5
threshold (CLEAR/Identity default, HOTA's middle alpha) sits exactly at
gate_m. Frames match by EXACT int64 microseconds — synthetic fragment
timestamps are subsets of the GT lattice and build_track.stitch() only
concatenates, so no interpolation exists in this path.

Per-T curve (the product metric): for each (gt id g, instant t0 where a
chain c is Hungarian-matched to g), the outcome at t0+T is
    RIGHT  — c (lerped within its span) is within gate of g,
    WRONG  — c is within gate of a DIFFERENT gt id and not of g,
    LOST   — c's span ended before t0+T (the honest outcome),
skipping pairs where g itself is unsampled at t0+T (can't judge).
P(right) is the headline; P(wrong) is the ship veto — wrong bridges are
the failure precision must veto (ceiling_eval doctrine). Within-chain
gaps count via lerp because the client renders a bridged chain
continuously; a wrong bridge SHOULD therefore show up here as WRONG.
"""
from __future__ import annotations

from collections import defaultdict

import numpy as np
from scipy.optimize import linear_sum_assignment

GATE_M = 1.0
PER_T_S = (5.0, 15.0, 30.0, 60.0)


def gt_frame_table(runs: list) -> dict:
    """{t_us: (gid array, xy Nx2)} from GT runs."""
    acc = defaultdict(list)
    for gid, ts, xy in runs:
        for i in range(len(ts)):
            acc[int(ts[i])].append((gid, xy[i]))
    return {t: (np.asarray([g for g, _ in v], int),
                np.asarray([p for _, p in v], float))
            for t, v in acc.items()}


def chain_frame_table(chains: list) -> dict:
    """{t_us: (cid array, xy Nx2)} from stitched chains (cid = index)."""
    acc = defaultdict(list)
    for cid, (ts, xy) in enumerate(chains):
        for i in range(len(ts)):
            acc[int(ts[i])].append((cid, xy[i]))
    return {t: (np.asarray([c for c, _ in v], int),
                np.asarray([p for _, p in v], float))
            for t, v in acc.items()}


def _sim(gxy: np.ndarray, cxy: np.ndarray, gate_m: float) -> np.ndarray:
    d = np.linalg.norm(gxy[:, None, :] - cxy[None, :, :], axis=2)
    return np.maximum(0.0, 1.0 - d / (2.0 * gate_m))


def run_metrics(gt_tab: dict, ch_tab: dict, gate_m: float = GATE_M) -> dict:
    from trackers.eval import (compute_clear_metrics, compute_hota_metrics,
                               compute_identity_metrics)
    frames = sorted(gt_tab)
    gt_ids, tr_ids, sims = [], [], []
    for t in frames:
        gids, gxy = gt_tab[t]
        if t in ch_tab:
            cids, cxy = ch_tab[t]
        else:
            cids, cxy = np.asarray([], int), np.zeros((0, 2))
        gt_ids.append(gids)
        tr_ids.append(cids)
        sims.append(_sim(gxy, cxy, gate_m) if len(cids) else
                    np.zeros((len(gids), 0)))
    hota = compute_hota_metrics(gt_ids, tr_ids, sims)
    clear = compute_clear_metrics(gt_ids, tr_ids, sims, threshold=0.5)
    ident = compute_identity_metrics(gt_ids, tr_ids, sims, threshold=0.5)
    return {'hota': hota, 'clear': clear, 'identity': ident}


def _matches_at(gt_tab, ch_tab, t, gate_m):
    """{gid: cid} Hungarian matching at one frame."""
    if t not in gt_tab or t not in ch_tab:
        return {}
    gids, gxy = gt_tab[t]
    cids, cxy = ch_tab[t]
    if len(gids) == 0 or len(cids) == 0:
        return {}
    d = np.linalg.norm(gxy[:, None, :] - cxy[None, :, :], axis=2)
    ri, ci = linear_sum_assignment(d)
    return {int(gids[a]): int(cids[b]) for a, b in zip(ri, ci)
            if d[a, b] <= gate_m}


def _chain_pos(chain, t_us):
    """Lerped chain position at t_us if within span, else None."""
    ts, xy = chain
    if t_us < ts[0] or t_us > ts[-1]:
        return None
    i = int(np.searchsorted(ts, t_us))
    if i < len(ts) and ts[i] == t_us:
        return xy[i]
    lo, hi = i - 1, i
    w = (t_us - ts[lo]) / max(ts[hi] - ts[lo], 1)
    return xy[lo] * (1 - w) + xy[hi] * w


def per_t_curve(gt_tab: dict, ch_tab: dict, chains: list,
                gate_m: float = GATE_M, horizons=PER_T_S,
                stride: int = 5) -> dict:
    """{T: {'right': p, 'wrong': p, 'lost': p, 'n': count}}.
    t0 = every stride-th GT frame where a chain is matched (product taps
    are arbitrary instants; stride keeps runtime sane without bias)."""
    frames = sorted(gt_tab)
    pos_of = {t: i for i, t in enumerate(frames)}
    out = {T: {'right': 0, 'wrong': 0, 'lost': 0, 'n': 0} for T in horizons}
    for t0 in frames[::stride]:
        m0 = _matches_at(gt_tab, ch_tab, t0, gate_m)
        if not m0:
            continue
        for T in horizons:
            # step by frame INDEX (round T to the 0.4s lattice); the int64
            # keys carry float-truncation jitter, so arithmetic t0+T*1e6
            # would miss. Skip when a period gap lands inside the horizon.
            p1 = pos_of[t0] + int(round(T / 0.4))
            if p1 >= len(frames):
                continue
            t1 = frames[p1]
            if abs((t1 - t0) / 1e6 - T) > 0.5:
                continue  # gap/period boundary inside the horizon
            gids1, gxy1 = gt_tab[t1]
            gpos = {int(g): gxy1[i] for i, g in enumerate(gids1)}
            for g, c in m0.items():
                if g not in gpos:
                    continue  # gt unsampled at t1 — can't judge
                pos = _chain_pos(chains[c], t1)
                out[T]['n'] += 1
                if pos is None:
                    out[T]['lost'] += 1
                    continue
                d_self = float(np.hypot(*(pos - gpos[g])))
                if d_self <= gate_m:
                    out[T]['right'] += 1
                    continue
                d_other = min(
                    (float(np.hypot(*(pos - p))) for gg, p in gpos.items()
                     if gg != g), default=np.inf)
                if d_other <= gate_m:
                    out[T]['wrong'] += 1
                else:
                    out[T]['lost'] += 1
    for T in horizons:
        n = max(out[T]['n'], 1)
        for k in ('right', 'wrong', 'lost'):
            out[T][k] = round(out[T][k] / n, 4)
    return out


def smoke_test():
    """Hand-computable 2-player crossing: A and B walk toward each other,
    tracker follows A then jumps to B at the crossing (a wrong bridge).
    Expected: IDF1 well below 1, per-T WRONG > 0 at T past the crossing."""
    t = (np.arange(0, 100) * 0.4e6).astype(np.int64)
    ax = np.stack([np.linspace(0, 40, 100), np.full(100, 10.0)], axis=1)
    bx = np.stack([np.linspace(40, 0, 100), np.full(100, 10.0)], axis=1)
    runs = [(0, t, ax), (1, t, bx)]
    gt_tab = gt_frame_table(runs)
    # tracker: chain 0 swaps A->B at the crossing (wrong bridge); chain 1
    # honestly ENDS at the crossing (the lost outcome)
    swap = np.concatenate([ax[:50], bx[50:]])
    chains = [(t, swap), (t[:50], bx[:50])]
    ch_tab = chain_frame_table(chains)
    m = run_metrics(gt_tab, ch_tab)
    curve = per_t_curve(gt_tab, ch_tab, chains, stride=1)
    idf1 = m['identity']['IDF1']
    assert idf1 < 0.75, f'swap should depress IDF1, got {idf1}'
    # A's follower is WRONG past the crossing; B's follower is LOST
    assert curve[15.0]['wrong'] > 0.2, f'expected WRONG at T=15: {curve}'
    assert curve[15.0]['lost'] > 0.2, f'expected LOST at T=15: {curve}'
    # perfect tracker for contrast
    perfect = [(t, ax), (t, bx)]
    mp = run_metrics(gt_tab, chain_frame_table(perfect))
    assert mp['identity']['IDF1'] > 0.99 and mp['hota']['HOTA'] > 0.9
    print(f'smoke OK: swap IDF1={idf1:.3f} HOTA={m["hota"]["HOTA"]:.3f} '
          f'perfect IDF1={mp["identity"]["IDF1"]:.3f}; '
          f'T=15 {curve[15.0]}')


if __name__ == '__main__':
    smoke_test()

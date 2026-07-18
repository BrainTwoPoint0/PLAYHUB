"""Veo tracking.json -> identity ground truth for the MOT eval harness.

GT identities are JERSEY-CHAINED: Veo trackIds merged on (team, jersey)
majority reads — required, not optional, because raw trackIds live ~65s
median and the per-T curve at T=60s would otherwise have almost no valid
pairs (and the survivors would be selection-biased toward easy tracks).
Merge key uses the TEAM column, never roleTeam side — teams swap ends at
half time. Merges are guarded: overlapping same-key tracks REFUSE the
merge (two bodies reading one jersey = upstream mislabel; honest = keep
separate), and short-gap merges must pass the physical seam test
(implied speed < SEAM_SPEED_MPS, the uuid_reuse.py convention).

GT is never interpolated across Veo's own tracking gaps: runs are split
at sample gaps > MAX_GAP_S and at period boundaries, and scoring happens
only on sampled frames.
"""
from __future__ import annotations

import json
import os
from collections import Counter, defaultdict

import numpy as np

CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cache')

MAX_GAP_S = 1.2         # Veo-internal tracking gap => run boundary
SEAM_SPEED_MPS = 9.0    # physical merge guard (uuid_reuse convention)
SEAM_GUARD_MAX_GAP_S = 10.0  # beyond this the jersey IS the evidence
BALL_ROLE = 6


def load_tracking(slug: str) -> dict:
    with open(os.path.join(CACHE, f'{slug}.tracking.json')) as f:
        trk = json.load(f)
    sch = trk['schema']
    # strict: `is True`, not `is not False` — the capture job documents why
    if sch.get('scaleKnown') is not True:
        raise RuntimeError(f'{slug}: scaleKnown is not True — metric '
                           f'coordinates would be garbage')
    return trk


def grid_check(trk: dict) -> dict:
    """Assert the frame grid is the uniform 2.5Hz lattice the scorer's
    exact-timestamp matching depends on, and that (frame, trackId) pairs
    are unique. Returns stats for the record."""
    keys = sorted(float(k) for k in trk['frames'])
    diffs = np.diff(keys)
    periods = [(p['start'], p['end']) for p in trk.get('periods', [])]
    in_period_diffs = [d for k, d in zip(keys[:-1], diffs)
                       if not any(abs(k - e) < 2.0 for _, e in periods)
                       or d <= 1.0]
    med = float(np.median(diffs))
    assert abs(med - 0.4) < 0.02, f'frame spacing {med} != 0.4s lattice'
    dupes = 0
    for k, rows in trk['frames'].items():
        ids = [r[0] for r in rows if r[1] != BALL_ROLE]
        dupes += len(ids) - len(set(ids))
    assert dupes == 0, f'{dupes} duplicate (frame, trackId) pairs'
    return {'frames': len(keys), 'span_s': keys[-1] - keys[0],
            'median_spacing_s': med,
            'p99_in_period_spacing_s': float(
                np.percentile(in_period_diffs, 99)) if in_period_diffs else None}


def player_tracks(trk: dict) -> dict:
    """{trackId: (t_s array asc, xy_m Nx2, jersey array, team array)} —
    players only (roleTeam != 6)."""
    L = float(trk['schema']['pitch']['lengthM'])
    W = float(trk['schema']['pitch']['widthM'])
    per = defaultdict(list)
    for k, rows in trk['frames'].items():
        t = float(k)
        for r in rows:
            if r[1] == BALL_ROLE:
                continue
            per[r[0]].append((t, (r[2] - 0.5) * L, (r[3] - 0.5) * W,
                              int(r[4]), int(r[7])))
    out = {}
    for tid, samples in per.items():
        samples.sort()
        arr = np.asarray(samples, float)
        out[tid] = (arr[:, 0], arr[:, 1:3],
                    arr[:, 3].astype(int), arr[:, 4].astype(int))
    return out


def _majority(vals, exclude=None):
    cnt = Counter(v for v in vals if v != exclude)
    if not cnt:
        return None
    top, n = cnt.most_common(1)[0]
    return top if n * 2 > sum(cnt.values()) else None


def jersey_chain_ids(tracks: dict) -> tuple:
    """{trackId: gid} + stats. Tracks sharing a strict-majority
    (team, jersey) key merge into one GT identity when their spans don't
    overlap and short-gap seams are physically plausible; everything else
    keeps its own gid (honest)."""
    keyed = defaultdict(list)   # (team, jersey) -> [trackId]
    for tid, (ts, xy, jerseys, teams) in tracks.items():
        j = _majority(jerseys, exclude=-1)
        team = _majority(teams)
        if j is not None and team is not None:
            keyed[(team, j)].append(tid)

    gid_of = {}
    next_gid = 0
    stats = {'merged_tracks': 0, 'chains': 0, 'refused_overlap': 0,
             'refused_seam': 0, 'unlabelled': 0}

    for key, tids in keyed.items():
        tids.sort(key=lambda t: tracks[t][0][0])
        groups: list = []   # each: list of tids, non-overlapping, seam-ok
        for tid in tids:
            ts = tracks[tid][0]
            placed = False
            for g in groups:
                last = g[-1]
                lts, lxy = tracks[last][0], tracks[last][1]
                if ts[0] <= lts[-1]:            # overlap -> refuse
                    stats['refused_overlap'] += 1
                    continue
                gap = ts[0] - lts[-1]
                if gap <= SEAM_GUARD_MAX_GAP_S:
                    d = float(np.linalg.norm(tracks[tid][1][0] - lxy[-1]))
                    if d / max(gap, 0.4) > SEAM_SPEED_MPS:
                        stats['refused_seam'] += 1
                        continue
                g.append(tid)
                placed = True
                break
            if not placed:
                groups.append([tid])
        for g in groups:
            for tid in g:
                gid_of[tid] = next_gid
            stats['merged_tracks'] += len(g) - 1
            if len(g) > 1:
                stats['chains'] += 1
            next_gid += 1

    for tid in tracks:
        if tid not in gid_of:
            gid_of[tid] = next_gid
            next_gid += 1
            stats['unlabelled'] += 1
    stats['gids'] = next_gid
    return gid_of, stats


def contiguous_runs(tracks: dict, gid_of: dict, periods: list,
                    max_gap_s: float = MAX_GAP_S) -> list:
    """[(gid, ts_us int64 asc, xy_m Nx2)] — GT split at Veo's own gaps and
    at period boundaries. The synthesizer cuts WITHIN these; the scorer
    sees gaps as missing frames, never interpolated."""
    bounds = sorted((p['start'], p['end']) for p in periods)

    def period_idx(t):
        for i, (lo, hi) in enumerate(bounds):
            if lo - 0.2 <= t <= hi + 0.2:
                return i
        return -1

    runs = []
    for tid, (ts, xy, _, _) in tracks.items():
        gid = gid_of[tid]
        start = 0
        for i in range(1, len(ts) + 1):
            split = (i == len(ts)
                     or ts[i] - ts[i - 1] > max_gap_s
                     or period_idx(ts[i]) != period_idx(ts[i - 1]))
            if split:
                if i - start >= 2:
                    runs.append((gid,
                                 (ts[start:i] * 1e6).astype(np.int64),
                                 xy[start:i].copy()))
                start = i
    runs.sort(key=lambda r: r[1][0])
    return runs


def gt_stats(tracks: dict, gid_of: dict, runs: list) -> dict:
    per_gid = defaultdict(float)
    for gid, ts, _ in runs:
        per_gid[gid] += (ts[-1] - ts[0]) / 1e6
    durs = sorted(per_gid.values())
    return {'tracks': len(tracks), 'gids': len(per_gid), 'runs': len(runs),
            'gid_span_median_s': durs[len(durs) // 2] if durs else 0,
            'gid_span_p90_s': durs[int(len(durs) * 0.9)] if durs else 0}


if __name__ == '__main__':
    import sys
    for slug in sys.argv[1:]:
        trk = load_tracking(slug)
        print(slug)
        print('  grid:', grid_check(trk))
        tracks = player_tracks(trk)
        gid_of, jstats = jersey_chain_ids(tracks)
        print('  jersey-chain:', jstats)
        runs = contiguous_runs(tracks, gid_of, trk.get('periods', []))
        print('  gt:', gt_stats(tracks, gid_of, runs))

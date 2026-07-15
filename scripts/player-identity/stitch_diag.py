"""Why do chains die? Measure it before redesigning anything.

    python3 fetch_tracklets.py <game_id>
    python3 stitch_diag.py <game_id> [<game_id> ...]

Two questions, both unanswered until now:

1. NOISE (gates everything). Every threshold in build_track.py:51-56 is
   currently unjustified. AMBIGUITY_FLOOR_M = 0.5 may be SMALLER than the
   noise on the quantity it tests, in which case the best/rival ordering is a
   coin flip regardless of geometry. Estimated with difference kernels that
   annihilate smooth motion: [1,-2,1] (kills constant velocity, Var = 6*sigma^2)
   and [1,-4,6,-4,1] (kills up to cubic, Var = 70*sigma^2). If the two agree,
   real acceleration is not contaminating the estimate. The lag-1/lag-2
   autocorrelation of the 2nd difference has a known white-noise signature
   (-2/3, +1/6); departures toward 0 mean the residual is slow bias, not white
   measurement noise.

2. DEATH TAXONOMY. Every chain death is (a) no candidate at all, (b) killed by
   a hard gate, (c) refused by the ambiguity margin, or (d) its head was taken
   by a better bridge. All four are derived from (candidates, edges, next_of)
   — production stitch() carries no debug code. The published finding is that
   59% of deaths happen with another player near; the OTHER ~64% of deaths are
   uninvestigated and, per the attributable-fraction arithmetic, are the
   majority of the problem.

Everything runs in Spiideo's METRIC space — H is only applied at publish time
(build_track.py:438), so the corner non-planarity finding is irrelevant here.
"""
import json, os, sys

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    '../../infrastructure/batch/player-tracklets'))
import numpy as np
import build_track
import solve_h

OUT = os.path.dirname(os.path.abspath(__file__))
CACHE = f'{OUT}/cache'
NEAR_M = 2.0        # "another player was right there" at the moment of death
REACH_MS = 7.0      # m/s a player could plausibly cover during a gap
GAP_BINS = [0.2, 0.4, 0.6, 0.8, 1.0, 1.2, 1.5, 2.0, 3.0, 5.0, 10.0]


def load(game: str):
    streams = json.load(open(f'{CACHE}/{game}_streams.json'))
    items = [(i, r.encode())
             for i, r in json.load(open(f'{CACHE}/{game}_trk.json'))]
    cad = build_track.estimate_cadence_us(streams['tracklets'], items)
    frags = build_track.parse_items(items, streams['start_time_us'], cad)
    lo, hi = solve_h.pitch_rect_metric(frags)
    on = build_track.filter_on_pitch(frags, lo, hi)
    return streams, cad, sorted(on, key=lambda f: int(f[0][0]))


# ── 1. noise ─────────────────────────────────────────────────────────────────

def _mad_sigma(v: np.ndarray, kernel_var: float) -> float:
    """Robust sigma from a motion-annihilating difference series."""
    if len(v) < 8:
        return np.nan
    return float(np.median(np.abs(v - np.median(v))) * 1.4826
                 / np.sqrt(kernel_var))


def noise_report(frags: list) -> None:
    d2, d4 = [], []
    for ts, xy in frags:
        # uniform sampling only: a bridged/irregular step breaks the kernel
        if len(ts) < 12 or np.ptp(np.diff(ts)) > 1000:
            continue
        for ax in (0, 1):
            x = xy[:, ax]
            d2.append(x[2:] - 2 * x[1:-1] + x[:-2])
            d4.append(x[4:] - 4 * x[3:-1] + 6 * x[2:-2] - 4 * x[1:-3] + x[:-4])
    if not d2:
        print('  (no uniformly-sampled fragments long enough)')
        return
    a2 = np.concatenate(d2)
    a4 = np.concatenate(d4)
    s2, s4 = _mad_sigma(a2, 6.0), _mad_sigma(a4, 70.0)
    # white-noise signature of the [1,-2,1] kernel: r1 = -2/3, r2 = +1/6
    c = a2 - a2.mean()
    denom = float(c @ c)
    r1 = float(c[:-1] @ c[1:]) / denom
    r2 = float(c[:-2] @ c[2:]) / denom
    print(f'  sigma (2nd diff, kills linear motion) : {s2:.3f} m')
    print(f'  sigma (4th diff, kills cubic motion)  : {s4:.3f} m')
    print(f'  2nd-diff autocorr  lag1 {r1:+.3f} (white: -0.667)   '
          f'lag2 {r2:+.3f} (white: +0.167)')
    verdict = ('WHITE — measurement noise' if r1 < -0.55
               else 'NOT white — slow bias / real motion dominates')
    print(f'  -> {verdict}')
    # sigma on d_fwd: head position + tail prediction, each ~sigma, over a gap
    sg = s4 if not np.isnan(s4) else s2
    print(f'  sigma(d_fwd) ~ {sg*np.sqrt(2):.2f} m at gap->0  vs '
          f'AMBIGUITY_FLOOR_M = {build_track.AMBIGUITY_FLOOR_M}')


# ── 2. deaths ────────────────────────────────────────────────────────────────

def _pos_at(frag, t: int):
    ts, xy = frag
    if t < ts[0] or t > ts[-1]:
        return None
    return np.array([np.interp(t, ts, xy[:, 0]), np.interp(t, ts, xy[:, 1])])


def death_report(frags: list, cad_us: int, streams: dict) -> dict:
    n = len(frags)
    cands = build_track.stitch_candidates(frags)
    wide = build_track.stitch_candidates(frags, max_gap_s=10.0)
    edges = build_track.stitch_edges(frags)
    next_of = build_track.stitch_assign(n, edges)
    prev_of = {j: i for i, j in next_of.items()}
    live = next_of

    by_end: dict[int, list] = {}
    for c in cands:
        by_end.setdefault(c[0], []).append(c)
    wide_by_end: dict[int, list] = {}
    for c in wide:
        wide_by_end.setdefault(c[0], []).append(c)
    e_by_end: dict[int, list] = {}
    for d, i, j in edges:
        e_by_end.setdefault(i, []).append((d, j))

    stop = streams['tracklets'].get('stopTime')
    t_end = int(stop) if stop is not None else max(int(f[0][-1]) for f in frags)
    starts = np.array([int(f[0][0]) for f in frags])
    ends = np.array([int(f[0][-1]) for f in frags])

    buckets = {'a_no_candidate': 0, 'b_gate_distance': 0, 'b_gate_velocity': 0,
               'b_gate_reverse': 0, 'c_ambiguity': 0, 'd_claimed': 0}
    near_split: dict[str, list] = {k: [] for k in buckets}
    gaps, dv_spread = [], []

    deaths = [i for i in range(n)
              if i not in next_of
              and int(frags[i][0][-1])
              < t_end - int(build_track.STITCH_EXT_GAP_S * 1e6)]

    for i in deaths:
        t = int(frags[i][0][-1])
        # bucket
        if i in e_by_end:
            targets = e_by_end[i]
            if any(j not in prev_of or prev_of[j] == i for _, j in targets):
                key = 'c_ambiguity'
            else:
                key = 'd_claimed'
            if len(targets) >= 2:
                ds = sorted(targets)[:2]
                dv_of = {(cc[0], cc[1]): cc[5] for cc in by_end.get(i, [])}
                v0 = dv_of.get((i, ds[0][1]))
                v1 = dv_of.get((i, ds[1][1]))
                if v0 is not None and v1 is not None:
                    dv_spread.append(abs(v0 - v1))
        elif i in by_end:
            best = min(by_end[i], key=lambda c: c[3])
            _, _, gap, d_fwd, d_back, dv = best
            # production's own gate — never re-derive it here, or this
            # attribution drifts the moment the envelope changes shape
            gate = build_track.stitch_gate_m(gap)
            if d_fwd > gate:
                key = 'b_gate_distance'
            elif dv > build_track.VEL_CONTINUITY:
                key = 'b_gate_velocity'
            else:
                key = 'b_gate_reverse'
        else:
            key = 'a_no_candidate'
        buckets[key] += 1

        # was anyone near, at the instant of death?
        pos = frags[i][1][-1]
        m = (starts <= t) & (ends >= t)
        m[i] = False
        best_d = np.inf
        for j in np.where(m)[0]:
            p = _pos_at(frags[j], t)
            if p is not None:
                best_d = min(best_d, float(np.linalg.norm(p - pos)))
        near_split[key].append(best_d)

        # gap to the nearest PLAUSIBLE continuation, ignoring the 1.5s ceiling
        g = np.inf
        for _, _, gp, d_fwd, _, _ in wide_by_end.get(i, []):
            if d_fwd <= max(2.0, REACH_MS * gp):
                g = min(g, gp)
        gaps.append(g)

    tot = max(len(deaths), 1)
    print(f'  {len(deaths)} deaths over {n} fragments')
    for k, v in buckets.items():
        arr = np.array([x for x in near_split[k] if np.isfinite(x)])
        nearpct = (100 * float((arr < NEAR_M).mean())) if len(arr) else 0.0
        print(f'    {k:18s} {v:5d}  {100*v/tot:5.1f}%   '
              f'near(<{NEAR_M}m) {nearpct:4.1f}%')

    allnear = np.array([x for k in buckets for x in near_split[k]
                        if np.isfinite(x)])
    if len(allnear):
        print(f'  deaths with another player <{NEAR_M}m: '
              f'{100*float((allnear < NEAR_M).mean()):.1f}%   '
              f'median separation {np.median(allnear):.2f} m')

    ga = np.array(gaps)
    print('  gap to nearest plausible continuation (ignores the 1.5s ceiling):')
    prev = 0.0
    for b in GAP_BINS:
        cnt = int(((ga > prev) & (ga <= b)).sum())
        print(f'    {prev:4.1f}-{b:4.1f}s {cnt:5d}  {100*cnt/tot:5.1f}%'
              + ('   <- inside the ceiling' if b <= 1.5 else ''))
        prev = b
    print(f'    none      {int(np.isinf(ga).sum()):5d}  '
          f'{100*float(np.isinf(ga).mean()):5.1f}%')

    if dv_spread:
        s = np.array(dv_spread)
        print(f'  |dv(best) - dv(2nd)| where >=2 gated edges compete: '
              f'median {np.median(s):.2f} m/s  (n={len(s)})')
        print('    -> velocity can only disambiguate if this is LARGE')

    return {'next_of': next_of, 'live': live, 'edges': edges,
            'deaths': len(deaths), 'buckets': buckets}


def chain_stats(frags: list, next_of: dict, label: str) -> float:
    n = len(frags)
    prev_of = {j: i for i, j in next_of.items()}
    spans = []
    for i in range(n):
        if i in prev_of:
            continue
        c = [i]
        while c[-1] in next_of:
            c.append(next_of[c[-1]])
        spans.append((int(frags[c[-1]][0][-1]) - int(frags[c[0]][0][0])) / 1e6)
    spans = np.array([s for s in spans if s >= build_track.MIN_CHAIN_SPAN_S])
    med = float(np.median(spans))
    print(f'  {label:22s} {len(spans):5d} chains   median {med:6.1f}s   '
          f'p90 {np.percentile(spans, 90):6.1f}s   max {spans.max():6.1f}s')
    return med


if __name__ == '__main__':
    games = sys.argv[1:]
    if not games:
        raise SystemExit(__doc__)
    for game in games:
        if not os.path.exists(f'{CACHE}/{game}_trk.json'):
            print(f'\n=== {game[:8]}  NO CACHE (run fetch_tracklets.py)')
            continue
        streams, cad, frags = load(game)
        print(f'\n=== {game[:8]}   {len(frags)} on-pitch fragments   '
              f'cadence {cad/1e6:.1f}s')
        print('\n-- noise')
        noise_report(frags)
        print('\n-- deaths')
        r = death_report(frags, cad, streams)
        print('\n-- chains')
        base = chain_stats(frags, r['next_of'], 'production')
        livem = chain_stats(frags, r['live'], 'live-rivals (Bug A)')
        print(f'  Bug A alone: median {base:.1f}s -> {livem:.1f}s '
              f'({100*(livem/base-1):+.0f}%)')

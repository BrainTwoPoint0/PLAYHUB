"""Does the stitcher bridge to the RIGHT player? Measured on production's own
decision function, at real-death crowding.

    python3 ceiling_eval.py <game_id> [<game_id> ...]

Ground truth, free: a fragment is a span where Spiideo held one uuid, so it IS
one player. Excise a gap from a long fragment and the true pairing is known.

This calls build_track.stitch_edges + stitch_assign DIRECTLY — the same code
the Fargate job runs, gates and ambiguity margin included. An earlier version
of this script scored a hand-rolled "unique candidate inside a linear envelope"
rule instead, and reported 98%. That number was meaningless: production never
restricts to unique candidates, it takes the best one whenever the ambiguity
margin passes, which is a strictly larger and more dangerous set. Never score a
reimplementation of the decision you are shipping.

Two numbers matter, and only one of them is precision:

  RECALL    = bridged correctly / injected breaks
  PRECISION = bridged correctly / bridged at all       <- the wrong-follow rate
              is 1 - PRECISION, and it is the ONLY thing that can veto a ship

Median chain duration cannot referee this: a wrong bridge makes chains LONGER.
Duration and identity purity are the same dial turned opposite ways, so the
headline metric moves the wrong way under the failure mode being risked.

BIAS, stated up front. A long fragment is by construction a stretch where the
tracker did NOT break — i.e. where the problem didn't happen. So injected
breaks are easier than real ones. The CROWDED rows below restrict to cuts with
another player inside NEAR_M, matching the real-death distribution (51-83% are
<2m apart) instead of leaving the reader to discount an "upper bound" by an
unknown factor. Read the CROWDED rows; the ALL rows are the optimistic gloss.
"""
import os, sys

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    '../../infrastructure/batch/player-tracklets'))
import numpy as np
import build_track
from stitch_diag import load

MIN_SIDE_S = 3.0     # each piece must outlive _endpoint_velocity's 5-sample fit
NEAR_M = 2.0         # "crowded" = another player this close at the cut
TAUS = [0.6, 1.0, 1.4, 2.0, 2.4]


def _pos_at(frag, t):
    ts, xy = frag
    if t < ts[0] or t > ts[-1]:
        return None
    return np.array([np.interp(t, ts, xy[:, 0]), np.interp(t, ts, xy[:, 1])])


def _crowding(frags, starts, ends, i, t):
    p = _pos_at(frags[i], t)
    m = (starts <= t) & (ends >= t)
    m[i] = False
    best = np.inf
    for j in np.where(m)[0]:
        q = _pos_at(frags[j], t)
        if q is not None:
            best = min(best, float(np.linalg.norm(q - p)))
    return best


def run(game: str, ext_gap_s: float) -> None:
    _, _, frags = load(game)
    build_track.STITCH_EXT_GAP_S = ext_gap_s
    rng = np.random.default_rng(0)
    spans = np.array([(int(f[0][-1]) - int(f[0][0])) / 1e6 for f in frags])
    starts = np.array([int(f[0][0]) for f in frags])
    ends = np.array([int(f[0][-1]) for f in frags])

    print(f'  ceiling {ext_gap_s}s | {"tau":>5s} {"subset":>8s} {"n":>5s} '
          f'{"recall":>9s} {"PRECISION":>11s} {"wrong":>7s} {"refused":>9s}')
    for tau in TAUS:
        need = 2 * MIN_SIDE_S + tau + 1.0
        items, crowd = [], {}
        for i in range(len(frags)):
            ts, xy = frags[i]
            if spans[i] < need:
                items.append((ts, xy, None))
                continue
            lo = int(ts[0]) + int(MIN_SIDE_S * 1e6)
            hi = int(ts[-1]) - int((MIN_SIDE_S + tau) * 1e6)
            cut = int(rng.integers(lo, hi))
            a, b = ts <= cut, ts >= (cut + int(tau * 1e6))
            if a.sum() < 5 or b.sum() < 5:
                items.append((ts, xy, None))
                continue
            crowd[i] = _crowding(frags, starts, ends, i, cut)
            items.append((ts[a], xy[a], ('tail', i)))
            items.append((ts[b], xy[b], ('head', i)))
        order = sorted(range(len(items)), key=lambda k: int(items[k][0][0]))
        items = [items[k] for k in order]
        nf = [(t, x) for t, x, _ in items]
        tail_i = {tg[1]: k for k, (_, _, tg) in enumerate(items)
                  if tg and tg[0] == 'tail'}
        head_i = {tg[1]: k for k, (_, _, tg) in enumerate(items)
                  if tg and tg[0] == 'head'}

        # THE production decision — same gates, same ambiguity margin
        next_of = build_track.stitch_assign(len(nf), build_track.stitch_edges(nf))

        for label, keep in (('all', lambda i: True),
                            ('crowded', lambda i: crowd.get(i, np.inf) < NEAR_M)):
            sel = [i for i in tail_i if keep(i)]
            ok = wrong = refused = 0
            for i in sel:
                got = next_of.get(tail_i[i])
                if got is None:
                    refused += 1
                elif got == head_i[i]:
                    ok += 1
                else:
                    wrong += 1
            n = len(sel)
            if not n:
                continue
            bridged = ok + wrong
            prec = (100 * ok / bridged) if bridged else float('nan')
            print(f'  {"":11s} {tau:5.1f} {label:>8s} {n:5d} '
                  f'{100*ok/n:8.1f}% {prec:10.1f}% '
                  f'{wrong:6d} {100*refused/n:8.1f}%')


if __name__ == '__main__':
    games = sys.argv[1:]
    if not games:
        raise SystemExit(__doc__)
    for game in games:
        print(f'\n=== {game[:8]}')
        for ext in (build_track.STITCH_MAX_GAP_S, 2.5):
            run(game, ext)

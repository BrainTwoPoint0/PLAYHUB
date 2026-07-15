"""If STITCH_MAX_GAP_S is what's really killing chains, can it be raised?

    python3 ceiling_probe.py <game_id> [<game_id> ...]

stitch_diag shows the ambiguity gate fires on ~0% of deaths and that 70-86% of
them have their nearest plausible continuation 1.5-5s out — beyond the 1.5s
ceiling. So the ceiling is the binding constraint. The obvious move is to
raise it. This probe asks whether that can be done WITHOUT an identity signal.

The bound, with no labels needed: a bridge is safely acceptable only when the
true continuation is the ONLY thing it could be. So for each death, count the
candidates surviving a physical reach envelope at a raised ceiling:

  0 candidates  -> nothing to bridge to (the player's next fragment is further
                   out than the ceiling, or they left)
  1 candidate   -> UNAMBIGUOUS. Position alone can carry this at high precision.
  >=2 candidates-> the choice needs a per-person signal. Kinematics are spent.

The count of the "1" bucket is therefore an UPPER BOUND on the recall a raised
ceiling can buy at high precision — upper, because a unique candidate can still
be the wrong player (the true continuation may not exist as a fragment at all,
and nothing here verifies that it does).

The production gate (0.8 + 0.5*4*gap^2) is NOT reusable at long gaps: it is
acceleration-shaped, so it reaches 13m at 2.5s and 51m at 5s — wider than the
pitch, admitting everyone. A footballer cannot deviate from a constant-velocity
prediction at 4 m/s^2 for five seconds; they saturate. Hence a linear reach
envelope, base + slope*gap, swept over slope.
"""
import os, sys

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    '../../infrastructure/batch/player-tracklets'))
import numpy as np
import build_track
from stitch_diag import load

CEILINGS = [1.5, 2.0, 2.5, 3.0, 5.0]
SLOPES = [1.5, 2.5, 4.0]     # m/s of allowed deviation from the CV prediction
BASE_M = 0.8


def probe(game: str) -> None:
    streams, cad, frags = load(game)
    n = len(frags)
    edges = build_track.stitch_edges(frags)
    next_of = build_track.stitch_assign(n, edges)

    stop = streams['tracklets'].get('stopTime')
    t_end = int(stop) if stop is not None else max(int(f[0][-1]) for f in frags)
    max_ceil = max(CEILINGS)
    wide = build_track.stitch_candidates(frags, max_gap_s=max_ceil)
    by_end: dict[int, list] = {}
    for c in wide:
        by_end.setdefault(c[0], []).append(c)

    deaths = [i for i in range(n)
              if i not in next_of
              and int(frags[i][0][-1])
              < t_end - int(build_track.STITCH_MAX_GAP_S * 1e6)]
    tot = max(len(deaths), 1)
    print(f'  {len(deaths)} deaths (production leaves these unbridged)')
    print(f'  {"ceiling":>8s} {"slope":>6s} {"unique":>16s} {"ambiguous":>16s} '
          f'{"nothing":>16s}')
    for slope in SLOPES:
        for ceil in CEILINGS:
            uniq = amb = none = 0
            for i in deaths:
                k = 0
                for _, _, gap, d_fwd, _, _ in by_end.get(i, []):
                    if gap <= ceil and d_fwd <= BASE_M + slope * gap:
                        k += 1
                if k == 0:
                    none += 1
                elif k == 1:
                    uniq += 1
                else:
                    amb += 1
            print(f'  {ceil:8.1f} {slope:6.1f} '
                  f'{uniq:7d} ({100*uniq/tot:4.1f}%) '
                  f'{amb:7d} ({100*amb/tot:4.1f}%) '
                  f'{none:7d} ({100*none/tot:4.1f}%)')
    print('  unique% is the CEILING on high-precision recall from geometry;')
    print('  ambiguous% is what only a per-person signal (jersey) can unlock.')


if __name__ == '__main__':
    games = sys.argv[1:]
    if not games:
        raise SystemExit(__doc__)
    for game in games:
        print(f'\n=== {game[:8]}')
        probe(game)

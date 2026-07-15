"""Is a Spiideo objectUUID still the same player after it VANISHES for a few
seconds — or does the tracker recycle ids?

    python3 uuid_reuse.py <game_id> [<game_id> ...]

Why this matters. build_track.parse_items splits a uuid into separate
fragments whenever it disappears for >1s or misses an item, on the stated
grounds that "uuid reuse is not trusted across absences". That distrust was
never measured — the 2026-07-15 persistence result (0.29m median seam jump,
n=3122) only covered ADJACENT items. Meanwhile stitch_diag shows 70-86% of
chain deaths have their nearest plausible continuation 1.5-5s away, i.e.
exactly in the window this assumption throws away.

The test is a physical one, and it needs no labels. When a uuid disappears at
t0 (position p0, velocity v0) and reappears at t1 (position p1):

  REAL     -> p1 is where that player could actually have got to: the implied
              speed |p1-p0|/(t1-t0) sits inside a footballer's envelope.
  RECYCLED -> p1 is wherever an unrelated player happens to be, so the implied
              speed matches the NULL: the same statistic computed against a
              DIFFERENT uuid that was live at t1.

The null is the whole point — a small implied speed proves nothing on its own,
because players are never far apart. Only the separation from the null does.
"""
import json, os, sys

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    '../../infrastructure/batch/player-tracklets'))
import numpy as np
import build_track

OUT = os.path.dirname(os.path.abspath(__file__))
CACHE = f'{OUT}/cache'
MIN_GAP_S = 1.0
MAX_GAP_S = 10.0
SPRINT_MS = 9.0     # a footballer's ceiling; above this the link is impossible
BINS = [(1, 2), (2, 3), (3, 5), (5, 10)]


def uuid_series(game: str) -> dict:
    """uuid -> (ts[], xy[]) across the WHOLE stream, no splitting at all."""
    streams = json.load(open(f'{CACHE}/{game}_streams.json'))
    items = [(i, r.encode())
             for i, r in json.load(open(f'{CACHE}/{game}_trk.json'))]
    cad = build_track.estimate_cadence_us(streams['tracklets'], items)
    start = streams['start_time_us']
    seq: dict = {}
    for idx, raw in sorted(items, key=lambda it: it[0]):
        base = start + idx * cad
        try:
            data = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(data, dict):
            continue
        for uid, pts in data.items():
            if not isinstance(pts, list):
                continue
            d = seq.setdefault(uid, {})
            for p in pts:
                try:
                    d[base + int(round(p['timeOffset']))] = (float(p['x']),
                                                             float(p['y']))
                except (KeyError, TypeError, ValueError):
                    continue
    out = {}
    for uid, d in seq.items():
        if len(d) < 4:
            continue
        ts = np.array(sorted(d), np.int64)
        out[uid] = (ts, np.array([d[t] for t in ts], np.float64))
    return out


def analyse(game: str) -> None:
    ser = uuid_series(game)
    # for the null: which uuids are live at a given instant, and where
    uids = list(ser)
    spans = {u: (int(ser[u][0][0]), int(ser[u][0][-1])) for u in uids}

    def pos_at(u, t):
        ts, xy = ser[u]
        if t < ts[0] or t > ts[-1]:
            return None
        k = int(np.searchsorted(ts, t))
        k = min(max(k, 0), len(ts) - 1)
        if abs(int(ts[k]) - t) > 400_000:      # not actually sampled near t
            return None
        return xy[k]

    rng = np.random.default_rng(0)
    rows = []      # (gap_s, real_speed, null_speed|nan)
    for u in uids:
        ts, xy = ser[u]
        dt = np.diff(ts) / 1e6
        for k in np.where((dt >= MIN_GAP_S) & (dt <= MAX_GAP_S))[0]:
            gap = float(dt[k])
            p0, p1, t1 = xy[k], xy[k + 1], int(ts[k + 1])
            real = float(np.linalg.norm(p1 - p0)) / gap
            # null: a DIFFERENT uuid, live at t1, standing in for the return
            others = [o for o in uids
                      if o != u and spans[o][0] <= t1 <= spans[o][1]]
            null = np.nan
            if others:
                for o in rng.permutation(len(others))[:6]:
                    q = pos_at(others[o], t1)
                    if q is not None:
                        null = float(np.linalg.norm(q - p0)) / gap
                        break
            rows.append((gap, real, null))

    if not rows:
        print('  no uuid re-appearances in range')
        return
    g = np.array([r[0] for r in rows])
    real = np.array([r[1] for r in rows])
    null = np.array([r[2] for r in rows])
    print(f'  {len(rows)} uuid re-appearances after a {MIN_GAP_S}-{MAX_GAP_S}s absence')
    print(f'  {"gap":>8s} {"n":>6s} {"real m/s":>10s} {"null m/s":>10s} '
          f'{"real<9m/s":>10s} {"null<9m/s":>10s}')
    for lo, hi in BINS:
        m = (g >= lo) & (g < hi)
        if not m.sum():
            continue
        nm = m & np.isfinite(null)
        print(f'  {lo:3d}-{hi:<4d} {int(m.sum()):6d} '
              f'{np.median(real[m]):10.2f} '
              f'{(np.median(null[nm]) if nm.sum() else np.nan):10.2f} '
              f'{100*float((real[m] < SPRINT_MS).mean()):9.1f}% '
              f'{(100*float((null[nm] < SPRINT_MS).mean()) if nm.sum() else np.nan):9.1f}%')
    ok = float((real < SPRINT_MS).mean())
    nm = np.isfinite(null)
    okn = float((null[nm] < SPRINT_MS).mean()) if nm.sum() else np.nan
    print(f'  overall: real {100*ok:.1f}% physically possible  vs  '
          f'null {100*okn:.1f}%')
    print(f'  -> {"uuid reuse carries REAL identity" if ok > okn + 0.2 else "indistinguishable from recycling"}')


if __name__ == '__main__':
    games = sys.argv[1:]
    if not games:
        raise SystemExit(__doc__)
    for game in games:
        if not os.path.exists(f'{CACHE}/{game}_trk.json'):
            print(f'\n=== {game[:8]}  NO CACHE')
            continue
        print(f'\n=== {game[:8]}')
        analyse(game)

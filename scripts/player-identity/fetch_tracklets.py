"""Cache Spiideo tracklet streams for N games, so the stitcher diagnostics can
run offline and repeatably.

    python3 fetch_tracklets.py <game_id> [<game_id> ...]

Only the tracklets stream is pulled here (items are public CloudFront; only
sign-in + stream discovery need the JWT). Detections are windowed and belong
to whoever needs them — see signal_bench.py.

Writes cache/{game}_streams.json + cache/{game}_trk.json. Creds are read from
the workspace .env and NEVER written to the cache: any repo file containing an
env-var VALUE fails Netlify's secrets scan at exit 2 (the 2026-07-14 outage).
"""
import json, os, sys

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    '../../infrastructure/batch/player-tracklets'))
import spiideo

OUT = os.path.dirname(os.path.abspath(__file__))
CACHE = f'{OUT}/cache'
ENVS = [f'{OUT}/../../../.env', f'{OUT}/../../.env']


def _env(key: str) -> str:
    if os.environ.get(key):
        return os.environ[key]
    for path in ENVS:
        if not os.path.exists(path):
            continue
        for line in open(path):
            line = line.strip()
            if line.startswith(f'{key}='):
                return line.split('=', 1)[1].strip().strip('"').strip("'")
    raise SystemExit(f'{key} not found in env or {ENVS}')


def fetch_game(jwt: str, game: str) -> None:
    s_path, t_path = f'{CACHE}/{game}_streams.json', f'{CACHE}/{game}_trk.json'
    if os.path.exists(s_path) and os.path.exists(t_path):
        print(f'{game[:8]}  cached')
        return
    streams = spiideo.discover_streams(jwt, game)
    if not streams['tracklets']:
        print(f'{game[:8]}  NO TRACKLETS STREAM (pre-rollout game)')
        return
    items = spiideo.fetch_items(game, streams['tracklets']['id'])
    if not items:
        # items persist ~72d vs the ~30d raw-VP purge, but they are not forever
        print(f'{game[:8]}  stream exists but 0 items (purged?)')
        return
    # keep only what the diagnostics read; drop nothing else into the repo
    json.dump({'tracklets': streams['tracklets'],
               'detections': streams['detections'],
               'start_time_us': streams['start_time_us']},
              open(s_path, 'w'))
    json.dump([[i, r.decode()] for i, r in items], open(t_path, 'w'))
    span = (int(streams['tracklets'].get('stopTime', 0))
            - streams['start_time_us']) / 1e6
    print(f'{game[:8]}  {len(items):4d} items  stream span {span/60:.1f} min')


if __name__ == '__main__':
    games = sys.argv[1:]
    if not games:
        raise SystemExit(__doc__)
    os.makedirs(CACHE, exist_ok=True)
    jwt = spiideo.sign_in(_env('SPIIDEO_PLAY_EMAIL'), _env('SPIIDEO_PLAY_PASSWORD'))
    print('signed in')
    for g in games:
        try:
            fetch_game(jwt, g)
        except Exception as err:   # one bad game must not kill the batch
            print(f'{g[:8]}  FAILED: {type(err).__name__}: {err}')

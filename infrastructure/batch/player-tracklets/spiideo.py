"""Spiideo data-stream access for the player-tracklets job.

Sign-in + stream discovery hit the internal api.spiideo.com (same JWT flow as
vp-materialize/entrypoint.mjs and src/lib/spiideo/internal-client.ts). The
per-10s item files themselves are public CloudFront objects — no auth — at
{CF}/{gameId}/{streamId}/item-{8-digit-index}.

Verified 2026-07-14 (spike): the tracklets stream (type=object_data,
format=tracker_position) exists on Nazwa games from 2026-06-09 onward, all
Football Plus July games, and HCT back to at least 2026-05-03; 72-day-old
items still fetch, so the stream persists (unlike the ~30-day raw-VP purge).
Games recorded before a venue's tracklets rollout simply lack the stream —
callers must treat that as a settled no-data outcome, not a retryable error.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request

API = 'https://api.spiideo.com'
CF = 'https://d35u71x3nb8v2y.cloudfront.net'

# Item cadence is PER-STREAM (every current tracklets stream measures 16s;
# the b923 research assumed 10s — the 2026-07-15 time-base bug). Derive it
# with build_track.estimate_cadence_us, never hardcode.
# Stop enumerating after this many consecutive missing items. A single gap in
# the middle of a match must not truncate the artifact to its first half.
MAX_CONSECUTIVE_MISSES = 5
# Hard cap ≈ 5.5h of match — a runaway-loop backstop, far above any real game.
MAX_ITEMS = 2000


def _get(url: str, headers: dict | None = None, timeout: int = 30,
         retries: int = 2) -> bytes | None:
    """GET with small retry on 5xx/network; None on 404/403 (missing item)."""
    for attempt in range(retries + 1):
        req = urllib.request.Request(url)
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as err:
            if err.code in (403, 404):
                return None
            if attempt >= retries:
                raise
        except urllib.error.URLError:
            if attempt >= retries:
                raise
        time.sleep(2 * (attempt + 1))
    return None


def sign_in(email: str, password: str) -> str:
    body = json.dumps({'email': email, 'password': password,
                       'rolesToAssume': ['ROLE_USER']}).encode()
    req = urllib.request.Request(f'{API}/v1/auth/sign-in', data=body,
                                 method='POST')
    req.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(req, timeout=30) as resp:
        jwt = json.loads(resp.read()).get('jwt')
    if not jwt:
        raise RuntimeError('Spiideo sign-in returned no jwt')
    return jwt


def discover_streams(jwt: str, game_id: str) -> dict:
    """Return {'tracklets': stream|None, 'detections': [streams],
    'start_time_us': int|None} for the game.

    HCT-style 2-cam scenes publish one detection stream per camera — all are
    returned and their frames merged by the H solver.
    """
    qs = '&'.join(f'type={t}' for t in ('object_data', 'tag'))
    raw = _get(f'{API}/v1/streams?gameId={urllib.parse.quote(game_id)}&{qs}',
               headers={'authorization': f'Bearer {jwt}'})
    if raw is None:
        raise RuntimeError('stream discovery denied (403/404)')
    data = json.loads(raw)
    streams = data.get('content') or (data if isinstance(data, list) else [])
    tracklets = None
    detections = []
    for s in streams:
        name = (s.get('streamName') or '').lower()
        if s.get('type') == 'object_data' and (
                s.get('format') == 'tracker_position' or name == 'tracklets'):
            tracklets = s
        elif name.startswith('object-detections'):
            detections.append(s)
    start = tracklets.get('startTime') if tracklets else None
    # null-check, never truthiness (the price-0 lesson): 0 is a value
    return {'tracklets': tracklets, 'detections': detections,
            'start_time_us': int(start) if start is not None else None}


def fetch_items(game_id: str, stream_id: str,
                max_items: int = MAX_ITEMS) -> list[tuple[int, bytes]]:
    """Enumerate item-00000000.. until MAX_CONSECUTIVE_MISSES, return raw
    (index, bytes) pairs. Raw bytes are kept so the caller can archive them
    as provenance before parsing."""
    items: list[tuple[int, bytes]] = []
    misses = 0
    idx = 0
    while idx < max_items and misses < MAX_CONSECUTIVE_MISSES:
        raw = _get(f'{CF}/{game_id}/{stream_id}/item-{idx:08d}')
        if raw is None:
            misses += 1
        else:
            misses = 0
            items.append((idx, raw))
        idx += 1
    return items

"""Aim-track Batch job — reg-SIFT the produced Play render against the raw
panorama and publish the {t, pan, tilt, fov} auto-follow track.

Mirrors vp-materialize/entrypoint.mjs operationally: 2-minute heartbeat on
aim_track_started_at (keeps the sweep's stuck-detector from double-claiming),
terminal status write (ready|error with a redacted message), non-zero exit on
failure so Batch surfaces it.

Inputs come from env (RECORDING_ID, GAME_ID) + the recording row itself
(s3_key = produced Play mp4, panorama_s3_key = raw VP — both must be present;
the sweep only submits when they are). The mesh is read from the PUBLIC
panorama-meshes bucket; the output aim-track.json is uploaded next to it
(public, pure camera angles, no PII) plus a provenance copy next to the VP
in private S3.

No Spiideo dependency: everything needed is already in our storage.
"""

from __future__ import annotations

import json
import os
import signal
import sys
import threading
import urllib.request

import boto3

from register import register
from aim_convert import convert

import uuid as _uuid

# Format asserts make "a stray & in env rewrites the PATCH filter under
# service role" structurally impossible (values are interpolated into
# PostgREST query strings and storage paths).
RECORDING_ID = str(_uuid.UUID(os.environ['RECORDING_ID']))
GAME_ID = str(_uuid.UUID(os.environ['GAME_ID']))
SUPABASE_URL = os.environ['SUPABASE_URL'].rstrip('/')
SERVICE_KEY = os.environ['SUPABASE_SERVICE_ROLE_KEY']
BUCKET = os.environ['S3_RECORDINGS_BUCKET']
SAMPLE_FPS = float(os.environ.get('SAMPLE_FPS', '5'))
VP_S3_PREFIX = os.environ.get('VP_S3_PREFIX', 'panoramas')
MESH_BUCKET = 'panorama-meshes'

s3 = boto3.client('s3')


def _sb(method: str, path: str, body: bytes | None = None,
        content_type: str = 'application/json', extra: dict | None = None):
    req = urllib.request.Request(f'{SUPABASE_URL}{path}', data=body, method=method)
    req.add_header('apikey', SERVICE_KEY)
    req.add_header('Authorization', f'Bearer {SERVICE_KEY}')
    req.add_header('Content-Type', content_type)
    for k, v in (extra or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read()


def set_status(fields: dict, retries: int = 0):
    # Terminal writes after a multi-hour job get retries: one transient 5xx on
    # that single PATCH must not turn a finished track into a full re-run.
    import time
    for attempt in range(retries + 1):
        try:
            _sb('PATCH',
                f'/rest/v1/playhub_match_recordings?id=eq.{RECORDING_ID}',
                json.dumps(fields).encode(),
                extra={'Prefer': 'return=minimal'})
            return
        except Exception:  # noqa: BLE001
            if attempt >= retries:
                raise
            time.sleep(5 * (attempt + 1))


def fetch_row() -> dict:
    out = _sb('GET',
              f'/rest/v1/playhub_match_recordings?id=eq.{RECORDING_ID}'
              f'&select=s3_key,s3_bucket,panorama_s3_key,spiideo_game_id')
    rows = json.loads(out)
    if not rows:
        raise RuntimeError('recording row not found')
    return rows[0]


def download_mesh(dest_dir: str):
    os.makedirs(dest_dir, exist_ok=True)
    for name in ('scene.json', 'vertices.bin', 'indices.bin'):
        url = f'{SUPABASE_URL}/storage/v1/object/public/{MESH_BUCKET}/{GAME_ID}/{name}'
        with urllib.request.urlopen(url, timeout=60) as resp, \
                open(os.path.join(dest_dir, name), 'wb') as f:
            f.write(resp.read())


def upload_track(payload: dict):
    body = json.dumps(payload).encode()
    # Public copy next to the mesh — the player fetches it with the same
    # optional-artifact pattern as tuning.json.
    _sb('POST',
        f'/storage/v1/object/{MESH_BUCKET}/{GAME_ID}/aim-track.json',
        body, extra={'x-upsert': 'true'})
    # Provenance copy next to the raw VP in private S3.
    s3.put_object(Bucket=BUCKET,
                  Key=f'{VP_S3_PREFIX}/{GAME_ID}/aim-track.json',
                  Body=body, ContentType='application/json')


def heartbeat_loop(stop: threading.Event):
    from datetime import datetime, timezone
    while not stop.wait(120):
        try:
            set_status({'aim_track_started_at':
                        datetime.now(timezone.utc).isoformat()})
        except Exception as err:  # noqa: BLE001 — heartbeat must never kill the job
            print(f'heartbeat failed (non-fatal): {err}', flush=True)


# Quality gates — a garbage track must NEVER reach 'ready' ('ready' is
# terminal: the sweep won't reclaim it, so recovery would need manual SQL).
MIN_COVERAGE = 0.5
MIN_DURATION_FRACTION = 0.9  # registration must reach ~the end of the match


def main():
    row = fetch_row()
    if not row.get('s3_key') or not row.get('panorama_s3_key'):
        raise RuntimeError('missing s3_key or panorama_s3_key on the row')
    if row.get('spiideo_game_id') != GAME_ID:
        raise RuntimeError('GAME_ID does not match the recording row')

    stop = threading.Event()
    hb = threading.Thread(target=heartbeat_loop, args=(stop,), daemon=True)
    hb.start()

    play_path, raw_path = '/tmp/play.mp4', '/tmp/raw.mp4'
    print(f'downloading s3://{BUCKET}/{row["s3_key"]}', flush=True)
    s3.download_file(row.get('s3_bucket') or BUCKET, row['s3_key'], play_path)
    print(f'downloading s3://{BUCKET}/{row["panorama_s3_key"]}', flush=True)
    s3.download_file(BUCKET, row['panorama_s3_key'], raw_path)
    download_mesh('/tmp/mesh')

    reg = register(raw_path, play_path, sample_fps=SAMPLE_FPS)
    print(f'registered n={reg["n"]} coverage={reg["coverage"]} '
          f'median_inliers={reg["median_inliers"]}', flush=True)

    if reg['coverage'] < MIN_COVERAGE:
        raise RuntimeError(
            f'quality gate: coverage {reg["coverage"]:.2f} < {MIN_COVERAGE} '
            '(registration failed on most of the match)')
    reached = float(reg['t'][-1])
    if reached < MIN_DURATION_FRACTION * reg['dur']:
        # A raw VP shorter than the Play mp4 (truncated capture) makes
        # registration stop early; publishing would freeze Auto-follow at the
        # last aim for the rest of the match.
        raise RuntimeError(
            f'quality gate: registration reached {reached:.0f}s of '
            f'{reg["dur"]:.0f}s (truncated input?)')

    track = convert(reg, '/tmp/mesh')
    upload_track(track)

    stop.set()
    set_status({'aim_track_status': 'ready', 'aim_track_error': None},
               retries=3)
    print(f'aim track ready: {len(track["t"])} samples, '
          f'coverage {track["coverage"]}', flush=True)


def _on_sigterm(signum, frame):  # noqa: ARG001
    # Batch sends SIGTERM (30s grace) on timeout/termination. Without this the
    # process dies silently and the row goes heartbeat-dead 'pending' with no
    # recorded reason — the 3-attempt budget becomes undebuggable.
    try:
        set_status({'aim_track_status': 'error',
                    'aim_track_error': 'terminated (Batch timeout/SIGTERM)'})
    finally:
        sys.exit(1)


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, _on_sigterm)
    try:
        main()
    except Exception as err:  # noqa: BLE001 — terminal status then non-zero exit
        # aim_track_error is readable on published rows (the public-SELECT RLS
        # policy exposes every column), so only SELF-AUTHORED messages go to
        # the DB: our RuntimeErrors verbatim (quality gates, missing keys),
        # everything else as the exception class name. Full detail → logs.
        if isinstance(err, RuntimeError):
            msg = str(err)[:300]
        else:
            msg = f'{type(err).__name__} (see job logs)'
        print(f'FATAL: {type(err).__name__}: {str(err)[:500]}',
              file=sys.stderr, flush=True)
        try:
            set_status({'aim_track_status': 'error', 'aim_track_error': msg})
        except Exception as err2:  # noqa: BLE001
            print(f'could not write error status: {err2}', file=sys.stderr,
                  flush=True)
        sys.exit(1)

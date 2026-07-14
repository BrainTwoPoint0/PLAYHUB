"""Player-tracklets Batch job — fetch Spiideo's tracklets + object-detections
data streams, solve the per-game metric->ray homography, and publish the
per-player {t, pan, tilt} spotlight track next to the scene mesh.

Operational contract mirrors aim-track/entrypoint.py: 2-minute heartbeat on
tracklets_started_at, terminal status write (ready|error, self-authored
messages only — the column is publicly SELECTable), SIGTERM handler, non-zero
exit on failure.

Unlike aim-track this job DOES talk to Spiideo (the data streams are not in
our storage): JWT sign-in via SPIIDEO_PLAY_EMAIL/PASSWORD for stream
discovery, then public CloudFront item fetches. Raw tracklet items are
archived to private S3 as provenance (capture-on-publish doctrine — stream
longevity is Spiideo's choice, not ours).

Games recorded before a venue's tracklets rollout have no tracklets stream;
that surfaces as a clear 'no tracklets stream' error and settles via the
sweep's attempts cap.
"""

from __future__ import annotations

import io
import json
import os
import signal
import sys
import tarfile
import threading
import urllib.request
import uuid as _uuid

import boto3
import numpy as np
from scipy.spatial import cKDTree

import spiideo
import solve_h
import build_track
import detections
from mesh_rays import load_mesh_rays

RECORDING_ID = str(_uuid.UUID(os.environ['RECORDING_ID']))
GAME_ID = str(_uuid.UUID(os.environ['GAME_ID']))
SUPABASE_URL = os.environ['SUPABASE_URL'].rstrip('/')
SERVICE_KEY = os.environ['SUPABASE_SERVICE_ROLE_KEY']
BUCKET = os.environ['S3_RECORDINGS_BUCKET']
SPIIDEO_EMAIL = os.environ['SPIIDEO_PLAY_EMAIL']
SPIIDEO_PASSWORD = os.environ['SPIIDEO_PLAY_PASSWORD']
VP_S3_PREFIX = os.environ.get('VP_S3_PREFIX', 'panoramas')
# How many detection items (10s windows) to sample across the match for the
# H solve — the reference solve reached 0.0073 rayn from a 15-item window.
DET_ITEM_TARGET = int(os.environ.get('DET_ITEM_TARGET', '40'))
MESH_BUCKET = 'panorama-meshes'

# Quality gates — 'ready' is terminal (the sweep never reclaims it), so a
# garbage artifact must never pass. The GLOBAL eval (Hungarian re-assignment
# of every frame at a 0.03 gate with the final H) is the real arbiter — but
# calibrated on ABSOLUTE matches, not rate: the ±80ms det↔trk pairing slop on
# running players means even a correct H tightly matches only ~1% of offered
# points (pilot: 89 matches, median 0.016), while a WRONG H matches zero
# (identity-H control: 0). The tight-gate median_res is telemetry only.
MAX_EVAL_MEDIAN = 0.02
MIN_EVAL_MATCHES_PER_1K_FRAMES = 50.0
MIN_MATCHED_FRAMES = 100
MIN_MEDIAN_CONCURRENT = 8
MIN_SPAN_FRACTION = 0.6

s3 = boto3.client('s3')
# Module-scope so the terminal error path can stop it before writing status.
HEARTBEAT_STOP = threading.Event()


def _sb(method: str, path: str, body: bytes | None = None,
        extra: dict | None = None):
    req = urllib.request.Request(f'{SUPABASE_URL}{path}', data=body,
                                 method=method)
    req.add_header('apikey', SERVICE_KEY)
    req.add_header('Authorization', f'Bearer {SERVICE_KEY}')
    req.add_header('Content-Type', 'application/json')
    for k, v in (extra or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def set_status(fields: dict, retries: int = 0):
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
              f'&select=spiideo_game_id')
    rows = json.loads(out)
    if not rows:
        raise RuntimeError('recording row not found')
    return rows[0]


def download_mesh(dest_dir: str):
    os.makedirs(dest_dir, exist_ok=True)
    for name in ('scene.json', 'vertices.bin', 'indices.bin'):
        url = (f'{SUPABASE_URL}/storage/v1/object/public/'
               f'{MESH_BUCKET}/{GAME_ID}/{name}')
        with urllib.request.urlopen(url, timeout=60) as resp, \
                open(os.path.join(dest_dir, name), 'wb') as f:
            f.write(resp.read())


def heartbeat_loop(stop: threading.Event):
    from datetime import datetime, timezone
    while not stop.wait(120):
        try:
            set_status({'tracklets_started_at':
                        datetime.now(timezone.utc).isoformat()})
        except Exception as err:  # noqa: BLE001 — heartbeat never kills the job
            print(f'heartbeat failed (non-fatal): {err}', flush=True)


def archive_provenance(items: list[tuple[int, bytes]], diag: dict,
                       payload: dict):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w:gz') as tar:
        for idx, raw in items:
            info = tarfile.TarInfo(name=f'item-{idx:08d}.json')
            info.size = len(raw)
            tar.addfile(info, io.BytesIO(raw))
    buf.seek(0)
    s3.put_object(Bucket=BUCKET,
                  Key=f'{VP_S3_PREFIX}/{GAME_ID}/tracklets-raw.tar.gz',
                  Body=buf.read(), ContentType='application/gzip')
    s3.put_object(Bucket=BUCKET,
                  Key=f'{VP_S3_PREFIX}/{GAME_ID}/tracklets-solve.json',
                  Body=json.dumps({'H': diag['H'].tolist(),
                                   'median_res': diag['median_res'],
                                   'eval_median': diag['eval_median'],
                                   'eval_rate': diag['eval_rate'],
                                   'matched_frames': diag['matched_frames'],
                                   'n_matches': diag['n_matches'],
                                   'meta': payload['meta']}).encode(),
                  ContentType='application/json')


def upload_track(payload: dict):
    body = json.dumps(payload).encode()
    _sb('POST',
        f'/storage/v1/object/{MESH_BUCKET}/{GAME_ID}/tracklets.json',
        body, extra={'x-upsert': 'true'})


def median_concurrency(chains: list) -> float:
    if not chains:
        return 0.0
    t0 = min(int(c[0][0]) for c in chains)
    t1 = max(int(c[0][-1]) for c in chains)
    if t1 <= t0:
        return 0.0
    samples = np.linspace(t0, t1, 100)
    counts = [sum(1 for ts, _ in chains
                  if ts[0] <= s <= ts[-1]) for s in samples]
    return float(np.median(counts))


def main():
    row = fetch_row()
    if row.get('spiideo_game_id') != GAME_ID:
        raise RuntimeError('GAME_ID does not match the recording row')

    threading.Thread(target=heartbeat_loop, args=(HEARTBEAT_STOP,),
                     daemon=True).start()

    jwt = spiideo.sign_in(SPIIDEO_EMAIL, SPIIDEO_PASSWORD)
    streams = spiideo.discover_streams(jwt, GAME_ID)
    if not streams['tracklets']:
        raise RuntimeError('no tracklets stream published for this game')
    if not streams['detections']:
        raise RuntimeError('no object-detections stream for this game')
    start_us = streams['start_time_us']
    if start_us is None:
        raise RuntimeError('tracklets stream has no startTime')

    download_mesh('/tmp/mesh')
    uv, rays = load_mesh_rays('/tmp/mesh')
    # Ray-plane needs z>0 (in front of the camera); pitch content always is.
    front = rays[:, 2] > 0.05
    uv_f, rays_f = uv[front], rays[front]
    rayn = rays_f[:, :2] / rays_f[:, 2:3]
    tree = cKDTree(uv_f)

    def uv_to_rayn(pts: np.ndarray) -> np.ndarray:
        _, idx = tree.query(pts, k=3)
        return rayn[idx].mean(axis=1)

    trk_items = spiideo.fetch_items(GAME_ID, streams['tracklets']['id'])
    if not trk_items:
        raise RuntimeError('tracklets stream has no items')
    print(f'fetched {len(trk_items)} tracklet items', flush=True)

    objects = build_track.parse_items(trk_items, start_us)
    if not objects:
        raise RuntimeError('tracklets stream parsed to zero objects')
    trk_window = (min(int(ts[0]) for ts, _ in objects.values()),
                  max(int(ts[-1]) for ts, _ in objects.values()))

    det_frames: dict = {}
    for det_stream in streams['detections']:
        det_items = detections.sample_detection_items(
            GAME_ID, det_stream['id'], DET_ITEM_TARGET, window_us=trk_window)
        # shared dict: timestamp collisions across 2-cam streams concatenate
        detections.parse_detection_items(det_items, uv_to_rayn,
                                         frames=det_frames)
    print(f'{len(det_frames)} detection frames sampled', flush=True)
    trk_frames: dict = {}
    for ts, xy in objects.values():
        for t, p in zip(ts.tolist(), xy.tolist()):
            trk_frames.setdefault(t, []).append(p)
    trk_frames = {k: np.array(v, np.float64) for k, v in trk_frames.items()}

    diag = solve_h.solve(det_frames, trk_frames)
    print(f'H solved: inlier median {diag["median_res"]:.4f} rayn; global '
          f'eval median {diag["eval_median"]:.4f} rate {diag["eval_rate"]:.2f} '
          f'({diag["eval_matches"]} matches / {diag["matched_frames"]} frames)',
          flush=True)
    if diag['eval_median'] > MAX_EVAL_MEDIAN:
        raise RuntimeError(
            f'quality gate: H eval median {diag["eval_median"]:.4f} rayn > '
            f'{MAX_EVAL_MEDIAN} (calibration unreliable)')
    min_eval_matches = max(
        30.0, MIN_EVAL_MATCHES_PER_1K_FRAMES * diag['matched_frames'] / 1000)
    if diag['eval_matches'] < min_eval_matches:
        raise RuntimeError(
            f'quality gate: H eval matches {diag["eval_matches"]} < '
            f'{min_eval_matches:.0f} (H matches too few detections)')
    if diag['matched_frames'] < MIN_MATCHED_FRAMES:
        raise RuntimeError(
            f'quality gate: only {diag["matched_frames"]} matched frames')

    on_pitch = build_track.filter_on_pitch(
        objects, diag['pitch_lo'], diag['pitch_hi'])
    chains = build_track.stitch(on_pitch)
    conc = median_concurrency(chains)
    if conc < MIN_MEDIAN_CONCURRENT:
        raise RuntimeError(
            f'quality gate: median concurrent tracked objects {conc:.0f} < '
            f'{MIN_MEDIAN_CONCURRENT}')

    span_s = (max(int(c[0][-1]) for c in chains)
              - min(int(c[0][0]) for c in chains)) / 1e6
    stream_span_s = len(trk_items) * spiideo.ITEM_SECONDS
    if span_s < MIN_SPAN_FRACTION * stream_span_s:
        raise RuntimeError(
            f'quality gate: tracked span {span_s:.0f}s < '
            f'{MIN_SPAN_FRACTION:.0%} of stream span {stream_span_s}s')

    payload = build_track.build_payload(chains, diag['H'], start_us, diag)
    upload_track(payload)
    archive_provenance(trk_items, diag, payload)

    HEARTBEAT_STOP.set()
    set_status({'tracklets_status': 'ready', 'tracklets_error': None},
               retries=3)
    print(f'tracklets ready: {payload["meta"]["nObjects"]} objects, '
          f'median concurrency {conc:.0f}, span {span_s:.0f}s', flush=True)


def _on_sigterm(signum, frame):  # noqa: ARG001
    try:
        set_status({'tracklets_status': 'error',
                    'tracklets_error': 'terminated (Batch timeout/SIGTERM)'})
    finally:
        sys.exit(1)


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, _on_sigterm)
    try:
        main()
    except Exception as err:  # noqa: BLE001 — terminal status, non-zero exit
        if isinstance(err, RuntimeError):
            msg = str(err)[:300]
        else:
            msg = f'{type(err).__name__} (see job logs)'
        print(f'FATAL: {type(err).__name__}: {str(err)[:500]}',
              file=sys.stderr, flush=True)
        HEARTBEAT_STOP.set()
        try:
            set_status({'tracklets_status': 'error', 'tracklets_error': msg})
        except Exception as err2:  # noqa: BLE001
            print(f'could not write error status: {err2}', file=sys.stderr,
                  flush=True)
        sys.exit(1)

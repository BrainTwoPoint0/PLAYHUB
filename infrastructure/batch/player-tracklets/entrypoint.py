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
import urllib.parse
import urllib.request
import uuid as _uuid

import boto3
import numpy as np
from scipy.spatial import cKDTree

import spiideo
import solve_h
import build_track
import calibration_still
import detections
import validate_render
from mesh_rays import load_mesh_rays

RECORDING_ID = str(_uuid.UUID(os.environ['RECORDING_ID']))
GAME_ID = str(_uuid.UUID(os.environ['GAME_ID']))
SUPABASE_URL = os.environ['SUPABASE_URL'].rstrip('/')
SERVICE_KEY = os.environ['SUPABASE_SERVICE_ROLE_KEY']
BUCKET = os.environ['S3_RECORDINGS_BUCKET']
SPIIDEO_EMAIL = os.environ['SPIIDEO_PLAY_EMAIL']
SPIIDEO_PASSWORD = os.environ['SPIIDEO_PLAY_PASSWORD']
VP_S3_PREFIX = os.environ.get('VP_S3_PREFIX', 'panoramas')
MESH_BUCKET = 'panorama-meshes'
# Scenes whose SHIPPED artifact uses the calibrated field-of-play filter.
# Everyone else runs it in DRY-RUN (comparison logged + stamped in meta,
# percentile rect ships). Per-venue enablement happens only after a human
# reviews the dry-run numbers for that venue.
FIELD_FILTER_SCENES = {s.strip() for s in
                       os.environ.get('FIELD_FILTER_SCENES', '').split(',')
                       if s.strip()}

# Detection windows for the H solve: one DENSE CONTIGUOUS solve window (the
# shape the reference chain was validated on) + two held-out eval windows at
# 25%/75% of the tracklet span. With the correct tracklet time base +
# interpolated pairing, a correct H matches ~0.6 of offered points on
# held-out windows while a wrong one matches ~0.02 — rates and per-region
# medians are finally discriminative (the first pilot's absolute-count gate
# was un-gameable and let two bad ships through).
SOLVE_WINDOW_S = 185.0
EVAL_WINDOW_S = 65.0
MIN_TRK_SPAN_S = 600.0

# Quality gates — 'ready' is terminal (the sweep never reclaims it), so a
# garbage artifact must never pass.
MIN_EVAL_RATE_SOLVE = 0.25
MIN_EVAL_RATE_HELDOUT = 0.20
MAX_EVAL_MEDIAN = 0.02
MIN_HALF_MATCHES = 50    # pooled, per half-pitch region
MIN_QUAD_MATCHES = 25    # pooled, per quadrant
MAX_REGION_MEDIAN = 0.025
MAX_REGION_BIAS = 0.012  # signed median residual vector — a shear's tell
MAX_LAG_S = 1.5          # time-base canary (item cadence drift)
MIN_LAG_CORR = 0.10
MIN_MATCHED_FRAMES = 300
MIN_MEDIAN_CONCURRENT = 8
MIN_SPAN_FRACTION = 0.6
# a detection landing outside mesh coverage snaps to an arbitrary nearest
# front vertex — reject queries further than this from any mesh UV sample
MAX_UV_QUERY_DIST = 0.01

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
              f'&select=spiideo_game_id,spiideo_scene_id,'
              f'panorama_s3_key,s3_bucket')
    rows = json.loads(out)
    if not rows:
        raise RuntimeError('recording row not found')
    return rows[0]


def fetch_calibration(scene_id: str | None) -> dict | None:
    """Active pitch calibration for the scene, or None. Non-fatal by design:
    the filter upgrade is optional — a fetch error must never fail the job."""
    if not scene_id:
        return None
    try:
        sid = urllib.parse.quote(str(scene_id), safe='')
        out = _sb('GET',
                  f'/rest/v1/playhub_pitch_calibrations'
                  f'?scene_id=eq.{sid}&status=eq.active'
                  f'&select=homography,pitch_length_m,pitch_width_m,'
                  f'reprojection_error_px,marks,solver_version,'
                  f'mesh_source_game_id')
        rows = json.loads(out)
        cal = rows[0] if rows else None
        if cal:
            # Mesh-epoch check: the calibration's marks were made through the
            # scene mesh registered at MARKING time. If the registry has since
            # moved to a different source game (a refit/fanout), the composed
            # map is cross-epoch garbage — degrade to the rect until the admin
            # re-marks (the refit acceptance flow). Same-source regeneration
            # is not detectable here; the span/collapse fallbacks carry that.
            reg = _sb('GET',
                      f'/rest/v1/playhub_panorama_scene_meshes'
                      f'?scene_id=eq.{sid}&select=source_game_id')
            reg_rows = json.loads(reg)
            src = reg_rows[0]['source_game_id'] if reg_rows else None
            if (src and cal.get('mesh_source_game_id')
                    and src != cal['mesh_source_game_id']):
                print(f'calibration mesh epoch mismatch (marked on '
                      f'{cal["mesh_source_game_id"]}, registry now {src}) — '
                      f'ignoring calibration', flush=True)
                return None
        return cal
    except Exception as err:  # noqa: BLE001
        print(f'calibration fetch failed (non-fatal): {err}', flush=True)
        return None


def emit_calibration_still(row: dict):
    """Best-effort median still for the pitch-calibration marking UI, keyed
    the way the pitch-calibration API enforces:
    calibration-stills/{scene_id}/{recording_id}.jpg

    Deliberately independent of the tracklets quality gates — a still is
    useful even when the solve fails, and for venues whose tracker rollout
    postdates the game (those jobs die at 'no tracklets stream'). Never
    fails the job."""
    try:
        scene_id = row.get('spiideo_scene_id')
        pano_key = row.get('panorama_s3_key')
        if not scene_id or not pano_key:
            print('calibration still: no scene id or banked panorama — '
                  'skipping', flush=True)
            return
        key = f'calibration-stills/{scene_id}/{RECORDING_ID}.jpg'
        try:
            s3.head_object(Bucket=BUCKET, Key=key)
            print(f'calibration still already banked at {key} — skipping',
                  flush=True)
            return
        except Exception:  # noqa: BLE001
            # DELIBERATELY broad: without s3:ListBucket a missing object
            # surfaces as 403 (not 404), and a throttle just means an
            # idempotent re-render + overwrite. Do not narrow to 404.
            pass
        url = s3.generate_presigned_url(
            'get_object',
            Params={'Bucket': BUCKET, 'Key': pano_key}, ExpiresIn=3600)
        jpg = calibration_still.render_median_still(url)
        if jpg is None:
            return
        s3.put_object(Bucket=BUCKET, Key=key, Body=jpg,
                      ContentType='image/jpeg')
        print(f'calibration still uploaded ({len(jpg) // 1024} KB) → {key}',
              flush=True)
    except Exception as err:  # noqa: BLE001 — never fails the job
        print(f'calibration still failed (non-fatal): {err}', flush=True)


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


def archive_provenance(items: list[tuple[int, bytes]], solve_doc: dict,
                       validation_png: bytes | None):
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
                  Body=json.dumps(solve_doc).encode(),
                  ContentType='application/json')
    if validation_png:
        s3.put_object(Bucket=BUCKET,
                      Key=f'{VP_S3_PREFIX}/{GAME_ID}/tracklets-validate.png',
                      Body=validation_png, ContentType='image/png')


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

    # Before stream discovery: games predating the venue's tracker rollout
    # die there, and their stills are exactly the ones calibration needs.
    emit_calibration_still(row)

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
    rayn_tree = cKDTree(rayn)

    def uv_to_rayn(pts: np.ndarray) -> np.ndarray:
        d, idx = tree.query(pts, k=3)
        out = rayn[idx].mean(axis=1)
        # outside mesh coverage the nearest-vertex snap is arbitrary — mark
        # NaN so the detection parser drops the point
        out[d[:, 0] > MAX_UV_QUERY_DIST] = np.nan
        return out

    def rayn_to_uv(pts: np.ndarray) -> np.ndarray:
        _, idx = rayn_tree.query(pts, k=3)
        return uv_f[idx].mean(axis=1)

    trk_items = spiideo.fetch_items(GAME_ID, streams['tracklets']['id'])
    if not trk_items:
        raise RuntimeError('tracklets stream has no items')
    cadence_us = build_track.estimate_cadence_us(streams['tracklets'],
                                                 trk_items)
    print(f'fetched {len(trk_items)} tracklet items, cadence '
          f'{cadence_us / 1e6:.1f}s/item', flush=True)

    fragments = build_track.parse_items(trk_items, start_us, cadence_us)
    if not fragments:
        raise RuntimeError('tracklets stream parsed to zero fragments')
    trk_lo = min(int(ts[0]) for ts, _ in fragments)
    trk_hi = max(int(ts[-1]) for ts, _ in fragments)
    trk_span_s = (trk_hi - trk_lo) / 1e6
    if trk_span_s < MIN_TRK_SPAN_S:
        raise RuntimeError(
            f'tracklets span {trk_span_s:.0f}s < {MIN_TRK_SPAN_S:.0f}s — '
            'too short to calibrate')

    # Windows by MOVING-sample density (a fixed 50% anchor is halftime on any
    # two-half recording — pairs starve and a good game burns its attempts).
    windows = solve_h.pick_windows(fragments, SOLVE_WINDOW_S, EVAL_WINDOW_S)
    eval_names = [k for k in windows if k != 'solve']
    if not eval_names:
        raise RuntimeError(
            'no independent eval window with player activity — cannot gate '
            'the calibration')
    # Fetch once per (stream, window); parsing re-runs per layout candidate.
    raw_det_items: dict = {}
    for det_stream in streams['detections']:
        for name, w in windows.items():
            raw_det_items[(det_stream['id'], name)] = \
                detections.fetch_window_items(GAME_ID, det_stream, w)

    def build_det_windows(transforms: dict | None) -> dict:
        dw: dict = {name: {} for name in windows}
        for det_stream in streams['detections']:
            tf = None if transforms is None else transforms[det_stream['id']]
            for name, w in windows.items():
                # shared dict: ts collisions across 2-cam streams
                # concatenate; window clamp keeps solve frames out of the
                # held-out windows
                detections.parse_detection_items(
                    raw_det_items[(det_stream['id'], name)], uv_to_rayn,
                    frames=dw[name], window_us=w, uv_transform=tf)
        return dw

    # Det-uv layout arbitration (multi-camera scenes): per-lens uv fed into
    # the stacked mesh is spatial garbage that presents as a time-base
    # failure (the 2026-07-17 HCT incident: occupancy correlated at lag 0
    # while the speed-profile canary showed a spurious -4s/r=0.20). Each
    # candidate is scored with the speed-profile correlation CONSTRAINED to
    # |lag| <= MAX_LAG_S — an unconstrained scan would let a wrong layout
    # shop ~480 lag bins for a noise peak while the true layout reports its
    # lag-0 r (review finding). Single-camera scenes have exactly one
    # candidate (identity) and behave as before.
    layout_label, layout_transforms, det_windows, layout_diag = \
        detections.choose_layout(
            detections.strip_candidates(streams['detections']),
            build_det_windows,
            lambda pooled: solve_h.lag_peak_s(pooled, fragments,
                                              max_lag_s=MAX_LAG_S))
    fence_premasked = layout_transforms is not None
    for lbl, d in layout_diag.items():
        print(f'det layout {lbl}: lag {d["lag_s"]} r={d["lag_r"]} '
              f'(scan |lag|<={MAX_LAG_S:.1f}s)', flush=True)
    print('windows: ' + ' '.join(
        f'{k}@{(windows[k][0] - start_us) / 1e6:.0f}s'
        f'={len(det_windows[k])}f' for k in windows), flush=True)

    # Time-base canary on the CHOSEN layout, full +-120s scan: with the
    # right cadence and layout the correlation peaks at ~0 lag. A shifted
    # peak means the item cadence model no longer matches Spiideo's stream;
    # a weak/absent one at every layout means an unrecognized det-uv layout
    # — fail loudly either way.
    pooled_chosen: dict = {}
    for frames in det_windows.values():
        pooled_chosen.update(frames)
    lag_s, lag_r = solve_h.lag_peak_s(pooled_chosen, fragments)
    print(f'time-base check ({layout_label}): lag {lag_s:+.1f}s '
          f'(r={lag_r:.2f})', flush=True)
    if np.isnan(lag_r):
        raise RuntimeError(
            'time-base gate: no overlapping det/trk speed profile '
            '(detection stream too sparse for the canary)')
    if abs(lag_s) > MAX_LAG_S or lag_r < MIN_LAG_CORR:
        raise RuntimeError(
            f'time-base gate: det/trk lag {lag_s:+.1f}s (r={lag_r:.2f}) '
            f'with det layout {layout_label} — cadence drift or '
            'unrecognized det-uv layout')

    diag = solve_h.solve(det_windows['solve'], fragments,
                         fence_premasked=fence_premasked)
    ev = diag['eval']
    print(f'H solved: inlier median {diag["median_res"]:.4f} rayn; solve-'
          f'window eval rate {ev["rate"]:.2f} median {ev["median"]:.4f} '
          f'({ev["matches"]}/{ev["offered"]} over {diag["matched_frames"]} '
          f'frames); basin rates {diag["basin_rates"]}', flush=True)
    if diag['matched_frames'] < MIN_MATCHED_FRAMES:
        raise RuntimeError(
            f'quality gate: only {diag["matched_frames"]} paired frames')
    evals = {'solve': ev}
    lo, hi = diag['pitch_lo'], diag['pitch_hi']
    for name in eval_names:
        pairs = solve_h.time_paired_sets(det_windows[name], fragments, lo, hi,
                                         fence_premasked=fence_premasked)
        evals[name] = solve_h.evaluate(diag['H'], pairs, lo, hi)
        e = evals[name]
        print(f'held-out {name}: rate {e["rate"]:.2f} median '
              f'{e["median"]:.4f} ({e["matches"]}/{e["offered"]})', flush=True)
    if ev['rate'] < MIN_EVAL_RATE_SOLVE or ev['median'] > MAX_EVAL_MEDIAN:
        raise RuntimeError(
            f'quality gate: solve-window eval rate {ev["rate"]:.2f} / median '
            f'{ev["median"]:.4f} (need >={MIN_EVAL_RATE_SOLVE} / '
            f'<={MAX_EVAL_MEDIAN})')
    for name in eval_names:
        e = evals[name]
        if e['rate'] < MIN_EVAL_RATE_HELDOUT or e['median'] > MAX_EVAL_MEDIAN:
            raise RuntimeError(
                f'quality gate: held-out {name} rate {e["rate"]:.2f} / '
                f'median {e["median"]:.4f} (need >={MIN_EVAL_RATE_HELDOUT} '
                f'/ <={MAX_EVAL_MEDIAN})')
    # Per-region gates on the pooled evals: halves must be populated with
    # clean medians AND low SIGNED bias (a shear's coherent offset survives
    # the gate's magnitude truncation); quadrants catch corner-localized
    # errors that dilute into halves.
    halves = ('left', 'right', 'far', 'near')
    quads = ('far-left', 'far-right', 'near-left', 'near-right')
    pooled: dict = {r: {'n': 0, 'medians': [], 'biases': []}
                    for r in halves + quads}
    for e in evals.values():
        for r, st in e['regions'].items():
            p = pooled[r]
            p['n'] += st['n']
            if st['n'] >= 10:
                p['medians'].append(st['median'])
                p['biases'].append(st['bias'])
    problems = []
    for r in halves + quads:
        p = pooled[r]
        floor = MIN_HALF_MATCHES if r in halves else MIN_QUAD_MATCHES
        if p['n'] < floor:
            problems.append(f'{r} starved (n={p["n"]})')
            continue
        if p['medians'] and max(p['medians']) > MAX_REGION_MEDIAN:
            problems.append(f'{r} median {max(p["medians"]):.4f}')
        if p['biases'] and max(p['biases']) > MAX_REGION_BIAS:
            problems.append(f'{r} bias {max(p["biases"]):.4f}')
    if problems:
        raise RuntimeError('quality gate: per-region — ' + '; '.join(problems))

    # On-pitch filtering: percentile rect always computed (and always what
    # ships unless the scene is explicitly enabled); when a usable admin
    # calibration exists, the calibrated field-of-play filter runs alongside
    # it — dry-run comparison for un-enabled scenes, the shipped set for
    # enabled ones. KNOWN LIMIT: calibration marks are mesh-epoch-coupled;
    # after a mesh refit the admin re-marks (the refit acceptance flow),
    # which restores alignment — the near-empty fallback below catches a
    # stale epoch in the meantime.
    rect_chains = build_track.filter_chains_on_pitch(
        build_track.stitch(build_track.filter_on_pitch(
            fragments, diag['pitch_lo'], diag['pitch_hi'])),
        diag['pitch_lo'], diag['pitch_hi'])

    # The ENTIRE polygon path is guarded: this feature is optional, so no
    # failure inside it (novel stitch inputs — the polygon set is not a
    # subset of the rect set — or a near-singular H_cal producing NaN maps)
    # may ever kill a job that would otherwise ship rect_chains.
    filter_cmp = None
    use_polygon = False
    poly_chains = None
    chains = rect_chains
    cal = fetch_calibration(row.get('spiideo_scene_id'))
    cal_reason = build_track.calibration_unusable_reason(cal)
    if cal_reason is None:
        try:
            # sign/scale reference: the median of all fragment medians is a
            # physical on-ground tracker position (premise-validated) — it
            # fixes the composed map's projective sign so beyond-horizon
            # points cannot mirror into the pitch box.
            ref = np.median(np.vstack(
                [np.median(xy, axis=0) for _, xy in fragments]), axis=0)
            pmap = build_track.pitch_frame_map(
                diag['H'], cal['homography'], ref_metric_xy=ref)
            length_m = float(cal['pitch_length_m'])
            width_m = float(cal['pitch_width_m'])
            poly_chains = build_track.filter_on_pitch_calibrated(
                build_track.stitch(build_track.filter_on_pitch_calibrated(
                    fragments, pmap, length_m, width_m,
                    apron=build_track.FIELD_FRAGMENT_APRON_M)),
                pmap, length_m, width_m,
                apron=build_track.FIELD_CHAIN_APRON_M)
        except Exception as err:  # noqa: BLE001 — degrade to rect, never die
            cal_reason = f'polygon filter failed: {err}'
            poly_chains = None
    if poly_chains is not None:
        enabled = (row.get('spiideo_scene_id') or '') in FIELD_FILTER_SCENES
        # premise-as-code: a healthy calibrated filter keeps a cloud spanning
        # most of the pitch; a partially-wrong map (epoch drift amputating a
        # flank) fails this even when the count ratio looks plausible.
        span_x, span_y = build_track.pitch_span_m(poly_chains, pmap)
        span_ok = span_x >= 0.6 * length_m and span_y >= 0.6 * width_m
        use_polygon, fallback = build_track.choose_filter(
            enabled, len(rect_chains), len(poly_chains), span_ok=span_ok)
        filter_cmp = {'rectChains': len(rect_chains),
                      'polygonChains': len(poly_chains),
                      'polygonSpanM': [round(span_x, 1), round(span_y, 1)]}
        if fallback:
            # Loud: a frame/epoch mismatch maps the pitch elsewhere and would
            # ship a near-empty artifact. 'ready' is terminal.
            print(f'FIELD FILTER FALLBACK: polygon kept {len(poly_chains)}/'
                  f'{len(rect_chains)} chains (<5%) — shipping percentile '
                  f'rect; check the calibration / mesh epoch', flush=True)
            filter_cmp['fallback'] = True
        if use_polygon:
            chains = poly_chains
        print(f'field filter {"ENABLED" if use_polygon else "dry-run"}: '
              f'polygon kept {len(poly_chains)} chains vs rect '
              f'{len(rect_chains)}', flush=True)
    else:
        print(f'field filter: percentile rect ({cal_reason})', flush=True)

    conc = median_concurrency(chains)
    if conc < MIN_MEDIAN_CONCURRENT and use_polygon:
        # The polygon, not the footage, may be starving the gate (a wrong-but-
        # not-collapsed calibration). Ship the honest rect rather than settle
        # the row at error — and say so loudly.
        print(f'FIELD FILTER FALLBACK: polygon chains fail the concurrency '
              f'gate ({conc:.0f} < {MIN_MEDIAN_CONCURRENT}; polygon '
              f'{len(poly_chains)} vs rect {len(rect_chains)} chains) — '
              f'shipping percentile rect', flush=True)
        use_polygon = False
        filter_cmp['fallback'] = True
        chains = rect_chains
        conc = median_concurrency(chains)
    if conc < MIN_MEDIAN_CONCURRENT:
        raise RuntimeError(
            f'quality gate: median concurrent tracked objects {conc:.0f} < '
            f'{MIN_MEDIAN_CONCURRENT}')

    span_s = (max(int(c[0][-1]) for c in chains)
              - min(int(c[0][0]) for c in chains)) / 1e6
    # denominator from stream METADATA: a mid-stream item gap truncates the
    # fetch, and len(items)*cadence would shrink in lockstep — the gate must
    # measure against what Spiideo says the stream covers
    stop = streams['tracklets'].get('stopTime')
    stream_span_s = ((int(stop) - start_us) / 1e6 if stop is not None
                     else len(trk_items) * cadence_us / 1e6)
    if span_s < MIN_SPAN_FRACTION * stream_span_s:
        raise RuntimeError(
            f'quality gate: tracked span {span_s:.0f}s < '
            f'{MIN_SPAN_FRACTION:.0%} of stream span {stream_span_s:.0f}s')

    # Un-gameable visual check: dots-on-raw-frame PNG into private
    # provenance. Required whenever the raw panorama is preserved — during
    # the pilot a human signs off on it before a venue is enabled.
    validation_png = None
    if row.get('panorama_s3_key'):
        # panorama_s3_key always lives in the job's own bucket (the row's
        # s3_bucket column pairs with s3_key, the produced video)
        url = s3.generate_presigned_url(
            'get_object',
            Params={'Bucket': BUCKET, 'Key': row['panorama_s3_key']},
            ExpiresIn=3600)
        # pooled frames from ALL windows: the banked video can be shorter
        # than the streams, leaving the solve window uncovered — the early
        # eval window still yields verifiable panels
        validation_png = validate_render.render_validation_png(
            url, start_us, pooled_chosen, fragments, diag['H'],
            rayn_to_uv)
        if validation_png is None:
            raise RuntimeError(
                'validation render failed (raw panorama present but no '
                'frame could be extracted)')
        print(f'validation PNG rendered ({len(validation_png) // 1024} KB)',
              flush=True)
    else:
        print('no panorama_s3_key on row — skipping validation PNG',
              flush=True)

    # NOTE: `build_track.dedup_concurrent` exists + is tested, but is deliberately
    # NOT wired in: measurement showed a SAFE metric dedup barely helps (Spiideo's
    # duplicate fragments sit 1-1.7m apart — the same regime as close-marking
    # players — so no radius separates them safely; concurrent-p95 only 19→18),
    # and the duplicate-dot artifact converges on Tier-3 (jersey). See
    # scripts/player-identity/tier2b/RECORD.md §"Phase 1b".
    payload = build_track.build_payload(chains, diag['H'], start_us, diag)
    payload['meta']['pitchFilter'] = ('polygon' if use_polygon
                                      else 'percentile-rect')
    if filter_cmp is not None:
        payload['meta']['pitchFilterCompare'] = filter_cmp
    upload_track(payload)
    solve_doc = {
        'H': diag['H'].tolist(),
        'median_res': diag['median_res'],
        'cadence_us': cadence_us,
        'lag_s': lag_s,
        'lag_r': lag_r,
        'det_layout': {'chosen': layout_label, 'candidates': layout_diag,
                       'selection_scan_s': MAX_LAG_S},
        'basin_rates': diag.get('basin_rates'),
        'windows': {k: [(w[0] - start_us) / 1e6, (w[1] - start_us) / 1e6]
                    for k, w in windows.items()},
        'pitch_lo': diag['pitch_lo'],
        'pitch_hi': diag['pitch_hi'],
        'evals': evals,
        'matched_frames': diag['matched_frames'],
        'n_matches': diag['n_matches'],
        'meta': payload['meta'],
    }
    archive_provenance(trk_items, solve_doc, validation_png)

    HEARTBEAT_STOP.set()
    set_status({'tracklets_status': 'ready', 'tracklets_error': None},
               retries=3)
    print(f'tracklets ready: {payload["meta"]["nObjects"]} objects, '
          f'median concurrency {conc:.0f}, span {span_s:.0f}s', flush=True)


def _on_sigterm(signum, frame):  # noqa: ARG001
    HEARTBEAT_STOP.set()
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
            set_status({'tracklets_status': 'error', 'tracklets_error': msg},
                       retries=3)
        except Exception as err2:  # noqa: BLE001
            print(f'could not write error status: {err2}', file=sys.stderr,
                  flush=True)
        sys.exit(1)

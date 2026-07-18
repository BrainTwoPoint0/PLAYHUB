"""Jersey-labels Batch job — read jersey numbers off the banked raw panorama
for an allowlisted organized-kit venue, assemble (number, kit) identity
SLOTS, and republish the game's tracklets.json enriched with `jersey` +
`slot` per labelled object.

Operational contract mirrors player-tracklets/entrypoint.py: 2-minute
heartbeat on jersey_started_at, terminal status write (ready|error,
self-authored messages only), SIGTERM handler, non-zero exit on failure.

Inputs are OUR OWN artifacts only — archived tracklets provenance
(tracklets-raw.tar.gz + tracklets-solve.json, reconstructing the EXACT
production chains), the public scene mesh, and the preserved raw panorama.
No Spiideo/Veo calls at runtime.

Two-writer protocol with the tracklets job (which owns the base artifact):
the row's tracklets_started_at is recorded at claim time and re-checked
immediately before publish — if the tracklets job re-ran meanwhile, this job
aborts as 'stale' rather than publishing labels computed from superseded
provenance. The tracklets job resets jersey_status on its own success, so
the sweep re-enriches naturally.
"""

from __future__ import annotations

import hashlib
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

import build_track
import chains_source
import enrich
import harvest
import slots
import split
from mesh_rays import load_mesh_rays

RECORDING_ID = str(_uuid.UUID(os.environ['RECORDING_ID']))
GAME_ID = str(_uuid.UUID(os.environ['GAME_ID']))
SUPABASE_URL = os.environ['SUPABASE_URL'].rstrip('/')
SERVICE_KEY = os.environ['SUPABASE_SERVICE_ROLE_KEY']
BUCKET = os.environ['S3_RECORDINGS_BUCKET']
VP_S3_PREFIX = os.environ.get('VP_S3_PREFIX', 'panoramas')
WEIGHTS_S3_PREFIX = os.environ.get(
    'WEIGHTS_S3_PREFIX', 'provenance/jersey-reader/2026-07-16-probe')
HARVEST_STEP_S = float(os.environ.get('JERSEY_HARVEST_STEP_S', '4.0'))
# Stacked 2-lens panoramas have a horizontal seam at this fraction of frame
# height; boxes straddling it are two half-bodies. Empty string disables
# (single-lens venues). Pilot venue (HCT) is stacked.
SEAM_FRACTION_ENV = os.environ.get('JERSEY_SEAM_FRACTION', '0.5')
NUM_THREADS = int(os.environ.get('JERSEY_TORCH_THREADS', '8'))
MESH_BUCKET = 'panorama-meshes'
STRHUB_ROOT = os.environ.get('STRHUB_ROOT', '/app/jersey-number-pipeline')

WORK = os.environ.get('JERSEY_WORKDIR', '/tmp/jersey')
MAX_DEBUG_CROPS = 150

# The measured harness's interpolation bracket (solve_h.INTERP_MAX_BRACKET_US
# = 0.6s): a chain position interpolated across a longer (bridged) gap sits
# mid-bridge — exactly where identity is least certain — and attributes crops
# to whichever body stands near the phantom point. 5x looser here was a port
# bug (CV review, 2026-07-18); every purity number was measured at 0.6s.
INTERP_MAX_BRACKET_US = 600_000

s3 = boto3.client('s3')
HEARTBEAT_STOP = threading.Event()


class JobError(RuntimeError):
    """The ONLY exception whose message is written verbatim to the
    club-readable jersey_error column. Torch raises RuntimeError routinely
    (layer names, tensor shapes, local paths) — a bare RuntimeError filter
    would leak those; everything that is not a JobError degrades to its type
    name (security review, 2026-07-18)."""


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
              f'&select=spiideo_game_id,spiideo_scene_id,panorama_s3_key,'
              f'tracklets_status,tracklets_started_at')
    rows = json.loads(out)
    if not rows:
        raise JobError('recording row not found')
    return rows[0]


def fetch_calibration(scene_id: str | None) -> dict | None:
    """Active pitch calibration for the scene, or None. Non-fatal by design:
    GK zone-slots are optional — a fetch error must never fail the job.

    LOCKSTEP: mirrors player-tracklets/entrypoint.py fetch_calibration
    (importing that module is impossible here — it hard-requires Spiideo env
    at import and modules absent from this image). Keep the select list and
    the mesh-epoch check identical to the original.
    """
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
            # Mesh-epoch check: marks were made through the mesh registered
            # at MARKING time; a refit/fanout since makes the composed map
            # cross-epoch garbage — skip until the admin re-marks.
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


def fetch_half_bounds(start_us: int, end_s: float, spans: list) -> tuple:
    """((half1_us, half2_us), source) or (None, reason). Halves on the chain
    µs clock: chain_µs = start_us + video_seconds × 1e6 (build_payload's
    exact inverse — timestamp_seconds and the harvest t_vp share the
    produced-video clock).

    Primary: admin-tagged phase events. Fallback: the harvest's own activity
    spans when they split cleanly into exactly two. Anything ambiguous →
    None (no GK slots — honest beats guessed halves; keepers swap ends at
    half time, so a wrong boundary silently swaps bodies)."""
    try:
        out = _sb('GET',
                  f'/rest/v1/playhub_recording_events'
                  f'?match_recording_id=eq.{RECORDING_ID}'
                  f'&event_type=in.(kick_off,half_time,full_time)'
                  f'&select=event_type,timestamp_seconds'
                  f'&order=timestamp_seconds.asc')
        events = json.loads(out)
    except Exception as err:  # noqa: BLE001
        print(f'phase events fetch failed (non-fatal): {err}', flush=True)
        events = []
    bounds = slots.half_bounds_from_events(events, start_us, end_s)
    if bounds is not None:
        return bounds, 'phase events'
    if events:
        print(f'phase events unusable ({len(events)} events)', flush=True)
    bounds = slots.halves_from_spans(spans, start_us)
    if bounds is not None:
        return bounds, 'activity spans'
    return (None, f'no usable half bounds ({len(events)} phase events, '
                  f'{len(spans)} activity spans)')


def heartbeat_loop(stop: threading.Event):
    from datetime import datetime, timezone
    while not stop.wait(120):
        try:
            set_status({'jersey_started_at':
                        datetime.now(timezone.utc).isoformat()})
        except Exception as err:  # noqa: BLE001
            print(f'heartbeat failed (non-fatal): {err}', flush=True)


def download_mesh(dest_dir: str):
    os.makedirs(dest_dir, exist_ok=True)
    for name in ('scene.json', 'vertices.bin', 'indices.bin'):
        url = (f'{SUPABASE_URL}/storage/v1/object/public/'
               f'{MESH_BUCKET}/{GAME_ID}/{name}')
        with urllib.request.urlopen(url, timeout=60) as resp, \
                open(os.path.join(dest_dir, name), 'wb') as f:
            f.write(resp.read())


def download_s3(key: str, dest: str, sha256: str | None = None):
    s3.download_file(BUCKET, key, dest)
    if sha256:
        h = hashlib.sha256()
        with open(dest, 'rb') as f:
            for blk in iter(lambda: f.read(1 << 20), b''):
                h.update(blk)
        if h.hexdigest() != sha256:
            raise JobError(f'sha256 mismatch for {os.path.basename(dest)}')


def fetch_live_meta() -> dict | None:
    """meta of the currently-published artifact (informational only)."""
    try:
        url = (f'{SUPABASE_URL}/storage/v1/object/public/'
               f'{MESH_BUCKET}/{GAME_ID}/tracklets.json')
        with urllib.request.urlopen(url, timeout=60) as resp:
            return json.loads(resp.read()).get('meta')
    except Exception:  # noqa: BLE001
        return None


def upload_track(payload: dict):
    body = json.dumps(payload, separators=(',', ':')).encode()
    _sb('POST',
        f'/storage/v1/object/{MESH_BUCKET}/{GAME_ID}/tracklets.json',
        body, extra={'x-upsert': 'true'})
    return len(body)


def archive_provenance(log_doc: dict, debug_crops: list):
    # DELIBERATELY outside the VP_S3_PREFIX ('panoramas/*') prefix: that
    # prefix carries a CloudFront OAC GetObject grant, and the debug tar
    # holds face-bearing player crops — provenance has no reason to live in
    # a CDN-servable prefix (security review, 2026-07-18).
    prefix = f'provenance/jersey-labels/{GAME_ID}'
    s3.put_object(Bucket=BUCKET,
                  Key=f'{prefix}/jersey-labels.json',
                  Body=json.dumps(log_doc, indent=1).encode(),
                  ContentType='application/json')
    if debug_crops:
        import cv2
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode='w:gz') as tar:
            for name, crop in debug_crops:
                ok, jpg = cv2.imencode('.jpg', crop)
                if not ok:
                    continue
                info = tarfile.TarInfo(name=name)
                info.size = len(jpg)
                tar.addfile(info, io.BytesIO(jpg.tobytes()))
        buf.seek(0)
        s3.put_object(Bucket=BUCKET,
                      Key=f'{prefix}/jersey-debug.tar.gz',
                      Body=buf.read(), ContentType='application/gzip')


def main():
    import cv2

    row = fetch_row()
    if row.get('spiideo_game_id') != GAME_ID:
        raise JobError('GAME_ID does not match the recording row')
    if row.get('tracklets_status') != 'ready':
        raise JobError('tracklets not ready — nothing to enrich')
    if not row.get('panorama_s3_key'):
        raise JobError('no banked raw panorama on this recording')
    claimed_tracklets_started_at = row.get('tracklets_started_at')

    threading.Thread(target=heartbeat_loop, args=(HEARTBEAT_STOP,),
                     daemon=True).start()
    os.makedirs(WORK, exist_ok=True)

    # ── inputs ──────────────────────────────────────────────────────────
    prov = os.path.join(WORK, 'prov')
    os.makedirs(prov, exist_ok=True)
    for name in ('tracklets-raw.tar.gz', 'tracklets-solve.json'):
        download_s3(f'{VP_S3_PREFIX}/{GAME_ID}/{name}',
                    os.path.join(prov, name))
    download_mesh(os.path.join(WORK, 'mesh'))
    weights = {}
    for name, env in (('parseq_armB.pt', 'PARSEQ_SHA256'),
                      ('legibility_soccernet.pth', 'LEGIBILITY_SHA256'),
                      ('yolov8x.pt', 'YOLO_SHA256')):
        dest = os.path.join(WORK, name)
        download_s3(f'{WEIGHTS_S3_PREFIX}/{name}', dest,
                    sha256=os.environ.get(env) or None)
        weights[name] = dest
    pano = os.path.join(WORK, 'pano.mp4')
    print(f'downloading panorama {row["panorama_s3_key"]}', flush=True)
    s3.download_file(BUCKET, row['panorama_s3_key'], pano)
    print(f'panorama on disk: {os.path.getsize(pano) / 1e9:.1f} GB',
          flush=True)

    # ── chains (exact production reconstruction) ────────────────────────
    solve, items, source_digest = chains_source.load_provenance(prov)
    chains, Hm, start_us = chains_source.build_chains(solve, items)
    if not chains:
        raise JobError('provenance reconstructed to zero chains')
    print(f'{len(chains)} chains reconstructed (digest {source_digest[:12]})',
          flush=True)
    pitch_lo = np.asarray(solve['pitch_lo'], float)
    pitch_hi = np.asarray(solve['pitch_hi'], float)

    uv, rays = load_mesh_rays(os.path.join(WORK, 'mesh'))
    front = rays[:, 2] > 0.05
    uv_f, rays_f = uv[front], rays[front]
    rayn = rays_f[:, :2] / rays_f[:, 2:3]
    rayn_tree = cKDTree(rayn)

    def rayn_to_uv(pts: np.ndarray) -> np.ndarray:
        _, idx = rayn_tree.query(pts, k=3)
        return uv_f[idx].mean(axis=1)

    # ── harvest ─────────────────────────────────────────────────────────
    cap = cv2.VideoCapture(pano)
    if not cap.isOpened():
        raise JobError('could not open the downloaded panorama')
    frame_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    frame_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    n_frames_total = cap.get(cv2.CAP_PROP_FRAME_COUNT)
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    dur_s = n_frames_total / fps if n_frames_total > 0 else 0.0
    if dur_s <= 0:
        raise JobError('panorama reports zero duration')
    print(f'panorama {frame_w}x{frame_h}, {dur_s:.0f}s', flush=True)

    if SEAM_FRACTION_ENV.strip():
        harvest.SEAM_FRACTION = float(SEAM_FRACTION_ENV)
        seam_note = harvest.SEAM_FRACTION
    else:
        harvest.SEAM_FRACTION = 10.0  # off the frame — disabled
        seam_note = None

    from ultralytics import YOLO
    yolo = YOLO(weights['yolov8x.pt'])

    def detect(win):
        r = yolo.predict(win, classes=[0], conf=0.3, imgsz=1280,
                         verbose=False)[0]
        return r.boxes.xyxy.cpu().numpy()

    from reader import JerseyReader
    rd = JerseyReader(weights['parseq_armB.pt'],
                      weights['legibility_soccernet.pth'],
                      STRHUB_ROOT, num_threads=NUM_THREADS)
    from kit import shirt_lab

    cents = harvest.play_centroids(chains, start_us)
    counts = harvest.mover_counts(chains, start_us)
    spans = harvest.in_match_spans(counts)
    if not spans:
        raise JobError(
            'no in-match activity span found — cannot anchor the harvest')
    print(f'{len(cents)} play bins; in-match spans '
          + ', '.join(f'{lo:.0f}-{hi:.0f}s' for lo, hi in spans), flush=True)

    records: list = []
    debug_crops: list = []
    pending: list = []   # (record, crop) awaiting batched inference

    def flush_pending():
        if not pending:
            return
        recs = [r for r, _ in pending]
        crops = [c for _, c in pending]
        legs = rd.legibility(crops)
        reads = rd.read(crops)
        for r, c, leg, (txt, conf) in zip(recs, crops, legs, reads):
            r['leg'] = round(float(leg), 3)
            r['read'] = txt
            r['conf'] = round(float(conf), 3)
            if (conf >= slots.CONF and txt.isdigit() and 1 <= len(txt) <= 2
                    and leg >= slots.LEG_GATE
                    and len(debug_crops) < MAX_DEBUG_CROPS):
                debug_crops.append(
                    (f'c{r["chain"]}_t{int(r["t_vp"])}_{txt}.jpg', c))
        pending.clear()

    times = np.arange(0.0, dur_s - 2.0, HARVEST_STEP_S)
    n_frames = 0
    for t_vp in times:
        t_rel = t_vp  # video clock == stream-relative clock
        if not harvest.in_spans(t_rel, spans):
            continue
        b = int(t_rel / harvest.PLAY_BIN_S)
        cent = cents.get(b)
        if cent is None:
            cent = cents.get(b - 1)
        if cent is None:
            continue
        t_us = start_us + t_vp * 1e6
        proj = harvest.project_chains_at(
            chains, Hm, rayn_to_uv, t_us, frame_w, frame_h,
            INTERP_MAX_BRACKET_US)
        if len(proj) < 4:
            continue
        cap.set(cv2.CAP_PROP_POS_MSEC, t_vp * 1000.0)
        ok, img = cap.read()
        if not ok:
            continue
        n_frames += 1
        recs = harvest.harvest_frame(img, t_vp, proj, cent, detect,
                                     frame_w, frame_h)
        for r in recs:
            crop = r.pop('crop')
            r['t_us'] = t_us
            r['on_pitch'] = bool(
                pitch_lo[0] <= r['x_m'] <= pitch_hi[0]
                and pitch_lo[1] <= r['y_m'] <= pitch_hi[1])
            r['in_match'] = True   # times are already span-filtered
            if r['solo']:
                r['kit_desc'] = shirt_lab(crop, r['h_px'])
                pending.append((r, crop))
            records.append(r)
        if len(pending) >= 256:
            flush_pending()
        if n_frames % 50 == 0:
            print(f'[{n_frames} frames] t={t_vp:.0f}s, '
                  f'{len(records)} crops so far', flush=True)
    flush_pending()
    cap.release()
    solo_records = [r for r in records if r['solo']]
    print(f'harvest: {n_frames} frames -> {len(records)} crops '
          f'({len(solo_records)} solo)', flush=True)
    if not solo_records:
        raise JobError('harvest produced zero solo crops')

    # ── kit clustering ──────────────────────────────────────────────────
    import kit as kit_mod
    anchor_chains = sorted({
        r['chain'] for r in slots.confident(solo_records)
        if r.get('play_dist') is not None
        and r['play_dist'] <= slots.PLAY_GATE_M})
    descs = kit_mod.chain_descriptors(solo_records)
    anchors = [c for c in anchor_chains if c in descs]
    if not anchors:
        raise JobError('no kit anchor chains (no confident reads?)')
    try:
        centroids, k, sil = kit_mod.cluster_kits(
            np.stack([descs[c] for c in anchors]))
    except ValueError as err:  # self-authored message — safe to surface
        raise JobError(str(err)) from err
    print(f'kit clusters: k={k} (silhouette {sil:.3f}, '
          f'{len(anchors)} anchors)', flush=True)
    for r in solo_records:
        d = r.get('kit_desc')
        r['kit'] = kit_mod.assign_kit(d, centroids) if d is not None else None

    # ── kit change-point splitting (repair body-impure chains) ──────────
    kit_prof = slots.chain_kit_profile(solo_records)
    impure = slots.kit_inconsistent_chains(kit_prof)
    by_chain_crops: dict = {}
    for r in solo_records:
        if r.get('kit') is not None:
            by_chain_crops.setdefault(r['chain'], []).append(r)
    decisions: dict = {}
    for c in sorted(impure):
        rs = by_chain_crops.get(c, [])
        decisions[c] = split.propose_split(
            chains[c], [r['t_us'] for r in rs], [r['kit'] for r in rs],
            min_span_s=build_track.MIN_CHAIN_SPAN_S)
    accepted = {c: d for c, d in decisions.items() if d['accepted']}
    print(f'split: {len(impure)} kit-inconsistent chains, '
          f'{len(accepted)} split, {len(decisions) - len(accepted)} refused',
          flush=True)
    final_chains, index_map = split.apply_splits(chains, accepted)
    split.remap_records(solo_records, index_map)
    split.remap_records([r for r in records if not r['solo']], index_map)

    # ── labels + slots ──────────────────────────────────────────────────
    labels, label_diag = slots.build_labels(solo_records)
    slot_of, slot_diag = slots.assign_slots(labels, final_chains)
    print(f'labels: {label_diag}; slots: {slot_diag}', flush=True)

    # ── synthetic GK zone-slots (2026-07-18) ────────────────────────────
    # Keepers never earn a jersey slot (harvest windows the play, kit
    # clustering excludes the GK kit) yet are the players the follow loses
    # hardest. Every failure here degrades to "no GK slots" — this block
    # must never settle the row at error.
    gk_slot_of: dict = {}
    gk_diag: dict = {}
    try:
        cal = fetch_calibration(row.get('spiideo_scene_id'))
        reason = build_track.calibration_unusable_reason(cal)
        if reason:
            print(f'gk slots skipped: {reason}', flush=True)
        else:
            meds = np.asarray([np.median(xy, axis=0)
                               for _, xy in final_chains])
            pmap = build_track.pitch_frame_map(
                Hm, cal['homography'], np.median(meds, axis=0))
            length_m = float(cal['pitch_length_m'])
            width_m = float(cal['pitch_width_m'])
            span_x, span_y = build_track.pitch_span_m(final_chains, pmap)
            if span_x < 0.6 * length_m or span_y < 0.6 * width_m:
                print(f'gk slots skipped: span premise failed '
                      f'({span_x:.1f}x{span_y:.1f}m mapped on a '
                      f'{length_m:.0f}x{width_m:.0f}m pitch)', flush=True)
            else:
                bounds, src = fetch_half_bounds(start_us, dur_s, spans)
                if bounds is None:
                    print(f'gk slots skipped: {src}', flush=True)
                else:
                    gk_slot_of, gk_diag = slots.assign_gk_slots(
                        final_chains, pmap, length_m, width_m, bounds,
                        set(slot_of))
                    print(f'gk slots ({src}): {gk_diag}', flush=True)
    except Exception as err:  # noqa: BLE001 — optional enrichment only
        print(f'gk slots skipped (non-fatal): '
              f'{type(err).__name__}: {err}', flush=True)
        gk_slot_of, gk_diag = {}, {'error': type(err).__name__}

    # ── enriched artifact ───────────────────────────────────────────────
    diag = {'median_res': solve['median_res'],
            'matched_frames': solve['matched_frames'],
            'eval': solve['evals'].get('solve')
            if isinstance(solve.get('evals'), dict) else None}
    try:
        payload = build_track.build_payload(final_chains, Hm, start_us, diag)
    except RuntimeError as err:  # caps message — self-authored, safe
        raise JobError(str(err)) from err
    attached = enrich.attach_labels(payload, final_chains, labels, slot_of)
    gk_attached = enrich.attach_slots(payload, final_chains, gk_slot_of)
    enrich.stamp_meta(
        payload, harvest_step_s=HARVEST_STEP_S, source_digest=source_digest,
        kits=int(k), slots=slot_diag['slots'], labelled=attached,
        split_accepted=len(accepted),
        split_refused=len(decisions) - len(accepted),
        gk_slots=gk_diag.get('gkSlots', 0))
    try:
        enrich.assert_caps(payload)
    except RuntimeError as err:  # self-authored caps message
        raise JobError(str(err)) from err

    # ── staleness check + publish ───────────────────────────────────────
    fresh = fetch_row()
    if (fresh.get('tracklets_status') != 'ready'
            or fresh.get('tracklets_started_at')
            != claimed_tracklets_started_at):
        raise JobError(
            'stale — tracklets re-ran while this job was computing')
    size = upload_track(payload)
    log_doc = {
        'gameId': GAME_ID,
        'recordingId': RECORDING_ID,
        'sourceDigest': source_digest,
        'harvestStepS': HARVEST_STEP_S,
        'seamFraction': seam_note,
        'frames': n_frames,
        'crops': len(records),
        'soloCrops': len(solo_records),
        'kit': {'k': int(k), 'silhouette': round(sil, 3),
                'centroids': [[round(float(x), 1) for x in c]
                              for c in centroids],
                'anchors': len(anchors)},
        'labelDiag': label_diag,
        'slotDiag': slot_diag,
        'gkDiag': gk_diag,
        'roster': enrich.summarize(labels, slot_of),
        'splitDecisions': {str(c): d for c, d in decisions.items()},
        'meta': payload['meta'],
    }
    archive_provenance(log_doc, debug_crops)

    HEARTBEAT_STOP.set()
    set_status({'jersey_status': 'ready', 'jersey_error': None}, retries=3)
    n_obj, n_pts = enrich.payload_sizes(payload)
    print(f'jersey ready: {attached} labelled objects across '
          f'{slot_diag["slots"]} slots + {gk_attached} gk-slotted objects '
          f'across {gk_diag.get("gkSlots", 0)} gk slots; artifact '
          f'{n_obj} objects / {n_pts} pts / {size / 1e6:.1f}MB', flush=True)


def _on_sigterm(signum, frame):  # noqa: ARG001
    HEARTBEAT_STOP.set()
    try:
        set_status({'jersey_status': 'error',
                    'jersey_error': 'terminated (Batch timeout/SIGTERM)'})
    finally:
        sys.exit(1)


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, _on_sigterm)
    try:
        main()
    except Exception as err:  # noqa: BLE001 — terminal status, non-zero exit
        if isinstance(err, JobError):
            msg = str(err)[:300]
        else:
            msg = f'{type(err).__name__} (see job logs)'
        print(f'FATAL: {type(err).__name__}: {str(err)[:500]}',
              file=sys.stderr, flush=True)
        HEARTBEAT_STOP.set()
        try:
            set_status({'jersey_status': 'error', 'jersey_error': msg},
                       retries=3)
        except Exception as err2:  # noqa: BLE001
            print(f'could not write error status: {err2}', file=sys.stderr,
                  flush=True)
        sys.exit(1)

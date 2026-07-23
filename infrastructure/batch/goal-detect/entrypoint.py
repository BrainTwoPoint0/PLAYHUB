"""Goal-detect Batch job — run the FROZEN goal-detection chain on a Spiideo
recording's tracklets artifact, cut a review clip per candidate from the
produced match video, and write review-first candidate rows.

Operational contract mirrors jersey-labels/entrypoint.py: 2-minute heartbeat
on goal_detect_started_at, terminal status write (ready|error, self-authored
messages only), SIGTERM handler, non-zero exit on failure.

Inputs are OUR OWN artifacts only: the public tracklets.json, the ACTIVE
admin pitch calibration (mesh-epoch + red-band gated — REQUIRED here, unlike
jersey's optional GK path: no usable calibration means the projection is
garbage, so the job settles as error), the banked frozen sklearn models
(sha256-pinned), and the produced match mp4 for clips. No Spiideo calls.

Review-decision safety (portrait writeRenderGuarded semantics): candidate
writes CAS on status in (draft, error) — an approved/rejected row is never
touched by a re-run; superseded drafts flip to error, never deleted.

Two-writer protocol with the tracklets job: tracklets_started_at is recorded
at claim and re-checked before candidate writes; a mid-run tracklets re-run
aborts this job as 'stale'. The tracklets job does NOT reset
goal_detect_status (a silent re-detection would orphan reviewed candidates —
re-detection is a manual operator step for the pilot).
"""
from __future__ import annotations

import hashlib
import json
import os
import signal
import subprocess
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
import uuid as _uuid

import boto3
import joblib

import chain as chain_mod
import clip_plan
import kickoff
import projection
import reconcile
from calibration_gate import calibration_unusable_reason

RECORDING_ID = str(_uuid.UUID(os.environ['RECORDING_ID']))
GAME_ID = str(_uuid.UUID(os.environ['GAME_ID']))
SUPABASE_URL = os.environ['SUPABASE_URL'].rstrip('/')
SERVICE_KEY = os.environ['SUPABASE_SERVICE_ROLE_KEY']
BUCKET = os.environ['S3_RECORDINGS_BUCKET']
AWS_REGION = os.environ.get('AWS_REGION', 'eu-west-2')
WEIGHTS_S3_PREFIX = os.environ.get(
    'GOAL_WEIGHTS_S3_PREFIX', 'provenance/goal-detect/2026-07-23')
MESH_BUCKET = 'panorama-meshes'
CLIPS_BUCKET = 'goal-review-clips'
WORK = os.environ.get('GOAL_DETECT_WORKDIR', '/tmp/goal-detect')

# Clip window + encode settings live in clip_plan (pure, unit-tested):
# standard tier is byte-identical to the original fixed settings; episodes
# whose full window exceeds 300s get the extended 480s @ 700kbps tier so a
# flurry's later goals stay inside the clip (AGREED PLAN item 1c).
RECONCILE_S = chain_mod.MERGE_S   # episode-identity radius for re-run matching

# The presign must be REGIONAL (eu-west-2) + s3v4: a region-less client
# presigns SigV2 on the global endpoint and ffmpeg's range seeks silently
# fail mid-scan (pilot lesson, stoppage_shortlist.py).
s3 = boto3.client('s3', region_name=AWS_REGION)
HEARTBEAT_STOP = threading.Event()


class JobError(RuntimeError):
    """The ONLY exception whose message is written verbatim to the
    goal_detect_error column (readable outside engineering). Everything else
    degrades to its type name."""


def _sb(method: str, path: str, body: bytes | None = None,
        extra: dict | None = None) -> bytes:
    req = urllib.request.Request(f'{SUPABASE_URL}{path}', data=body,
                                 method=method)
    req.add_header('apikey', SERVICE_KEY)
    req.add_header('Authorization', f'Bearer {SERVICE_KEY}')
    req.add_header('Content-Type', 'application/json')
    for k, v in (extra or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=120) as resp:
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
              f'&select=spiideo_game_id,spiideo_scene_id,s3_key,'
              f'tracklets_status,tracklets_started_at')
    rows = json.loads(out)
    if not rows:
        raise JobError('recording row not found')
    return rows[0]


def fetch_calibration(scene_id: str | None) -> dict | None:
    """Active pitch calibration, mesh-epoch gated.

    LOCKSTEP: mirrors player-tracklets/entrypoint.py fetch_calibration (that
    module hard-requires Spiideo env + cv2 at import). Keep the select list
    and the epoch check identical. Unlike jersey (optional GK slots), a
    missing/unusable calibration here is FATAL to the caller — but this
    function still returns None so the caller can raise a JobError with the
    reason string.
    """
    if not scene_id:
        return None
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
        reg = _sb('GET',
                  f'/rest/v1/playhub_panorama_scene_meshes'
                  f'?scene_id=eq.{sid}&select=source_game_id')
        reg_rows = json.loads(reg)
        src = reg_rows[0]['source_game_id'] if reg_rows else None
        if (src and cal.get('mesh_source_game_id')
                and src != cal['mesh_source_game_id']):
            print(f'calibration mesh epoch mismatch (marked on '
                  f'{cal["mesh_source_game_id"]}, registry now {src})',
                  flush=True)
            return None
    return cal


def heartbeat_loop(stop: threading.Event):
    from datetime import datetime, timezone
    while not stop.wait(120):
        try:
            set_status({'goal_detect_started_at':
                        datetime.now(timezone.utc).isoformat()})
        except Exception as err:  # noqa: BLE001
            print(f'heartbeat failed (non-fatal): {err}', flush=True)


def download_s3(key: str, dest: str, sha256: str | None = None):
    s3.download_file(BUCKET, key, dest)
    if sha256:
        h = hashlib.sha256()
        with open(dest, 'rb') as f:
            for blk in iter(lambda: f.read(1 << 20), b''):
                h.update(blk)
        if h.hexdigest() != sha256:
            raise JobError(f'sha256 mismatch for {os.path.basename(dest)}')


def fetch_tracklets() -> dict:
    url = (f'{SUPABASE_URL}/storage/v1/object/public/'
           f'{MESH_BUCKET}/{GAME_ID}/tracklets.json')
    try:
        with urllib.request.urlopen(url, timeout=120) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as err:
        if err.code == 404:
            raise JobError('tracklets artifact not found') from err
        raise


def presign_video(s3_key: str) -> str:
    url = s3.generate_presigned_url(
        'get_object', Params={'Bucket': BUCKET, 'Key': s3_key},
        ExpiresIn=7200)
    # fail-fast 206 probe: a dead/misregioned URL must abort, never let
    # ffmpeg silently truncate mid-scan (pilot lesson)
    req = urllib.request.Request(url, headers={'Range': 'bytes=0-1023'})
    with urllib.request.urlopen(req, timeout=60) as resp:
        if resp.status != 206:
            raise JobError(f'video probe returned {resp.status}, not 206')
    return url


def cut_clip(url: str, p: clip_plan.ClipPlan, dest: str):
    subprocess.run(
        ['ffmpeg', '-y', '-nostdin', '-loglevel', 'error',
         '-ss', f'{p.start:.2f}', '-i', url, '-t', f'{p.dur:.1f}',
         '-vf', f'scale={clip_plan.CLIP_WIDTH}:-2', '-an',
         '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '27',
         '-maxrate', p.maxrate, '-bufsize', p.bufsize, dest],
        check=True, timeout=1800)


def clip_exists(storage_path: str) -> bool:
    """Retry resume guard (infra review M1): a timed-out attempt must not
    re-encode clips it already banked — three attempts of the same slow
    encode would settle the row at error with the work 90% done."""
    req = urllib.request.Request(
        f'{SUPABASE_URL}/storage/v1/object/info/authenticated/'
        f'{CLIPS_BUCKET}/{storage_path}')
    req.add_header('apikey', SERVICE_KEY)
    req.add_header('Authorization', f'Bearer {SERVICE_KEY}')
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status == 200
    except urllib.error.HTTPError:
        return False
    except Exception:  # noqa: BLE001 — transient probe failure = re-encode
        return False


def upload_clip(path: str, storage_path: str):
    with open(path, 'rb') as f:
        body = f.read()
    req = urllib.request.Request(
        f'{SUPABASE_URL}/storage/v1/object/{CLIPS_BUCKET}/{storage_path}',
        data=body, method='POST')
    req.add_header('apikey', SERVICE_KEY)
    req.add_header('Authorization', f'Bearer {SERVICE_KEY}')
    req.add_header('Content-Type', 'video/mp4')
    req.add_header('x-upsert', 'true')
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            resp.read()
    except urllib.error.HTTPError as err:
        # Storage wraps its 413 in an HTTP 400; surface the size so the
        # error column says what actually happened (first-pilot lesson).
        raise JobError(
            f'clip upload rejected ({err.code}) for {storage_path} '
            f'at {len(body) / 1e6:.0f}MB') from err
    return len(body)


# ── candidate writes (portrait writeRenderGuarded semantics) ───────────────

def fetch_candidates() -> list[dict]:
    out = _sb('GET',
              f'/rest/v1/playhub_goal_candidates'
              f'?match_recording_id=eq.{RECORDING_ID}'
              f'&select=id,anchor_s,status')
    return json.loads(out)


def update_candidate_guarded(cand_id: str, fields: dict) -> bool:
    """CAS refresh: wins only while the row is still draft/error (a review
    decision is permanent). Simple filters only — the top-level or= +
    return=representation PostgREST 400 does not apply here."""
    out = _sb('PATCH',
              f'/rest/v1/playhub_goal_candidates?id=eq.{cand_id}'
              f'&status=in.(draft,error)',
              json.dumps(fields).encode(),
              extra={'Prefer': 'return=representation'})
    return bool(json.loads(out))


def insert_candidate(fields: dict) -> bool:
    try:
        _sb('POST', '/rest/v1/playhub_goal_candidates',
            json.dumps(fields).encode(),
            extra={'Prefer': 'return=minimal'})
        return True
    except urllib.error.HTTPError as err:
        # PostgREST maps BOTH 23505 (unique — the intended backstop) and
        # 23503 (FK — recording deleted mid-run) to HTTP 409; only the
        # former is 'protected row wins' (senior review, ask #1).
        if err.code == 409:
            try:
                code = json.loads(err.read()).get('code')
            except Exception:  # noqa: BLE001
                code = None
            if code == '23505':
                print(f'insert conflict (protected row wins): '
                      f'{fields.get("anchor_s")}', flush=True)
                return False
        raise


def main():
    row = fetch_row()
    if row.get('spiideo_game_id') != GAME_ID:
        raise JobError('GAME_ID does not match the recording row')
    if row.get('tracklets_status') != 'ready':
        raise JobError('tracklets not ready — nothing to detect on')
    if not row.get('s3_key'):
        raise JobError('no produced video on this recording')
    claimed_tracklets_started_at = row.get('tracklets_started_at')

    threading.Thread(target=heartbeat_loop, args=(HEARTBEAT_STOP,),
                     daemon=True).start()
    os.makedirs(WORK, exist_ok=True)

    # ── calibration (REQUIRED) ──────────────────────────────────────────
    cal = fetch_calibration(row.get('spiideo_scene_id'))
    if cal is None:
        raise JobError('no usable calibration: missing, inactive, or '
                       'mesh-epoch mismatch')
    reason = calibration_unusable_reason(cal)
    if reason:
        raise JobError(f'no usable calibration: {reason}')
    L = float(cal['pitch_length_m'])
    W = float(cal['pitch_width_m'])

    # ── inputs ──────────────────────────────────────────────────────────
    artifact = fetch_tracklets()
    art_meta = artifact.get('meta') or {}
    models = {}
    for name, env in (('stoppage_clf_full.pkl', 'STOPPAGE_SHA256'),
                      ('kickoff_clf.pkl', 'KICKOFF_SHA256'),
                      ('period_gap_clf.pkl', 'PERIOD_GAP_SHA256'),
                      ('constants.json', 'CONSTANTS_SHA256')):
        pin = os.environ.get(env)
        if not pin:
            # FAIL CLOSED (security review 2026-07-22): the next step is an
            # unpickle in a task carrying the service-role key. A missing pin
            # (job-def edit, manual submit-job override) must settle the row
            # as error, never load unverified bytes.
            raise JobError(f'missing weights pin {env}')
        dest = os.path.join(WORK, name)
        download_s3(f'{WEIGHTS_S3_PREFIX}/{name}', dest, sha256=pin)
        models[name] = dest
    stoppage_art = joblib.load(models['stoppage_clf_full.pkl'])
    period_art = joblib.load(models['period_gap_clf.pkl'])
    ko_models = kickoff.load_models(models['kickoff_clf.pkl'])
    # Frozen-constant drift canary (senior review): the banked constants.json
    # records the freeze; a future "tune one constant" edit to chain.py must
    # fail loudly against the bank, not silently ship a different detector.
    banked = json.load(open(models['constants.json']))['chain']
    for key, val in (('TAU', chain_mod.TAU),
                     ('TAU_PEAK', chain_mod.TAU_PEAK),
                     ('SPLIT_LIVE_THR', chain_mod.SPLIT_LIVE_THR),
                     ('DCTX_FLOOR', chain_mod.DCTX_FLOOR),
                     ('MERGE_S', chain_mod.MERGE_S),
                     ('PERIOD_THR', chain_mod.PERIOD_THR),
                     ('GRID_STEP', chain_mod.GRID_STEP),
                     ('MIN_PLAYERS', chain_mod.MIN_PLAYERS)):
        if banked.get(key) != val:
            raise JobError(f'frozen-constant drift: {key} is {val}, '
                           f'bank says {banked.get(key)}')

    # ── projection + frozen chain ───────────────────────────────────────
    try:
        shim = projection.load_pitch_frames(
            artifact, cal['homography'], L, W)
        episodes, survivors, env0, env1 = chain_mod.run_chain(
            shim, stoppage_art, ko_models, period_art)
    except (projection.ProjectionError, chain_mod.ChainError) as err:
        raise JobError(str(err)) from err
    print(f'chain: {len(episodes)} episodes detected, '
          f'{len(survivors)} candidates after envelope+period filters '
          f'(envelope {env0:.0f}..{env1:.0f}s)', flush=True)

    # ── staleness gate BEFORE any publish work (senior review #1: the
    # jersey template's ordering — a run computed from a superseded artifact
    # must not bank clips a fresh run's resume guard would then adopt) ────
    art_digest = hashlib.sha256(json.dumps(
        art_meta, sort_keys=True).encode()).hexdigest()[:16]

    def assert_fresh():
        fresh = fetch_row()
        if (fresh.get('tracklets_status') != 'ready'
                or fresh.get('tracklets_started_at')
                != claimed_tracklets_started_at):
            raise JobError(
                'stale — tracklets re-ran while this job was running')

    assert_fresh()

    # ── clips (keyed by artifact digest + anchor: a retry resumes its own
    # work, but clips from a DIFFERENT artifact epoch can never be adopted) ─
    clip_paths: dict[float, str] = {}
    clip_spans: dict[float, float] = {}
    if survivors:
        url = presign_video(row['s3_key'])
        for e in survivors:
            # The plan is deterministic from (t0, t1) + frozen constants, so
            # a resume-adopted clip's span is recomputed exactly; extended
            # plans key differently (storage_suffix) so a legacy 300s-capped
            # clip can never be adopted as a 480s one.
            p = clip_plan.plan(e['t0'], e['t1'])
            storage_path = (f'{RECORDING_ID}/'
                            f'{art_digest[:8]}-{int(e["anchor"])}'
                            f'{clip_plan.storage_suffix(p)}.mp4')
            if clip_exists(storage_path):
                clip_paths[e['anchor']] = storage_path
                clip_spans[e['anchor']] = round(p.dur, 1)
                print(f'clip {storage_path} already banked — skipped',
                      flush=True)
                continue
            dest = os.path.join(WORK, f'{int(e["anchor"])}.mp4')
            cut_clip(url, p, dest)
            size = upload_clip(dest, storage_path)
            clip_paths[e['anchor']] = storage_path
            clip_spans[e['anchor']] = round(p.dur, 1)
            os.remove(dest)
            print(f'clip {storage_path} ({size / 1e6:.1f}MB, '
                  f'{p.dur:.0f}s @ {p.maxrate})', flush=True)

    # ── re-check + guarded writes (plan is pure + unit-tested) ──────────
    assert_fresh()
    now_iso = __import__('datetime').datetime.now(
        __import__('datetime').timezone.utc).isoformat()
    existing = fetch_candidates()
    refreshes, inserts, supersede_ids = reconcile.plan_writes(
        survivors, existing, RECONCILE_S)

    def fields_for(e: dict) -> dict:
        return dict(
            match_recording_id=RECORDING_ID,
            t0_s=round(e['t0'], 2), t1_s=round(e['t1'], 2),
            anchor_s=round(e['anchor'], 2),
            pko=round(e['pko'], 3), deadctx=round(e['ev'], 3),
            p_period=round(e.get('p_period', 0.0), 3),
            # Row carries the CAPPED hint list (anchor cycle + top-7 rest by
            # per-cycle P_ko, K=8: 99.9% goal-cycle retention on freeze and
            # zero stamped-goal losses on the labeled matches — see the
            # SUB_ANCHORS_ROW_CAP comment before changing); the full list
            # lives in provenance.
            sub_anchors_s=[round(s, 2) for s in chain_mod.cap_sub_anchors(
                e.get('sub_anchors') or [e['anchor']],
                e.get('sub_anchor_pko') or [e.get('pko', 0.0)])],
            clip_path=clip_paths.get(e['anchor']),
            # Clip-truncation badge substrate: the strip compares the
            # episode span against exactly where this clip ends (NULL rows
            # fall back to the legacy fixed 300s cap client-side).
            clip_span_s=clip_spans.get(e['anchor']),
            status='draft', error=None,
            detector_version=chain_mod.DETECTOR_VERSION,
            artifact_digest=art_digest,
            updated_at=now_iso,
        )

    n_upd = n_ins = n_kept = n_sup = 0
    for cand_id, e in refreshes:
        if update_candidate_guarded(cand_id, fields_for(e)):
            n_upd += 1
        else:
            n_kept += 1          # reviewed row — left untouched
    for e in inserts:
        if insert_candidate(fields_for(e)):
            n_ins += 1
    for cand_id in supersede_ids:
        if update_candidate_guarded(
                cand_id, dict(status='error',
                              error='superseded by re-detection',
                              updated_at=now_iso)):
            n_sup += 1
    print(f'candidates: {n_ins} inserted, {n_upd} refreshed, '
          f'{n_kept} reviewed-kept, {n_sup} superseded', flush=True)

    # ── provenance ──────────────────────────────────────────────────────
    s3.put_object(
        Bucket=BUCKET, Key=f'provenance/goal-detect/{GAME_ID}/goal-detect.json',
        Body=json.dumps({
            'gameId': GAME_ID, 'recordingId': RECORDING_ID,
            'detectorVersion': chain_mod.DETECTOR_VERSION,
            'artifactDigest': art_digest, 'artifactMeta': art_meta,
            'pitch': {'lengthM': L, 'widthM': W},
            'envelope': [env0, env1],
            'episodes': [
                {'t0': e['t0'], 't1': e['t1'], 'anchor': e['anchor'],
                 'subAnchors': e.get('sub_anchors') or [e['anchor']],
                 'subAnchorPko': [round(p, 3) for p in
                                  e.get('sub_anchor_pko') or []],
                 'pko': round(e['pko'], 3), 'ev': round(e['ev'], 3),
                 'pPeriod': round(e['p_period'], 3)
                 if 'p_period' in e else None,
                 'drop': e.get('drop')}
                for e in episodes],
            'writes': {'inserted': n_ins, 'refreshed': n_upd,
                       'reviewedKept': n_kept, 'superseded': n_sup},
        }, indent=1).encode(),
        ContentType='application/json')

    HEARTBEAT_STOP.set()
    set_status({'goal_detect_status': 'ready', 'goal_detect_error': None},
               retries=3)
    print(f'goal-detect ready: {len(survivors)} candidates', flush=True)


def _on_sigterm(signum, frame):  # noqa: ARG001
    HEARTBEAT_STOP.set()
    try:
        set_status({'goal_detect_status': 'error',
                    'goal_detect_error': 'terminated (Batch timeout/SIGTERM)'})
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
            set_status({'goal_detect_status': 'error',
                        'goal_detect_error': msg}, retries=3)
        except Exception as err2:  # noqa: BLE001
            print(f'could not write error status: {err2}', file=sys.stderr,
                  flush=True)
        sys.exit(1)

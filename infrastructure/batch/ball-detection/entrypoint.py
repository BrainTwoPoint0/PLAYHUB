"""
AWS Batch entrypoint for ball-detection PRECOMPUTE.

Primary mode (array job): each array task processes a contiguous shard of an S3
JSONL manifest, runs detect_ball() on each clip, and UPSERTs the result into the
Supabase `playhub_crop_detections` cache (keyed by veo_highlight_id) so the editor
loads it instantly. Idempotent: re-running a reclaimed spot shard re-upserts the
same rows (no duplicates, cheap resume).

Writes go through the Supabase REST API (PostgREST), NOT raw Postgres — hundreds of
concurrent shards must not each open a Postgres connection (pooler exhaustion).

Environment:
  Precompute (array) mode:
    MANIFEST_S3_URI            s3://bucket/manifests/run.jsonl  (one {id,url} per line)
    SHARD_SIZE                 clips per array task (default 20)
    AWS_BATCH_JOB_ARRAY_INDEX  set by Batch (0..arraySize-1)
    SUPABASE_URL               https://<ref>.supabase.co
    SUPABASE_SERVICE_ROLE_KEY  service-role key (injected from Secrets Manager)
    OUTPUT_FPS                 detection sample rate (default 25 — accuracy)
    RESULTS_S3_PREFIX          optional: also back up raw JSON to s3://bucket/<prefix>/<id>.json
    S3_BUCKET                  bucket for the manifest + optional backup
  Single-clip fallback (smoke test): INPUT_URL + HIGHLIGHT_ID.
"""

import json
import os
import sys
import urllib.request
import urllib.parse

import boto3


def _require_cuda():
    """Fail loud if the GPU/driver isn't visible — otherwise YOLO silently runs on
    CPU (10-50x slower) and blows the job timeout across the whole corpus."""
    try:
        import torch

        if not torch.cuda.is_available():
            print("FATAL: CUDA not available — GPU AMI/driver misconfigured.", file=sys.stderr)
            sys.exit(1)
        print(f"CUDA OK: {torch.cuda.get_device_name(0)}", file=sys.stderr)
    except ImportError:
        print("FATAL: torch not importable — image build is broken.", file=sys.stderr)
        sys.exit(1)


def _upsert_detection(supabase_url, key, highlight_id, detection, inference_ms, app_version):
    """Idempotent upsert into playhub_crop_detections via PostgREST."""
    endpoint = f"{supabase_url.rstrip('/')}/rest/v1/playhub_crop_detections"
    body = json.dumps(
        {
            "veo_highlight_id": highlight_id,
            "detection": detection,
            "modal_inference_ms": inference_ms,
            "modal_app_version": app_version,
        }
    ).encode("utf-8")
    req = urllib.request.Request(endpoint, data=body, method="POST")
    req.add_header("apikey", key)
    req.add_header("Authorization", f"Bearer {key}")
    req.add_header("Content-Type", "application/json")
    # merge-duplicates = upsert on the veo_highlight_id PK; minimal = no row echoed back.
    req.add_header("Prefer", "resolution=merge-duplicates,return=minimal")
    with urllib.request.urlopen(req, timeout=30) as resp:
        if resp.status not in (200, 201, 204):
            raise RuntimeError(f"upsert {highlight_id} -> HTTP {resp.status}")


def _read_manifest_shard(s3, bucket, key, shard_index, shard_size):
    """Download the (small) JSONL manifest and return this task's slice."""
    obj = s3.get_object(Bucket=bucket, Key=key)
    lines = obj["Body"].read().decode("utf-8").splitlines()
    rows = [json.loads(l) for l in lines if l.strip()]
    start = shard_index * shard_size
    return rows[start : start + shard_size]


def _detect_one(url, output_fps):
    sys.path.insert(0, "/app")
    from detect_ball import detect_ball
    import time as _t

    input_path = "/tmp/input.mp4"
    urllib.request.urlretrieve(url, input_path)
    size_mb = os.path.getsize(input_path) / (1024 * 1024)
    t0 = _t.monotonic()
    result = detect_ball(input_path, output_fps=output_fps)
    inference_ms = int((_t.monotonic() - t0) * 1000)
    os.unlink(input_path)
    return result, inference_ms, size_mb


def main():
    _require_cuda()

    manifest_uri = os.environ.get("MANIFEST_S3_URI")
    output_fps = float(os.environ.get("OUTPUT_FPS", "25"))
    supabase_url = os.environ.get("SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    app_version = os.environ.get("APP_VERSION", "aws-batch-precompute")
    s3 = boto3.client("s3")

    if not supabase_url or not supabase_key:
        print("ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required", file=sys.stderr)
        sys.exit(1)

    # ── Single-clip fallback (smoke test) ──
    if not manifest_uri:
        url = os.environ.get("INPUT_URL")
        hid = os.environ.get("HIGHLIGHT_ID")
        if not url or not hid:
            print("ERROR: MANIFEST_S3_URI, or INPUT_URL+HIGHLIGHT_ID, required", file=sys.stderr)
            sys.exit(1)
        result, ms, mb = _detect_one(url, output_fps)
        _upsert_detection(supabase_url, supabase_key, hid, result, ms, app_version)
        print(f"Done {hid}: {len(result.get('positions', []))} pos, {mb:.1f}MB, {ms}ms", file=sys.stderr)
        return

    # ── Array-shard precompute mode ──
    parsed = urllib.parse.urlparse(manifest_uri)
    m_bucket, m_key = parsed.netloc, parsed.path.lstrip("/")
    shard_index = int(os.environ.get("AWS_BATCH_JOB_ARRAY_INDEX", "0"))
    shard_size = int(os.environ.get("SHARD_SIZE", "20"))
    results_prefix = os.environ.get("RESULTS_S3_PREFIX")
    backup_bucket = os.environ.get("S3_BUCKET", m_bucket)

    shard = _read_manifest_shard(s3, m_bucket, m_key, shard_index, shard_size)
    print(f"Shard {shard_index}: {len(shard)} clips (size={shard_size})", file=sys.stderr)

    ok, failed = 0, 0
    for i, row in enumerate(shard):
        hid, url = row["veo_highlight_id"], row["url"]
        try:
            result, ms, mb = _detect_one(url, output_fps)
            _upsert_detection(supabase_url, supabase_key, hid, result, ms, app_version)
            if results_prefix:  # optional raw-JSON backup so a silent write-fail is recoverable
                s3.put_object(
                    Bucket=backup_bucket,
                    Key=f"{results_prefix.strip('/')}/{hid}.json",
                    Body=json.dumps(result),
                    ContentType="application/json",
                )
            ok += 1
            print(f"  [{i+1}/{len(shard)}] {hid}: {len(result.get('positions', []))} pos, {mb:.1f}MB, {ms}ms", file=sys.stderr)
        except Exception as exc:  # noqa: BLE001 — one bad clip must not fail the shard
            failed += 1
            print(f"  [{i+1}/{len(shard)}] {hid}: FAILED — {str(exc)[:200]}", file=sys.stderr)

    print(f"Shard {shard_index} done: {ok} ok, {failed} failed", file=sys.stderr)
    # Fail the task only if EVERY clip failed (systemic issue worth a retry).
    if shard and failed == len(shard):
        sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"FATAL: {e}", file=sys.stderr)
        sys.exit(1)

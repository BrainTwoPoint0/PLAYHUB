#!/usr/bin/env python3
"""
Build the precompute work-list: every GOAL highlight that has a video URL and is
not yet in the playhub_crop_detections cache → a JSONL manifest → upload to S3.

The manifest freezes the work set at submit time (deterministic, reproducible) so
the Batch array job shards it without racing, and re-runs against the same file
are safe (the entrypoint upserts idempotently).

Usage:
  DATABASE_URL=postgres://...  \
  python3 build_manifest.py --out s3://playhub-recordings-eu-west-2/manifests/goals-2026-06-29.jsonl
  # then `wc -l` the printed local copy to get arraySize math (ceil(N / SHARD_SIZE)).

Needs: psycopg2-binary, boto3.  DATABASE_URL = the Supabase Postgres connection
string (Settings → Database → Connection string, session pooler is fine for a
one-off read).
"""
import argparse
import json
import os
import sys
import urllib.parse

import boto3
import psycopg2

# Goal highlights with a video URL that aren't cached yet. Mirrors the validated
# query; tag slug 'goal' (NOT 'shot-on-goal', which is a different ~27k-row type).
QUERY = """
SELECT h->>'id' AS veo_highlight_id,
       h->'videos'->0->>'url' AS url
FROM playhub_veo_match_content_cache c,
     jsonb_array_elements(c.highlights) h
WHERE jsonb_typeof(c.highlights) = 'array'
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(h->'tags') t WHERE t->>'slug' = 'goal')
  AND COALESCE(h->'videos'->0->>'url', '') <> ''
  AND NOT EXISTS (
    SELECT 1 FROM playhub_crop_detections d WHERE d.veo_highlight_id = h->>'id'
  );
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="s3://bucket/key.jsonl destination")
    ap.add_argument("--shard-size", type=int, default=20, help="for the arraySize hint")
    args = ap.parse_args()

    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("ERROR: set DATABASE_URL (Supabase Postgres connection string)", file=sys.stderr)
        sys.exit(1)

    conn = psycopg2.connect(db_url)
    with conn.cursor() as cur:
        cur.execute(QUERY)
        rows = cur.fetchall()
    conn.close()

    seen = set()
    lines = []
    for hid, url in rows:
        if not hid or hid in seen:
            continue
        seen.add(hid)
        lines.append(json.dumps({"veo_highlight_id": hid, "url": url}))

    n = len(lines)
    local = "/tmp/manifest.jsonl"
    with open(local, "w") as f:
        f.write("\n".join(lines) + "\n")

    parsed = urllib.parse.urlparse(args.out)
    boto3.client("s3").upload_file(local, parsed.netloc, parsed.path.lstrip("/"))

    array_size = (n + args.shard_size - 1) // args.shard_size
    print(f"Wrote {n} goal clips → {args.out}  (local: {local})")
    print(f"arraySize = ceil({n} / {args.shard_size}) = {array_size}")
    print(f"Submit with: --array-properties size={array_size} "
          f"--container-overrides 'environment=[{{name=MANIFEST_S3_URI,value={args.out}}},"
          f"{{name=SHARD_SIZE,value={args.shard_size}}}]'")


if __name__ == "__main__":
    main()

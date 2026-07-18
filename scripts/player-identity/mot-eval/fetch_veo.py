"""Veo corpus inventory + tracking.json fetch/cache for the MOT eval harness.

Prefix-driven S3 listing (the playhub_veo_captures table provably
under-reports what is in S3 — backfill_tracking_schema.mjs lesson).
Only tracking.json (+ alignment.veo) is fetched — a few MB per match, no
video. The panorama Glacier clock is irrelevant to this harness.

Usage:
    python3 fetch_veo.py inventory          # list slugs + declared dims
    python3 fetch_veo.py fetch <slug> ...   # cache tracking.json locally
"""
from __future__ import annotations

import json
import os
import sys

import boto3
from botocore.config import Config

BUCKET = 'playhub-recordings-eu-west-2'
PREFIX = 'veo-panoramas/'
CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cache')

# region + s3v4 explicitly: region-less local boto3 presigns SigV2 on the
# global endpoint and eu-west-2 rejects it (2026-07-17 lesson).
_s3 = boto3.client('s3', region_name='eu-west-2',
                   config=Config(signature_version='s3v4'))


def list_slugs() -> list:
    slugs = []
    paginator = _s3.get_paginator('list_objects_v2')
    for page in paginator.paginate(Bucket=BUCKET, Prefix=PREFIX,
                                   Delimiter='/'):
        for cp in page.get('CommonPrefixes', []):
            slugs.append(cp['Prefix'][len(PREFIX):].rstrip('/'))
    return sorted(slugs)


def read_schema(slug: str) -> dict | None:
    """The schema block of a banked tracking.json, WITHOUT downloading the
    whole file: range-read the head (schema is written first in the JSON)."""
    key = f'{PREFIX}{slug}/tracking.json'
    try:
        head = _s3.get_object(Bucket=BUCKET, Key=key,
                              Range='bytes=0-16383')['Body'].read()
    except _s3.exceptions.NoSuchKey:
        return None
    except Exception as err:  # noqa: BLE001
        print(f'  {slug}: read failed ({type(err).__name__})', file=sys.stderr)
        return None
    # the head is truncated JSON — extract the "schema" object bracket-wise
    text = head.decode('utf-8', errors='replace')
    i = text.find('"schema"')
    if i < 0:
        return None
    j = text.find('{', i)
    depth, k = 0, j
    for k in range(j, len(text)):
        if text[k] == '{':
            depth += 1
        elif text[k] == '}':
            depth -= 1
            if depth == 0:
                break
    else:
        return None
    try:
        return json.loads(text[j:k + 1])
    except json.JSONDecodeError:
        return None


def inventory() -> list:
    """[(slug, length_m, width_m, scale_known)] for every banked capture,
    printed with adult (declared length >= 90) candidates flagged."""
    rows = []
    slugs = list_slugs()
    print(f'{len(slugs)} banked capture prefixes')
    for slug in slugs:
        sch = read_schema(slug)
        if sch is None:
            rows.append((slug, None, None, False))
            continue
        pitch = sch.get('pitch') or {}
        rows.append((slug, pitch.get('lengthM'), pitch.get('widthM'),
                     bool(sch.get('scaleKnown'))))
    adults = [r for r in rows if r[1] is not None and r[1] >= 90 and r[3]]
    for slug, length, width, known in rows:
        tag = ' ADULT' if (slug, length, width, known) in adults else ''
        print(f'  {slug:>60} {length}x{width} scaleKnown={known}{tag}')
    print(f'\n{len(adults)} adult (length >= 90m, scaleKnown) candidates:')
    for slug, length, width, _ in adults:
        print(f'  {slug} ({length}x{width})')
    return rows


def fetch(slug: str) -> str:
    os.makedirs(CACHE, exist_ok=True)
    dest = os.path.join(CACHE, f'{slug}.tracking.json')
    if not os.path.exists(dest):
        _s3.download_file(BUCKET, f'{PREFIX}{slug}/tracking.json', dest)
        print(f'fetched {slug} -> {dest} '
              f'({os.path.getsize(dest) / 1e6:.1f} MB)')
    return dest


if __name__ == '__main__':
    if len(sys.argv) >= 2 and sys.argv[1] == 'inventory':
        inventory()
    elif len(sys.argv) >= 3 and sys.argv[1] == 'fetch':
        for s in sys.argv[2:]:
            fetch(s)
    else:
        print(__doc__)

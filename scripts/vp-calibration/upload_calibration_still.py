#!/usr/bin/env python3
"""One-shot calibration-still upload — pilot backstop for the batch emission.

Produces the median still the pitch-calibration marking UI renders on, for
recordings processed BEFORE the player-tracklets job learned to emit stills.
Fetches the recording row, presigns its banked raw panorama, runs
median_frame.py on it, and uploads the JPEG to the key shape the
pitch-calibration API enforces: calibration-stills/{scene_id}/{recording_id}.jpg

Env: RECORDING_ID (playhub_match_recordings.id)
     SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
     AWS creds via AWS_PROFILE=playhub (or explicit env)
     N (optional, frames for the median, default 15)

Usage:
  set -a; source ../../.env; set +a
  AWS_PROFILE=playhub RECORDING_ID=<uuid> python3 upload_calibration_still.py
"""
import json
import os
import subprocess
import sys
import tempfile
import urllib.request

import boto3
from botocore.config import Config

RECORDING_ID = os.environ['RECORDING_ID']
SUPABASE_URL = os.environ['SUPABASE_URL'].rstrip('/')
SERVICE_KEY = os.environ['SUPABASE_SERVICE_ROLE_KEY']
N = os.environ.get('N', '15')
AWS_REGION = os.environ.get('PLAYHUB_AWS_REGION', 'eu-west-2')


def fetch_row(recording_id: str) -> dict:
    url = (f'{SUPABASE_URL}/rest/v1/playhub_match_recordings'
           f'?id=eq.{recording_id}'
           f'&select=id,spiideo_scene_id,panorama_s3_key,s3_bucket')
    req = urllib.request.Request(url, headers={
        'apikey': SERVICE_KEY,
        'Authorization': f'Bearer {SERVICE_KEY}',
    })
    with urllib.request.urlopen(req) as res:
        rows = json.loads(res.read())
    if not rows:
        sys.exit(f'no recording row for {recording_id}')
    return rows[0]


row = fetch_row(RECORDING_ID)
scene_id = row.get('spiideo_scene_id')
pano_key = row.get('panorama_s3_key')
if not scene_id:
    sys.exit('recording has no spiideo_scene_id — cannot key the still')
if not pano_key:
    sys.exit('recording has no panorama_s3_key — raw panorama not banked')

# Local presigns default to SigV2 on the global endpoint and 400 in-region —
# force region + s3v4 (see memory: spiideo-tracklet gotchas).
bucket = os.environ.get('S3_RECORDINGS_BUCKET', 'playhub-recordings-eu-west-2')
s3 = boto3.client('s3', region_name=AWS_REGION,
                  config=Config(signature_version='s3v4'))
src = s3.generate_presigned_url(
    'get_object', Params={'Bucket': bucket, 'Key': pano_key}, ExpiresIn=3600)

out = os.path.join(tempfile.mkdtemp(prefix='calib-still-'), 'still.jpg')
env = dict(os.environ, SRC=src, OUT=out, N=N)
subprocess.run(
    [sys.executable, os.path.join(os.path.dirname(__file__), 'median_frame.py')],
    env=env, check=True)

key = f'calibration-stills/{scene_id}/{RECORDING_ID}.jpg'
with open(out, 'rb') as f:
    s3.put_object(Bucket=bucket, Key=key, Body=f, ContentType='image/jpeg')
print(f'uploaded s3://{bucket}/{key} ({os.path.getsize(out)} bytes)')

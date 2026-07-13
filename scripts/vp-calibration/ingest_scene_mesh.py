#!/usr/bin/env python3
"""A3 — publish a scene's de-warp mesh so the watch page can offer "Explore the
pitch" for that game. Takes a locally-generated mesh dir (scene.json + vertices.bin
+ indices.bin, from calibrate.py → generate_mesh.py) and uploads it to the PUBLIC,
CDN-cacheable Supabase Storage bucket `panorama-meshes/{gameId}/`, which
`src/lib/panorama/mesh.ts::meshBaseUrl(gameId)` serves.

Keyed by the recording's spiideo_game_id (matches meshBaseUrl). The mesh is pure
lens geometry + camera pose — NO imagery/PII — hence public. This script REFUSES to
upload a scene.json that smuggles any URL/token/bucket/credential (the security
pre-ship invariant), so a future mesh revision can't leak the private video path.

Usage:  GAME_ID=<spiideo_game_id> MESH_DIR=PLAYHUB/public/vp-mesh-kuwait \
        SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
        python3 ingest_scene_mesh.py
"""
import os, sys, json, urllib.request, urllib.error

GAME_ID = os.environ.get('GAME_ID')
MESH_DIR = os.environ.get('MESH_DIR')
SUPABASE_URL = (os.environ.get('SUPABASE_URL') or os.environ.get('NEXT_PUBLIC_SUPABASE_URL') or '').rstrip('/')
SERVICE_KEY = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
BUCKET = os.environ.get('PANORAMA_MESH_BUCKET', 'panorama-meshes')
FILES = [('scene.json', 'application/json'),
         ('vertices.bin', 'application/octet-stream'),
         ('indices.bin', 'application/octet-stream'),
         ('tuning.json', 'application/json')]  # tuning.json optional

if not (GAME_ID and MESH_DIR and SUPABASE_URL and SERVICE_KEY):
    sys.exit('need GAME_ID, MESH_DIR, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY')

# Geometry-only guard: the public mesh must never carry imagery or a private-video
# URL/credential. scene.json is human-readable — reject anything suspicious.
scene_path = os.path.join(MESH_DIR, 'scene.json')
if not os.path.exists(scene_path):
    sys.exit(f'no scene.json in {MESH_DIR}')
blob = open(scene_path, 'r', encoding='utf-8', errors='replace').read().lower()
BANNED = ['http://', 'https://', 's3://', 'token', 'bearer', 'authorization', 'secret', 'password', 'bucket']
hit = [w for w in BANNED if w in blob]
if hit:
    sys.exit(f'REFUSING upload — scene.json contains banned tokens {hit} (must be geometry-only)')
try:
    json.loads(blob)  # must be valid JSON geometry
except Exception as e:
    sys.exit(f'scene.json is not valid JSON: {e}')


def req(method, path, data=None, ctype=None, ok=(200, 201)):
    url = f'{SUPABASE_URL}/storage/v1{path}'
    headers = {'Authorization': f'Bearer {SERVICE_KEY}'}
    if ctype:
        headers['Content-Type'] = ctype
    r = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(r) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


# Ensure the bucket exists + is public (idempotent — 409 if it already exists).
st, body = req('POST', '/bucket', json.dumps({'id': BUCKET, 'name': BUCKET, 'public': True}).encode(),
               'application/json', ok=(200, 201, 409))
if st not in (200, 201, 409):
    print(f'warning: bucket ensure returned {st}: {body[:200]}')

uploaded = 0
for name, ctype in FILES:
    p = os.path.join(MESH_DIR, name)
    if not os.path.exists(p):
        if name == 'tuning.json':
            continue  # optional
        sys.exit(f'missing required mesh file {name}')
    with open(p, 'rb') as f:
        payload = f.read()
    # x-upsert overwrites an existing object (re-ingest after recalibration).
    url = f'{SUPABASE_URL}/storage/v1/object/{BUCKET}/{GAME_ID}/{name}'
    r = urllib.request.Request(url, data=payload, method='POST',
                              headers={'Authorization': f'Bearer {SERVICE_KEY}',
                                       'Content-Type': ctype, 'x-upsert': 'true'})
    try:
        with urllib.request.urlopen(r) as resp:
            print(f'  uploaded {name} ({len(payload)} bytes) → {resp.status}')
            uploaded += 1
    except urllib.error.HTTPError as e:
        sys.exit(f'upload {name} failed: HTTP {e.code} {e.read()[:200]}')

base = f'{SUPABASE_URL}/storage/v1/object/public/{BUCKET}/{GAME_ID}'
print(f'\npublished {uploaded} mesh files for game {GAME_ID}')
print(f'meshBaseUrl → {base}')
print(f'verify: curl -sI {base}/scene.json  (expect 200)')

# Register this game as the canonical mesh for its scene, so new captures on the
# same camera auto-copy it (vp-materialize Batch job) and a backfill can fan it
# out to sibling recordings (fanout_scene_mesh.mjs). SCENE_ID is required for
# the registry — pass the recording's spiideo scene id.
SCENE_ID = os.environ.get('SCENE_ID')
if SCENE_ID:
    # Guard: a wrong SCENE_ID/GAME_ID pairing would fan THIS mesh to every
    # recording on that scene, corrupting de-warp camera-wide. Cross-check the
    # game's cached scene (written by the Batch job at capture) before trusting it.
    chk = urllib.request.Request(
        f'{SUPABASE_URL}/rest/v1/playhub_match_recordings?spiideo_game_id=eq.{GAME_ID}&select=spiideo_scene_id',
        headers={'apikey': SERVICE_KEY, 'Authorization': f'Bearer {SERVICE_KEY}'})
    try:
        rows = json.loads(urllib.request.urlopen(chk).read() or b'[]')
    except Exception as e:
        rows = []
        print(f'warning: could not verify game→scene ({e}); proceeding on caller trust')
    cached = next((r.get('spiideo_scene_id') for r in rows if r.get('spiideo_scene_id')), None)
    if cached and cached != SCENE_ID:
        sys.exit(f'REFUSING registry upsert — game {GAME_ID} is cached on scene {cached}, '
                 f'not SCENE_ID={SCENE_ID}. Fix the pairing (a wrong one corrupts the whole camera).')
    if not cached:
        print(f'note: game {GAME_ID} has no cached scene to cross-check against SCENE_ID={SCENE_ID} '
              f'(brand-new capture?) — proceeding on caller trust')
    reg_url = f'{SUPABASE_URL}/rest/v1/playhub_panorama_scene_meshes?on_conflict=scene_id'
    payload = json.dumps([{'scene_id': SCENE_ID, 'source_game_id': GAME_ID}]).encode()
    r = urllib.request.Request(
        reg_url, data=payload, method='POST',
        headers={'apikey': SERVICE_KEY, 'Authorization': f'Bearer {SERVICE_KEY}',
                 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal'})
    try:
        with urllib.request.urlopen(r) as resp:
            print(f'registered scene {SCENE_ID} → game {GAME_ID} ({resp.status})')
            print(f'fan out to siblings: node veo-automations/fanout_scene_mesh.mjs --scene {SCENE_ID}')
    except urllib.error.HTTPError as e:
        print(f'warning: scene registry upsert failed HTTP {e.code}: {e.read()[:200]}')
else:
    print('note: SCENE_ID not set — registry NOT updated (new captures on this '
          'camera will not auto-inherit the mesh). Re-run with SCENE_ID=<sceneId>.')

"""Prod mesh swap executor (per venue): backup -> upload canonical -> fanout
to game folders -> delete stale aim/tracklets artifacts. scene.json is
uploaded LAST everywhere (vp-materialize's presence gate keys off it).

  python3 swap_meshes.py <mesh_dir> <canonical_game_id> <game_id,game_id,...> <backup_dir> [--execute]

Without --execute: dry run (lists actions + verifies inputs + downloads backups).
"""
import json
import os
import sys
import urllib.request

import numpy as np

MESH_FILES_ORDER = ['vertices.bin', 'indices.bin', 'tuning.json', 'scene.json']
ARTIFACTS = ['aim-track.json', 'tracklets.json']


def env_keys():
    url = key = None
    for f in ['/Users/karimfawaz/Dev Projects/PLAYBACK Workspace/PLAYHUB/.env',
              '/Users/karimfawaz/Dev Projects/PLAYBACK Workspace/PLAYHUB/.env.local']:
        if not os.path.exists(f):
            continue
        for line in open(f):
            if line.startswith('NEXT_PUBLIC_SUPABASE_URL=') and not url:
                url = line.split('=', 1)[1].strip().strip('"')
            if line.startswith('SUPABASE_SERVICE_ROLE_KEY=') and not key:
                key = line.split('=', 1)[1].strip().strip('"')
    assert url and key, 'missing supabase env'
    return url.rstrip('/'), key


URL, KEY = env_keys()


def req(method, path, data=None, headers=None, ok=(200, 201)):
    h = {'authorization': f'Bearer {KEY}', 'apikey': KEY}
    h.update(headers or {})
    r = urllib.request.Request(f'{URL}{path}', data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(r) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def head_public(key):
    try:
        with urllib.request.urlopen(urllib.request.Request(
                f'{URL}/storage/v1/object/public/panorama-meshes/{key}',
                method='HEAD')) as r:
            return r.status == 200
    except Exception:
        return False


def download(key, dest):
    with urllib.request.urlopen(
            f'{URL}/storage/v1/object/public/panorama-meshes/{key}') as r:
        data = r.read()
    open(dest, 'wb').write(data)
    return len(data)


def upload(key, path):
    data = open(path, 'rb').read()
    ct = 'application/json' if key.endswith('.json') else 'application/octet-stream'
    st, body = req('POST', f'/storage/v1/object/panorama-meshes/{key}', data,
                   {'content-type': ct, 'x-upsert': 'true'})
    if st not in (200, 201):
        raise RuntimeError(f'upload {key}: HTTP {st} {body[:200]}')
    return len(data)


def delete(key):
    st, body = req('DELETE', f'/storage/v1/object/panorama-meshes/{key}')
    return st


def main():
    mesh_dir, canonical, games_csv, backup_dir = sys.argv[1:5]
    execute = '--execute' in sys.argv
    games = [g.strip() for g in games_csv.split(',') if g.strip()]
    assert canonical in games, 'canonical must be in the games list'
    for f in ('scene.json', 'vertices.bin', 'indices.bin'):
        assert os.path.exists(os.path.join(mesh_dir, f)), f'missing {f}'
    os.makedirs(backup_dir, exist_ok=True)

    # 1. backup canonical (+ note which optional files exist)
    print(f'== backup canonical {canonical} -> {backup_dir}')
    have = {}
    for f in MESH_FILES_ORDER + ARTIFACTS:
        k = f'{canonical}/{f}'
        if head_public(k):
            n = download(k, os.path.join(backup_dir, f))
            have[f] = n
            print(f'  saved {f} ({n} B)')
    assert 'scene.json' in have, 'canonical has no scene.json?!'

    # 2. sanity: sample game folder should MATCH canonical today (copies)
    sample = next(g for g in games if g != canonical)
    s_local = os.path.join(backup_dir, 'sample-scene.json')
    if head_public(f'{sample}/scene.json'):
        download(f'{sample}/scene.json', s_local)
        same = open(s_local, 'rb').read() == open(
            os.path.join(backup_dir, 'scene.json'), 'rb').read()
        print(f'  sample game {sample[:8]} scene.json identical to canonical: {same}')

    if not execute:
        print('DRY RUN — no writes. Games:', len(games))
        return

    # 3. upload new mesh to every folder, canonical LAST; scene.json last per folder
    for g in games[::-1] if canonical == games[-1] else \
            [g for g in games if g != canonical] + [canonical]:
        for f in MESH_FILES_ORDER:
            p = os.path.join(mesh_dir, f)
            if not os.path.exists(p):
                # new mesh has no tuning.json: DELETE any stale one (it tunes
                # the OLD mesh)
                if f == 'tuning.json' and head_public(f'{g}/{f}'):
                    st = delete(f'{g}/{f}')
                    print(f'  {g[:8]}/tuning.json deleted (stale, HTTP {st})')
                continue
            n = upload(f'{g}/{f}', p)
            print(f'  {g[:8]}/{f} uploaded ({n} B)')

    # 4. delete stale artifacts (sweeps rebuild them against the new mesh)
    for g in games:
        for a in ARTIFACTS:
            if head_public(f'{g}/{a}'):
                st = delete(f'{g}/{a}')
                print(f'  {g[:8]}/{a} deleted (HTTP {st})')

    # 5. verify: public scene.json content == local new mesh
    import hashlib
    want = hashlib.sha256(open(os.path.join(mesh_dir, 'scene.json'), 'rb').read()).hexdigest()
    for g in games:
        tmp = os.path.join(backup_dir, 'verify-scene.json')
        download(f'{g}/scene.json', tmp)
        got = hashlib.sha256(open(tmp, 'rb').read()).hexdigest()
        assert got == want, f'{g}: scene.json mismatch after upload!'
    print(f'VERIFIED: {len(games)} game folders serve the new mesh (sha {want[:12]})')


if __name__ == '__main__':
    main()

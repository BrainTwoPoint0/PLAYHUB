"""Mesh UV <-> world-ray geometry, duplicated verbatim from
../aim-track/aim_convert.py (load_mesh_rays/_pan_tilt/MOUNT_S). The build
context of each Batch image is its own directory, so the module is copied
rather than imported across jobs — keep the two in sync if the mesh format
ever changes.
"""

from __future__ import annotations

import json

import numpy as np

# Sensor-mount tilt, verbatim from VirtualPanoramaPlayer.tsx MOUNT_S.
MOUNT_S = np.array([[0.0, -0.218849, 0.975731],
                    [-1.000013, 0.0, 0.0],
                    [0.0, -0.975762, -0.218884]], np.float64)


def load_mesh_rays(mesh_dir: str):
    """UVs + world rays for triangle-referenced vertices across all projections.

    Vertex layout [f0, f1, u, v, alpha]; world = transpose(R·MOUNT_S)·(f0,f1,1).
    Spiideo-sourced meshes can have n_indices % 3 != 0 — iterate triples
    tolerantly, exactly like the player and mesh_dewarp.load_mesh do. Culled
    vertices remain in vertices.bin with garbage values; only triangle-
    referenced vertices are usable (the 2026-07-12 invariant).
    """
    sc = json.load(open(f'{mesh_dir}/scene.json'))
    V = np.frombuffer(open(f'{mesh_dir}/vertices.bin', 'rb').read(),
                      np.float32).reshape(-1, 5)
    I = np.frombuffer(open(f'{mesh_dir}/indices.bin', 'rb').read(), np.uint32)
    uvs, rays = [], []
    voff = ioff = 0
    for p in sc['projections']:
        nv, ni = p['n_vertices'], p['n_indices']
        vv = V[voff:voff + nv]
        R = np.array(p['camera']['rotation'], np.float64).reshape(3, 3)
        tw = (R @ MOUNT_S).T
        img = np.column_stack([vv[:, 0], vv[:, 1], np.ones(nv)])
        world = (tw @ img.T).T
        tris = I[ioff:ioff + ni].astype(np.int64) - voff
        t3 = tris[:len(tris) - len(tris) % 3].reshape(-1, 3)
        t3 = t3[np.all((t3 >= 0) & (t3 < nv), axis=1)]
        referenced = np.unique(t3)
        uvs.append(vv[referenced, 2:4].astype(np.float64))
        rays.append(world[referenced])
        voff += nv
        ioff += ni
    uv = np.concatenate(uvs)
    ray = np.concatenate(rays)
    ray /= np.linalg.norm(ray, axis=1, keepdims=True)
    return uv, ray


def pan_tilt_deg(ray: np.ndarray):
    """ray (N,3) world -> (pan_deg, tilt_deg) in the dewarp convention.

    z(pan,tilt) = (−sin pan·cos tilt, −sin tilt, cos pan·cos tilt) inverted:
    pan = atan2(−x, z) (valid across ±180°), tilt = −asin(y).
    """
    x, y, z = ray[:, 0], ray[:, 1], ray[:, 2]
    pan = np.degrees(np.arctan2(-x, z))
    tilt = np.degrees(-np.arcsin(np.clip(y, -1.0, 1.0)))
    return pan, tilt


def rayn_pan_tilt_deg(rn: np.ndarray):
    """Ray-plane points (N,2), rn = (x/z, y/z) -> (pan_deg, tilt_deg).

    Closed form from scripts/follow-re/viewport_follow2.py::ray_to_pantilt:
    pan = atan2(−rn_x, 1), tilt = −asin(rn_y / |(rn_x, rn_y, 1)|).
    """
    x, y = rn[:, 0], rn[:, 1]
    n = np.sqrt(x * x + y * y + 1.0)
    pan = np.degrees(np.arctan2(-x, 1.0))
    tilt = np.degrees(-np.arcsin(np.clip(y / n, -1.0, 1.0)))
    return pan, tilt

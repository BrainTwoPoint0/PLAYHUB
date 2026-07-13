"""Convert registered pano coords into the player's {t, pan, tilt, fov} track.

Venue-independent, GL-free: instead of per-venue fisheye fit constants, the
scene's own mesh (panorama-meshes/{gameId}/) provides the UV<->world-ray map —
triangle-REFERENCED vertices only (culled vertices remain in vertices.bin with
garbage values; consuming them is the known 2026-07-12 invariant). A KDTree
over referenced UVs answers "which world ray does this pano point image?", and
the closed form from scripts/follow-re/viewport_follow2.py::ray_to_pantilt
turns rays into the dewarp's pan/tilt convention. Horizontal fov = the angle
between the view's left/right edge rays (reg's footw at the centre row).

MOUNT_S is the global sensor-mount matrix, verbatim from
VirtualPanoramaPlayer.tsx — the SAME constant the player composes with each
projection's rotation, so world rays here match the player's exactly.

Output series are savgol-smoothed (edge-safe mode='nearest', the §0d lesson:
'same'-mode convolution biases the first frames into a jerky start).
"""

from __future__ import annotations

import json

import numpy as np
from scipy.signal import savgol_filter
from scipy.spatial import cKDTree

# Sensor-mount tilt, verbatim from VirtualPanoramaPlayer.tsx MOUNT_S.
MOUNT_S = np.array([[0.0, -0.218849, 0.975731],
                    [-1.000013, 0.0, 0.0],
                    [0.0, -0.975762, -0.218884]], np.float64)


def load_mesh_rays(mesh_dir: str):
    """UVs + world rays for triangle-referenced vertices across all projections.

    Vertex layout [f0, f1, u, v, alpha]; world = transpose(R·MOUNT_S)·(f0,f1,1).
    Spiideo-sourced meshes can have n_indices % 3 != 0 — iterate triples
    tolerantly, exactly like the player and mesh_dewarp.load_mesh do.
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


def _rays_for_uv(tree: cKDTree, rays: np.ndarray, pts: np.ndarray) -> np.ndarray:
    _, idx = tree.query(pts)
    return rays[idx]


def _pan_tilt(ray: np.ndarray):
    """ray (N,3) world -> (pan_deg, tilt_deg) in the dewarp convention.

    z(pan,tilt) = (−sin pan·cos tilt, −sin tilt, cos pan·cos tilt) inverted:
    pan = atan2(−x, z) (valid across ±180°, so wide aims past ±90° — meshes
    span ±135° — resolve correctly), tilt = −asin(y).
    """
    x, y, z = ray[:, 0], ray[:, 1], ray[:, 2]
    pan = np.degrees(np.arctan2(-x, z))
    tilt = np.degrees(-np.arcsin(np.clip(y, -1.0, 1.0)))
    return pan, tilt


def _interp_nan(t: np.ndarray, v: np.ndarray) -> np.ndarray:
    ok = ~np.isnan(v)
    if ok.sum() < 2:
        raise RuntimeError('fewer than 2 valid samples to interpolate from')
    return np.interp(t, t[ok], v[ok])


def convert(reg: dict, mesh_dir: str, smooth_seconds: float = 1.5) -> dict:
    """reg (register.register output) + mesh -> aim-track payload dict."""
    uv, rays = load_mesh_rays(mesh_dir)
    tree = cKDTree(uv)

    t = reg['t']
    px, py, fw = reg['pano_x'].copy(), reg['pano_y'].copy(), reg['footw'].copy()
    # Registration gaps -> interpolate pano coords first (matches the reg_*.json
    # behaviour the offline pipeline validated against).
    px, py, fw = (_interp_nan(t, v) for v in (px, py, fw))
    py = np.clip(py, 0.0, 1.0)
    px = np.clip(px, 0.0, 1.0)
    # Edge-ray fov is only well-posed while both edges stay comfortably inside
    # the panorama; beyond that (Spiideo's whole-pitch wide shots, footw up to
    # ~1.3) the edge rays approach the fisheye boundary and the chord angle
    # blows up (>150 deg). Clamp the FOOTPRINT for the edge lookup and the
    # resulting fov to the player's follow range - wide shots ride at max
    # zoom-out, exactly like the offline follow render's fov clamp.
    fw = np.clip(fw, 0.02, 0.6)

    centre = _rays_for_uv(tree, rays, np.column_stack([px, py]))
    left = _rays_for_uv(tree, rays, np.column_stack([np.clip(px - fw / 2, 0, 1), py]))
    right = _rays_for_uv(tree, rays, np.column_stack([np.clip(px + fw / 2, 0, 1), py]))

    pan, tilt = _pan_tilt(centre)
    # Angle between the edge rays = HORIZONTAL angular span of the view. The
    # player's camera.fov (three.js PerspectiveCamera) is VERTICAL - convert
    # through the 16:9 pinhole relationship (validated against the GL-bisection
    # framing output: hfov ~41 deg -> vfov ~23 deg, matching its 21-46 range).
    cosang = np.clip(np.sum(left * right, axis=1), -1.0, 1.0)
    hfov = np.arccos(cosang)
    fov = np.degrees(2.0 * np.arctan(np.tan(hfov / 2.0) / (16.0 / 9.0)))

    pan, tilt, fov = (_interp_nan(t, v) for v in (pan, tilt, fov))

    # Edge-safe smoothing; window ~smooth_seconds of samples, odd, >= 5.
    if smooth_seconds > 0:
        win = max(5, int(round(smooth_seconds * reg['sample_fps'])) | 1)
        if len(t) > win:
            pan, tilt, fov = (savgol_filter(v, win, 2, mode='nearest')
                              for v in (pan, tilt, fov))
    # Final clamp AFTER smoothing (savgol can overshoot a pre-clamped plateau).
    # 14..62 = the player's follow-fov range; clampView re-clamps client-side.
    fov = np.clip(fov, 14.0, 62.0)

    # No per-sample inliers array in the payload: the player never reads it,
    # and on a 2h match it's ~20% of a ~1MB JSON fetched on the player's mesh
    # load path. The scalar coverage/median_inliers stats carry the quality
    # signal; the full reg evidence lives in the private S3 provenance copy.
    return dict(
        version=1,
        sample_fps=reg['sample_fps'],
        dur=round(reg['dur'], 3),
        n=reg['n'],
        coverage=reg['coverage'],
        median_inliers=reg['median_inliers'],
        min_inliers=reg['min_inliers'],
        t=[round(float(x), 3) for x in t],
        pan=[round(float(x), 3) for x in pan],
        tilt=[round(float(x), 3) for x in tilt],
        fov=[round(float(x), 3) for x in fov],
    )

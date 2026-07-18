"""Shared KB (Kannala-Brandt / cv2.fisheye) forward+inverse projection.

The forward form is generate_mesh.py's manual arccos projection (valid past
90 deg — cv2.fisheye folds z<0 rays back inside the disc). The inverse solves
theta(r) by bisection: r(theta) = F*theta*(1 + k1 th^2 + k2 th^4 + k3 th^6 +
k4 th^8) is monotonic over the fitted range for our lenses; we cap at
THETA_INV_MAX and refuse beyond.

Conventions (identical to generate_mesh.py):
  world ray d(pan,tilt) = [cos(t)sin(p), -sin(t), cos(t)cos(p)]
  camera ray dc = Rmount @ d,  Rmount = Rz(roll) @ Ry(yaw) @ Rx(tilt)
  pixel: theta = arccos(dc_z), phi = atan2(dc_y, dc_x),
         r = F*theta*(1+...), px = (CX + r cos phi, CY + r sin phi)
"""
import json
import os

import cv2
import numpy as np

THETA_INV_MAX = np.radians(115)


def load_fit(site, base=None):
    base = base or os.path.dirname(__file__)
    return json.load(open(os.path.join(base, f'{site}-fit.json')))


def mount_R(fit):
    rx = np.radians(float(fit.get('TILT', 0)))
    ry = np.radians(float(fit.get('YAW', 0)))
    rz = np.radians(float(fit.get('ROLL', 0)))
    return (cv2.Rodrigues(np.array([0., 0., rz]))[0]
            @ cv2.Rodrigues(np.array([0., ry, 0.]))[0]
            @ cv2.Rodrigues(np.array([rx, 0., 0.]))[0])


def euler_from_mount_R(R):
    """Inverse of mount_R: R = Rz(rz) @ Ry(ry) @ Rx(rx) -> (tilt, yaw, roll) deg."""
    ry = np.arcsin(-np.clip(R[2, 0], -1, 1)) if abs(R[2, 0]) <= 1 else 0.0
    # R[2,0] = -sin(ry); R[2,1] = sin(rx)cos(ry); R[2,2] = cos(rx)cos(ry)
    rx = np.arctan2(R[2, 1], R[2, 2])
    # R[1,0] = sin(rz)cos(ry) ... R[0,0] = cos(rz)cos(ry)
    rz = np.arctan2(R[1, 0], R[0, 0])
    return np.degrees(rx), np.degrees(ry), np.degrees(rz)


def kb_params(fit):
    """ks is a 4- or 6-vector: [k1..k4] radial, optionally + [p1, p2] Brown
    tangential (fits with P1/P2 keys — the reg-SIFT-constrained capacity
    extension, 2026-07-18). project/unproject accept both forms, so every
    consumer supports tangential fits without call-site changes."""
    F = float(fit['F'])
    cx, cy = float(fit['CX']), float(fit['CY'])
    ks = [float(fit.get(f'K{i}', 0)) for i in (1, 2, 3, 4)]
    if 'P1' in fit or 'P2' in fit:
        ks += [float(fit.get('P1', 0)), float(fit.get('P2', 0))]
    return F, cx, cy, ks


def _tang(ks):
    return (float(ks[4]), float(ks[5])) if len(ks) > 4 else (0.0, 0.0)


def project(dc, F, cx, cy, ks):
    """Camera-frame unit rays (N,3) -> pixels (N,2). Manual arccos KB form,
    plus Brown tangential in normalized coords when ks carries p1/p2."""
    th = np.arccos(np.clip(dc[:, 2], -1.0, 1.0))
    ph = np.arctan2(dc[:, 1], dc[:, 0])
    k1, k2, k3, k4 = ks[:4]
    r = F * th * (1 + k1 * th**2 + k2 * th**4 + k3 * th**6 + k4 * th**8)
    p1, p2 = _tang(ks)
    if p1 or p2:
        x = (r / F) * np.cos(ph)
        y = (r / F) * np.sin(ph)
        r2 = x * x + y * y
        return np.column_stack([
            cx + F * (x + 2 * p1 * x * y + p2 * (r2 + 2 * x * x)),
            cy + F * (y + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y)])
    return np.column_stack([cx + r * np.cos(ph), cy + r * np.sin(ph)])


def unproject(px, F, cx, cy, ks):
    """Pixels (N,2) -> camera-frame unit rays (N,3). Fixed-point removal of
    the tangential term (when present), then bisection on theta(r)."""
    p1, p2 = _tang(ks)
    if p1 or p2:
        x = (px[:, 0] - cx) / F
        y = (px[:, 1] - cy) / F
        xr, yr = x.copy(), y.copy()
        for _ in range(6):
            r2 = xr * xr + yr * yr
            xr = x - (2 * p1 * xr * yr + p2 * (r2 + 2 * xr * xr))
            yr = y - (p1 * (r2 + 2 * yr * yr) + 2 * p2 * xr * yr)
        dx = F * xr
        dy = F * yr
    else:
        dx = px[:, 0] - cx
        dy = px[:, 1] - cy
    r = np.hypot(dx, dy)
    ph = np.arctan2(dy, dx)
    k1, k2, k3, k4 = ks[:4]

    def r_of(th):
        return F * th * (1 + k1 * th**2 + k2 * th**4 + k3 * th**6 + k4 * th**8)

    lo = np.zeros_like(r)
    hi = np.full_like(r, THETA_INV_MAX)
    bad = r > r_of(np.array([THETA_INV_MAX]))[0]
    for _ in range(60):
        mid = 0.5 * (lo + hi)
        m = r_of(mid) < r
        lo = np.where(m, mid, lo)
        hi = np.where(m, hi, mid)
    th = 0.5 * (lo + hi)
    st = np.sin(th)
    d = np.column_stack([st * np.cos(ph), st * np.sin(ph), np.cos(th)])
    return d, ~bad


def mesh_world_rays(mesh_dir):
    """Triangle-referenced vertices of a generated mesh -> (world rays, uv).

    world = transpose(R_scene @ MOUNT_S) @ unit(f0, f1, 1) — the player's
    textureToWorld. Culled vertices stay in vertices.bin with garbage values,
    so ONLY triangle-referenced vertices are usable (the §0h invariant).
    """
    scene = json.load(open(os.path.join(mesh_dir, 'scene.json')))
    v = np.fromfile(os.path.join(mesh_dir, 'vertices.bin'), np.float32).reshape(-1, 5)
    idx = np.fromfile(os.path.join(mesh_dir, 'indices.bin'), np.uint32)
    MOUNT_S = np.array([[0, -0.218849, 0.975731],
                        [-1.000013, 0, 0],
                        [0, -0.975762, -0.218884]], np.float64)
    rays = np.zeros((len(v), 3))
    base = 0
    for p in scene['projections']:
        n = p['n_vertices']
        R_scene = np.array(p['camera']['rotation']).reshape(3, 3)
        tw = (R_scene @ MOUNT_S).T
        g = np.column_stack([v[base:base + n, 0], v[base:base + n, 1],
                             np.ones(n)])
        g /= np.linalg.norm(g, axis=1, keepdims=True)
        rays[base:base + n] = (tw @ g.T).T
        base += n
    ref = np.unique(idx[:len(idx) - len(idx) % 3])
    return rays[ref], v[ref, 2:4]

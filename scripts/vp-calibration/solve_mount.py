#!/usr/bin/env python3
"""Solve the mount rotation (TILT/YAW/ROLL) for a refit camera model.

§0k RULE: after ANY principal-point change, re-solve the mount rotation against
the previous world frame (or a physical datum) BEFORE judging coverage or
framing — moving CX/CY re-levels the whole (pan,tilt) datum, and an intrinsics-
only refit will point the mesh's tilt window into the ground.

MODE=prior-mesh (default): Kabsch-align the NEW model's camera rays to the OLD
approved mesh's world frame. For each triangle-referenced vertex of the prior
mesh we have (pixel via UV, world ray via textureToWorld); the new intrinsics
unproject the same pixel to a camera ray; the rotation minimising
sum |cam_ray - R @ world_ray|^2 IS the new mount (dc = Rmount @ d_world).
Restricted to the pitch-ish tilt band + one 3-sigma trim (rim rays carry the
genuine calibration correction — they must not drag the datum).

MODE=pitch: take the camera rotation from register_pitch.py's pitch-anchored
solve (no prior mesh needed — new venues). Reads <site>-pitch.json and converts
each camera's R into mount euler angles.

Writes TILT/YAW/ROLL back into <site>-fit.json (single-camera) and prints the
residual profile (median/p90/max deg) — the residual after rotation is the
genuine calibration correction, NOT an error to chase to zero.

Env: SITE, PRIOR_MESH (dir; required for prior-mesh), MODE, W, H,
     TILT_BAND ("lo,hi" deg of old-frame tilt to align over, default -65,5),
     DRY=1 (don't write the fit json).
"""
import json
import os
import sys

import numpy as np

from fisheye_model import (euler_from_mount_R, kb_params, load_fit,
                           mesh_world_rays, unproject)

SITE = os.environ.get('SITE', 'kuwait')
MODE = os.environ.get('MODE', 'prior-mesh')
HERE = os.path.dirname(os.path.abspath(__file__))
FIT_PATH = os.path.join(HERE, f'{SITE}-fit.json')
fit = load_fit(SITE)
W = int(float(os.environ.get('W', fit.get('W', 3840))))
H = int(float(os.environ.get('H', fit.get('H', 2160))))

if MODE == 'pitch':
    # register_pitch.py already solved each camera's world rotation against the
    # pitch model; here we only report it in mount-euler terms. Multi-camera
    # sites keep per-camera R in <site>-pitch.json's cameras[] (consumed by
    # generate_mesh.py directly); a single-camera site gets its fit json updated.
    pj = json.load(open(os.path.join(HERE, f'{SITE}-pitch.json')))
    for cam in pj['cameras']:
        R = np.array(cam['R']).reshape(3, 3)
        t, y, r = euler_from_mount_R(R)
        print(f"cam {cam.get('name', '?')}: TILT={t:.3f} YAW={y:.3f} ROLL={r:.3f}")
    if len(pj['cameras']) == 1 and not os.environ.get('DRY'):
        R = np.array(pj['cameras'][0]['R']).reshape(3, 3)
        t, y, r = euler_from_mount_R(R)
        fit.update(TILT=round(t, 3), YAW=round(y, 3), ROLL=round(r, 3))
        json.dump(fit, open(FIT_PATH, 'w'), indent=1)
        print(f'wrote {FIT_PATH}')
    sys.exit(0)

PRIOR = os.environ.get('PRIOR_MESH')
if not PRIOR:
    sys.exit('MODE=prior-mesh needs PRIOR_MESH=<old approved mesh dir>')
band = os.environ.get('TILT_BAND', '-65,5').split(',')
t_lo, t_hi = np.radians(float(band[0])), np.radians(float(band[1]))

rays_old, uv = mesh_world_rays(PRIOR)
px = uv * np.array([W, H])
tilt_old = -np.arcsin(np.clip(rays_old[:, 1], -1, 1))  # d_y = -sin(tilt)
keep = (tilt_old >= t_lo) & (tilt_old <= t_hi)
rays_old, px = rays_old[keep], px[keep]
print(f'{keep.sum()} prior-mesh vertices in tilt band '
      f'[{np.degrees(t_lo):.0f},{np.degrees(t_hi):.0f}]')

F, cx, cy, ks = kb_params(fit)
cam, ok = unproject(px, F, cx, cy, ks)
rays_old, cam = rays_old[ok], cam[ok]


def kabsch(a, b):
    """Rotation R minimising sum |a - R @ b|^2 (a, b unit rays, N x 3)."""
    Cov = a.T @ b
    U, _, Vt = np.linalg.svd(Cov)
    S = np.diag([1, 1, np.sign(np.linalg.det(U @ Vt))])
    return U @ S @ Vt


R = kabsch(cam, rays_old)
for _ in range(2):  # trim pass: drop >3-sigma outliers, re-solve
    res = np.degrees(np.arccos(np.clip(np.sum(cam * (R @ rays_old.T).T, axis=1),
                                       -1, 1)))
    keep = res < max(3 * np.median(res), 1e-3)
    R = kabsch(cam[keep], rays_old[keep])

res = np.degrees(np.arccos(np.clip(np.sum(cam * (R @ rays_old.T).T, axis=1), -1, 1)))
t, y, r = euler_from_mount_R(R)
print(f'residual after rotation (deg): median {np.median(res):.2f} '
      f'p90 {np.percentile(res, 90):.2f} max {res.max():.2f}')
print(f'TILT={t:.3f} YAW={y:.3f} ROLL={r:.3f}')
if os.environ.get('DRY'):
    print('DRY=1 — fit json untouched')
else:
    fit.update(TILT=round(t, 3), YAW=round(y, 3), ROLL=round(r, 3))
    json.dump(fit, open(FIT_PATH, 'w'), indent=1)
    print(f'wrote {FIT_PATH}')

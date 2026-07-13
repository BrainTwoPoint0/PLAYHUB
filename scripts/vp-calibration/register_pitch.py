#!/usr/bin/env python3
"""Camera orientation + virtual-pinhole K from scene structure (gap #2:
extrinsics WITHOUT a prior approved mesh) — a Manhattan-style vanishing bundle.

Input: snapped lines (snap_lines.py) per camera, each assigned to a world
DIRECTION FAMILY in the guides/config:
    vertical — floodlight poles, columns (plumb)
    length   — touchlines, track kerb/lane lines on the straight (pitch length)
    width    — halfway line (pitch width, ⊥ length, horizontal)
Families are mutually orthogonal. Each snapped line, unprojected through the
camera model, spans a great-circle plane; that plane must CONTAIN its family
direction (plane normal ⊥ direction). With one camera this solves R (3) + K
(F, cx, cy) when ≥2 families are present and non-degenerate; the joint
multi-camera solve adds SHARED lines (e.g. the halfway line seen by both
co-located cameras must be the SAME world plane), which couples the cameras
and yields the relative rotation for free.

Model: PINHOLE per camera (+ optional k1). Rationale (HCT discovery,
2026-07-13): providers may deliver PRE-RECTIFIED per-lens tiles — clean world
lines are straight in raw pixels, which makes the plumb-line KB solve
structurally degenerate (straight stays straight under ANY pinhole K).
Vanishing geometry is what still identifies K there. For a raw fisheye venue,
run calibrate.py SOLVE=full first and use MODE=pitch here only for the mount.

Config json (env CONFIG):
{
  "cameras": [
    {"name": "top",    "lines": "hct-top-lines.json",    "W": 3840, "H": 1080,
     "tex_v0": 0.0, "tex_v1": 0.5},
    {"name": "bottom", "lines": "hct-bottom-lines.json", "W": 3840, "H": 1080,
     "tex_v0": 0.5, "tex_v1": 1.0}
  ],
  "families": {"vertical": ["pole"], "length": ["kerb", "lane", "touch"],
               "width": ["halfway"]},          # name-prefix match
  "exclude": ["goalbar"],                       # portable goals: not axis-aligned
  "shared": [["halfway_A", "halfway_B"]]        # same world line in both cams
}

World frame (matches generate_mesh.py): up = -y; length direction = +x
(pan ±90 looks along the pitch length), width = +z at pan 0. Output:
<SITE>-fit.json with cameras[] carrying K + R (world→camera) + texture window.
Env: SITE, CONFIG, K1=1 to also solve a per-camera k1.
"""
import json
import os
import sys

import cv2
import numpy as np
from scipy.optimize import least_squares

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.environ.get('SITE', 'hct')
CONFIG = os.environ.get('CONFIG', os.path.join(HERE, f'{SITE}-register.json'))
SOLVE_K1 = os.environ.get('K1') == '1'
cfg = json.load(open(CONFIG))

FAMILY_DIRS = {  # world directions (unit)
    'vertical': np.array([0., 1., 0.]),   # nadir/zenith axis (up = -y)
    'length': np.array([1., 0., 0.]),
    'width': np.array([0., 0., 1.]),
}


def family_of(name):
    for fam, prefixes in cfg['families'].items():
        if any(name.startswith(p) or p in name for p in prefixes):
            return fam
    return None


cams = []
for c in cfg['cameras']:
    lines = json.load(open(os.path.join(HERE, c['lines'])))['lines']
    keep = []
    for ln in lines:
        if any(x in ln['name'] for x in cfg.get('exclude', [])):
            continue
        fam = family_of(ln['name'])
        if fam is None:
            continue
        keep.append((ln['name'], fam, np.array(ln['pts'], np.float64)))
    cams.append(dict(cfg=c, lines=keep))
    print(f"cam {c['name']}: " + ' '.join(f"{n}({f})" for n, f, _ in keep))

shared = cfg.get('shared', [])


SHARED_F = os.environ.get('SHARED_F', '1') == '1'
FIX_F = os.environ.get('FIX_F') == '1'  # freeze F at F0 (external anchor, e.g.
# the provider's own window geometry); rotations remain the only unknowns.
# SHARED_F=1 (default): one F for all cameras, principal points FIXED at the
# crop centre, only rotations free per camera. Full free-K vanishing
# calibration needs long, well-spread verticals; short pole chords let K run
# away to a degenerate optimum (observed: F 5835/469, centres off-image).
# Same-provider tiles share one rectification pipeline, so one F is right.


def unpack(th):
    out = []
    if SHARED_F:
        F = F0 if FIX_F else th[0]
        off = 0 if FIX_F else 1
        for c in cams:
            rvec = th[off:off + 3]
            k1 = th[off + 3] if SOLVE_K1 else 0.0
            off += 4 if SOLVE_K1 else 3
            out.append((F, c['cfg']['W'] / 2, c['cfg']['H'] / 2,
                        cv2.Rodrigues(rvec)[0], k1))
        return out
    off = 0
    for c in cams:
        F, cx, cy = th[off:off + 3]
        rvec = th[off + 3:off + 6]
        k1 = th[off + 6] if SOLVE_K1 else 0.0
        off += 7 if SOLVE_K1 else 6
        out.append((F, cx, cy, cv2.Rodrigues(rvec)[0], k1))
    return out


def line_plane_normal(pts, F, cx, cy, k1):
    """Unit normal of the great-circle plane best fitting the line's rays."""
    x = (pts[:, 0] - cx) / F
    y = (pts[:, 1] - cy) / F
    if k1:
        r2 = x * x + y * y
        x, y = x * (1 + k1 * r2), y * (1 + k1 * r2)
    d = np.column_stack([x, y, np.ones(len(x))])
    d /= np.linalg.norm(d, axis=1, keepdims=True)
    # smallest singular vector of the ray bundle = plane normal
    _, _, Vt = np.linalg.svd(d, full_matrices=False)
    return Vt[2], d


def constrained_normal(rays, u_c):
    """Best plane normal for the ray bundle, constrained to contain u_c
    (normal ⊥ u_c). Smallest eigenvector of the projected scatter."""
    Pj = np.eye(3) - np.outer(u_c, u_c)
    M = Pj @ (rays.T @ rays) @ Pj
    w, V = np.linalg.eigh(M)
    # eigenvector with smallest eigenvalue that is ⊥ u_c (skip the u_c null dir)
    for i in np.argsort(w):
        if abs(np.dot(V[:, i], u_c)) < 0.5:
            n = V[:, i]
            return n / np.linalg.norm(n)
    return V[:, 0]


def residuals(th):
    """Per-POINT pixel-scaled residuals: each snapped point's ray must lie in
    a plane that contains its family's world direction. F multiplies the
    ray-plane angular offset, so residuals are ~pixels and do NOT collapse as
    F grows (an unweighted angular objective rewards F→infinity)."""
    P = unpack(th)
    res = []
    normals = {}
    for ci, (cam, prm) in enumerate(zip(cams, P)):
        F, cx, cy, R, k1 = prm
        for name, fam, pts in cam['lines']:
            _, rays = line_plane_normal(pts, F, cx, cy, k1)
            u_c = R @ FAMILY_DIRS[fam]
            n = constrained_normal(rays, u_c)
            normals[name] = R.T @ n
            res.extend(F * (rays @ n) / np.sqrt(len(pts)))
    for a, b in shared:
        if a in normals and b in normals:
            na, nb = normals[a], normals[b]
            if np.dot(na, nb) < 0:
                nb = -nb
            # co-located cameras seeing the same world line share its plane
            res.extend(200.0 * (na - nb))
    return np.array(res)


# ---- seed: F from a generic HFOV guess, centre at crop centre, R from a
# coarse grid over (tilt, yaw) with roll 0 (cameras are roughly level).
F0 = float(os.environ.get('F0', 0.58 * cams[0]['cfg']['W']))
th0 = ([] if FIX_F else [F0]) if SHARED_F else []
for ci, cam in enumerate(cams):
    W, H = cam['cfg']['W'], cam['cfg']['H']
    best = None
    for tilt in np.radians([5, 10, 15, 20]):
        for yaw in np.radians(np.arange(-60, 61, 10)):
            R = (cv2.Rodrigues(np.array([0., yaw, 0.]))[0]
                 @ cv2.Rodrigues(np.array([tilt, 0., 0.]))[0])
            s = 0.0
            for name, fam, pts in cam['lines']:
                n_cam, _ = line_plane_normal(pts, F0, W / 2, H / 2, 0.0)
                s += abs(float(np.dot(R.T @ n_cam, FAMILY_DIRS[fam])))
            if best is None or s < best[0]:
                best = (s, R)
    if not SHARED_F:
        th0 += [F0, W / 2, H / 2]
    th0 += [*cv2.Rodrigues(best[1])[0].ravel()]
    if SOLVE_K1:
        th0.append(0.0)
th0 = np.array(th0)

sol = least_squares(residuals, th0, method='trf', max_nfev=20000)
P = unpack(sol.x)
print(f'\nbundle residual rms {np.sqrt(np.mean(sol.fun**2)):.4f} '
      f'(weighted plane-alignment units)')

out_cams = []
for cam, (F, cx, cy, R, k1) in zip(cams, P):
    c = cam['cfg']
    # report per-line alignment in degrees for the record
    print(f"cam {c['name']}: F={F:.1f} c=({cx:.1f},{cy:.1f})"
          + (f' k1={k1:.5f}' if SOLVE_K1 else ''))
    for name, fam, pts in cam['lines']:
        n_cam, _ = line_plane_normal(pts, F, cx, cy, k1)
        mis = 90 - np.degrees(np.arccos(abs(float(np.dot(R.T @ n_cam,
                                                         FAMILY_DIRS[fam])))))
        print(f'   {name:<12} {fam:<8} plane-misalign {mis:5.2f} deg')
    axis = R.T @ np.array([0., 0., 1.])
    pan = np.degrees(np.arctan2(axis[0], axis[2]))
    tilt = np.degrees(-np.arcsin(axis[1]))
    print(f'   optical axis: pan {pan:+.2f} tilt {tilt:+.2f}')
    out_cams.append(dict(name=c['name'], W=c['W'], H=c['H'],
                         F=float(F), CX=float(cx), CY=float(cy),
                         K1=float(k1), K2=0.0, K3=0.0, K4=0.0,
                         R=R.flatten().tolist(),
                         tex_v0=c['tex_v0'], tex_v1=c['tex_v1']))

if len(out_cams) == 2:
    R0 = np.array(out_cams[0]['R']).reshape(3, 3)
    R1 = np.array(out_cams[1]['R']).reshape(3, 3)
    rel = np.degrees(np.arccos(np.clip((np.trace(R1 @ R0.T) - 1) / 2, -1, 1)))
    print(f'\ninter-camera rotation angle: {rel:.2f} deg')

fit_path = os.path.join(HERE, f'{SITE}-fit.json')
existing = json.load(open(fit_path)) if os.path.exists(fit_path) else {}
existing['cameras'] = out_cams
json.dump(existing, open(fit_path, 'w'), indent=1)
print(f'wrote {fit_path}')

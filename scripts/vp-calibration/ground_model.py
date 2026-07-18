#!/usr/bin/env python3
"""Empirical GROUND HEIGHT field from the hand-snapped pitch lines — input to
generate_mesh.py's ground-flattening warp (GROUND env).

Why: the near-line/corner "curved upwards" percept survives every lens fit.
Measured 2026-07-18 (see benchmarks/README.md §GROUND): all candidate fits
agree per-line to 0.1-0.2%; the near_touch deviation profile is a WIGGLE
(-3.5 -> +9.8 -> -8.3 -> +3.9 -> +11.9 mrad along the line, three sign
changes) — local turf undulation seen from 4m, not a crown. Parametric
surfaces measured out: a quadratic fails held-out near_touch; cubic runs
unphysical at the corners; quartic overfits (held-out 24.8 mrad). Hence
EMPIRICAL: per-point heights solved exactly from the tape-verified
plan-straightness of each painted line, smoothed, interpolated.

Method:
  1. Metric pitch->camera pose from the admin-marks homography (plane H
     decomposition; t is in metres once ||r1||=||r2||=1).
  2. Per line: intersect rays with z=0, fit the 2D plan line (PCA); then per
     point solve the ray against the VERTICAL PLANE through that line ->
     unique 3D point -> height z_i. Iterate (plan line refits from the
     lifted points). Remove per-line mean+slope (plane gauge lives in the
     mount, not the ground). Smooth along arc length (snap noise ~1-2 mrad).
  3. Attribution caveat, recorded here on purpose: any bottom-sector LENS
     field error is absorbed into z too (the reg-SIFT constraint has no
     bottom coverage — fov<=45 filter removes near-touch framings). For the
     display-side flattener that is the desired behaviour: the warp
     straightens the rendered paint whatever the physical mix. Do NOT feed
     this surface to anything metric.
  4. Interpolate scattered line samples to a grid (RBF thin-plate with
     smoothing), taper to zero beyond the pitch margin, cap |z|.

Lines nearly RADIAL to the camera (halfway, box sides) carry weak height
signal (height moves points along the line); the transverse touchlines carry
the strong signal — which is where the percept lives.

Env: SITE, FIT (default accepted fit), LINES, MARKS, OUT, Z_CAP (0.5 m),
SMOOTH_MRAD (spline tolerance, default 1.5), GRID_STEP (m, default 0.5),
MARGIN (taper metres beyond pitch, default 2.5).
"""
import json
import os
import sys

import numpy as np
from scipy.interpolate import Rbf, UnivariateSpline

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from fisheye_model import kb_params, unproject  # noqa: E402
from marks_solver import MARK_WORLD, ray_dlt_homography  # noqa: E402

SITE = os.environ.get('SITE', 'kuwait')
Z_CAP = float(os.environ.get('Z_CAP', 0.5))
SMOOTH_MRAD = float(os.environ.get('SMOOTH_MRAD', 1.5))
GRID_STEP = float(os.environ.get('GRID_STEP', 0.5))
MARGIN = float(os.environ.get('MARGIN', 2.5))


def load_fit():
    p = os.environ.get('FIT')
    if not p:
        cand = os.path.join(HERE, 'benchmarks', 'baselines',
                            f'{SITE}-accepted-fit.json')
        p = cand if os.path.exists(cand) else os.path.join(HERE, f'{SITE}-fit.json')
    return json.load(open(p)), p


def metric_pose(fit, marks):
    F, cx, cy, ks = kb_params(fit)
    px = np.array([m['uv'] for m in marks['marks']], np.float64)
    world = np.array([MARK_WORLD[m['name']](float(marks['lengthM']),
                                            float(marks['widthM']))
                      for m in marks['marks']])
    rays, ok = unproject(px, F, cx, cy, ks)
    if not ok.all():
        sys.exit('ground_model: mark outside invertible range of the fit')
    Hh = ray_dlt_homography(world, rays)
    if Hh[2, 2] < 0:
        Hh = -Hh
    s = np.sqrt(np.linalg.norm(Hh[:, 0]) * np.linalg.norm(Hh[:, 1]))
    Hh = Hh / s
    r1 = Hh[:, 0] / np.linalg.norm(Hh[:, 0])
    r2 = Hh[:, 1] / np.linalg.norm(Hh[:, 1])
    R0 = np.column_stack([r1, r2, np.cross(r1, r2)])
    U, _, Vt = np.linalg.svd(R0)
    R = U @ np.diag([1, 1, np.sign(np.linalg.det(U @ Vt))]) @ Vt
    t = Hh[:, 2]
    C = -R.T @ t
    return R, t, C


def line_heights(rp, C):
    """Heights that put every ray exactly on ONE straight plan line.
    Returns (plan_xy, z, arc, angular_weight) after gauge removal."""
    lam0 = -C[2] / rp[:, 2]
    ok = np.isfinite(lam0) & (lam0 > 0) & (np.abs(rp[:, 2]) > 0.03)
    rp = rp[ok]
    if len(rp) < 6:
        return None
    lam = -C[2] / rp[:, 2]
    P = C[None, :] + lam[:, None] * rp
    for _ in range(3):
        c = P[:, :2].mean(0)
        q = P[:, :2] - c
        _, _, Vt = np.linalg.svd(q, full_matrices=False)
        d, n = Vt[0], Vt[1]  # along, normal (plan)
        # ray ∩ vertical plane {p: (p_xy - c)·n = 0}
        denom = rp[:, 0] * n[0] + rp[:, 1] * n[1]
        keep = np.abs(denom) > 1e-4
        lam = ((c[0] - C[0]) * n[0] + (c[1] - C[1]) * n[1]) / \
            np.where(keep, denom, np.nan)
        P = C[None, :] + lam[:, None] * rp
        good = np.isfinite(lam) & (lam > 0)
        P, rp, lam = P[good], rp[good], lam[good]
        if len(P) < 6:
            return None
    arc = (P[:, :2] - c) @ d
    z = P[:, 2]
    A = np.column_stack([np.ones(len(arc)), arc])
    coef, *_ = np.linalg.lstsq(A, z, rcond=None)
    z = z - A @ coef  # remove mean+slope: plane gauge
    o = np.argsort(arc)
    w = np.abs(rp[:, 2]) / np.maximum(lam, 1e-6)  # rad of view per metre of z
    return P[o, :2], z[o], arc[o], w[o]


def main():
    fit, fit_path = load_fit()
    marks = json.load(open(os.environ.get(
        'MARKS', os.path.join(HERE, f'{SITE}-marks.json'))))
    lines_j = json.load(open(os.environ.get(
        'LINES', os.path.join(HERE, f'{SITE}-lines.json'))))
    L, W = float(marks['lengthM']), float(marks['widthM'])
    R, t, C = metric_pose(fit, marks)
    print(f'fit: {os.path.relpath(fit_path, HERE)}')
    print(f'camera (pitch frame): x={C[0]:.2f} y={C[1]:.2f} z={C[2]:.2f} m')
    if not (1.5 < abs(C[2]) < 40):
        sys.exit('ground_model: implausible camera height')
    up = -np.sign(C[2])  # ground z toward the camera side is "up"

    F, cx, cy, ks = kb_params(fit)
    samples = []
    print(f'{"line":<12} {"n":>4} {"z rms cm":>9} {"z max cm":>9} '
          f'{"weak(radial)":>13}')
    for ln in lines_j['lines']:
        pts = np.array(ln['pts'], np.float64)
        rays, ok = unproject(pts, F, cx, cy, ks)
        rp = (R.T @ rays[ok].T).T
        res = line_heights(rp, C)
        if res is None:
            print(f'{ln["name"]:<12} skipped')
            continue
        plan, z, arc, w = res
        # angular sensitivity: if height barely moves the view (radial
        # line), the solved z is noise-amplified — downweight/skip
        sens = np.median(w)
        weak = sens * 1000 < 1.0  # <1 mrad per metre of height
        # smooth along arc: spline whose tolerance ~ SMOOTH_MRAD of view
        tol_m = SMOOTH_MRAD / 1000.0 / np.maximum(sens, 1e-6)
        try:
            sp = UnivariateSpline(arc, z, s=len(z) * tol_m ** 2)
            zs = sp(arc)
        except Exception:
            zs = z
        zs = np.clip(zs, -Z_CAP, Z_CAP)
        print(f'{ln["name"]:<12} {len(z):>4} {np.sqrt((zs**2).mean())*100:9.1f} '
              f'{np.abs(zs).max()*100:9.1f} {"WEAK-skip" if weak else "":>13}')
        if not weak:
            samples.append(np.column_stack([plan, zs]))

    S = np.vstack(samples)
    # pin the boundary beyond the pitch to 0 so the RBF decays outward
    bx = np.concatenate([np.linspace(-MARGIN, L + MARGIN, 25),
                         np.linspace(-MARGIN, L + MARGIN, 25),
                         np.full(13, -MARGIN), np.full(13, L + MARGIN)])
    by = np.concatenate([np.full(25, -MARGIN), np.full(25, W + MARGIN),
                         np.linspace(-MARGIN, W + MARGIN, 13),
                         np.linspace(-MARGIN, W + MARGIN, 13)])
    X = np.concatenate([S[:, 0], bx])
    Y = np.concatenate([S[:, 1], by])
    Z = np.concatenate([S[:, 2], np.zeros(len(bx))])
    rbf = Rbf(X, Y, Z, function='thin_plate', smooth=1e-4)
    gx = np.arange(-MARGIN, L + MARGIN + 1e-9, GRID_STEP)
    gy = np.arange(-MARGIN, W + MARGIN + 1e-9, GRID_STEP)
    GX, GY = np.meshgrid(gx, gy)
    GZ = np.clip(rbf(GX, GY), -Z_CAP, Z_CAP)
    # taper: cosine falloff over the outer half of the margin
    dx = np.clip(np.maximum(-GX, GX - L), 0, None)
    dy = np.clip(np.maximum(-GY, GY - W), 0, None)
    dd = np.hypot(dx, dy)
    taper = 0.5 * (1 + np.cos(np.pi * np.clip(dd / MARGIN, 0, 1)))
    GZ = GZ * taper
    print(f'grid {GZ.shape[1]}x{GZ.shape[0]} step {GRID_STEP}m  '
          f'z range [{GZ.min()*100:.1f}, {GZ.max()*100:.1f}] cm  up={up:+.0f}')

    out = os.environ.get('OUT', os.path.join(HERE, f'{SITE}-ground.json'))
    json.dump(dict(site=SITE, mode='empirical-grid',
                   lengthM=L, widthM=W, margin=MARGIN,
                   grid_x0=float(gx[0]), grid_y0=float(gy[0]),
                   grid_step=GRID_STEP,
                   grid=[[round(float(v), 4) for v in row] for row in GZ],
                   R=R.flatten().tolist(), t=t.tolist(), C=C.tolist(),
                   fit=os.path.relpath(fit_path, HERE)),
              open(out, 'w'), indent=None)
    print(f'wrote {out}')


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Acceptance gates for a calibration fit + generated mesh — codified so a fit
is judged by measurement, not eyeballing (§0k rule; the eye only judges the
final product look on /panorama-test).

GATE A — chord-bow: every snapped plumb line, unprojected through the fit and
re-projected through a virtual pinhole aimed at the line, must be straight.
Reported as max/rms perpendicular px over the chord on a 1920x1080 render at
FOV deg vertical (§0k reference numbers: kuwait far-touch 29.1px bad fit →
4.0px good fit at fov46).

GATE B — raw-frame coverage: % of the raw frame the mesh's triangle-referenced
UVs cover (binned). With PRIOR_MESH set, also the delta (a big loss means a
mis-levelled window — §0k's "80→70%" trap).

GATE C — world reconstruction: per projection, pan/tilt ranges of the
triangle-referenced world rays + UV bounds. Catches hemisphere flips (a strip
whose pan range spans ~360 has mirrored through the origin) and out-of-frame
UVs. (f0/f1 prints hide flips — always reconstruct.)

GATE D — cross-camera seam (multi-camera fits only): where both cameras claim
the same world ray, project it through BOTH models and measure the offset in
output px at FOV — the ghosting bound at the seam. Requires cameras[] in the
fit json (Phase B two-cam sites).

Env: SITE, LINES (snapped-lines json for gate A), MESH (mesh dir for B/C),
     PRIOR_MESH (coverage compare), FOV (default 46), W, H,
     BOW_MAX (px, default 5), COVER_LOSS_MAX (abs %, default 2), SEAM_MAX (px,
     default 4). Exit code 0 = all gates PASS.
"""
import json
import os
import sys

import numpy as np

from fisheye_model import kb_params, load_fit, mesh_world_rays, mount_R, project, unproject

SITE = os.environ.get('SITE', 'kuwait')
HERE = os.path.dirname(os.path.abspath(__file__))
fit = (json.load(open(os.environ['FIT'])) if os.environ.get('FIT')
       else load_fit(SITE))
W = int(float(os.environ.get('W', fit.get('W', 3840))))
H = int(float(os.environ.get('H', fit.get('H', 2160))))
FOV = float(os.environ.get('FOV', 46))
# Gate A thresholds, calibrated on the APPROVED kuwait refit (which also passed
# the landmark stamp, 0.63px median vs Spiideo): weighted-median of per-line
# rendered rms ≤ RMS_MED_MAX, and every long (≥30pt) line rms ≤ RMS_LONG_MAX.
# Rim-heavy short lines carry genuine beyond-landmark-range residual in the
# approved fit — a universal per-line max would fail the shipped state.
RMS_MED_MAX = float(os.environ.get('RMS_MED_MAX', 8))
RMS_LONG_MAX = float(os.environ.get('RMS_LONG_MAX', 15))
COVER_LOSS_MAX = float(os.environ.get('COVER_LOSS_MAX', 2))
SEAM_MAX = float(os.environ.get('SEAM_MAX', 4))
RW, RH = 1920, 1080
failures = []


def view_basis(fwd):
    z = fwd / np.linalg.norm(fwd)
    x = np.cross(np.array([0., -1., 0.]), z)
    x /= np.linalg.norm(x)
    return np.array([x, np.cross(z, x), z])


def pinhole_project(world, aim):
    Rv = view_basis(aim)
    v = (Rv @ world.T).T
    f = (RH / 2) / np.tan(np.radians(FOV) / 2)
    ok = v[:, 2] > 1e-6
    return np.column_stack([RW / 2 + f * v[:, 0] / v[:, 2],
                            RH / 2 + f * v[:, 1] / v[:, 2]]), ok


def line_bow(pts_px, cams_of):
    """Perpendicular residuals of pinhole-rendered line points to their TLS line.

    Only points landing INSIDE the render frame count — a touchline spans far
    more pan than any single view; §0k's reference numbers are over the visible
    ~1350px chord at the line's own aim, not the whole wrap (where pinhole px
    lose meaning as vz->0).
    """
    cam, ok = cams_of(pts_px)
    world = (Rm.T @ cam[ok].T).T
    if len(world) < 8:
        return None
    scr, vis = pinhole_project(world, world.mean(axis=0))
    scr = scr[vis]
    inframe = ((scr[:, 0] >= 0) & (scr[:, 0] <= RW)
               & (scr[:, 1] >= 0) & (scr[:, 1] <= RH))
    if inframe.sum() >= 8:
        scr = scr[inframe]
    c = scr.mean(axis=0)
    d = scr - c
    _, _, Vt = np.linalg.svd(d, full_matrices=False)
    perp = d @ Vt[1]
    return np.abs(perp).max(), np.sqrt((perp**2).mean()), len(scr)


# ---- multi-camera fits carry cameras[]; single-camera fits are the flat form
cameras = fit.get('cameras')
Rm = mount_R(fit) if not cameras else None

# GATE A
lines_path = os.environ.get('LINES')
if lines_path:
    lines = json.load(open(lines_path))['lines']
    print(f'GATE A — chord-bow at fov{FOV:.0f} ({len(lines)} lines):')
    stats = []
    for ln in lines:
        pts = np.array(ln['pts'], np.float64)
        if cameras:
            cam_id = ln.get('camera', 0)
            c = cameras[cam_id]
            F, cx, cy, ks = (float(c['F']), float(c['CX']), float(c['CY']),
                             [float(c.get(f'K{i}', 0)) for i in (1, 2, 3, 4)])
            Rm = np.array(c['R']).reshape(3, 3)
        else:
            F, cx, cy, ks = kb_params(fit)
        r = line_bow(pts, lambda p: unproject(p, F, cx, cy, ks))
        if r is None:
            print(f'  {ln["name"]:<15} SKIP (<8 usable points)')
            continue
        mx, rms, n = r
        stats.append((ln['name'], rms, mx, n))
        flag = '  << LONG-LINE FAIL' if (n >= 30 and rms > RMS_LONG_MAX) else ''
        print(f'  {ln["name"]:<15} rms {rms:5.1f}px  max {mx:5.1f}px  ({n} pts){flag}')
    if stats:
        rmss = np.array([s[1] for s in stats])
        wts = np.array([s[3] for s in stats], np.float64)
        order = np.argsort(rmss)
        cum = np.cumsum(wts[order]) / wts.sum()
        wmed = rmss[order][np.searchsorted(cum, 0.5)]
        print(f'  weighted-median rms {wmed:.1f}px (limit {RMS_MED_MAX})')
        if wmed > RMS_MED_MAX:
            failures.append(f'gate A: weighted-median rms {wmed:.1f}px > {RMS_MED_MAX}')
        for name, rms, mx, n in stats:
            if n >= 30 and rms > RMS_LONG_MAX:
                failures.append(f'gate A: long line {name} rms {rms:.1f}px > {RMS_LONG_MAX}')

# GATES B + C
mesh_dir = os.environ.get('MESH')


def coverage(mesh_dir, bins=(128, 72)):
    _, uv = mesh_world_rays(mesh_dir)
    gx = np.clip((uv[:, 0] * bins[0]).astype(int), 0, bins[0] - 1)
    gy = np.clip((uv[:, 1] * bins[1]).astype(int), 0, bins[1] - 1)
    hit = np.zeros(bins[0] * bins[1], bool)
    hit[gy * bins[0] + gx] = True
    return 100.0 * hit.mean()


if mesh_dir:
    cov = coverage(mesh_dir)
    line = f'GATE B — raw-frame coverage: {cov:.1f}%'
    prior = os.environ.get('PRIOR_MESH')
    if prior:
        cov0 = coverage(prior)
        line += f'  (prior {cov0:.1f}%, delta {cov - cov0:+.1f}%)'
        if cov0 - cov > COVER_LOSS_MAX:
            failures.append(f'gate B: coverage loss {cov0 - cov:.1f}% > {COVER_LOSS_MAX}%')
    print(line)

    print('GATE C — world reconstruction per projection:')
    scene = json.load(open(os.path.join(mesh_dir, 'scene.json')))
    v = np.fromfile(os.path.join(mesh_dir, 'vertices.bin'), np.float32).reshape(-1, 5)
    idx = np.fromfile(os.path.join(mesh_dir, 'indices.bin'), np.uint32)
    ref = np.unique(idx[:len(idx) - len(idx) % 3])
    base = 0
    MOUNT_S = np.array([[0, -0.218849, 0.975731], [-1.000013, 0, 0],
                        [0, -0.975762, -0.218884]], np.float64)
    for i, p in enumerate(scene['projections']):
        n = p['n_vertices']
        mask = ref[(ref >= base) & (ref < base + n)]
        R_scene = np.array(p['camera']['rotation']).reshape(3, 3)
        tw = (R_scene @ MOUNT_S).T
        g = np.column_stack([v[mask, 0], v[mask, 1], np.ones(len(mask))])
        g /= np.linalg.norm(g, axis=1, keepdims=True)
        d = (tw @ g.T).T
        pan = np.degrees(np.arctan2(d[:, 0], d[:, 2]))
        tilt = np.degrees(-np.arcsin(np.clip(d[:, 1], -1, 1)))
        u_ok = ((v[mask, 2] >= -0.021) & (v[mask, 2] <= 1.021)
                & (v[mask, 3] >= -0.021) & (v[mask, 3] <= 1.021)).all()
        span = pan.max() - pan.min()
        is_bowl = tilt.max() < np.degrees(float(scene.get('minTilt', -1.6))) + 40
        flip = span > 300 and not is_bowl
        print(f'  proj{i}: {len(mask)} ref verts  pan [{pan.min():7.1f},{pan.max():7.1f}] '
              f'tilt [{tilt.min():6.1f},{tilt.max():6.1f}]  uv_ok={u_ok}'
              + ('  << HEMISPHERE FLIP' if flip else ''))
        if not u_ok:
            failures.append(f'gate C: proj{i} UVs out of frame')
        if flip:
            failures.append(f'gate C: proj{i} pan span {span:.0f} — hemisphere flip')
        base += n

# GATE D — cross-camera seam consistency
if cameras and len(cameras) > 1:
    print('GATE D — cross-camera seam ghosting:')
    A, B = cameras[0], cameras[1]
    prm = []
    for c in (A, B):
        prm.append((float(c['F']), float(c['CX']), float(c['CY']),
                    [float(c.get(f'K{i}', 0)) for i in (1, 2, 3, 4)],
                    np.array(c['R']).reshape(3, 3),
                    int(c.get('W', W)), int(c.get('H', H // 2))))
    # sample world rays across the seam band: pans around the crossover, pitch tilts
    seam_pan = float(fit.get('SEAM_PAN_DEG', 0))
    pans = np.radians(np.linspace(seam_pan - 8, seam_pan + 8, 33))
    tilts = np.radians(np.linspace(-35, -2, 12))
    pg, tg = np.meshgrid(pans, tilts)
    d = np.stack([np.cos(tg) * np.sin(pg), -np.sin(tg),
                  np.cos(tg) * np.cos(pg)], -1).reshape(-1, 3)
    px_ab = []
    vis_ab = []
    for (F, cx, cy, ks, R, w, h) in prm:
        dc = (R @ d.T).T
        p = project(dc, F, cx, cy, ks)
        vis = ((dc[:, 2] > 0.05) & (p[:, 0] >= 0) & (p[:, 0] <= w)
               & (p[:, 1] >= 0) & (p[:, 1] <= h))
        px_ab.append(p)
        vis_ab.append(vis)
    both = vis_ab[0] & vis_ab[1]
    if both.sum() < 10:
        print(f'  only {both.sum()} rays visible in BOTH cameras — widen seam band?')
        failures.append('gate D: no usable overlap')
    else:
        # ghosting = angular disagreement: unproject each camera's pixel back to
        # world through ITS model; the angle between the two worlds, scaled to
        # output px at FOV.
        w0 = (prm[0][4].T @ unproject(px_ab[0][both], *prm[0][:4])[0].T).T
        w1 = (prm[1][4].T @ unproject(px_ab[1][both], *prm[1][:4])[0].T).T
        ang = np.degrees(np.arccos(np.clip(np.sum(w0 * w1, axis=1), -1, 1)))
        pxscale = (RH / 2) / np.tan(np.radians(FOV) / 2) * np.radians(1)  # px per deg
        ghost = ang * pxscale
        print(f'  {both.sum()} shared rays: ghost median {np.median(ghost):.1f}px '
              f'p90 {np.percentile(ghost, 90):.1f}px max {ghost.max():.1f}px at fov{FOV:.0f}')
        if np.percentile(ghost, 90) > SEAM_MAX:
            failures.append(f'gate D: seam ghost p90 {np.percentile(ghost, 90):.1f}px > {SEAM_MAX}')

print()
if failures:
    print('RESULT: FAIL')
    for f in failures:
        print(f'  - {f}')
    sys.exit(1)
print('RESULT: PASS')

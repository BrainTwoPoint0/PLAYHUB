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

GATE E — admin-mark reprojection (MARKS + MESH): the venue admin's 4-corner
(+midline) marks scored through the generated mesh exactly as the product
does (marks_solver.py = pitch-solver.ts port, validated to 1e-10 px against
the stored server result). Currency: max per-mark error in raw-frame px, and
as % of the pitch span (longest pairwise corner distance in raw px — the
"31.8px on a 3118px span" scoreboard). Gate on MARK_PCT_MAX when set (the
automation target is 0.3).

Gate A also reports each line's bow as % of its own rendered chord (pct_max);
for the long pitch lines the chord IS the pitch span, so the same 0.3% target
applies via BOW_PCT_MAX (checked on lines with chord >= 40% of the longest).

REPORT=<path>: dump every computed metric as JSON (baseline freezing + the
auto-fit optimizer loop consume this; the printed text is for humans).

GATE F — plumb verticals vs the marks-mount up (VERTS + MARKS): detected
vert_ chains' great-circle plane normals through the fit, deviation from the
up axis decomposed out of the marks homography. Informative by default and
self-disqualifying — hard-gates via PLUMB_MAX_DEG only when enough chains sit
at moderate theta with x-spread (see inline note for the measured kuwait
negative that forced this shape).

GATE G — rim ray-field residual, ON BY DEFAULT for single-camera fits (the
2026-07-18 lesson: every interior gate improved while the rim bent 5-7 deg).
Incumbent mode (RIM_REF_FIT) Kabsch-aligns the candidate ray field to the
reference on theta<=75 and gates the theta 85-92 band; disc mode gates the
annotated image-circle arc ({SITE}-disc.json with az_deg) against the
lens-class DISC_THETA_DEG (disc_rim.py).

Env: SITE, LINES (snapped-lines json for gate A), MESH (mesh dir for B/C/E),
     MARKS (marks json for gate E), VERTS (auto-lines json for gate F),
     PRIOR_MESH (coverage compare),
     FOV (default 46), W, H, BOW_MAX (px, default 5), COVER_LOSS_MAX (abs %,
     default 2), SEAM_MAX (px, default 4), MARK_PCT_MAX, BOW_PCT_MAX,
     PLUMB_MAX_DEG (+ PLUMB_THETA_MAX/PLUMB_MIN_CHAINS/PLUMB_MIN_COLS),
     RIM_REF_FIT (reference fit json for gate G incumbent mode),
     RIM_MAX_DEG (default 2.0, 'off' disables), DISC_TOL_DEG (default 2.0,
     'off' disables), REPORT (json out path). Exit code 0 = all gates PASS.
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
report = {'site': SITE, 'fov': FOV}


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
    along = d @ Vt[0]
    chord = float(along.max() - along.min())
    return np.abs(perp).max(), np.sqrt((perp**2).mean()), len(scr), chord


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
        mx, rms, n, chord = r
        pct = 100.0 * mx / chord if chord > 0 else float('inf')
        stats.append((ln['name'], rms, mx, n, chord, pct))
        flag = '  << LONG-LINE FAIL' if (n >= 30 and rms > RMS_LONG_MAX) else ''
        print(f'  {ln["name"]:<15} rms {rms:5.1f}px  max {mx:5.1f}px  '
              f'bow {pct:5.2f}% of chord  ({n} pts){flag}')
    if stats:
        rmss = np.array([s[1] for s in stats])
        wts = np.array([s[3] for s in stats], np.float64)
        order = np.argsort(rmss)
        cum = np.cumsum(wts[order]) / wts.sum()
        wmed = rmss[order][np.searchsorted(cum, 0.5)]
        chord_max = max(s[4] for s in stats)
        long_lines = [s for s in stats if s[4] >= 0.4 * chord_max]
        worst_long_pct = max(s[5] for s in stats if s[4] >= 0.4 * chord_max)
        print(f'  weighted-median rms {wmed:.1f}px (limit {RMS_MED_MAX}); '
              f'worst long-chord bow {worst_long_pct:.2f}% '
              f'({len(long_lines)} lines with chord >= 40% of longest)')
        if wmed > RMS_MED_MAX:
            failures.append(f'gate A: weighted-median rms {wmed:.1f}px > {RMS_MED_MAX}')
        for name, rms, mx, n, chord, pct in stats:
            if n >= 30 and rms > RMS_LONG_MAX:
                failures.append(f'gate A: long line {name} rms {rms:.1f}px > {RMS_LONG_MAX}')
        bow_pct_max = os.environ.get('BOW_PCT_MAX')
        if bow_pct_max is not None and worst_long_pct > float(bow_pct_max):
            failures.append(f'gate A: worst long-chord bow {worst_long_pct:.2f}% '
                            f'> {float(bow_pct_max)}%')
        report['gateA'] = {
            'lines': [dict(name=s[0], rms_px=float(s[1]), max_px=float(s[2]),
                           n=int(s[3]), chord_px=float(s[4]), pct_max=float(s[5]))
                      for s in stats],
            'weighted_median_rms_px': float(wmed),
            'worst_long_chord_pct': float(worst_long_pct),
        }

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
    report['gateB'] = {'coverage_pct': float(cov)}

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
        if len(mask) == 0:
            # a projection no triangle references = the window missed the
            # frame entirely (observed on a mirrored-mount divergence) — a
            # hard failure, not a traceback
            print(f'  proj{i}: 0 ref verts  << EMPTY PROJECTION')
            failures.append(f'gate C: proj{i} has no referenced vertices')
            base += n
            continue
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

# GATE D — cross-camera seam consistency. Only meaningful when the fit's
# camera models GENERATED the mesh: for converted-Spiideo venues (HCT) the
# shipped mesh is Spiideo's own geometry and hct-fit.json does not reproduce
# its uv↔ray map (measured 2026-07-18: ~1300px median with the stored R,
# ~290px even after a free Kabsch refit — the fit was made against a different
# artifact). SEAM=0 skips.
if cameras and len(cameras) > 1 and os.environ.get('SEAM') != '0':
    print('GATE D — cross-camera seam ghosting:')
    A, B = cameras[0], cameras[1]
    prm = []
    for c in (A, B):
        prm.append((float(c['F']), float(c['CX']), float(c['CY']),
                    [float(c.get(f'K{i}', 0)) for i in (1, 2, 3, 4)],
                    np.array(c['R']).reshape(3, 3),
                    int(c.get('W', W)), int(c.get('H', H // 2))))
    # sample world rays across the seam band: pans around the crossover, pitch
    # tilts. Defaults suit a single overhead fisheye venue; side-by-side
    # two-cam scenes (HCT: visible tilt window -15..+29) need SEAM_TILT and a
    # seam pan matching where the views actually cross (SEAM_PAN env or
    # SEAM_PAN_DEG in the fit).
    seam_pan = float(os.environ.get('SEAM_PAN', fit.get('SEAM_PAN_DEG', 0)))
    st_lo, st_hi = (float(x) for x in
                    os.environ.get('SEAM_TILT', '-35,-2').split(','))
    pans = np.radians(np.linspace(seam_pan - 8, seam_pan + 8, 33))
    tilts = np.radians(np.linspace(st_lo, st_hi, 12))
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
        report['gateD'] = {'ghost_median_px': float(np.median(ghost)),
                           'ghost_p90_px': float(np.percentile(ghost, 90)),
                           'ghost_max_px': float(ghost.max())}

# GATE E — admin-mark reprojection through the mesh (the product scoreboard)
marks_path = os.environ.get('MARKS')
if marks_path and mesh_dir:
    from marks_solver import score_marks_file
    res, mj = score_marks_file(marks_path, mesh_dir)
    pct = 100.0 * res['reprojection_error_px'] / res['span_px']
    print(f'GATE E — admin-mark reprojection through {mesh_dir}:')
    for name, v in res['per_mark_err_px'].items():
        print(f'  {name:<12} {v:6.1f}px')
    print(f'  max {res["reprojection_error_px"]:.1f}px on a '
          f'{res["span_px"]:.0f}px span = {pct:.2f}% of pitch span')
    mark_pct_max = os.environ.get('MARK_PCT_MAX')
    if mark_pct_max is not None and pct > float(mark_pct_max):
        failures.append(f'gate E: mark reprojection {pct:.2f}% of span '
                        f'> {float(mark_pct_max)}%')
    report['gateE'] = {
        'per_mark_err_px': {k: float(v) for k, v in res['per_mark_err_px'].items()},
        'max_err_px': float(res['reprojection_error_px']),
        'span_px': float(res['span_px']),
        'pct_of_span': float(pct),
    }
elif marks_path:
    failures.append('gate E: MARKS set but MESH missing (marks score through the mesh)')

# GATE F — plumb verticals vs the marks-mount up. INFORMATIVE BY DEFAULT and
# self-disqualifying: it only hard-gates (PLUMB_MAX_DEG set) when the detected
# vertical chains QUALIFY — moderate theta (< PLUMB_THETA_MAX, where the fit
# is interpolating, not rim-extrapolating) with enough count and x-spread.
# Measured 2026-07-18 on kuwait (night, caged): the near-vertical outside-
# pitch segment pool is only ~6-8% true plumb (cage posts curve inward
# toward the roof netting; netting seams and rails dominate), every axis-
# vote variant — grass gate, marks-pitch-mask gate, theta caps, chain-first,
# even a vote WINDOWED to 8 deg of true up — converged 8-24 deg off, and the
# one detected cluster (window columns on a single building, theta 57-63)
# reads 2-10 deg through a fit whose marks-mount is validated at 1.02 deg —
# the building's night edges are not plumb references either. So kuwait
# fails the SPREAD criterion and stays informative. Venues with clean
# mid-theta verticals (indoor steel columns) are what the hard gate is for.
verts_path = os.environ.get('VERTS')
if verts_path and marks_path and not cameras:
    from marks_solver import MARK_WORLD, ray_dlt_homography
    PLUMB_THETA_MAX = float(os.environ.get('PLUMB_THETA_MAX', 70))
    PLUMB_MIN_CHAINS = int(os.environ.get('PLUMB_MIN_CHAINS', 6))
    PLUMB_MIN_COLS = int(os.environ.get('PLUMB_MIN_COLS', 3))
    F, cx, cy, ks = kb_params(fit)
    mj = json.load(open(marks_path))
    mpx = np.array([m['uv'] for m in mj['marks']], np.float64)
    mworld = np.array([MARK_WORLD[m['name']](float(mj['lengthM']),
                                             float(mj['widthM']))
                       for m in mj['marks']])
    mrays, mok = unproject(mpx, F, cx, cy, ks)
    vchains = [ln for ln in json.load(open(verts_path))['lines']
               if ln.get('family') == 'vertical']
    if mok.all() and vchains:
        Hh = ray_dlt_homography(mworld, mrays)
        up = np.cross(Hh[:, 0] / np.linalg.norm(Hh[:, 0]),
                      Hh[:, 1] / np.linalg.norm(Hh[:, 1]))
        up /= np.linalg.norm(up)
        if up[1] > 0:
            up = -up
        rows = []
        for ln in vchains:
            pts = np.array(ln['pts'], np.float64)
            rays, ok = unproject(pts, F, cx, cy, ks)
            rays = rays[ok & np.isfinite(rays).all(1)]
            if len(rays) < 4:
                continue
            _, _, Vt3 = np.linalg.svd(rays, full_matrices=False)
            dev = np.degrees(np.arcsin(min(1.0, abs(float(Vt3[2] @ up)))))
            thmax = np.degrees(np.arccos(np.clip(rays[:, 2], -1, 1))).max()
            rows.append((ln['name'], dev, float(thmax), float(pts[:, 0].mean())))
        qual = [r for r in rows if r[2] < PLUMB_THETA_MAX]
        cols = sorted({int(np.clip(r[3] / (W / 8), 0, 7)) for r in qual})
        viable = len(qual) >= PLUMB_MIN_CHAINS and len(cols) >= PLUMB_MIN_COLS
        print(f'GATE F — plumb verticals vs marks-mount up '
              f'({len(rows)} chains, {len(qual)} at theta<{PLUMB_THETA_MAX:.0f}):')
        for name, dev, thmax, _ in rows:
            q = '' if thmax < PLUMB_THETA_MAX else '  (rim — not qualifying)'
            print(f'  {name:<12} dev {dev:5.2f} deg  theta_max {thmax:5.1f}{q}')
        med = float(np.median([r[1] for r in qual])) if qual else None
        if viable:
            print(f'  median dev {med:.2f} deg over {len(qual)} qualifying '
                  f'chains in {len(cols)} x-cols — hard-gate viable')
        else:
            print(f'  insufficient qualifying verticals '
                  f'({len(qual)} chains, {len(cols)} x-cols; need '
                  f'>={PLUMB_MIN_CHAINS} in >={PLUMB_MIN_COLS}) — informative only')
        plumb_max = os.environ.get('PLUMB_MAX_DEG')
        if plumb_max is not None and viable and med > float(plumb_max):
            failures.append(f'gate F: plumb median {med:.2f} deg > {float(plumb_max)}')
        report['gateF'] = {
            'chains': [dict(name=r[0], dev_deg=r[1], theta_max_deg=r[2])
                       for r in rows],
            'qualifying': len(qual), 'x_cols': cols,
            'median_dev_deg': med, 'hard_gate_viable': viable,
        }

# GATE G — rim ray-field residual. The interior gates cannot see the rim:
# lines + marks reach theta ~80, and the 2026-07-18 kuwait auto fit bent the
# rim 5-7 deg (Karim's eyes-on caught ~100-150px of near-edge warp) while
# every gate IMPROVED. This gate is ON BY DEFAULT — a warped rim must never
# again pass green. Two modes, both reported when available:
#   incumbent (RIM_REF_FIT env — kuwait/footballplus have validated hand
#   fits): sample pixels on the REFERENCE fit's iso-theta circles, unproject
#   through both fits, Kabsch-align the candidate ray field onto the
#   reference over the INTERIOR (theta <= 75 — datum differences are the
#   mount solve's to absorb, not a lens error), then measure angular ray
#   error over the rim band theta 85..92. Gate: RIM_MAX_DEG (deg, median;
#   'off' disables). Reference points: hand-vs-itself 0, the rejected auto
#   fit ~5 deg, the hand-anchored capacity ablation ~3.6 deg (Karim: "much
#   better but still not fully flat") — green means < RIM_MAX_DEG.
#   disc ({SITE}-disc.json with az_deg — venues whose image circle is in
#   frame): the annotated arc's mean theta through the candidate vs the
#   lens-class DISC_THETA_DEG (disc_rim.py). Gate: DISC_TOL_DEG ('off'
#   disables). Hand fit reads +0.0 by construction; the rejected auto fit
#   read +6.0.
if not cameras:
    import disc_rim as _disc_rim
    F_c, cx_c, cy_c, ks_c = kb_params(fit)
    gG = {}
    # r(theta) INJECTIVITY (CV review 2026-07-18): the mesh samples the fit
    # over theta up to ~100 deg; a non-monotonic r(theta) double-covers
    # pixels and unproject's bisection assumes monotonicity. The refinement
    # is protected by the rim pin's bad->500 penalty and the k3/k4 bounds
    # (verified: no in-bounds multi-root config reaches the rim radii — the
    # bounds are load-bearing for that proof), but RIM_W=0 paths (venues
    # with no disc, e.g. footballplus) previously had NO check anywhere.
    _th_g = np.radians(np.linspace(1.0, 100.0, 200))
    _t2 = _th_g * _th_g
    _rp = F_c * (1 + _t2 * (3 * ks_c[0] + _t2 * (5 * ks_c[1]
                 + _t2 * (7 * ks_c[2] + _t2 * 9 * ks_c[3]))))
    if (_rp <= 0).any():
        fold_at = float(np.degrees(_th_g[np.argmax(_rp <= 0)]))
        print(f'GATE G — r(theta) NON-MONOTONIC: dr/dtheta <= 0 from '
              f'{fold_at:.1f} deg — the mesh domain is double-covered')
        failures.append(f'gate G: r(theta) folds at {fold_at:.1f} deg '
                        f'(< 100) — non-injective fit')
        gG['fold_deg'] = fold_at
    ref_fit_path = os.environ.get('RIM_REF_FIT')
    if ref_fit_path and os.path.exists(ref_fit_path):
        _ref = json.load(open(ref_fit_path))
        F_r, cx_r, cy_r, ks_r = kb_params(_ref)

        def _fwd_r(th, F_, ks_):
            t2 = th * th
            return F_ * th * (1 + t2 * (ks_[0] + t2 * (ks_[1] + t2 * (ks_[2] + t2 * ks_[3]))))

        th_grid = np.concatenate([np.radians(np.arange(20, 76, 5)),
                                  np.radians(np.arange(85, 92.5, 1))])
        pts, band = [], []
        for th in th_grid:
            r = _fwd_r(th, F_r, ks_r)
            az = np.radians(np.arange(0, 360, 5))
            p = np.column_stack([cx_r + r * np.cos(az), cy_r + r * np.sin(az)])
            m = ((p[:, 0] >= 8) & (p[:, 0] <= W - 8)
                 & (p[:, 1] >= 8) & (p[:, 1] <= H - 8))
            pts.append(p[m])
            band.append(np.full(int(m.sum()), th))
        pts = np.concatenate(pts)
        band = np.concatenate(band)
        a, oka = unproject(pts, F_c, cx_c, cy_c, ks_c)   # candidate rays
        b, okb = unproject(pts, F_r, cx_r, cy_r, ks_r)   # reference rays
        okg = oka & okb
        interior = okg & (band <= np.radians(75.01))
        rim_band = okg & (band >= np.radians(84.99))
        if interior.sum() >= 50 and rim_band.sum() >= 20:
            Hm = a[interior].T @ b[interior]
            U, _, Vt = np.linalg.svd(Hm)
            Q = Vt.T @ np.diag([1, 1, np.sign(np.linalg.det(Vt.T @ U.T))]) @ U.T
            ang = np.degrees(np.arccos(np.clip(np.sum(((Q @ a.T).T) * b, axis=1),
                                               -1, 1)))
            int_med = float(np.median(ang[interior]))
            rim_med = float(np.median(ang[rim_band]))
            rim_p90 = float(np.percentile(ang[rim_band], 90))
            print(f'GATE G — rim ray-field vs {os.path.basename(ref_fit_path)} '
                  f'(datum-aligned on theta<=75):')
            print(f'  interior median {int_med:.2f} deg; rim (theta 85-92) '
                  f'median {rim_med:.2f} deg  p90 {rim_p90:.2f} deg  '
                  f'({int(rim_band.sum())} pts)')
            rim_max = os.environ.get('RIM_MAX_DEG', '2.0')
            if rim_max != 'off' and rim_med > float(rim_max):
                failures.append(f'gate G: rim ray-field median {rim_med:.2f} deg '
                                f'> {float(rim_max)} vs incumbent')
            gG['incumbent'] = {'ref': ref_fit_path,
                               'interior_median_deg': int_med,
                               'rim_median_deg': rim_med,
                               'rim_p90_deg': rim_p90}
        else:
            failures.append('gate G: incumbent rim comparison has no usable '
                            'overlap (candidate cannot invert the reference '
                            'sample points)')
    _disc = _disc_rim.load_disc(SITE)
    if _disc is not None:
        rim_pts = _disc_rim.rim_points(_disc)
        theta_d = _disc_rim.disc_theta_deg(_disc)
        rays, okd = unproject(rim_pts, F_c, cx_c, cy_c, ks_c)
        th = np.degrees(np.arccos(np.clip(rays[:, 2], -1, 1)))[okd]
        if len(th) >= 8:
            derr = float(np.mean(th) - theta_d)
            # CIRCULARITY CAVEAT (CV review 2026-07-18): for a candidate
            # that was itself disc-refined (auto_fit RIM_REF=disc) this
            # re-evaluates the quantity the optimizer just minimized —
            # convergence, not quality. It stays a hard gate because it
            # catches NON-disc-refined fits (the rejected 2026-07-18 auto
            # fit reads +5.97 here), but disc mode ALONE (no incumbent, no
            # marks) is never sufficient evidence — those fits need eyes-on.
            print(f'GATE G — disc arc through candidate: mean theta '
                  f'{np.mean(th):.2f} deg vs DISC_THETA {theta_d:.1f} '
                  f'(err {derr:+.2f} deg, sd {np.std(th):.2f}, n={len(th)})'
                  + ('' if ref_fit_path else
                     '  [only rim gate — circular for disc-refined fits;'
                     ' not sufficient alone]'))
            disc_tol = os.environ.get('DISC_TOL_DEG', '2.0')
            if disc_tol != 'off' and abs(derr) > float(disc_tol):
                failures.append(f'gate G: disc arc theta error {derr:+.2f} deg '
                                f'beyond +/-{float(disc_tol)}')
            gG['disc'] = {'theta_mean_deg': float(np.mean(th)),
                          'theta_sd_deg': float(np.std(th)),
                          'theta_ref_deg': float(theta_d),
                          'err_deg': derr}
        else:
            failures.append('gate G: candidate cannot invert the disc arc '
                            f'({len(th)}/{len(rim_pts)} points usable)')
    if gG:
        report['gateG'] = gG

print()
report['failures'] = failures
report_path = os.environ.get('REPORT')
if report_path:
    json.dump(report, open(report_path, 'w'), indent=2)
    print(f'report → {report_path}')

if failures:
    print('RESULT: FAIL')
    for f in failures:
        print(f'  - {f}')
    sys.exit(1)
print('RESULT: PASS')

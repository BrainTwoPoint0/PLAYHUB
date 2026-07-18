#!/usr/bin/env python3
"""Auto-fit orchestrator: median still + auto lines (+ admin marks) → fit →
mesh → benchmark, with zero hand annotation.

Pipeline (writes {SITE}-auto-fit.json + /tmp/vp-mesh-{SITE}-auto, never
touches the hand fit):
  1. auto_annotate.py output ({SITE}-auto-lines.json) feeds calibrate.py
     SOLVE=full via MANUAL_LINES → intrinsics F/CX/CY/K1..K4.
  2. MOUNT:
     marks      — admin marks ({SITE}-marks.json) unprojected through the new
                  intrinsics → calibrated pitch→ray homography → decompose:
                  columns r1 (pitch +x) and r2 (pitch +y) span the ground
                  plane, up = ±r1×r2. Validated 2026-07-18 on kuwait: 1.02°
                  from the shipped mount, pitch +x horizontal to 0.6°. The
                  mount R maps world→camera with pitch length along pan ±90°
                  (x_world) and up = −y_world — the venue convention.
     prior-mesh — solve_mount.py MODE=prior-mesh (existing approved venues).
     keep       — copy TILT/YAW/ROLL from the hand fit (ablation only).
  3. generate_mesh.py with the new fit (window params inherited from the hand
     fit when present — PAN_DEG/TILT_HI are scene-window truth, not solve
     outputs).
  4. gates.py with the HAND lines (scoring stays independent of the auto
     detector) + marks + the new mesh → report json for baseline comparison.

Env: SITE (venue prefix, e.g. kuwait), MOUNT (marks|prior-mesh|keep),
     SRC (still, default {SITE}-fisheye.jpg), SKIP_ANNOTATE=1 (reuse the
     existing auto-lines json), PRIOR_MESH (for MOUNT=prior-mesh).
Run from the workspace root (calibrate.py writes repo-relative paths).
"""
import json
import os
import subprocess
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
SITE = os.environ.get('SITE', 'kuwait')
AUTO = f'{SITE}-auto'
MOUNT = os.environ.get('MOUNT', 'marks')
SRC = os.environ.get('SRC', os.path.join(HERE, f'{SITE}-fisheye.jpg'))


def run(cmd, env=None, cwd=ROOT):
    e = dict(os.environ)
    e.update(env or {})
    print(f'>> {" ".join(cmd)} {" ".join(f"{k}={v}" for k, v in (env or {}).items())}')
    r = subprocess.run(cmd, env=e, cwd=cwd)
    if r.returncode != 0:
        sys.exit(f'step failed: {cmd}')


# 1. auto-annotate (unless reusing)
if os.environ.get('SKIP_ANNOTATE') != '1':
    run([sys.executable, os.path.join(HERE, 'auto_annotate.py')],
        {'SITE': SITE, 'SRC': SRC})

# 2. intrinsics — calibrate.py SOLVE=full on the auto lines under the AUTO
# prefix. Disc anchor: reuse the venue's disc json when it exists (the auto
# disc detector inside calibrate.py is the fallback for new venues).
disc_src = os.path.join(HERE, f'{SITE}-disc.json')
disc_dst = os.path.join(HERE, f'{AUTO}-disc.json')
if os.path.exists(disc_src):
    json.dump(json.load(open(disc_src)), open(disc_dst, 'w'))
run([sys.executable, os.path.join(HERE, 'calibrate.py')],
    {'SITE': AUTO, 'SRC': SRC, 'SOLVE': 'full',
     'MANUAL_LINES': os.path.join(HERE, f'{SITE}-auto-lines.json')})

fit_path = os.path.join(HERE, f'{AUTO}-fit.json')
fit = json.load(open(fit_path))
hand = {}
try:
    hand = json.load(open(os.path.join(HERE, f'{SITE}-fit.json')))
except Exception:
    pass


# 2b. JOINT REFINEMENT — lines + admin marks over [CX, CY, k1..k4], F kept at
# the SOLVE=full anchor. The auto line set alone under-constrains the k-curve
# where it has no coverage (kuwait round 1: midline_s 109.7px — the bottom rim
# had thin line coverage); the 6 marks are precise human clicks with metric
# ground truth, and the DLT-in-the-loop keeps their residual mount-invariant.
def refine_with_marks(fit):
    from scipy.optimize import least_squares
    from fisheye_model import unproject
    from marks_solver import MARK_WORLD, ray_dlt_homography

    marks_p = os.path.join(HERE, f'{SITE}-marks.json')
    have_marks = os.path.exists(marks_p)
    if have_marks:
        mj = json.load(open(marks_p))
        mpx = np.array([m['uv'] for m in mj['marks']], np.float64)
        mworld = np.array([MARK_WORLD[m['name']](float(mj['lengthM']),
                                                 float(mj['widthM']))
                           for m in mj['marks']])
    # REFINE_LINES: optional richer line set for the refinement ONLY. The
    # free SOLVE=full is basin-fragile on short noisy rim lines (measured
    # 2026-07-18: adding the 6 HAND box lines flipped it to a mirrored
    # mount, CY +127px, k collapse) — extra short lines belong here, where
    # bounds + x_scale + elementwise soft-L1 keep the step safe.
    lines_path = os.environ.get('REFINE_LINES',
                                os.path.join(HERE, f'{SITE}-auto-lines.json'))
    lines = [np.array(ln['pts'], np.float64) for ln in
             json.load(open(lines_path))['lines']]
    F0 = float(fit['F'])
    FREE_F = os.environ.get('REFINE_F') == '1'
    x0 = np.array([fit['CX'], fit['CY']]
                  + [float(fit.get(f'K{i}', 0)) for i in (1, 2, 3, 4)]
                  + ([F0] if FREE_F else []))
    MARK_W = float(os.environ.get('MARK_W', 20.0))

    def mark_resid(cx, cy, ks, F):
        if not have_marks:
            return np.zeros(0)
        rays, ok = unproject(mpx, F, cx, cy, ks)
        if not ok.all():
            return np.full(len(mpx), 500.0)
        Hh = ray_dlt_homography(mworld, rays)
        pred = (Hh @ np.column_stack([mworld, np.ones(len(mworld))]).T).T
        pn = np.linalg.norm(pred, axis=1)
        dots = np.abs(np.sum(pred * rays, axis=1)) / np.maximum(pn, 1e-12)
        return 1000.0 * np.arccos(np.clip(dots, -1, 1))  # mrad

    def line_resid(cx, cy, ks, F):
        out = []
        for pts in lines:
            rays, ok = unproject(pts, F, cx, cy, ks)
            r = np.full(len(pts), 500.0)
            fin = ok & np.isfinite(rays).all(1)
            if fin.sum() >= 3:
                rf = rays[fin]
                _, _, Vt = np.linalg.svd(rf, full_matrices=False)
                r[np.nonzero(fin)[0]] = 1000.0 * (rf @ Vt[2])
            out.append(r)
        return np.concatenate(out)

    # RIM ANCHOR. Karim's eyes-on (2026-07-18) caught what the interior-only
    # gates cannot: lines+marks constrain theta only to ~80 deg; beyond that
    # the k-polynomial extrapolates arbitrarily, and the free refinement bent
    # the rim 5-7 deg vs the validated hand fit (~100-150px of near-edge warp
    # at product framing) while every gate IMPROVED. References:
    #   disc  — DEFAULT when {SITE}-disc.json has a trusted arc (az_deg): the
    #           annotated image-circle arc as a constant-theta RAY-FIELD
    #           constraint (disc_rim.py — each arc pixel must unproject to
    #           DISC_THETA_DEG off the axis). Acts on CX/CY as well as the
    #           curve: a radial-only pin left a 3.6 deg rim residual because
    #           the fits disagreed on CX by 143px. Needs no hand fit.
    #   seed  — the solve's minimum-|k| curve, radial-only. WRONG reference
    #           (the validated hand rim is +172px past equidistant at theta
    #           90, +715px at 100 — this lens's rim is strongly stretched),
    #           and pinning to it contorted the optimizer into a MIRRORED
    #           mount that the mark-residual sanity check cannot see (marks
    #           fit fine on an upside-down decomposition). Ablation only.
    #   hand  — the venue's hand-fit curve, radial-only. Circular for a new
    #           venue; kept as a capacity ABLATION (can the polynomial hold
    #           the interior AND a hand-like rim?): RIM_REF=hand RIM_W=10.
    import disc_rim as _disc_rim
    _disc = _disc_rim.load_disc(SITE, HERE)
    RIM_REF = os.environ.get('RIM_REF', 'disc' if _disc is not None else 'seed')
    # RIM_W=1.5 from the 2026-07-18 kuwait ablation (RIM_SMOOTH_W=3): the
    # only weight beating the frozen baseline on ALL interior metrics (bow
    # 2.09 vs 2.14, wmed 5.9 vs 6.00, marks 0.44% vs 1.02) while holding the
    # arc at +0.99 deg. W=1 under-enforces (arc +4.4 deg, mount aborts);
    # W>=2 regresses the long-chord bow past baseline (2.25-2.33).
    RIM_W = float(os.environ.get('RIM_W',
                                 1.5 if (RIM_REF == 'disc' and _disc is not None)
                                 else 0.0))
    if RIM_W > 0 and RIM_REF == 'disc':
        if _disc is None:
            sys.exit('RIM_REF=disc but no usable disc annotation '
                     f'({SITE}-disc.json with az_deg)')
        rim_pts = _disc_rim.rim_points(_disc)
        rim_theta = _disc_rim.disc_theta_deg(_disc)
        print(f'rim anchor: {len(rim_pts)} disc-arc pts pinned to theta='
              f'{rim_theta:.1f} deg as a ray-field constraint (RIM_W={RIM_W:g})')

        def rim_resid(cx, cy, ks, F):
            return _disc_rim.rim_theta_mrad(rim_pts, F, cx, cy, list(ks),
                                            rim_theta)
    elif RIM_W > 0:
        if RIM_REF == 'hand':
            _ref = json.load(open(os.path.join(HERE, f'{SITE}-fit.json')))
            ref_F = float(_ref['F'])
            ref_ks = [float(_ref.get(f'K{i}', 0)) for i in (1, 2, 3, 4)]
        else:
            ref_F = F0
            ref_ks = [float(fit.get(f'K{i}', 0)) for i in (1, 2, 3, 4)]

        def _fwd_r(th, F, ks):
            t2 = th * th
            return F * th * (1 + t2 * (ks[0] + t2 * (ks[1] + t2 * (ks[2] + t2 * ks[3]))))

        rim_th = np.radians(np.linspace(float(os.environ.get('RIM_LO', 80)),
                                        100.0, 16))
        rim_r = _fwd_r(rim_th, ref_F, ref_ks)
        print(f'rim anchor: pinning {len(rim_r)} radii over theta '
              f'{np.degrees(rim_th[0]):.0f}..100 to the {RIM_REF} curve '
              f'(RIM_W={RIM_W:g})')

        def rim_resid(cx, cy, ks, F):
            px_r = np.column_stack([cx + rim_r, np.full(len(rim_r), cy)])
            d, ok = unproject(px_r, F, cx, cy, ks)
            th = np.arccos(np.clip(d[:, 2], -1, 1))
            th[~ok] = np.pi
            return 1000.0 * (th - rim_th)  # mrad off the anchored curve
    else:
        def rim_resid(cx, cy, ks, F):
            return np.zeros(0)

    # RIM SMOOTHNESS — the single-contour disc pin fixes r(theta_disc) but
    # not the SLOPE: measured 2026-07-18, the pin alone let k4 whip the curve
    # between the interior (theta<=80) and the pin — the arc read 0.26 deg
    # while pixels just inside it read 6.6 deg vs the hand fit. Penalizing
    # the second difference of r(theta) over the extrapolation zone damps
    # the whip. CAVEATS (CV review): this is NOT anti-fold protection (a
    # folding curve has LOWER smoothness cost than the genuine stretched
    # rim — the fold-killer is the rim pin's bad->penalty path plus the k
    # bounds); the term is in px at this venue's F while everything else is
    # angular, so re-tune per lens class at fanout; and it directionally
    # penalizes the genuine rim acceleration MORE than equidistant
    # extrapolation — do not raise W as "more insurance" (the 1/3/10/30
    # sweep shows degradation onset by 10).
    # REG-SIFT dense ray-field term (Spiideo venues, {SITE}-regsift.npz —
    # see regsift_rim.py): their Play render registered against our raw
    # panorama, per-frame DLT-in-the-loop like the marks. Covers the rim
    # azimuths the disc arc cannot see (kuwait right, footballplus
    # everywhere). Opt-in (REG_W env) until the weight is ablated against
    # the frozen baselines, same road the disc source took.
    import regsift_rim as _regsift
    _reg = _regsift.load_regsift(SITE, HERE)
    REG_W = float(os.environ.get('REG_W', 0.0))
    if REG_W > 0 and _reg is None:
        sys.exit(f'REG_W>0 but no usable {SITE}-regsift.npz')
    if REG_W > 0:
        n_reg = sum(len(f['play']) for f in _reg)
        print(f'regsift anchor: {len(_reg)} render frames / {n_reg} '
              f'correspondences as ray-field constraints (REG_W={REG_W:g})')

    RIM_SMOOTH_W = float(os.environ.get('RIM_SMOOTH_W',
                                        3.0 if RIM_W > 0 else 0.0))
    _smooth_th = np.radians(np.arange(76.0, 93.1, 2.0))

    def rim_smooth(ks, F):
        t2 = _smooth_th * _smooth_th
        r = F * _smooth_th * (1 + t2 * (ks[0] + t2 * (ks[1] + t2 * (ks[2]
                                                     + t2 * ks[3]))))
        return np.diff(r, 2)  # px per (2 deg)^2 step

    # MARKS-LESS MODE — venues with a disc annotation but no admin marks yet
    # (the no-marks path used to skip refinement entirely, which is how the
    # footballplus auto rim shipped as the solve's raw minimum-|k|
    # extrapolation): refine on lines + rim only. The mark-sanity abort is
    # unavailable; GATE G and the mount stage are the backstops.
    if not have_marks and RIM_W <= 0 and REG_W <= 0:
        print('no marks json and no rim/regsift reference — skipping joint '
              'refinement')
        return fit
    if not have_marks:
        print('no marks json — refining on lines + rim/regsift only '
              '(marks-less mode)')

    def soft_l1_elem(r, delta):
        """Elementwise soft-L1 residual transform (robustness for the LINE
        residuals only — auto lines carry junk). Marks stay linear: they are
        6 trustworthy human clicks, and a global robust loss saturated on
        their large initial residuals and killed the gradient (observed:
        refinement froze at the seed with midline_s at 78 mrad)."""
        return np.sign(r) * np.sqrt(2 * delta *
                                    (np.sqrt(1 + (r / delta) ** 2) - 1)) \
            * np.sqrt(delta)

    def resfn(x):
        cx, cy = x[0], x[1]
        ks = list(x[2:6])
        F = x[6] if FREE_F else F0
        res = [soft_l1_elem(line_resid(cx, cy, ks, F), 5.0),
               MARK_W * mark_resid(cx, cy, ks, F),
               RIM_W * rim_resid(cx, cy, ks, F),
               RIM_SMOOTH_W * rim_smooth(ks, F)]
        if REG_W > 0:
            # soft-L1 (delta ~2x the measured 4-5 mrad floor): SIFT pools
            # keep a few % of false matches after the harvest filter
            res.append(REG_W * soft_l1_elem(
                _regsift.regsift_resid_mrad(_reg, F, cx, cy, list(ks)), 10.0))
        if FREE_F:
            # soft prior: the disc anchor is right to a few %; the gauge
            # direction (F trades against the k's) needs pinning, not freedom
            res.append(np.array([50.0 * (F - F0) / (0.03 * F0)]))
        return np.concatenate(res)

    # CX/CY travel: 120 without a rim reference (the historical safe step),
    # 160 with one — the measured hand-vs-auto CX gap is 143px, real travel
    # the rim signal must be able to close (a 120 bound clips it and the fit
    # parks on the bound).
    CB = float(os.environ.get('REFINE_C_BOUND', 160 if RIM_W > 0 else 120))
    # The k3/k4 bounds are LOAD-BEARING for rim safety (CV review
    # 2026-07-18): inside this box no r(theta) has multiple roots at the rim
    # radii with the descending branch recovering by 115 deg (verified by an
    # 800k-sample search), so unproject's bisection cannot silently return a
    # wrong root — folded curves fail the bad->penalty path instead. Widening
    # any k bound voids that proof; re-run the search before doing so.
    lo = [x0[0] - CB, x0[1] - CB, -0.3, -0.15, -0.08, -0.04] \
        + ([0.90 * F0] if FREE_F else [])
    hi = [x0[0] + CB, x0[1] + CB, 0.3, 0.15, 0.08, 0.04] \
        + ([1.10 * F0] if FREE_F else [])
    # x_scale is load-bearing: CX/CY live at ~2000px, k's at ~0.01 — the
    # default x_scale=1 makes the trust region collapse around the k's and
    # freezes the principal point at its seed (observed twice)
    xs = [30.0, 30.0, 0.02, 0.01, 0.005, 0.0025] + ([0.01 * F0] if FREE_F else [])
    sol = least_squares(resfn, np.clip(x0, lo, hi), bounds=(lo, hi),
                        x_scale=xs)
    cx, cy = sol.x[0], sol.x[1]
    ks = sol.x[2:6]
    Fs = sol.x[6] if FREE_F else F0
    mfin = mark_resid(cx, cy, list(ks), Fs)
    print(f'refine: CX {fit["CX"]:.1f}→{cx:.1f}  CY {fit["CY"]:.1f}→{cy:.1f}  '
          f'F {F0:.1f}→{Fs:.1f}  '
          f'k=({ks[0]:.5f},{ks[1]:.5f},{ks[2]:.5f},{ks[3]:.5f})  '
          f'mark residual mrad {np.round(mfin, 2).tolist()}')
    if RIM_W > 0:
        rfin = rim_resid(cx, cy, list(ks), Fs)
        print(f'refine: rim residual mrad median {np.median(rfin):+.1f} '
              f'({np.degrees(np.median(rfin) / 1000):+.2f} deg)  '
              f'max |{np.max(np.abs(rfin)):.1f}|')
    # BASIN SANITY — fail loudly here, before the mount/mesh, when the solve
    # landed somewhere the bounded refinement cannot recover from. Measured
    # 2026-07-18: a wrong-CY solve basin (CY +120px off) leaves the marks at
    # ~200 mrad after refinement vs <=17 mrad from the good basin — an order
    # of magnitude of separation; downstream it becomes a mirrored mount and
    # a half-empty mesh that only the final gates catch. Threshold 50 = 3x
    # the observed good max, 4x under the observed bad. (Marks-less mode has
    # no marks to check — GATE G is the backstop there.)
    sanity = float(os.environ.get('MARK_SANITY_MRAD', 50))
    if have_marks and np.max(mfin) > sanity:
        sys.exit(f'refine: max mark residual {np.max(mfin):.1f} mrad > '
                 f'{sanity} — SOLVE=full likely converged to a wrong CX/CY '
                 f'basin (see benchmarks/README.md, basin-fragility note). '
                 f'Inspect the line set fed to the solve before retrying.')
    fit.update(CX=float(cx), CY=float(cy), F=float(Fs),
               K1=float(ks[0]), K2=float(ks[1]),
               K3=float(ks[2]), K4=float(ks[3]),
               refined='%s joint (%s%s%s%s)'
                       % ('lines+marks' if have_marks else 'lines+rim',
                          'MARK_W=%.0f' % MARK_W if have_marks else 'no marks',
                          ', free F' if FREE_F else '',
                          ', rim=%s W=%g' % (RIM_REF, RIM_W) if RIM_W > 0
                          else '',
                          ', regsift W=%g' % REG_W if REG_W > 0 else ''))
    json.dump(fit, open(fit_path, 'w'), indent=1)
    return fit


if os.environ.get('SKIP_REFINE') != '1':
    fit = refine_with_marks(fit)

# 3. mount
if MOUNT == 'marks':
    from fisheye_model import euler_from_mount_R, unproject
    from marks_solver import MARK_WORLD, ray_dlt_homography

    if not os.path.exists(os.path.join(HERE, f'{SITE}-marks.json')):
        sys.exit(f'MOUNT=marks but no {SITE}-marks.json — marks-less venue: '
                 f'set MOUNT=prior-mesh or MOUNT=keep')
    mj = json.load(open(os.path.join(HERE, f'{SITE}-marks.json')))
    px = np.array([m['uv'] for m in mj['marks']], np.float64)
    world = np.array([MARK_WORLD[m['name']](float(mj['lengthM']),
                                            float(mj['widthM']))
                      for m in mj['marks']])
    ks = [float(fit.get(f'K{i}', 0)) for i in (1, 2, 3, 4)]
    rays, ok = unproject(px, float(fit['F']), float(fit['CX']),
                         float(fit['CY']), ks)
    if not ok.all():
        sys.exit('mark(s) outside the invertible theta range of the new fit')

    Hh = ray_dlt_homography(world, rays)
    # H-SIGN DISAMBIGUATION (found on footballplus 2026-07-18): the DLT's H
    # is defined up to +/- sign, and with the wrong sign the pitch sits
    # BEHIND the camera — the decomposition then reads as a mirrored mount
    # (TILT 135/ROLL -179) even though the marks fit at ~1 mrad. The
    # physical constraint: t = H[:,2] is the ray to the pitch origin, which
    # must be in the forward hemisphere (t_z > 0). kuwait's H happened to
    # come out positive, which is why this never fired before.
    if Hh[2, 2] < 0:
        Hh = -Hh
    Hh /= np.sqrt(np.linalg.norm(Hh[:, 0]) * np.linalg.norm(Hh[:, 1]))
    r1 = Hh[:, 0] / np.linalg.norm(Hh[:, 0])
    r2 = Hh[:, 1] / np.linalg.norm(Hh[:, 1])
    up = np.cross(r1, r2)
    up /= np.linalg.norm(up)
    if up[1] > 0:  # ground normal must be camera-up-ish (negative y)
        up = -up
        r2 = -r2  # keep the frame right-handed with the flipped normal
    # world→camera columns: x_world = pitch length → r1; y_world = −up;
    # z_world = x × y. SVD-project to the nearest rotation (r1, r2 carry the
    # homography's small non-orthogonality).
    R0 = np.column_stack([r1, -up, np.cross(r1, -up)])
    U, _, Vt2 = np.linalg.svd(R0)
    Rm = U @ np.diag([1, 1, np.sign(np.linalg.det(U @ Vt2))]) @ Vt2
    t, y, r = euler_from_mount_R(Rm)
    print(f'mount from marks: TILT={t:.3f} YAW={y:.3f} ROLL={r:.3f}')
    # MIRROR SANITY — the mark-residual basin check cannot see this failure:
    # a contorted fit can reproject all marks at <15 mrad while the homography
    # decomposes to an upside-down ground plane (observed 2026-07-18:
    # TILT 140/ROLL 176, mesh coverage 61%). A physical down-tilted mount
    # lives well inside (5, 85) tilt with |roll| < 30.
    if not (5.0 < t < 85.0 and abs(r) < 30.0):
        sys.exit(f'mount from marks is non-physical (TILT={t:.1f} ROLL={r:.1f})'
                 f' — mirrored homography decomposition, the fit is in a bad'
                 f' basin the mark-residual check cannot see. Do not trust'
                 f' this fit.')
    fit.update(TILT=round(t, 3), YAW=round(y, 3), ROLL=round(r, 3),
               mount_source='marks-homography')
    json.dump(fit, open(fit_path, 'w'), indent=1)
elif MOUNT == 'prior-mesh':
    run([sys.executable, os.path.join(HERE, 'solve_mount.py')],
        {'SITE': AUTO, 'PRIOR_MESH': os.environ['PRIOR_MESH'],
         'MODE': 'prior-mesh'})
    fit = json.load(open(fit_path))
elif MOUNT == 'keep':
    for k in ('TILT', 'YAW', 'ROLL'):
        if k in hand:
            fit[k] = hand[k]
    fit['mount_source'] = 'hand-fit (ablation)'
    json.dump(fit, open(fit_path, 'w'), indent=1)

# 4. mesh — window params are scene truth, inherit from the hand fit
mesh_out = f'/tmp/vp-mesh-{AUTO}'
mesh_env = {'SITE': AUTO, 'OUT': mesh_out}
for k in ('PAN_DEG', 'TILT_HI', 'TILT_LO', 'W', 'H'):
    if k in hand:
        mesh_env[k] = str(hand[k])
run([sys.executable, os.path.join(HERE, 'generate_mesh.py')], mesh_env)

# 5. benchmark — hand lines + marks through the NEW fit/mesh
gate_env = {'SITE': SITE, 'FIT': fit_path, 'MESH': mesh_out,
            'REPORT': os.path.join(HERE, 'benchmarks', f'{AUTO}-report.json')}
hand_lines = os.path.join(HERE, f'{SITE}-lines.json')
if os.path.exists(hand_lines):
    gate_env['LINES'] = hand_lines
marks_path = os.path.join(HERE, f'{SITE}-marks.json')
if os.path.exists(marks_path):
    gate_env['MARKS'] = marks_path
    # gate F (plumb verticals, informative) reads the AUTO lines' vert_ chains
    gate_env['VERTS'] = os.path.join(HERE, f'{SITE}-auto-lines.json')
# gate G incumbent mode: score the candidate's rim ray field against the
# venue's ACCEPTED fit — the eyes-on-validated baseline (kuwait: the
# disc-constrained auto fit, accepted 2026-07-18) — falling back to the
# hand fit. Scoring may use validated references; the FIT never does (same
# rule as scoring with the hand lines above).
accepted_fit_path = os.path.join(HERE, 'benchmarks', 'baselines',
                                 f'{SITE}-accepted-fit.json')
hand_fit_path = os.path.join(HERE, f'{SITE}-fit.json')
if os.path.exists(accepted_fit_path):
    gate_env['RIM_REF_FIT'] = accepted_fit_path
elif os.path.exists(hand_fit_path):
    gate_env['RIM_REF_FIT'] = hand_fit_path
run([sys.executable, os.path.join(HERE, 'gates.py')], gate_env)

base_path = os.path.join(HERE, 'benchmarks', 'baselines', f'{SITE}.json')
if os.path.exists(base_path):
    base = json.load(open(base_path))
    rep = json.load(open(gate_env['REPORT']))
    print('\n== auto vs frozen baseline ==')
    for key, label in [('worst_long_chord_pct', 'long-chord bow %'),
                       ('weighted_median_rms_px', 'wmed rms px')]:
        b = base.get('gateA', {}).get(key)
        a = rep.get('gateA', {}).get(key)
        if b is not None and a is not None:
            print(f'  {label:<18} baseline {b:7.2f}  auto {a:7.2f}  '
                  f'{"BETTER" if a <= b else "worse"}')
    b = base.get('gateE', {}).get('pct_of_span')
    a = rep.get('gateE', {}).get('pct_of_span')
    if b is not None and a is not None:
        print(f'  {"marks % of span":<18} baseline {b:7.2f}  auto {a:7.2f}  '
              f'{"BETTER" if a <= b else "worse"}')

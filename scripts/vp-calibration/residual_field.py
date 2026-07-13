#!/usr/bin/env python3
"""Phase B — line-driven NON-PARAMETRIC residual correction on top of the KB fit.

The parametric Kannala-Brandt fit (calibrate.py SOLVE=full) is radial-only:
one θ→r polynomial about a single principal point. Any DECENTERING / tangential
/ asymmetric lens error it structurally cannot represent shows up as a smooth
residual bow that survives the fit. This fits a smooth 2-D correction field
δ(px) — a tangent-plane angular nudge to each KB ray — from plumb-line
straightness alone (no vendor mesh; §0r proved Spiideo's carries no lens info).

Model:  r(px) = normalize( r0(px) + a·e1 + b·e2 ),  r0 = KB unproject,
        (e1,e2) an orthonormal tangent frame at r0,
        (a,b) = B(px) · C   — B a tensor B-spline basis over the norm. pixel
        plane, C the (Ku·Kv, 2) control coefficients (the only free variables;
        the parametric fit is FROZEN).

Cost = great-circle coplanarity of each line's corrected rays (the stretch-
invariant measure from calibrate.py:full_resids) + curvature regularization
+ gauge anchors (zero at the principal point; penalize the radial-breathing
family θ→atan(c·tanθ) that plumb lines cannot see — the §0k tan-scale trap).

Acceptance is EMPIRICAL and conservative: leave-one-LINE-out CV must improve
held-out straightness by ≥ KILL_FRAC over the parametric fit, else the field is
NULL (ships off) — the same discipline that (correctly) killed anti_bow.py in
§0e when the parametric fit already captured all the real distortion.

Usage:
  FIT=kuwait-fit.json LINES=kuwait-lines.json [W=3840 H=2160] \
  [KU=7 KV=5] [LAMBDA=...] python3 residual_field.py [--loo] [--save OUT.npz]
"""
import json
import os
import sys

import numpy as np
from scipy.optimize import least_squares

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fisheye_model import kb_params, unproject  # noqa: E402

FIT = os.environ.get('FIT', 'kuwait-fit.json')
LINES = os.environ.get('LINES', 'kuwait-lines.json')
W = float(os.environ.get('W', 3840))
H = float(os.environ.get('H', 2160))
KU = int(os.environ.get('KU', 7))          # control points across (pan)
KV = int(os.environ.get('KV', 5))          # control points down (tilt)
LAMBDA = float(os.environ.get('LAMBDA', 40.0))   # curvature weight (mrad-cost)
GAUGE = float(os.environ.get('GAUGE', 200.0))    # PP-zero + radial-breathing weight
KILL_FRAC = float(os.environ.get('KILL_FRAC', 0.30))
DEG = np.pi / 180


def load_lines(path):
    """Paint lines only (the 'lines' key; diagnostics_not_lines are skipped)."""
    d = json.load(open(path))
    return [{'name': l['name'], 'pts': np.array(l['pts'], float)} for l in d['lines']]


# --- B-spline tensor basis over normalized pixel plane [0,1]^2 -----------------
def _bspline_1d(t, K, degree=3):
    """Open-uniform cubic B-spline basis: (len(t), K) matrix. K >= degree+1."""
    from scipy.interpolate import BSpline
    n_knots = K + degree + 1
    inner = np.linspace(0, 1, K - degree + 1)
    knots = np.concatenate([[0] * degree, inner, [1] * degree])
    B = np.zeros((len(t), K))
    for j in range(K):
        c = np.zeros(K)
        c[j] = 1.0
        B[:, j] = BSpline(knots, c, degree, extrapolate=True)(np.clip(t, 0, 1))
    return B


def basis(px):
    """(N, KU*KV) tensor B-spline basis at pixel coords px (full-res)."""
    u = px[:, 0] / W
    v = px[:, 1] / H
    Bu = _bspline_1d(u, KU)
    Bv = _bspline_1d(v, KV)
    # tensor product, row-major (KV fastest)
    return (Bu[:, :, None] * Bv[:, None, :]).reshape(len(px), KU * KV)


def tangent_frame(r0):
    """Orthonormal (e1, e2) ⟂ r0 (N,3 each). e1 ~ horizontal-ish, stable."""
    up = np.array([0.0, 1.0, 0.0])
    e1 = np.cross(up[None, :], r0)
    n = np.linalg.norm(e1, axis=1, keepdims=True)
    bad = (n[:, 0] < 1e-6)
    e1[bad] = np.cross(np.array([1.0, 0, 0]), r0[bad])
    e1 /= np.linalg.norm(e1, axis=1, keepdims=True)
    e2 = np.cross(r0, e1)
    e2 /= np.linalg.norm(e2, axis=1, keepdims=True)
    return e1, e2


def corrected_rays(C, ctx):
    """Apply field C (KU*KV, 2) → corrected unit rays for all stacked points."""
    a = ctx['B'] @ C[:, 0]
    b = ctx['B'] @ C[:, 1]
    r = ctx['r0'] + a[:, None] * ctx['e1'] + b[:, None] * ctx['e2']
    return r / np.linalg.norm(r, axis=1, keepdims=True)


def line_plane_resids(r, ctx):
    """Great-circle plane residual per point (mrad), per line via SVD normal."""
    out = np.empty(len(r))
    for s, e in ctx['spans']:
        rl = r[s:e]
        _, _, vt = np.linalg.svd(rl - rl.mean(0) * 0, full_matrices=False)
        out[s:e] = 1000.0 * (rl @ vt[2])
    return out


def curvature_penalty(C):
    """2nd-difference of the control grid in u and v, both components."""
    G = C.reshape(KU, KV, 2)
    pen = []
    if KU >= 3:
        pen.append(np.diff(G, 2, axis=0).ravel())
    if KV >= 3:
        pen.append(np.diff(G, 2, axis=1).ravel())
    return np.concatenate(pen) if pen else np.zeros(0)


def build_ctx(lines, F, cx, cy, ks):
    pts, spans, i = [], [], 0
    for l in lines:
        r0, ok = unproject(l['pts'], F, cx, cy, ks)
        p = l['pts'][ok]
        if len(p) < 3:
            continue
        pts.append(p)
        spans.append((i, i + len(p)))
        i += len(p)
    px = np.vstack(pts)
    r0, _ = unproject(px, F, cx, cy, ks)
    r0 /= np.linalg.norm(r0, axis=1, keepdims=True)
    e1, e2 = tangent_frame(r0)
    B = basis(px)
    # gauge: basis value at the principal point (field must vanish there) +
    # the radial-breathing direction (offset ∝ radial pixel direction) which
    # plumb lines cannot constrain — penalize its projection onto the field.
    B_pp = basis(np.array([[cx, cy]]))[0]
    rad = np.stack([px[:, 0] - cx, px[:, 1] - cy], 1)
    rad /= (np.linalg.norm(rad, axis=1, keepdims=True) + 1e-9)
    return dict(px=px, r0=r0, e1=e1, e2=e2, B=B, spans=spans, B_pp=B_pp, rad=rad)


def solve(ctx):
    n = KU * KV

    def resfn(x):
        C = x.reshape(n, 2)
        r = corrected_rays(C, ctx)
        base = line_plane_resids(r, ctx)
        curv = LAMBDA * curvature_penalty(C)
        # PP anchor: field at principal point = 0 (both components)
        pp = GAUGE * np.array([ctx['B_pp'] @ C[:, 0], ctx['B_pp'] @ C[:, 1]])
        # radial-breathing anchor: mean radial component of the offset = 0
        a = ctx['B'] @ C[:, 0]
        b = ctx['B'] @ C[:, 1]
        # offset expressed back in pixel-ish tangent terms is (a,b) in (e1,e2);
        # its correlation with the pixel radial direction is the breathing mode
        breathe = GAUGE * np.array([np.mean(a), np.mean(b)])
        return np.concatenate([base, curv, pp, breathe])

    x0 = np.zeros(n * 2)
    sol = least_squares(resfn, x0, method='lm', max_nfev=4000)
    return sol.x.reshape(n, 2)


def rms_by_line(r, ctx, names):
    res = line_plane_resids(r, ctx)
    out = {}
    for (s, e), nm in zip(ctx['spans'], names):
        out[nm] = float(np.sqrt((res[s:e] ** 2).mean()))
    return out


def main():
    fit = json.load(open(FIT))
    F, cx, cy, ks = kb_params(fit)
    lines = load_lines(LINES)
    names = [l['name'] for l in lines]
    ctx = build_ctx(lines, F, cx, cy, ks)

    base = rms_by_line(ctx['r0'], ctx, names)
    C = solve(ctx)
    corr = rms_by_line(corrected_rays(C, ctx), ctx, names)
    print(f"{'line':>18} {'parametric':>11} {'+field':>9}")
    for nm in names:
        print(f"{nm:>18} {base[nm]:11.2f} {corr[nm]:9.2f}")
    b_all = np.sqrt(np.mean([v ** 2 for v in base.values()]))
    c_all = np.sqrt(np.mean([v ** 2 for v in corr.values()]))
    print(f"{'RMS(all)':>18} {b_all:11.2f} {c_all:9.2f}  train improvement {100*(1-c_all/b_all):.1f}%")

    if '--loo' in sys.argv:
        print('\nLEAVE-ONE-LINE-OUT (held-out straightness — the acceptance test):')
        held_base, held_corr = [], []
        for h in range(len(lines)):
            tr = [lines[i] for i in range(len(lines)) if i != h]
            cx2 = build_ctx(tr, F, cx, cy, ks)
            Ch = solve(cx2)
            ho = build_ctx([lines[h]], F, cx, cy, ks)
            hb = np.sqrt((line_plane_resids(ho['r0'], ho) ** 2).mean())
            hc = np.sqrt((line_plane_resids(corrected_rays(Ch, ho), ho) ** 2).mean())
            held_base.append(hb); held_corr.append(hc)
            print(f"  hold {lines[h]['name']:>16}: {hb:6.2f} → {hc:6.2f} mrad")
        mb = np.sqrt(np.mean(np.array(held_base) ** 2))
        mc = np.sqrt(np.mean(np.array(held_corr) ** 2))
        imp = 1 - mc / mb
        print(f"  held-out RMS: {mb:.2f} → {mc:.2f} mrad  ({100*imp:+.1f}%)")
        verdict = 'ACCEPT (ship field)' if imp >= KILL_FRAC else f'NULL — kill (<{KILL_FRAC:.0%}); ship OFF'
        print(f"  VERDICT: {verdict}")

    if '--save' in sys.argv:
        out = sys.argv[sys.argv.index('--save') + 1]
        # bake to a dense grid consumers can bilinear-sample
        gu, gv = np.meshgrid(np.linspace(0, 1, 129), np.linspace(0, 1, 73))
        gpx = np.column_stack([gu.ravel() * W, gv.ravel() * H])
        Bg = basis(gpx)
        da = (Bg @ C[:, 0]).reshape(73, 129)
        db = (Bg @ C[:, 1]).reshape(73, 129)
        np.savez(out, da=da.astype('f4'), db=db.astype('f4'),
                 KU=KU, KV=KV, W=W, H=H, cx=cx, cy=cy)
        print(f'saved field grid → {out}')


if __name__ == '__main__':
    main()

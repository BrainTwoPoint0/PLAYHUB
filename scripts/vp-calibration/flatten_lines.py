#!/usr/bin/env python3
"""Line-straightening DISPLACEMENT FIELD for the de-warp mesh (display-side
cosmetic; consumed by generate_mesh.py via FLATTEN env).

What/why: the rendered pitch lines bow at the near edge and corners through
EVERY lens fit (measured 2026-07-18, benchmarks/README.md §GROUND): the
per-line deviation profile is a wiggle (local turf undulation + possibly a
bottom-sector lens residual no current source can constrain), the pitch-line
paint is plan-straight (taped), and viewers read the bow as wrongness. 3D
attribution is measured OUT: quadratic ground fails held-out, quartic
overfits, and empirical per-point height inversion is ill-conditioned
because the mast stands ON the near touchline (below-mast and line-end
heights are unobservable from that line's straightness). So: straighten in
IMAGE space, by construction.

For each hand-snapped line: unproject its pixels through the venue fit, fit
the best great circle (the line's straight render), project each ray's
nearest-on-circle ray back to the raw frame -> target pixel. Displacement
sample at the TARGET position = actual - target (what the mesh sampler
should add to land on the paint). RBF-interpolate (dx, dy) over the raw
frame with zero anchors on a coarse grid away from lines, so the field
decays to nothing off-line. The mesh hook adds D(px) after projecting each
vertex ray.

HONESTY / LIMITS (keep in the record): this is COSMETIC — it makes the
painted lines render straight and smoothly carries the surrounding grass
with them. It is NOT a calibration improvement, must never feed metric code,
and content between lines is interpolation, not measurement. Overlay
consumers (spotlight dots/rings project rays directly) will land up to the
local displacement (~10-40px raw) off the warped pixels inside line bands —
acceptable for A/B staging, must be resolved before any prod swap.

Env: SITE, FIT (default accepted fit), LINES ({site}-lines.json),
EXCLUDE (comma-separated line names to skip, e.g. vertical structures),
GRID (raw-px grid step for the saved field, default 48), OFF_R (zero-anchor
exclusion radius around line samples, default 220 px), OUT.
"""
import json
import os
import sys

import numpy as np
from scipy.interpolate import Rbf, UnivariateSpline

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from fisheye_model import kb_params, project, unproject  # noqa: E402

SITE = os.environ.get('SITE', 'kuwait')
GRID = int(os.environ.get('GRID', 48))
OFF_R = float(os.environ.get("OFF_R", 350))


def load_fit():
    p = os.environ.get('FIT')
    if not p:
        cand = os.path.join(HERE, 'benchmarks', 'baselines',
                            f'{SITE}-accepted-fit.json')
        p = cand if os.path.exists(cand) else os.path.join(HERE, f'{SITE}-fit.json')
    return json.load(open(p)), p


def main():
    fit, fit_path = load_fit()
    lines_j = json.load(open(os.environ.get(
        'LINES', os.path.join(HERE, f'{SITE}-lines.json'))))
    exclude = set(filter(None, os.environ.get('EXCLUDE', '').split(',')))
    F, cx, cy, ks = kb_params(fit)
    W = int(fit.get('W', 3840))
    H = int(fit.get('H', 2160))

    targets, actuals = [], []
    print(f'fit: {os.path.relpath(fit_path, HERE)}')
    for ln in lines_j['lines']:
        if ln['name'] in exclude:
            print(f'{ln["name"]:<12} excluded')
            continue
        pts = np.array(ln['pts'], np.float64)
        rays, ok = unproject(pts, F, cx, cy, ks)
        pts, rays = pts[ok], rays[ok]
        if len(pts) < 5:
            continue
        # straight render target = best-fit great circle (normal n)
        _, _, Vt = np.linalg.svd(rays, full_matrices=False)
        n = Vt[2]
        proj = rays - np.outer(rays @ n, n)
        proj /= np.linalg.norm(proj, axis=1, keepdims=True)
        tgt = project(proj, F, cx, cy, ks)
        d = pts - tgt
        # SMOOTH the displacement along the line: the raw d carries each
        # click's snap noise (±2-3px at 50-150px spacing), which the field
        # would faithfully reproduce as visible line WOBBLE at product zoom
        # (caught by Karim's eyes-on of the first build). Spline each
        # component over arc length with a ~SNAP_TOL px tolerance so only
        # the smooth bow survives.
        c0 = tgt.mean(0)
        _, _, Vt2 = np.linalg.svd(tgt - c0, full_matrices=False)
        arc = (tgt - c0) @ Vt2[0]
        o = np.argsort(arc)
        SNAP_TOL = float(os.environ.get('SNAP_TOL', 2.5))
        if len(pts) >= 8:
            for k in (0, 1):
                sp = UnivariateSpline(arc[o], d[o, k],
                                      s=len(arc) * SNAP_TOL ** 2)
                d[o, k] = sp(arc[o])
        mag = np.hypot(d[:, 0], d[:, 1])
        print(f'{ln["name"]:<12} n={len(pts):>4}  disp px: rms {np.sqrt((mag**2).mean()):5.1f}  '
              f'max {mag.max():5.1f}')
        targets.append(tgt)
        actuals.append(tgt + d)
    T = np.vstack(targets)
    D = np.vstack(actuals) - T

    # zero anchors: coarse grid cells farther than OFF_R from any line sample
    ax = np.arange(0, W + 1, 160)
    ay = np.arange(0, H + 1, 160)
    AX, AY = np.meshgrid(ax, ay)
    A = np.column_stack([AX.ravel(), AY.ravel()])
    d2 = ((A[:, None, :] - T[None, :, :]) ** 2).sum(-1)
    far = d2.min(1) > OFF_R ** 2
    A = A[far]
    X = np.concatenate([T[:, 0], A[:, 0]])
    Y = np.concatenate([T[:, 1], A[:, 1]])
    ZX = np.concatenate([D[:, 0], np.zeros(len(A))])
    ZY = np.concatenate([D[:, 1], np.zeros(len(A))])
    # thin_plate: C1-smooth interpolation (the 'linear' kernel is piecewise
    # conical — its gradient kinks at every sample read as line bends at zoom)
    rx = Rbf(X, Y, ZX, function='thin_plate', smooth=5.0)
    ry = Rbf(X, Y, ZY, function='thin_plate', smooth=5.0)

    gx = np.arange(0, W + GRID, GRID, dtype=float)
    gy = np.arange(0, H + GRID, GRID, dtype=float)
    GX, GY = np.meshgrid(gx, gy)
    DX = rx(GX, GY)
    DY = ry(GX, GY)
    # bound the field: thin_plate extrapolates unbounded away from samples
    # (measured 61px overshoot off-line) — explicit gaussian decay with
    # distance to the nearest line sample + hard cap at the real line
    # displacement scale
    from scipy.spatial import cKDTree
    tree = cKDTree(T)
    dist, _ = tree.query(np.column_stack([GX.ravel(), GY.ravel()]))
    wmask = np.exp(-(dist ** 2) / (2 * 250.0 ** 2)).reshape(GX.shape)
    DX *= wmask
    DY *= wmask
    cap = float(np.percentile(np.hypot(D[:, 0], D[:, 1]), 99)) * 1.2
    m0 = np.hypot(DX, DY)
    scale = np.minimum(1.0, cap / np.maximum(m0, 1e-9))
    DX *= scale
    DY *= scale
    mag = np.hypot(DX, DY)
    print(f'field {DX.shape[1]}x{DX.shape[0]} step {GRID}px  '
          f'|D| p50 {np.percentile(mag, 50):.1f}  p99 {np.percentile(mag, 99):.1f}  '
          f'max {mag.max():.1f} px')
    out = os.environ.get('OUT', os.path.join(HERE, f'{SITE}-flatten.json'))
    json.dump(dict(site=SITE, mode='line-straighten-displacement',
                   frame_w=W, frame_h=H, grid_step=GRID,
                   dx=[[round(float(v), 2) for v in row] for row in DX],
                   dy=[[round(float(v), 2) for v in row] for row in DY],
                   fit=os.path.relpath(fit_path, HERE)),
              open(out, 'w'), indent=None)
    print(f'wrote {out}')


if __name__ == '__main__':
    main()

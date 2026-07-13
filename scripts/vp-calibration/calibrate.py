#!/usr/bin/env python3
"""Layer 2 — auto-fit the fisheye intrinsics from the pitch lines (plumb-line method).

Pitch lines are straight in the real world, so with the correct fisheye model
their points are collinear after undistortion. We fit the cv2.fisheye (Kannala-
Brandt) intrinsics that minimise each line's residual to a straight fit.

Design (per CV review 2026-07-05 — the earlier F+k1-only, centre-pinned fit left
the touchlines bowing asymmetrically):
  1. PRINCIPAL POINT (CX,CY) comes from the FISHEYE IMAGE CIRCLE, not the optimiser.
     CX/CY are unidentifiable from a handful of near-parallel plumb-lines on one
     frame (the shift couples with focal/distortion/rotation) — throwing them into
     least_squares fits a garbage optimum that nulls the training lines and warps
     everything else. Instead we detect the illuminated-disc boundary arc (this
     lens clips it top-left) and fit a circle → its centre IS the optical axis, and
     an off-centre axis is what makes the bow left/right asymmetric. Falls back to
     image centre if no reliable arc is found.
  2. RADIAL only, F + k1 + k2 (ceiling). k3,k4 enter as θ⁶/θ⁸ — enormous leverage
     at the 90° rim where the mask is noisiest; fitting them from ~a dozen lines
     overfits noise. Model choice (k1 vs k1+k2) is decided by LEAVE-ONE-LINE-OUT CV
     in pixels, not by training residual.
  3. ROBUST loss (soft_l1) + light L2 reg on k so one bad component (or a subtly
     world-curved one) can't dominate, and higher-order terms only move when the
     data insists. Residual reported in PIXELS (held-out RMS is the real metric).
  4. Lines are CENTRELINE-SAMPLED (bin along each component's principal axis, mean
     of the perpendicular) — the ~9px-thick CLOSE'd mask otherwise injects ±4px
     sample noise that swamps the k2 / off-centre signal.

Runs at SCALE_W px (low RAM); intrinsics scaled back to full res. Output →
kuwait-fit.json feeds generate_mesh.py (which already reads F/CX/CY/K1..K4/TILT).

SOLVE=full (2026-07-13, the halfway-bow refit): solves F + CX + CY + k1..k4
jointly, using the manual KB model (identical to generate_mesh.py's arccos
projection, valid past 90°) instead of cv2.fisheye. Needs the richer plumb-line
set from snap_lines.py (MANUAL_LINES) — a handful of near-parallel auto lines
cannot identify CX/CY, but ~10 lines spanning the frame (both touchlines,
halfway, goal lines, box edges) can. The disc centre/radius become soft PRIORS
(not hard constraints): the 8-point manual arc is itself uncertain, and the
residual ~1% bow apexing at the halfway line traced back to trusting it plus a
single k1. Model order (which k's, whether CX/CY float) is still chosen by
leave-one-line-out CV; one 3.5σ trim pass guards against snapped junk points.

Env: SRC, SCALE_W, TILT (mount tilt, framing param), MINLEN, MINELONG,
     DISC_THRESH (disc brightness cutoff), BORDER_PAD (px to exclude frame-clip
     edges from the circle fit), REG1..REG4 (k1..k4 L2 reg weights),
     SOLVE=full, SIGMA_C (CX/CY prior sigma, working px), PRIOR_F (F prior
     fractional sigma).
"""
import os, json, numpy as np, cv2
from scipy.optimize import least_squares

SITE = os.environ.get('SITE', 'kuwait')  # artifact prefix — one per venue camera
SRC = os.environ.get('SRC', f'PLAYHUB/scripts/vp-calibration/{SITE}-fisheye.jpg')
full = cv2.imread(SRC)
if full is None:
    raise SystemExit(f'could not read {SRC}')
Hf, Wf = full.shape[:2]
SCALE_W = int(os.environ.get('SCALE_W', 1280)); s = SCALE_W / Wf
img = cv2.resize(full, (SCALE_W, int(round(Hf * s))), interpolation=cv2.INTER_AREA); del full
H, W = img.shape[:2]
gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)


# ── 1. principal point from the fisheye image-circle boundary ────────────────
def fit_circle(pts):
    """Kåsa algebraic circle fit: x²+y² = a·x+b·y+c → centre (a/2,b/2), R."""
    x, y = pts[:, 0], pts[:, 1]
    A = np.stack([x, y, np.ones_like(x)], 1)
    sol, *_ = np.linalg.lstsq(A, x * x + y * y, rcond=None)
    cx, cy = sol[0] / 2, sol[1] / 2
    R = np.sqrt(max(sol[2] + cx * cx + cy * cy, 1e-9))
    resid = np.abs(np.hypot(x - cx, y - cy) - R)
    return cx, cy, R, resid


def detect_principal_point():
    """The fisheye EXTERIOR (beyond the image circle) is pure black. Detect that
    dark region's INNER boundary (the disc arc) and RANSAC a large circle to it —
    RANSAC locks onto the big smooth arc and rejects the netting / small corner
    notches as outliers. Circle centre = optical axis. Returns (cx,cy) at WORKING
    scale + confidence, or None if unreliable."""
    thr = int(os.environ.get('DISC_THRESH', 12))
    pad = int(os.environ.get('BORDER_PAD', 8))
    brt = int(os.environ.get('DISC_BRIGHT', 60))
    dark = (gray < thr).astype(np.uint8) * 255
    dark = cv2.morphologyEx(dark, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    dark = cv2.morphologyEx(dark, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    # the disc edge is only CLEAN where the black exterior meets the LIT scene;
    # boundaries inside dark night buildings (dark-vs-dark) are jagged noise.
    bright_near = cv2.dilate((gray > brt).astype(np.uint8), np.ones((21, 21), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(dark, 8)
    pts = []
    for i in range(1, n):
        if st[i, cv2.CC_STAT_AREA] < 500:
            continue
        x0, y0 = st[i, cv2.CC_STAT_LEFT], st[i, cv2.CC_STAT_TOP]
        ww, hh = st[i, cv2.CC_STAT_WIDTH], st[i, cv2.CC_STAT_HEIGHT]
        if not (x0 <= 1 or y0 <= 1 or x0 + ww >= W - 1 or y0 + hh >= H - 1):
            continue  # exterior black regions must touch a frame border
        cnts, _ = cv2.findContours((lab == i).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        for c in cnts:
            c = c.reshape(-1, 2).astype(np.float64)
            keep = ((c[:, 0] > pad) & (c[:, 0] < W - pad) & (c[:, 1] > pad) & (c[:, 1] < H - pad))
            ci = c[keep].astype(int)
            if len(ci):
                lit = bright_near[ci[:, 1], ci[:, 0]] > 0  # boundary point next to lit scene
                if lit.any():
                    pts.append(c[keep][lit])
    if not pts:
        return None
    pts = np.concatenate(pts)
    if len(pts) < 50:
        return None
    Rlo, Rhi, tol = 0.40 * W, 1.8 * W, 3.0
    rng = np.random.default_rng(0); best = None
    for _ in range(3000):
        try:
            cx, cy, R, _ = fit_circle(pts[rng.choice(len(pts), 3, replace=False)])
        except Exception:
            continue
        if not (Rlo < R < Rhi):
            continue
        inl = np.abs(np.hypot(pts[:, 0] - cx, pts[:, 1] - cy) - R) < tol
        if best is None or inl.sum() > best[0]:
            best = (int(inl.sum()), inl)
    if best is None:
        return None
    ninl, inl = best
    cx, cy, R, resid = fit_circle(pts[inl])  # refit on inliers
    rms = float(np.sqrt(np.mean(resid ** 2)))
    ok = ninl >= 80 and rms < 0.02 * R and 0.40 * W < R < 1.8 * W
    viz = img.copy()
    for (x, y) in pts.astype(int):
        cv2.circle(viz, (int(x), int(y)), 1, (0, 120, 255), -1)
    for (x, y) in pts[inl].astype(int):
        cv2.circle(viz, (int(x), int(y)), 1, (0, 255, 0), -1)
    cv2.circle(viz, (int(cx), int(cy)), 6, (0, 0, 255), -1)
    cv2.circle(viz, (int(cx), int(cy)), int(round(R)), (255, 0, 0), 1)
    cv2.imwrite(f'/tmp/{SITE}-circle.png', viz)
    return {'cx': cx, 'cy': cy, 'R': R, 'rms': rms, 'n_arc': ninl, 'ok': ok}


# prefer a MANUAL disc annotation (annotate_disc.py) — it's the robust principal
# point on dark/night frames where the auto-RANSAC below can't segment the rim.
_disc_json = os.path.join(os.path.dirname(__file__), f'{SITE}-disc.json')
manual = None
if os.path.exists(_disc_json):
    try:
        manual = json.load(open(_disc_json))
    except Exception:
        manual = None

# F_ANCHOR (working scale): when we have the disc RADIUS, the equidistant fisheye
# relation F = R / (FOV/2) = R·2/π (for a 180° lens) gives the focal directly — so
# we anchor F to it and let only k1/k2 float. This breaks the F–principal-point
# coupling that otherwise makes an off-centre fit unstable (F collapses). None →
# the no-disc fallback keeps floating F on the lens prior, exactly as before.
F_ANCHOR = None
if manual and 'cx' in manual and 'cy' in manual:
    CXw, CYw = manual['cx'] * s, manual['cy'] * s  # stored full-res → working scale
    disc = {'ok': True, 'cx': CXw, 'cy': CYw, 'R': manual.get('R', 0) * s,
            'rms': manual.get('rms', 0) * s, 'n_arc': manual.get('n_points', 0), 'manual': True}
    if manual.get('R'):
        F_ANCHOR = manual['R'] * s * 2 / np.pi
    print(f"DISC   MANUAL centre=({manual['cx']:.1f},{manual['cy']:.1f}) full-res "
          f"({manual.get('n_points','?')} pts, rms {manual.get('rms',0):.2f}px)  → "
          f"offset from centre ({manual['cx']-Wf/2:+.1f},{manual['cy']-Hf/2:+.1f})"
          + (f", F anchored to R → {F_ANCHOR/s:.0f} full-res" if F_ANCHOR else ''))
else:
    disc = detect_principal_point()
    if disc and disc['ok']:
        CXw, CYw = disc['cx'], disc['cy']
        F_ANCHOR = disc['R'] * 2 / np.pi
        print(f"DISC   AUTO centre=({CXw:.1f},{CYw:.1f})w R={disc['R']:.0f} rms={disc['rms']:.2f}px "
              f"arc={disc['n_arc']}pts  → offset ({CXw-W/2:+.1f},{CYw-H/2:+.1f})w, F anchored {F_ANCHOR/s:.0f}")
    else:
        CXw, CYw = W / 2, H / 2
        why = 'no reliable arc' if disc is None else f"arc rms {disc['rms']:.2f} / R {disc['R']:.0f} out of tolerance"
        print(f'DISC   fell back to image centre ({why}); annotate_disc.py for a manual fix. '
              f'circle viz → /tmp/{SITE}-circle.png')


# ── 2. white pitch-line mask, centreline-sampled straight components ─────────
# GREEN_SAT: saturation floor for the grass gate. Outdoor turf passes at the
# default 15; indoor arenas need ~50-70 — greenish arena lighting drags white
# walls/roof into the loose gate and the line fit locks onto junk.
GREEN_SAT = int(os.environ.get('GREEN_SAT', 15))
green = cv2.dilate(cv2.inRange(hsv, (30, GREEN_SAT, 15), (95, 255, 235)), np.ones((25, 25), np.uint8))
top = cv2.morphologyEx(gray, cv2.MORPH_TOPHAT, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))
mask = ((top > 15) & (green > 0)).astype(np.uint8) * 255
mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))

# MANUAL_LINES: snap_lines.py output (full-res pts). Bypasses the auto
# detector entirely — indoor arenas defeat it (see snap_lines.py docstring).
MANUAL_LINES = os.environ.get('MANUAL_LINES')
MINLEN = float(os.environ.get('MINLEN', 45)); MINELONG = float(os.environ.get('MINELONG', 4))
n, lab, st, _ = cv2.connectedComponentsWithStats(mask, 8)
comps, viz = [], img.copy()
if MANUAL_LINES:
    _ml = json.load(open(MANUAL_LINES))['lines']
    for _l in _ml:
        _pts = np.array(_l['pts'], dtype=np.float64) * s  # full-res -> working scale
        comps.append({'pts': _pts, 'length': float(np.hypot(*(_pts[-1] - _pts[0])))})
        for (_x, _y) in _pts.astype(int):
            cv2.circle(viz, (int(_x), int(_y)), 3, (0, 0, 255), -1)
    n = 1  # skip the auto loop below

for i in range(1, n):
    if st[i, cv2.CC_STAT_AREA] < 40:
        continue
    ys, xs = np.where(lab == i); p = np.stack([xs, ys], 1).astype(np.float64); c = p.mean(0)
    _, _, vt = np.linalg.svd(p - c); proj = (p - c) @ vt[0]; perp = (p - c) @ vt[1]
    length, width = proj.max() - proj.min(), max(perp.max() - perp.min(), 1e-6)
    if length <= MINLEN or length / width <= MINELONG:
        continue
    # centreline-sample: bin along the principal axis, take the mean perp offset
    nb = max(8, int(length / 6))
    edges = np.linspace(proj.min(), proj.max(), nb + 1)
    idx = np.clip(np.digitize(proj, edges) - 1, 0, nb - 1)
    centre = []
    for b in range(nb):
        m = idx == b
        if m.sum() >= 2:
            centre.append(c + np.median(proj[m]) * vt[0] + np.median(perp[m]) * vt[1])
    if len(centre) < 6:
        continue
    cl = np.array(centre)
    comps.append({'pts': cl, 'length': float(length)})
    for (x, y) in cl.astype(int):
        cv2.circle(viz, (int(x), int(y)), 3, (0, 0, 255), -1)
cv2.imwrite(f'/tmp/{SITE}-lines.png', viz)
print(f'LINES  {len(comps)} straight components (centreline-sampled)')
if len(comps) < 3:
    raise SystemExit(f'not enough lines — tune MINLEN/MINELONG/TOPHAT (see /tmp/{SITE}-lines.png)')

CX, CY = CXw, CYw  # working-scale principal point, fixed during the legacy solve
REG1 = float(os.environ.get('REG1', 0.02)); REG2 = float(os.environ.get('REG2', 0.2))
REG3 = float(os.environ.get('REG3', 1.0)); REG4 = float(os.environ.get('REG4', 5.0))
PENALTY = 10.0  # fixed large residual for unmappable points (~600× a typical residual)
FULL_PENALTY = 500.0  # same idea for the SOLVE=full path, whose residuals are in mrad


# ── 2b. SOLVE=full — joint F/CX/CY/k1..k4 plumb-line solve ────────────────────
def kb_undistort(pts, F, cx, cy, ks):
    """Invert the manual KB forward model r = F·θ·(1+k1θ²+k2θ⁴+k3θ⁶+k4θ⁸) —
    the EXACT model generate_mesh.py projects with — via Newton, then map each
    pixel to its unit RAY (sinθcosφ, sinθsinφ, cosθ). Returns (N,3) + valid."""
    k1, k2, k3, k4 = ks
    dx = pts[:, 0] - cx; dy = pts[:, 1] - cy
    r = np.hypot(dx, dy); phi = np.arctan2(dy, dx)
    th = r / F
    for _ in range(10):
        t2 = th * th
        f = F * th * (1 + t2 * (k1 + t2 * (k2 + t2 * (k3 + t2 * k4)))) - r
        fp = F * (1 + t2 * (3 * k1 + t2 * (5 * k2 + t2 * (7 * k3 + t2 * 9 * k4))))
        with np.errstate(divide='ignore', invalid='ignore'):
            th = th - f / fp
    valid = np.isfinite(th) & (th >= 0) & (th < np.radians(92))
    th_s = np.where(valid, th, 0.0)
    st = np.sin(th_s)
    return np.stack([st * np.cos(phi), st * np.sin(phi), np.cos(th_s)], 1), valid


def full_resids(theta, lines):
    """Great-circle residual: a straight world line's rays lie on a plane
    through the origin, so residual = n·ray (≈ angular deviation, radians) for
    the least-squares plane normal n. Unlike the tan-plane perp/std measure,
    this is STRETCH-INVARIANT — a radial remap cannot shrink the residual by
    elongating the line (the degeneracy that rode k1 to its bound), and it is
    well-conditioned at any θ (no tan blow-up near 90°).
    theta = [F, cx, cy, k1, k2, k3, k4]."""
    F, cx, cy = theta[0], theta[1], theta[2]
    r = []
    for ln in lines:
        p = ln['pts']
        rays, valid = kb_undistort(p, F, cx, cy, theta[3:7])
        out = np.full(len(p), FULL_PENALTY, float)
        fin = valid & np.isfinite(rays).all(1)
        if fin.sum() >= 3:
            rf = rays[fin]
            _, _, vt = np.linalg.svd(rf, full_matrices=False)
            out[np.nonzero(fin)[0]] = 1000.0 * (rf @ vt[2])  # mrad off the great-circle plane
        r.append(out)
    return np.concatenate(r) if r else np.array([])


SIGMA_C = float(os.environ.get('SIGMA_C', 30.0))   # CX/CY prior sigma (working px)
K_BOUND = [0.3, 0.15, 0.08, 0.04]
# L2 on k, in mrad-cost units: keeps the flat gauge direction (θ→atan(c·tanθ)
# is invisible to plumb lines) pinned at the minimum-|k| member near the disc-
# anchored equidistant curve, while genuine small corrections stay cheap.
K_REG_FULL = [float(os.environ.get(f'KREG{i+1}', d)) for i, d in
              enumerate([2000.0, 4000.0, 8000.0, 16000.0])]

# GAUGE HANDLING — plumb lines only constrain straightness; both the tan-scale
# family (θ→atan(c·tanθ)) and aggressive radial remaps leave line straightness
# untouched or even spuriously improved (first attempt rode k1 to -0.3 and
# moved a 53° pixel to 72°). Structure of the fix: (a) great-circle residuals
# (stretch-invariant), (b) F FIXED to the disc anchor (the gauge direction is
# then only reachable through k's), (c) minimum-norm L2 on k picks the member
# nearest the landmark-certified equidistant curve. The θ(r) deviation vs the
# previous fit is PRINTED as a diagnostic — landmark_stamp.py is the real gate.
_prev_fit = None
try:
    _pf = json.load(open(f'PLAYHUB/scripts/vp-calibration/{SITE}-fit.json'))
    _prev_fit = (_pf['F'] * s, np.array([_pf.get('K1', 0), _pf.get('K2', 0),
                                         _pf.get('K3', 0), _pf.get('K4', 0)]))
except Exception:
    pass


def theta_of_r(rr, F, ks):
    k1, k2, k3, k4 = ks
    th = rr / F
    for _ in range(20):
        t2 = th * th
        f = F * th * (1 + t2 * (k1 + t2 * (k2 + t2 * (k3 + t2 * k4)))) - rr
        fp = F * (1 + t2 * (3 * k1 + t2 * (5 * k2 + t2 * (7 * k3 + t2 * 9 * k4))))
        th = th - f / fp
    return th


def solve_full(lines, nk, cxy):
    """Fit CX/CY (if cxy) + k1..k_nk with F FIXED to the disc anchor (see the
    gauge note above). Priors are whispers in mrad-cost units — the line data
    decides; they only break exact flat directions."""
    free_k = list(range(nk))
    x0 = ([CXw, CYw] if cxy else []) + [0.0] * nk
    lo = ([CXw - 3 * SIGMA_C, CYw - 3 * SIGMA_C] if cxy else []) + [-K_BOUND[i] for i in free_k]
    hi = ([CXw + 3 * SIGMA_C, CYw + 3 * SIGMA_C] if cxy else []) + [K_BOUND[i] for i in free_k]

    def unpack(x):
        theta = np.zeros(7)
        theta[0] = f0
        theta[1], theta[2] = (x[0], x[1]) if cxy else (CXw, CYw)
        ko = 2 if cxy else 0
        for j, i in enumerate(free_k):
            theta[3 + i] = x[ko + j]
        return theta

    def resfn(x):
        theta = unpack(x)
        base = np.nan_to_num(full_resids(theta, lines), nan=FULL_PENALTY)
        pri = []
        if cxy:
            pri += [10.0 * (theta[1] - CXw) / SIGMA_C, 10.0 * (theta[2] - CYw) / SIGMA_C]
        pri += [K_REG_FULL[i] * theta[3 + i] for i in free_k]
        return np.concatenate([base, np.array(pri)])

    sol = least_squares(resfn, x0, bounds=(lo, hi), loss='soft_l1', f_scale=5.0)
    return sol, unpack(sol.x)




def line_resids(params, lines):
    """Per-point collinearity residual after undistortion, SCALE-NORMALIZED per
    line (perp distance ÷ the line's cluster spread) so it measures straightness
    as an angle — scale-invariant, which is what keeps F identifiable. (Raw or
    pixel-scaled perp distance has a focal degeneracy: as F→∞ the undistorted
    points shrink, driving the residual to 0.) params = [F, k1, k2] (k2 optional).
    Value is a unitless straightness (×1000 ≈ milliradians when reported)."""
    F = params[0]; k1 = params[1]; k2 = params[2] if len(params) > 2 else 0.0
    K = np.array([[F, 0, CX], [0, F, CY], [0, 0, 1]], float)
    D = np.array([[k1], [k2], [0], [0]], float)
    r = []
    for ln in lines:
        p = ln['pts']
        u = cv2.fisheye.undistortPoints(p.reshape(-1, 1, 2), K, D).reshape(-1, 2)
        fin = np.isfinite(u).all(1)
        # FIXED-LENGTH output (one residual per input point): points the model
        # can't map (NaN from undistortPoints near/past 90°, or a line with too
        # few finite points to fit) get a large FINITE penalty — never dropped
        # (scipy.least_squares needs a constant-length vector) and never 0 (which
        # would tell the optimiser a divergent param fits perfectly).
        out = np.full(len(u), PENALTY, float)
        if fin.sum() >= 3:
            uf = u[fin]; cc = uf.mean(0); _, _, vt = np.linalg.svd(uf - cc)
            out[fin] = ((uf - cc) @ vt[1]) / (np.std(uf - cc) + 1e-9)
        r.append(out)
    return np.concatenate(r) if r else np.array([])


f0 = F_ANCHOR if F_ANCHOR else 0.29 * SCALE_W  # disc-derived focal, else lens prior
# anchored F gets tight bounds (±8%); un-anchored keeps the wide search range.
F_LO, F_HI = (0.92 * F_ANCHOR, 1.08 * F_ANCHOR) if F_ANCHOR else (0.13 * SCALE_W, 0.80 * SCALE_W)

if os.environ.get('SOLVE') == 'full':
    # THE model is k1..k4 + CX/CY, seeded at the IMAGE CENTRE (the manual disc
    # arc is kept only as the F anchor: 8 points on a short arc extrapolate the
    # centre badly — kuwait's was 290px off, the direct cause of the halfway
    # bow; both solved centres land near the image centre). The L2 regs are the
    # overfit guard. LOO=1 prints the leave-one-line-out table as a diagnostic —
    # note it structurally punishes spatially UNIQUE lines (hold out the only
    # line in a region and nothing constrains that region), so it advises, it
    # does not select. Acceptance = rendered straightedge + landmark_stamp.
    name, nk, cxy = 'k1..k4+cxy', 4, True
    CXw, CYw = W / 2, H / 2  # cxy seed+prior — disc centre NOT trusted here

    if os.environ.get('LOO') == '1':
        def loo_full(nk_, cxy_):
            errs = []
            for h in range(len(comps)):
                _, th_ = solve_full([comps[i] for i in range(len(comps)) if i != h], nk_, cxy_)
                r = full_resids(th_, [comps[h]])
                r = r[np.isfinite(r) & (r != FULL_PENALTY)]
                errs.append(np.sqrt(np.mean(r ** 2)) if len(r) else np.inf)
            return np.array(errs)
        for nm, nk_, cxy_ in [('k1+k2 fixed-c', 2, False), ('k1..k4+cxy', 4, True)]:
            e = loo_full(nk_, cxy_)
            print(f'LOO    {nm:14s} held-out straightness {np.mean(e):7.2f}  (per line: '
                  + ' '.join(f'{v:.1f}' for v in e) + ')')

    sol, th = solve_full(comps, nk, cxy)
    # one trim pass: drop snapped junk (>3.5× robust sigma), re-solve
    res = full_resids(th, comps)
    sig = 1.4826 * np.median(np.abs(res[np.isfinite(res) & (res != FULL_PENALTY)])) + 1e-12
    trimmed, ntrim, off = [], 0, 0
    for ln in comps:
        m = np.abs(res[off:off + len(ln['pts'])]) < 3.5 * sig
        off += len(ln['pts'])
        ntrim += int((~m).sum())
        if m.sum() >= 6:
            trimmed.append({'pts': ln['pts'][m], 'length': ln['length']})
    if ntrim:
        print(f'TRIM   dropped {ntrim} points beyond 3.5σ; re-solving on {len(trimmed)} lines')
        sol, th = solve_full(trimmed, nk, cxy)
        comps = trimmed
    F_full = th[0] / s
    CXf, CYf = th[1] / s, th[2] / s
    K1, K2, K3, K4 = (float(v) for v in th[3:7])
    fin = full_resids(th, comps)
    fin = fin[np.isfinite(fin) & (fin != FULL_PENALTY)]
    train_rms = float(np.sqrt(np.mean(fin ** 2)))
    per_line = {}
    offp = 0
    for i, ln in enumerate(comps):
        r = full_resids(th, [ln]); r = r[np.isfinite(r) & (r != FULL_PENALTY)]
        per_line[i] = float(np.sqrt(np.mean(r ** 2))) if len(r) else float('inf')
    print(f'FIT    F={F_full:.1f}  CX={CXf:.1f} CY={CYf:.1f}  (Δ from prior {CXf-CX/s:+.1f},{CYf-CY/s:+.1f} full-res)')
    print(f'       k1={K1:.5f} k2={K2:.5f} k3={K3:.5f} k4={K4:.5f}  train straightness={train_rms:.2f}')
    print('       per-line RMS (mrad): ' + ' '.join(f'{v:.1f}' for v in per_line.values()))
    if _prev_fit is not None:
        rg = np.linspace(0.08, 1.45, 40) * f0
        dth = np.degrees(theta_of_r(rg, f0, th[3:7]) - theta_of_r(rg, _prev_fit[0], _prev_fit[1]))
        print(f'CURVE  θ(r) deviation vs previous fit: max {np.nanmax(np.abs(dth)):.2f}° '
              f'(at r={rg[np.nanargmax(np.abs(dth))]/s:.0f}px full-res) — verify with landmark_stamp.py')
    out = {'F': F_full, 'CX': CXf, 'CY': CYf, 'K1': K1, 'K2': K2, 'K3': K3, 'K4': K4,
           'TILT': float(os.environ.get('TILT', 32)), 'n_lines': len(comps),
           'disc_ok': bool(disc and disc['ok']), 'solver': f'full:{name}',
           'train_straightness': train_rms}
    json.dump(out, open(f'PLAYHUB/scripts/vp-calibration/{SITE}-fit.json', 'w'), indent=2)
    print(f'params → {SITE}-fit.json (SOLVE=full)')
    raise SystemExit(0)



def solve(lines, use_k2):
    x0 = [f0, 0.0] + ([0.0] if use_k2 else [])
    lo = [F_LO, -0.4] + ([-0.1] if use_k2 else [])
    hi = [F_HI, 0.4] + ([0.1] if use_k2 else [])

    def resfn(x):
        base = np.nan_to_num(line_resids(x, lines))
        reg = [REG1 * x[1]] + ([REG2 * x[2]] if use_k2 else [])  # light L2 on k
        return np.concatenate([base, reg])

    return least_squares(resfn, x0, bounds=(lo, hi), loss='soft_l1', f_scale=1.0)


def loo_fold_errs(use_k2):
    """Per-fold leave-one-line-out held-out straightness (×1000)."""
    errs = []
    for h in range(len(comps)):
        train = [comps[i] for i in range(len(comps)) if i != h]
        r = line_resids(solve(train, use_k2).x, [comps[h]])
        r = r[np.isfinite(r)]
        errs.append(np.sqrt(np.mean(r ** 2)) * 1000 if len(r) else np.inf)
    return np.array(errs)


e1, e2 = loo_fold_errs(False), loo_fold_errs(True)
loo1, loo2 = float(np.mean(e1)), float(np.mean(e2))
delta = e1 - e2  # per fold, >0 = k2 helps this held-out line
improved = int(np.sum(delta > 0)); se = float(np.std(delta) / np.sqrt(max(len(delta), 1)))
# adopt k2 only if it helps on MOST held-out lines (not just the mean) AND the
# mean gain clears both a relative floor and the fold-to-fold noise (n is small,
# so one lucky line must not carry the decision).
use_k2 = (improved >= int(np.ceil(0.8 * len(comps))) and
          (loo1 - loo2) > max(0.10 * loo1, 2 * se))
print(f'MODEL  leave-one-out held-out straightness: k1={loo1:.2f}  k1+k2={loo2:.2f}  '
      f'(k2 helps {improved}/{len(comps)} folds, mean gain {loo1-loo2:.2f} vs '
      f'floor {max(0.10*loo1, 2*se):.2f})  → {"k1+k2" if use_k2 else "k1 only"}')

sol = solve(comps, use_k2)
F_full = sol.x[0] / s
K1 = float(sol.x[1]); K2 = float(sol.x[2]) if use_k2 else 0.0
train_rms = float(np.sqrt(np.mean(line_resids(sol.x, comps) ** 2)) * 1000)
# parameter covariance from the Jacobian at the solution (identifiability proof)
try:
    resid_var = float(np.mean(line_resids(sol.x, comps) ** 2))
    cov = np.linalg.inv(sol.jac.T @ sol.jac) * resid_var
    stds = np.sqrt(np.clip(np.diag(cov), 0, None))
    std_str = 'F±%.0f k1±%.3f' % (stds[0] / s, stds[1]) + (' k2±%.3f' % stds[2] if use_k2 else '')
except Exception:
    std_str = 'n/a'
print(f'FIT    F(work)={sol.x[0]:.0f} k1={K1:.4f} k2={K2:.4f}  →  full-res F={F_full:.0f}  '
      f'CX={CX/s:.0f} CY={CY/s:.0f}  train straightness={train_rms:.2f}  (1σ: {std_str})')

out = {'F': F_full, 'CX': CX / s, 'CY': CY / s, 'K1': K1, 'K2': K2,
       'TILT': float(os.environ.get('TILT', 32)), 'n_lines': len(comps),
       'disc_ok': bool(disc and disc['ok']),
       'held_out_straightness': loo2 if use_k2 else loo1, 'train_straightness': train_rms}
json.dump(out, open(f'PLAYHUB/scripts/vp-calibration/{SITE}-fit.json', 'w'), indent=2)
print(f'lines viz → /tmp/{SITE}-lines.png ; circle viz → /tmp/{SITE}-circle.png ; params → {SITE}-fit.json')

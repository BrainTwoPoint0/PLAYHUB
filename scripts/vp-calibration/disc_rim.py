"""Disc-edge rim constraint — the rim information source for unfitted venues.

The fisheye image circle (annotated once per venue via annotate_disc.py) is a
constant-theta contour of the lens: every rim pixel sits at the lens cutoff
angle THETA from the optical axis. That gives the auto pipeline the two things
the interior data (lines + marks, theta <= ~80) cannot: where the principal
point is (the annotated arc's geometry — kuwait's left arc is maximally
informative about CX, the 143px hand-vs-auto disagreement axis) and where the
r(theta) curve ends (the rim is strongly non-equidistant: kuwait hand fit
+172px past r=F*theta at theta 90).

The constraint acts on the ray FIELD, not the radial curve: each annotated-arc
pixel, unprojected through a candidate fit, must land at DISC_THETA_DEG off
the axis. A radial-only pin cannot close a principal-point disagreement; this
can (measured 2026-07-18: the pure-auto kuwait fit reads the arc at 94.2 deg
vs 88.2 through the validated hand fit — the 5-7 deg rim warp Karim's eyes-on
caught, visible in this one observable).

DISC_THETA_DEG is a LENS-CLASS constant, defined as the MEAN theta of the
rim_points() sampling (annotated circle over az_deg, in-frame) through the
validated kuwait hand fit (2026-07-18). The constant and the sampling are a
PAIR — remeasure both together or neither. n=1 validation: footballplus's
image circle extends past its frame (zero exterior pixels — disc_ok:false is
physical, not a detection failure) and HCT's per-lens 3840x1080 crops show no
rim, so no second venue can corroborate it today. A venue with different lens
hardware must override it (json "theta_deg" or env DISC_THETA_DEG); GATE G +
eyes-on are the backstop when the constant is wrong for a new lens.

Precision note: the kuwait rim is an out-of-focus housing vignette (soft over
~50px, dark-on-dark invisible at some azimuths), so the annotation is worth
~±1-2 deg — 3-5x tighter than the 5-7 deg failure mode it exists to prevent.
Only the ANNOTATED azimuth range is trusted (az_deg in the disc json); the
8-point circle extrapolates badly away from the clicked arc (its centre is
~300px from the principal point — short-arc Taubin degeneracy).
"""
import json
import os

import numpy as np

from fisheye_model import unproject

DISC_THETA_DEG = 88.2  # kuwait hand fit, mean over the annotated arc (sd 1.6)
RIM_PENALTY_MRAD = 500.0


def load_disc(site, base=None):
    """Venue disc annotation with a usable arc range, or None. Requires
    az_deg — a disc json without it predates arc-range storage and its
    trusted region is unknown (annotate_disc.py now saves it)."""
    base = base or os.path.dirname(__file__)
    p = os.path.join(base, f'{site}-disc.json')
    if not os.path.exists(p):
        return None
    try:
        disc = json.load(open(p))
    except Exception:
        return None
    if 'az_deg' not in disc:
        print(f'disc_rim: {site}-disc.json has no az_deg (arc range) — '
              f'rim constraint unavailable; re-annotate or add the range')
        return None
    return disc


def disc_theta_deg(disc):
    env = os.environ.get('DISC_THETA_DEG')
    if env:
        return float(env)
    return float(disc.get('theta_deg', DISC_THETA_DEG))


def rim_points(disc, n=24, margin=8):
    """Sample the annotated circle inside the trusted azimuth range, in-frame
    FULL-RES pixels only. Azimuth is about the ANNOTATED centre (the range was
    measured there)."""
    lo, hi = (float(v) for v in disc['az_deg'])
    az = np.radians(np.linspace(lo, hi, n))
    cx, cy, R = float(disc['cx']), float(disc['cy']), float(disc['R'])
    p = np.column_stack([cx + R * np.cos(az), cy + R * np.sin(az)])
    w = float(disc.get('src_w', 3840))
    h = float(disc.get('src_h', 2160))
    keep = ((p[:, 0] >= margin) & (p[:, 0] <= w - margin)
            & (p[:, 1] >= margin) & (p[:, 1] <= h - margin))
    return p[keep]


def rim_theta_mrad(pts, F, cx, cy, ks, theta_deg):
    """Per-point (theta - theta_disc) in mrad through a candidate fit.
    Points the model cannot invert get RIM_PENALTY_MRAD (a curve that cannot
    reach the rim radius is a rim failure, not missing data)."""
    rays, ok = unproject(pts, F, cx, cy, ks)
    th = np.arccos(np.clip(rays[:, 2], -1.0, 1.0))
    res = 1000.0 * (th - np.radians(theta_deg))
    return np.where(ok & np.isfinite(res), res, RIM_PENALTY_MRAD)

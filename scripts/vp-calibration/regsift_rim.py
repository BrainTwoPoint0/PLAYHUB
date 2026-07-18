"""Reg-SIFT rim constraint — dense ray-field evidence from Spiideo's own Play
render (Spiideo venues only).

Where the disc edge gives ONE constant-theta arc (and only where the image
circle is visible — kuwait's left side), registering their produced Play
render against our banked raw panorama gives dense raw-pixel <-> render-pixel
correspondences at every framing their follow camera visited, including the
corners the disc cannot see (kuwait right, footballplus everywhere).

Constraint form: their render is locally a pinhole view of the same ray
bundle (same optical centre — a virtual rotation/zoom of the fisheye). For
each harvested frame, a 3x3 DLT homography maps render pixels (homogeneous)
to candidate-fit rays; the residual is the angle between the DLT-predicted
ray and the unprojected raw pixel, in mrad. The per-frame H absorbs their
pan/tilt/roll/zoom (never solved), so ONLY our fit's ray field is scored —
this is rotation-only self-calibration, the same physics as panorama
bundling. Across many overlapping framings the per-frame gauges chain, so
the joint term constrains CX/CY as well as the k-curve (a radial-only pin
cannot — measured on the disc source, benchmarks/README.md).

Measured floor (kuwait, 2026-07-18): ~4-5 mrad (~0.26 deg) median per frame —
their render's non-pinhole component + half-scale SIFT localization. The
residual is robustified (soft-L1 by the caller) because SIFT pools carry a
few % of false matches even after the harvest's local-affine filter.

Input artifact: {site}-regsift.npz with array 'frames' = object array of
dicts {t, play (n,2 render px), raw (n,2 full-res fisheye px)} — produced by
the harvest+promote pipeline (scripts in the session scratchpad, promoted
rows are pre-filtered: narrow fov, spatial spread, per-frame cap).
"""
import os

import numpy as np

from fisheye_model import unproject
from marks_solver import ray_dlt_homography

REG_PENALTY_MRAD = 500.0
PLAY_SCALE = 100.0  # render px / this ~ O(1..20): keeps the DLT well-scaled


def load_regsift(site, base=None):
    base = base or os.path.dirname(__file__)
    p = os.path.join(base, f'{site}-regsift.npz')
    if not os.path.exists(p):
        return None
    d = np.load(p, allow_pickle=True)
    frames = list(d['frames'])
    return frames if frames else None


def frame_resid_mrad(play, rays, ok):
    """One frame: DLT render-px -> ray on the invertible matches, residual per
    match in mrad. Non-invertible matches get the penalty (a curve that cannot
    reach those radii is a field failure, not missing data)."""
    out = np.full(len(play), REG_PENALTY_MRAD)
    if ok.sum() < 12:
        return out
    ph = play[ok] / PLAY_SCALE
    H = ray_dlt_homography(ph, rays[ok])
    pred = (H @ np.column_stack([ph, np.ones(len(ph))]).T).T
    pn = np.linalg.norm(pred, axis=1)
    dots = np.abs(np.sum(pred * rays[ok], axis=1)) / np.maximum(pn, 1e-12)
    out[np.nonzero(ok)[0]] = 1000.0 * np.arccos(np.clip(dots, -1, 1))
    return out


def regsift_resid_mrad(frames, F, cx, cy, ks):
    """All frames concatenated, order-stable across calls (least_squares needs
    a fixed residual layout)."""
    res = []
    for fr in frames:
        raw = np.asarray(fr['raw'], np.float64)
        play = np.asarray(fr['play'], np.float64)
        rays, ok = unproject(raw, F, cx, cy, ks)
        ok = ok & np.isfinite(rays).all(axis=1)
        res.append(frame_resid_mrad(play, rays, ok))
    return np.concatenate(res) if res else np.zeros(0)

"""Calibration usability gate — LOCKSTEP copy.

LOCKSTEP: mirrors infrastructure/batch/player-tracklets/build_track.py
(calibration_unusable_reason + _marks_corner_diag + CAL_* constants).
Importing build_track here is impossible — it imports cv2 at module top and
this image ships no OpenCV. Keep the three constants and both functions
byte-equivalent to the original; the web-side twin is
src/lib/panorama/pitch-band.ts::solveErrorBand (red boundary 1.5%).
"""
from __future__ import annotations

import numpy as np

CAL_SOLVER_VERSION = 1
CAL_BAND_REL_MAX = 0.015
CAL_BAND_ABS_MAX = 45.0  # fallback when the corner span is unavailable


def _marks_corner_diag(marks) -> float | None:
    """Max pairwise distance between CORNER marks in raw-frame px — the
    denominator of the web solveErrorBand's relative verdict."""
    try:
        pts = [m['uv'] for m in marks
               if str(m.get('name', '')).startswith('corner_')]
        best = 0.0
        for i in range(len(pts)):
            for j in range(i + 1, len(pts)):
                dx = float(pts[i][0]) - float(pts[j][0])
                dy = float(pts[i][1]) - float(pts[j][1])
                d = (dx * dx + dy * dy) ** 0.5
                best = max(best, d)
        return best if best > 0 else None
    except Exception:  # noqa: BLE001 — malformed marks = no diag, use abs
        return None


def calibration_unusable_reason(cal: dict | None) -> str | None:
    """Why this calibration must NOT drive projection, or None if it may."""
    if not cal:
        return 'no active calibration'
    if cal.get('solver_version') != CAL_SOLVER_VERSION:
        return f'solver_version {cal.get("solver_version")!r}'
    if not cal.get('homography'):
        return 'no homography'
    try:
        length_m = float(cal['pitch_length_m'])
        width_m = float(cal['pitch_width_m'])
    except (KeyError, TypeError, ValueError):
        return 'missing pitch dims'
    if not (length_m > 0 and width_m > 0):
        return 'non-positive pitch dims'
    try:
        err = float(cal.get('reprojection_error_px'))
    except (TypeError, ValueError):
        return 'no reprojection error'
    if not np.isfinite(err):
        return 'non-finite reprojection error'
    diag_px = _marks_corner_diag(cal.get('marks'))
    if diag_px is not None:
        if err / diag_px >= CAL_BAND_REL_MAX:
            return f'red band ({err:.0f}px over {diag_px:.0f}px diagonal)'
    elif err >= CAL_BAND_ABS_MAX:
        return f'red band ({err:.0f}px absolute)'
    return None

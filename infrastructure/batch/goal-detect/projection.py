"""Tracklets artifact -> per-frame pitch-metre player positions (Match shim).

Generalizes the pilot's stoppage_spiideo.load_pitch_frames: artifact
pan/tilt (degrees, aim convention) -> world ray by pure trig
(rx = -tan(pan), ry = -tan(tilt)/cos(pan) — the exact inverse of
mesh_rays.rayn_pan_tilt_deg) -> pitch metres via inv(H_cal), where H_cal is
the ACTIVE admin calibration homography (pitch-metres -> ray space) and the
pitch dims come from the same row. No tracklets-job internals needed: once
in ray space, only the calibration matters.

Sign/horizon handling (plan finding): the global sign of inv(H_cal) is
undefined — flip so the MEDIAN projected player point has w > 0, then
reject w <= 1e-6 (build_track.pitch_frame_map semantics: beyond-horizon
points mirror through the origin) and keep the pilot's ±8 m apron bounds.

The artifact is motion-adaptively decimated (NOT uniform 5 Hz): keep the
pilot's round(t/0.2) frame snap; consumers use nearest-frame lookup with a
±0.4 s tolerance.
"""
from __future__ import annotations

import bisect

import numpy as np

GRID = 0.2          # artifact cadence grid (5 Hz base)
APRON_M = 8.0
W_EPS = 1e-6
# The z=+1 ray convention MIRRORS directions past |pan|=90° (the workspace's
# gnomonic-mirror invariant): pan 100° wraps onto −80° and can land IN
# BOUNDS as plausible garbage the w-cut can't see. Artifact pans are
# produced in (−90°, 90°), so this guard is a no-op on well-formed data —
# it exists so a malformed sample degrades to n_bad, never to a phantom
# player (senior review #4; verified a no-op on the Nazwa gate).
PAN_LIMIT_DEG = 89.5


class ProjectionError(ValueError):
    """Self-authored message, safe to surface in the error column."""


class Shim:
    """Match-shim over Spiideo tracklets so frame_channels runs verbatim."""

    def __init__(self, frames, L, W):
        self.frames = frames
        self.length_m, self.width_m = L, W
        self.frame_times = sorted(frames)

    def players_at(self, t: float):
        """Rows at the frame nearest t (within GRID*2), else []."""
        ft = self.frame_times
        if not ft:
            return []
        i = bisect.bisect_left(ft, t)
        cand = [ft[j] for j in (i - 1, i) if 0 <= j < len(ft)]
        if not cand:
            return []
        key = min(cand, key=lambda x: abs(x - t))
        if abs(key - t) > 2 * GRID:
            return []
        return self.frames[key]


def _sign_normalized_hinv(H_cal: np.ndarray, rays: np.ndarray) -> np.ndarray:
    """inv(H_cal) with its global sign fixed so the median sample has w>0."""
    Hinv = np.linalg.inv(np.asarray(H_cal, float))
    w = (rays @ Hinv.T)[:, 2]
    finite = np.isfinite(w)
    if not finite.any():
        raise ProjectionError('calibration projection failed: no finite w')
    if float(np.median(w[finite])) < 0:
        Hinv = -Hinv
    return Hinv


def load_pitch_frames(artifact: dict, H_cal, L: float, W: float) -> Shim:
    """(tracklets.json dict, calibration homography, pitch dims) -> Shim.

    Raises ProjectionError when the composed projection is unusable
    (<50% of points in bounds, or nothing finite) — the caller settles the
    job as error rather than detecting on garbage geometry.
    """
    objects = artifact.get('objects') or []
    if not objects:
        raise ProjectionError('tracklets artifact has no objects')

    # one pass to collect all rays (for sign normalization), then project
    all_rays = []
    per_obj = []
    for o in objects:
        pan_deg = np.asarray(o['pan'], float)
        pan = np.radians(pan_deg)
        tilt = np.radians(np.asarray(o['tilt'], float))
        rx = -np.tan(pan)
        ry = -np.tan(tilt) / np.cos(pan)
        # mirror guard: NaN out samples the z=+1 convention cannot represent
        bad_pan = ~(np.abs(pan_deg) < PAN_LIMIT_DEG)
        if bad_pan.any():
            rx = np.where(bad_pan, np.nan, rx)
            ry = np.where(bad_pan, np.nan, ry)
        rays = np.stack([rx, ry, np.ones_like(rx)], axis=1)
        per_obj.append((o['t'], rays))
        all_rays.append(rays)
    Hinv = _sign_normalized_hinv(H_cal, np.concatenate(all_rays))

    frames: dict = {}
    n_pts = n_bad = 0
    for oi, (ts, rays) in enumerate(per_obj):
        p = rays @ Hinv.T
        w = p[:, 2]
        ok = w > W_EPS          # beyond-horizon / mirrored points rejected
        x = np.where(ok, p[:, 0] / np.where(ok, w, 1), np.nan)
        y = np.where(ok, p[:, 1] / np.where(ok, w, 1), np.nan)
        for t, xi, yi in zip(ts, x, y):
            n_pts += 1
            if not (np.isfinite(xi) and np.isfinite(yi)):
                n_bad += 1
                continue
            if not (-APRON_M <= xi <= L + APRON_M
                    and -APRON_M <= yi <= W + APRON_M):
                n_bad += 1
                continue
            tk = round(round(t / GRID) * GRID, 2)
            # row shape = veo tracking row: [trackId, role, xNorm, yNorm, ...]
            frames.setdefault(tk, []).append(
                [oi, 1, xi / L, yi / W, 0, 0, 0, 0])
    if n_pts == 0:
        raise ProjectionError('tracklets artifact has no samples')
    kept = n_pts - n_bad
    if kept < 0.5 * n_pts:
        raise ProjectionError(
            f'calibration projection failed: only {kept}/{n_pts} points '
            f'in bounds')
    print(f'projection: {len(objects)} objects, {n_pts} points, '
          f'{n_bad} dropped ({n_bad / n_pts:.1%}); '
          f'{len(frames)} frames on the {GRID}s grid', flush=True)
    return Shim(frames, float(L), float(W))

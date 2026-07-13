"""Per-frame feature vector for the imitation policy — computed identically at
training time (build_dataset) and inference/render time. Calibration-free: everything
is in normalized panorama-x, the same coordinate the SIFT-registered teacher targets
live in (all Nazwa matches share one fixed camera).

  [ player foot-x histogram (PB) | motion-energy histogram (MB, ball proxy) | scalars ]

Scalars: player count (soft-scaled), player-x mean, player-x spread, motion centroid,
leading/trailing player x (the "where's the furthest-forward action" edges). ~70 dim.
"""
from __future__ import annotations

import numpy as np

PB = 32          # player foot-x histogram bins
MB = 32          # motion-energy histogram bins (must match cache_players MB)
N_SCALAR = 6
DIM = PB + MB + N_SCALAR


def player_hist(player_xs):
    h = np.zeros(PB, np.float32)
    if len(player_xs):
        idx = np.clip((np.asarray(player_xs) * PB).astype(int), 0, PB - 1)
        for i in idx:
            h[i] += 1.0
        s = h.sum()
        if s > 0:
            h /= s
    return h


def scalars(player_xs, motion_x):
    xs = np.asarray(player_xs, np.float32)
    n = len(xs)
    cnt = np.tanh(n / 12.0)                       # soft-scaled count (~1 for a full pitch)
    mean = float(xs.mean()) if n else 0.5
    spread = float(xs.std()) if n > 1 else 0.0
    mot = float(motion_x) if motion_x == motion_x else mean   # nan → fall back to mean
    lead = float(xs.max()) if n else 0.5
    trail = float(xs.min()) if n else 0.5
    return np.array([cnt, mean, spread, mot, lead, trail], np.float32)


def frame_features(player_xs, mhist_vec, motion_x):
    """player_xs: list of normalized foot-x; mhist_vec: MB-length motion hist (or None)."""
    mh = np.asarray(mhist_vec, np.float32) if mhist_vec is not None else np.zeros(MB, np.float32)
    if mh.shape[0] != MB:
        mh = np.zeros(MB, np.float32)
    return np.concatenate([player_hist(player_xs), mh, scalars(player_xs, motion_x)]).astype(np.float32)

"""Per-game metric->ray-plane homography solve, self-seeding and video-free.

Ports the validated scripts/follow-re chain (calibrate_pano seed ->
calibrate_precise Hungarian -> calibrate_refine spectator-mask + spatial
balance + shrinking gates; final quality on the reference game: 0.0073 rayn,
bias-free) with one structural change: the seed comes from Spiideo's OWN
person detections instead of a YOLO cache, so no video download is needed.
Both feet sources are equivalent for the seed — the pano-UV cloud of people.

Inputs: detection frames {abs_ts_us: rayn feet (N,2)} with pano-UV kept for
fence masking, tracklet frames {abs_ts_us: metric xy (N,2)}. Output: H (3x3)
plus diagnostics the entrypoint gates on.

The _robust variant of the offline chain OVERFITS (recorded 2026-07-11) — do
not add its per-frame reweighting here.
"""

from __future__ import annotations

import numpy as np
import cv2
from scipy.optimize import linear_sum_assignment
from scipy.spatial import cKDTree

# Detections near the top of the frame are fence/spectator rows, not pitch
# (the v<0.18 mask from calibrate_refine).
FENCE_V = 0.18
# Time pairing gate between a detection frame and the nearest tracklet frame.
PAIR_GATE_US = 80_000
SEED_ICP_ITERS = 12
PRECISE_GATE = 0.08
REFINE_GATES = (0.06, 0.045, 0.035, 0.028, 0.022, 0.018, 0.015, 0.013,
                0.012, 0.012)


def pitch_rect_metric(trk_frames: dict) -> tuple[np.ndarray, np.ndarray]:
    """Robust metric pitch bounds: central mass of all tracklet positions
    (spectators are a sparse minority at fixed edge spots; players fill the
    pitch)."""
    allp = np.vstack(list(trk_frames.values()))
    lo = np.percentile(allp, 3, axis=0)
    hi = np.percentile(allp, 97, axis=0)
    pad = 3.0
    return lo - pad, hi + pad


def _robust_core(P: np.ndarray, k: float = 2.5) -> np.ndarray:
    m = np.median(P, 0)
    mad = np.median(np.abs(P - m), 0) + 1e-6
    return P[np.all(np.abs(P - m) < k * mad * 1.4826, 1)]


def _bbox_affine(src: np.ndarray, dst: np.ndarray, fx: int, fy: int):
    s0, s1 = src.min(0), src.max(0)
    d0, d1 = dst.min(0), dst.max(0)
    sc = (d1 - d0) / (s1 - s0 + 1e-9) * [fx, fy]
    H = np.eye(3)
    H[0, 0] = sc[0]
    H[1, 1] = sc[1]
    c = (d0 + d1) / 2 - sc * (s0 + s1) / 2
    H[0, 2] = c[0]
    H[1, 2] = c[1]
    return H


def _seed(Mc: np.ndarray, Rc: np.ndarray) -> np.ndarray:
    """Orientation-searching coarse ICP (calibrate_pano) on the pooled clouds."""
    tree = cKDTree(Rc)

    def icp(H0):
        H = H0.copy()
        for _ in range(SEED_ICP_ITERS):
            proj = cv2.perspectiveTransform(Mc[None].astype(np.float32), H)[0]
            d, idx = tree.query(proj)
            keep = d < np.percentile(d, 60)
            if keep.sum() < 12:
                break
            Hn, _ = cv2.findHomography(Mc[keep].astype(np.float32),
                                       Rc[idx[keep]].astype(np.float32),
                                       cv2.RANSAC, 0.03)
            if Hn is None:
                break
            H = Hn
        proj = cv2.perspectiveTransform(Mc[None].astype(np.float32), H)[0]
        d, _ = tree.query(proj)
        return H, float(np.median(d))

    best = (1e9, None)
    for fx in (1, -1):
        for fy in (1, -1):
            H, med = icp(_bbox_affine(Mc, Rc, fx, fy))
            if med < best[0]:
                best = (med, H)
    if best[1] is None:
        raise RuntimeError('H seed failed (degenerate point clouds)')
    return best[1]


def _balance(MM: np.ndarray, RR: np.ndarray, cell: float = 6.0, cap: int = 8):
    """Cap correspondences per metric grid cell so dense near-camera regions
    don't dominate the fit (the far-half bias fix from calibrate_refine)."""
    keys = np.floor(MM / cell).astype(int)
    seen: dict = {}
    keep = []
    order = np.random.default_rng(0).permutation(len(MM))
    for i in order:
        k = (keys[i, 0], keys[i, 1])
        seen[k] = seen.get(k, 0)
        if seen[k] < cap:
            seen[k] += 1
            keep.append(i)
    keep = np.array(keep)
    return MM[keep], RR[keep]


def solve(det_frames: dict, trk_frames: dict) -> dict:
    """det_frames: {abs_ts_us: (uv (N,2), rayn (N,2))},
    trk_frames: {abs_ts_us: metric (N,2)} -> {'H', 'median_res',
    'matched_frames', 'n_matches', 'pitch_lo', 'pitch_hi'}."""
    dts = np.array(sorted(det_frames))
    tts = np.array(sorted(trk_frames))
    if not len(dts) or not len(tts):
        raise RuntimeError('no detection or tracklet frames to solve H from')
    lo, hi = pitch_rect_metric(trk_frames)

    pairs = []
    for dt in dts:
        j = tts[np.argmin(np.abs(tts - dt))]
        if abs(int(j) - int(dt)) >= PAIR_GATE_US:
            continue
        uv, drn = det_frames[dt]
        met = trk_frames[j]
        dm = uv[:, 1] > FENCE_V
        mm = ((met[:, 0] > lo[0]) & (met[:, 0] < hi[0])
              & (met[:, 1] > lo[1]) & (met[:, 1] < hi[1]))
        if dm.sum() >= 4 and mm.sum() >= 4:
            pairs.append((drn[dm].astype(np.float32),
                          met[mm].astype(np.float32)))
    if len(pairs) < 30:
        raise RuntimeError(
            f'only {len(pairs)} time-matched det/tracklet frames — '
            'not enough for a homography solve')

    Mc = _robust_core(np.vstack([m for _, m in pairs]))
    Rc = _robust_core(np.vstack([d for d, _ in pairs]))
    H = _seed(Mc, Rc)

    # Precise: per-frame Hungarian at a loose gate, then refine with the
    # shrinking-gate schedule + spatial balancing.
    for gate in (PRECISE_GATE,) * 6 + REFINE_GATES:
        MM, RR = [], []
        for drn, met in pairs:
            proj = cv2.perspectiveTransform(met[None], H)[0]
            C = np.linalg.norm(proj[:, None] - drn[None], axis=2)
            ri, ci = linear_sum_assignment(C)
            good = C[ri, ci] < gate
            MM.append(met[ri[good]])
            RR.append(drn[ci[good]])
        MM = np.vstack(MM)
        RR = np.vstack(RR)
        # Tight gates keep only the best few dozen matches — that's fine (a
        # homography needs 4; RANSAC is stable from ~20). The MAX_H_RESIDUAL
        # gate downstream is the real quality arbiter, not match count.
        if len(MM) < 24:
            raise RuntimeError(
                f'homography match starved at gate {gate} ({len(MM)} pts)')
        MMb, RRb = _balance(MM, RR)
        thresh = 0.02 if gate >= PRECISE_GATE else 0.010
        Hn, _ = cv2.findHomography(MMb, RRb, cv2.RANSAC, thresh)
        if Hn is None:
            raise RuntimeError(f'findHomography failed at gate {gate}')
        H = Hn

    res = np.linalg.norm(cv2.perspectiveTransform(MM[None], H)[0] - RR, axis=1)

    # GLOBAL evaluation with the FINAL H: the tight-gate residual above only
    # measures inlier self-consistency (matches were selected at 0.012 — their
    # median can hardly exceed it, even for a locally-consistent-but-wrong H).
    # Re-assign every frame at a moderate gate instead: a correct H matches
    # most on-pitch detections; a wrong one matches almost nothing.
    EVAL_GATE = 0.03
    ev_res, ev_offered = [], 0
    for drn, met in pairs:
        proj = cv2.perspectiveTransform(met[None], H)[0]
        C = np.linalg.norm(proj[:, None] - drn[None], axis=2)
        ri, ci = linear_sum_assignment(C)
        good = C[ri, ci] < EVAL_GATE
        ev_res.extend(C[ri, ci][good].tolist())
        ev_offered += min(len(drn), len(met))
    eval_rate = len(ev_res) / max(1, ev_offered)
    eval_median = float(np.median(ev_res)) if ev_res else 1.0

    return {
        'H': H,
        'median_res': float(np.median(res)),
        'eval_median': eval_median,
        'eval_rate': float(eval_rate),
        'eval_matches': len(ev_res),
        'matched_frames': len(pairs),
        'n_matches': int(len(MM)),
        'pitch_lo': lo.tolist(),
        'pitch_hi': hi.tolist(),
    }

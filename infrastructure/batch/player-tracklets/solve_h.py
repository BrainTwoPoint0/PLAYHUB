"""Per-game metric->ray-plane homography solve, self-seeding and video-free.

Ports the validated scripts/follow-re chain (coarse ICP seed -> per-frame
Hungarian precise -> spectator-mask + spatial balance + shrinking gates) with
two hard-won 2026-07-15 corrections over the first shipped version:

1. TIME BASE: correspondences pair detections with tracklet positions
   INTERPOLATED per fragment at the exact detection timestamp. The fragments
   must be built with the correct per-stream item cadence
   (build_track.estimate_cadence_us) — the original 10s assumption compressed
   the tracklet timeline ~40% and made every correspondence garbage except
   near-stationary players, which is exactly what the first pilot H was
   found fitting.
2. SEED: the affine seed searches ROTATIONS (15° steps, both flips), not just
   axis-aligned bbox flips. The pilot venue's pitch long-axis is rotated ~90°
   between metric and rayn space — unrepresentable by the old seed, which is
   why it locked into a sheared local optimum.

With both fixes the pilot game evaluates at ~0.6 Hungarian match rate on
held-out windows (wrong H: ~0.02), so the rate/region gates in the entrypoint
are discriminative rather than the old un-gameable absolute counts.

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
SEED_ICP_ITERS = 12
SEED_MAX_PTS = 6000
SEED_ANGLE_STEP_DEG = 15
PRECISE_GATE = 0.08
REFINE_GATES = (0.06, 0.045, 0.035, 0.028, 0.022, 0.018, 0.015, 0.013,
                0.012, 0.012)
EVAL_GATE = 0.03


def pitch_rect_metric(fragments: list) -> tuple[np.ndarray, np.ndarray]:
    """Robust metric pitch bounds: central mass of all tracklet positions
    (spectators are a sparse minority at fixed edge spots; players fill the
    pitch)."""
    allp = np.vstack([xy for _, xy in fragments])
    lo = np.percentile(allp, 3, axis=0)
    hi = np.percentile(allp, 97, axis=0)
    pad = 3.0
    return lo - pad, hi + pad


# A query time whose bracketing samples are further apart than this is a
# tracker dropout — np.interp would straight-line through it (5-10m of
# invented position at sprint speed). 0.6s = 3 missed 5Hz samples.
INTERP_MAX_BRACKET_US = 600_000
# Two cameras of a 2-cam scene can both detect the same feet; dedupe grid in
# rayn so Hungarian 1-1 doesn't force the duplicate onto a wrong tracklet.
DET_DEDUPE_RAYN = 0.008


def time_paired_sets(det_frames: dict, fragments: list, lo, hi) -> list:
    """[(det rayn (N,2), interp tracklet metric (M,2)), ...] per detection
    frame. Tracklet positions are linearly interpolated per fragment at the
    exact detection timestamp — no nearest-frame slop, and never across a
    >0.6s intra-fragment dropout. Spectators are masked on both sides (pano
    fence line / metric pitch rect); near-duplicate detections (2-cam scenes)
    are deduped on a rayn grid."""
    spans = [(int(ts[0]), int(ts[-1]), ts.astype(np.float64), xy)
             for ts, xy in fragments]
    out = []
    for dt in sorted(det_frames):
        fuv, drn = det_frames[dt]
        met = []
        for t0, t1, ts, xy in spans:
            if t0 <= dt <= t1:
                j = int(np.searchsorted(ts, dt))
                # bracketing samples ts[j-1] <= dt < ts[j] (j==0 -> exact hit
                # on ts[0]); an exact sample hit needs no interpolation
                if 0 < j < len(ts) and dt != ts[j - 1] \
                        and ts[j] - ts[j - 1] > INTERP_MAX_BRACKET_US:
                    continue  # dropout gap — don't invent a position
                met.append([np.interp(dt, ts, xy[:, 0]),
                            np.interp(dt, ts, xy[:, 1])])
        if not met:
            continue
        met = np.array(met, np.float64)
        dm = fuv[:, 1] > FENCE_V
        drn_m = drn[dm]
        if len(drn_m):
            _, uniq = np.unique(
                np.round(drn_m / DET_DEDUPE_RAYN).astype(np.int64),
                axis=0, return_index=True)
            drn_m = drn_m[np.sort(uniq)]
        mm = ((met[:, 0] > lo[0]) & (met[:, 0] < hi[0])
              & (met[:, 1] > lo[1]) & (met[:, 1] < hi[1]))
        if len(drn_m) >= 4 and mm.sum() >= 4:
            out.append((drn_m.astype(np.float32),
                        met[mm].astype(np.float32)))
    return out


WINDOW_BIN_S = 5.0
# an eval window must carry real play, not stoppage stragglers: at least this
# fraction of the solve window's per-second activity
EVAL_ACTIVITY_FRACTION = 0.15
WINDOW_SEPARATION_S = 20.0


def pick_windows(fragments: list, solve_s: float, eval_s: float) -> dict:
    """Choose the solve window and up to two held-out eval windows by MOVING-
    sample density (players in motion, 0.5-11 m/s). A fixed 50%-of-span
    anchor lands on halftime for any two-half recording — pairs starve and a
    good game burns its attempts. Eval windows sit strictly before/after the
    solve window with a separation gap so solve frames can't leak into the
    held-out gates. Returns {'solve': (t0,t1), 'evalA': ..., 'evalB': ...}
    (eval keys present only when a side has room + activity)."""
    trk_lo = min(int(ts[0]) for ts, _ in fragments)
    trk_hi = max(int(ts[-1]) for ts, _ in fragments)
    nbins = max(int((trk_hi - trk_lo) / 1e6 / WINDOW_BIN_S), 1)
    score = np.zeros(nbins)
    for ts, xy in fragments:
        if len(ts) < 2:
            continue
        t = (ts - trk_lo) / 1e6
        dt = np.diff(t)
        sp = np.linalg.norm(np.diff(xy, axis=0), axis=1) / np.maximum(dt, 1e-9)
        moving = (sp > 0.5) & (sp < 11.0)
        idxs = np.clip((t[1:][moving] / WINDOW_BIN_S).astype(int), 0, nbins - 1)
        np.add.at(score, idxs, 1)

    def best(lo_bin: int, hi_bin: int, dur_s: float):
        w = max(int(round(dur_s / WINDOW_BIN_S)), 1)
        lo_bin, hi_bin = max(lo_bin, 0), min(hi_bin, nbins)
        if hi_bin - lo_bin < w:
            return None
        c = np.concatenate([[0.0], np.cumsum(score[lo_bin:hi_bin])])
        sums = c[w:] - c[:-w]
        k = int(np.argmax(sums))
        return lo_bin + k, lo_bin + k + w, float(sums[k])

    sw = best(0, nbins, solve_s)
    if sw is None:
        sw = (0, nbins, float(score.sum()))
    s0, s1, s_score = sw
    to_us = lambda b: trk_lo + int(b * WINDOW_BIN_S * 1e6)  # noqa: E731
    out = {'solve': (to_us(s0), min(to_us(s1), trk_hi))}
    sep = int(round(WINDOW_SEPARATION_S / WINDOW_BIN_S))
    floor = EVAL_ACTIVITY_FRACTION * s_score * (eval_s / solve_s)
    for key, lo_b, hi_b in (('evalA', 0, s0 - sep),
                            ('evalB', s1 + sep, nbins)):
        w = best(lo_b, hi_b, eval_s)
        if w is not None and w[2] >= floor:
            out[key] = (to_us(w[0]), min(to_us(w[1]), trk_hi))
    return out


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


def _rot_affine(src: np.ndarray, dst: np.ndarray, angle_deg: float,
                flip: float):
    """Affine seed: rotate/flip the metric cloud, then scale its bbox onto
    the rayn bbox. Covers orientations the bbox seed cannot represent."""
    a = np.radians(angle_deg)
    RF = np.array([[np.cos(a), -np.sin(a)], [np.sin(a), np.cos(a)]]) \
        @ np.diag([1.0, flip])
    rot = (src - src.mean(0)) @ RF.T
    sc = (dst.max(0) - dst.min(0)) / (rot.max(0) - rot.min(0) + 1e-9)
    A = np.eye(3)
    A[:2, :2] = np.diag(sc) @ RF
    A[:2, 2] = dst.mean(0) - A[:2, :2] @ src.mean(0)
    return A


def _seed_candidates(Mc: np.ndarray, Rc: np.ndarray,
                     top_k: int = 8) -> list[np.ndarray]:
    """Orientation-searching coarse ICP on the pooled clouds: bbox flips PLUS
    a full rotation sweep. Returns the top_k candidates by chamfer — chamfer
    alone must NOT pick the winner: the pooled cloud is time-blind and
    near-symmetric under 180° rotation, so a mirrored optimum can edge out
    the true one. The caller scores candidates on TIME-PAIRED matches."""
    rng = np.random.default_rng(0)
    if len(Mc) > SEED_MAX_PTS:
        Mc = Mc[rng.choice(len(Mc), SEED_MAX_PTS, replace=False)]
    if len(Rc) > SEED_MAX_PTS:
        Rc = Rc[rng.choice(len(Rc), SEED_MAX_PTS, replace=False)]
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

    seeds = [_bbox_affine(Mc, Rc, fx, fy)
             for fx in (1, -1) for fy in (1, -1)]
    seeds += [_rot_affine(Mc, Rc, ang, flip)
              for ang in range(0, 360, SEED_ANGLE_STEP_DEG)
              for flip in (1.0, -1.0)]
    results = []
    for H0 in seeds:
        H, med = icp(H0)
        if np.isfinite(med):
            results.append((med, H))
    if not results:
        raise RuntimeError('H seed failed (degenerate point clouds)')
    results.sort(key=lambda r: r[0])
    # Dedupe converged basins before truncating: 52 seeds collapse to a few
    # optima, and the 180°-mirror basin (near-equal chamfer on a symmetric
    # cloud) can otherwise fill all top_k slots and hide the true H from the
    # time-paired arbiter. Basin identity = where the pitch-rect corners land.
    corners = np.array([[Mc[:, 0].min(), Mc[:, 1].min()],
                        [Mc[:, 0].max(), Mc[:, 1].min()],
                        [Mc[:, 0].max(), Mc[:, 1].max()],
                        [Mc[:, 0].min(), Mc[:, 1].max()]], np.float64)
    kept: list = []
    kept_proj: list = []
    for med, H in results:
        proj = cv2.perspectiveTransform(corners[None],
                                        H.astype(np.float64))[0]
        if any(np.median(np.linalg.norm(proj - p, axis=1)) < 0.05
               for p in kept_proj):
            continue
        kept.append(H)
        kept_proj.append(proj)
        if len(kept) >= top_k:
            break
    return kept


def _subsample_score(H: np.ndarray, pairs: list, gate: float = EVAL_GATE,
                     max_frames: int = 80) -> int:
    """Time-paired Hungarian matches on a frame subsample — the cheap,
    orientation-discriminative candidate score."""
    step = max(1, len(pairs) // max_frames)
    n = 0
    for drn, met in pairs[::step]:
        proj = cv2.perspectiveTransform(
            met[None].astype(np.float64), np.asarray(H, np.float64))[0]
        C = np.linalg.norm(proj[:, None] - drn[None], axis=2)
        ri, ci = linear_sum_assignment(C)
        n += int((C[ri, ci] < gate).sum())
    return n


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


def evaluate(H: np.ndarray, pairs: list, lo, hi, gate: float = EVAL_GATE) -> dict:
    """Hungarian re-assignment eval of H on time-paired sets, with per-region
    counts, residual medians AND signed bias (median residual VECTOR norm).
    A sheared H produces coherent signed offsets that survive the gate's
    magnitude truncation — bias is the discriminative regional signal, and
    it's computed for the four half-pitch regions plus the four quadrants
    (a corner-localized error dilutes into halves but not quadrants).
    The cost matrix is clipped at the gate before assignment so Hungarian
    optimizes gated matches rather than total cost."""
    H = np.asarray(H, np.float64)
    res, vecs, pts, offered = [], [], [], 0
    for drn, met in pairs:
        proj = cv2.perspectiveTransform(met[None].astype(np.float64), H)[0]
        C = np.linalg.norm(proj[:, None] - drn[None], axis=2)
        ri, ci = linear_sum_assignment(np.minimum(C, gate))
        good = C[ri, ci] < gate
        res.extend(C[ri, ci][good].tolist())
        vecs.extend((proj[ri[good]] - drn[ci[good]]).tolist())
        pts.extend(met[ri[good]].tolist())
        offered += min(len(drn), len(met))
    res = np.array(res)
    vecs = np.array(vecs) if vecs else np.zeros((0, 2))
    pts = np.array(pts) if pts else np.zeros((0, 2))
    out = {
        'matches': int(len(res)),
        'offered': int(offered),
        'rate': float(len(res) / max(1, offered)),
        'median': float(np.median(res)) if len(res) else 1.0,
        'regions': {},
    }
    if len(pts):
        cx, cy = (lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2
        L, F = pts[:, 0] < cx, pts[:, 1] < cy
        regions = [('left', L), ('right', ~L), ('far', F), ('near', ~F),
                   ('far-left', F & L), ('far-right', F & ~L),
                   ('near-left', ~F & L), ('near-right', ~F & ~L)]
        for name, m in regions:
            out['regions'][name] = {
                'n': int(m.sum()),
                'median': float(np.median(res[m])) if m.sum() else 1.0,
                'bias': float(np.linalg.norm(np.median(vecs[m], axis=0)))
                if m.sum() else 1.0,
            }
    return out


def lag_peak_s(det_frames: dict, fragments: list,
               max_lag_s: float = 120.0, bin_s: float = 0.5) -> tuple:
    """(best_lag_seconds, correlation) between the detection-track speed
    profile and the tracklet speed profile. With a correct item cadence the
    peak sits at ~0; a drifted cadence shows up as a shifted/absent peak —
    this is the time-base canary."""
    dts = sorted(det_frames)
    if not dts or not fragments:
        return 0.0, 0.0
    t0 = dts[0]
    dprof: dict = {}
    for k in range(1, len(dts)):
        dt_us = dts[k] - dts[k - 1]
        if not (100_000 < dt_us < 450_000):
            continue
        _, a = det_frames[dts[k - 1]]
        _, b = det_frames[dts[k]]
        D = np.linalg.norm(a[:, None] - b[None], axis=2)
        ri = D.argmin(1)
        ci = D.argmin(0)
        sp = [D[i, j] / (dt_us / 1e6) for i, j in enumerate(ri)
              if ci[j] == i and D[i, j] < 0.03]
        if sp:
            dprof.setdefault(round((dts[k] - t0) / 1e6 / bin_s), []).append(
                float(np.mean(sp)))
    tprof: dict = {}
    for ts, xy in fragments:
        t = (ts - t0) / 1e6
        if len(t) < 2:
            continue
        sp = np.linalg.norm(np.diff(xy, axis=0), axis=1) \
            / np.maximum(np.diff(t), 1e-9)
        for tt, s in zip(t[1:], np.clip(sp, 0, 12.0)):
            tprof.setdefault(round(tt / bin_s), []).append(float(s))
    dp = {k: float(np.mean(v)) for k, v in dprof.items()}
    tp = {k: float(np.mean(v)) for k, v in tprof.items()}
    if not dp or not tp:
        return 0.0, float('nan')  # nan = no overlapping speed profile
    dkeys = sorted(dp)
    best = (0.0, -1.0)
    r_zero = -1.0
    scanned = 0
    for lag_b in range(int(-max_lag_s / bin_s), int(max_lag_s / bin_s) + 1):
        vals = [(dp[k], tp[k + lag_b]) for k in dkeys if (k + lag_b) in tp]
        if len(vals) < 120:
            continue
        a = np.array([v[0] for v in vals])
        b = np.array([v[1] for v in vals])
        sa, sb = a.std(), b.std()
        if sa < 1e-9 or sb < 1e-9:
            continue
        scanned += 1
        r = float(np.corrcoef(a, b)[0, 1])
        if lag_b == 0:
            r_zero = r
        if r > best[1]:
            best = (lag_b * bin_s, r)
    if not scanned:
        return 0.0, float('nan')
    # Flat-topped correlation ridges make the argmax jitter a few bins; if
    # lag 0 is within 10% of the peak, the time base is aligned — report it.
    if r_zero > 0 and r_zero >= 0.9 * best[1]:
        return 0.0, r_zero
    return best


def solve(det_frames: dict, fragments: list) -> dict:
    """det_frames: {abs_ts_us: (uv (N,2), rayn (N,2))} from the dense solve
    window; fragments: cadence-correct tracklet fragments. -> diagnostics
    dict incl. 'H', 'eval' (global Hungarian eval on the solve window),
    'pitch_lo'/'pitch_hi'."""
    if not det_frames or not fragments:
        raise RuntimeError('no detection frames or fragments to solve H from')
    lo, hi = pitch_rect_metric(fragments)
    pairs = time_paired_sets(det_frames, fragments, lo, hi)
    if len(pairs) < 30:
        raise RuntimeError(
            f'only {len(pairs)} time-paired det/tracklet frames — '
            'not enough for a homography solve')

    Mc = _robust_core(np.vstack([m for _, m in pairs]))
    Rc = _robust_core(np.vstack([d for d, _ in pairs]))
    candidates = _seed_candidates(Mc, Rc)
    # Pick the seed by TIME-PAIRED matches, then refine one precise round per
    # candidate first so a near-miss orientation gets a fair score.
    scored = []
    for Hc in candidates:
        MM, RR = [], []
        for drn, met in pairs[::max(1, len(pairs) // 80)]:
            proj = cv2.perspectiveTransform(
                met[None].astype(np.float64), Hc.astype(np.float64))[0]
            C = np.linalg.norm(proj[:, None] - drn[None], axis=2)
            ri, ci = linear_sum_assignment(C)
            good = C[ri, ci] < PRECISE_GATE
            MM.append(met[ri[good]])
            RR.append(drn[ci[good]])
        MM, RR = np.vstack(MM), np.vstack(RR)
        Hr = Hc
        if len(MM) >= 24:
            Hn, _ = cv2.findHomography(*_balance(MM, RR), cv2.RANSAC, 0.02)
            if Hn is not None:
                Hr = Hn
        scored.append((_subsample_score(Hr, pairs), Hr))
    scored.sort(key=lambda s: -s[0])
    H = scored[0][1]

    # Precise: per-frame Hungarian at a loose gate, then refine with the
    # shrinking-gate schedule + spatial balancing.
    for gate in (PRECISE_GATE,) * 6 + REFINE_GATES:
        MM, RR = [], []
        for drn, met in pairs:
            proj = cv2.perspectiveTransform(
                met[None].astype(np.float64), H.astype(np.float64))[0]
            C = np.linalg.norm(proj[:, None] - drn[None], axis=2)
            ri, ci = linear_sum_assignment(C)
            good = C[ri, ci] < gate
            MM.append(met[ri[good]])
            RR.append(drn[ci[good]])
        MM = np.vstack(MM)
        RR = np.vstack(RR)
        if len(MM) < 24:
            raise RuntimeError(
                f'homography match starved at gate {gate} ({len(MM)} pts)')
        MMb, RRb = _balance(MM, RR)
        # 0.015 floor: rayn foot-noise is heteroscedastic (0.002-0.006 across
        # the pitch) — a tighter RANSAC threshold re-selects the low-noise
        # region after _balance equalized it and tilts the fit
        thresh = 0.02 if gate >= PRECISE_GATE else 0.015
        Hn, _ = cv2.findHomography(MMb, RRb, cv2.RANSAC, thresh)
        if Hn is None:
            raise RuntimeError(f'findHomography failed at gate {gate}')
        H = Hn

    res = np.linalg.norm(
        cv2.perspectiveTransform(MM[None].astype(np.float64),
                                 H.astype(np.float64))[0] - RR, axis=1)
    ev = evaluate(H, pairs, lo, hi)
    return {
        'H': H,
        'median_res': float(np.median(res)),
        'eval': ev,
        'matched_frames': len(pairs),
        'n_matches': int(len(MM)),
        'pitch_lo': lo.tolist(),
        'pitch_hi': hi.tolist(),
    }

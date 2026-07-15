"""Parse tracklet items into per-fragment series, stitch by velocity-projected
proximity (global edge matching), RTS-smooth per chain, and convert to the
player's pan/tilt space.

Data model (empirically verified on the pilot game, 2026-07-15):
- Items are OVERLAPPING RE-COMPUTATIONS, not chunks of one stream: an item's
  timeOffsets run past its 10s window, and the overlap region is a
  re-estimated trajectory that DISAGREES with the previous item (~3m at the
  same reconstructed timestamp). Merging same-uuid across items by union
  interleaves the two estimates into a 5-13° sawtooth — the "twitching" bug.
  Every item is trimmed to its own 10s window (the newest item that saw each
  instant wins), EXCEPT when the successor item is missing / it is the final
  item — then the tail is the only coverage and is kept.
- objectUUIDs are PER-WINDOW, not persistent: same-uuid across the item seam
  jumps 5.1m median (69% >3m). Identity across items comes from POSITION +
  VELOCITY continuity (the stitcher), never from the uuid.
- Positions are raw tracker output: per-fragment hygiene (teleport-split,
  Hampel, speed gate) then per-chain constant-velocity Kalman + RTS backward
  smoothing (offline → non-causal is allowed and optimal), resampled to a
  uniform 5Hz grid. Spec per computer-vision review 2026-07-15.
"""

from __future__ import annotations

import json

import numpy as np
import cv2

from mesh_rays import rayn_pan_tilt_deg

SAMPLE_DT = 0.2  # 5 Hz
ITEM_WINDOW_US = 10_000_000
MIN_FRAGMENT_SAMPLES = 3   # ~0.6s — a uuid born late in a window is real
MIN_CHAIN_SPAN_S = 2.5     # noise floor moves to the CHAIN level
# Hygiene gates
TELEPORT_SPEED = 12.0      # m/s — beyond this, split (glitch or intra-item ID swap)
SPEED_GATE = 11.0          # m/s — consecutive-sample hard ceiling (futsal ≤ ~9)
HAMPEL_WINDOW = 7
HAMPEL_NSIGMA = 3.0
# Stitch gates (velocity-projected; see edges())
STITCH_MAX_GAP_S = 1.5
GATE_BASE_M = 0.8
GATE_ACCEL = 4.0           # m/s² — d_gate = base + 0.5·a·gap²
VEL_CONTINUITY = 4.0       # m/s — |v_end − v_start| ceiling
AMBIGUITY_RATIO = 1.5
AMBIGUITY_FLOOR_M = 0.5
PITCH_APRON_M = 2.0        # pre-stitch filter uses an expanded rect
# Kalman (constant velocity, white-acceleration process noise)
KF_SIGMA_M = 0.3           # m — measurement noise (pilot MAD estimate)
KF_SIGMA_A = 3.0           # m/s² — process noise (follows sprints, kills jitter)
# Artifact size budget — beyond this, halve the sample rate (client lerps).
MAX_TOTAL_POINTS = 700_000


# ── Parsing + per-fragment hygiene ───────────────────────────────────────────

def parse_items(items: list[tuple[int, bytes]], start_time_us: int) -> list:
    """(index, raw json bytes) -> hygienic per-(item, uuid) FRAGMENTS
    [(ts_us[], xy[]), ...]. Trimmed to the item's own window unless the
    successor item is missing (then the tail is the only coverage)."""
    present = {idx for idx, _ in items}
    fragments = []
    for idx, raw in items:
        base = start_time_us + idx * ITEM_WINDOW_US
        keep_tail = (idx + 1) not in present
        try:
            data = json.loads(raw)
        except ValueError:
            continue
        for pts in data.values():
            if not isinstance(pts, list):
                continue
            seq = {}
            for p in pts:
                try:
                    off = int(round(p['timeOffset']))
                    if off >= ITEM_WINDOW_US and not keep_tail:
                        continue  # overlap tail = an older re-estimate
                    seq[base + off] = (float(p['x']), float(p['y']))
                except (KeyError, TypeError, ValueError):
                    continue
            if len(seq) < MIN_FRAGMENT_SAMPLES:
                continue
            ts = np.array(sorted(seq), np.int64)
            xy = np.array([seq[t] for t in ts], np.float64)
            for f_ts, f_xy in _hygiene(ts, xy):
                fragments.append((f_ts, f_xy))
    return fragments


def _hampel(x: np.ndarray) -> np.ndarray:
    """Replace outliers with the local window median (per axis)."""
    n = len(x)
    if n < HAMPEL_WINDOW:
        return x
    half = HAMPEL_WINDOW // 2
    out = x.copy()
    for i in range(n):
        w = x[max(0, i - half):min(n, i + half + 1)]
        med = np.median(w)
        mad = np.median(np.abs(w - med))
        if mad > 0 and abs(x[i] - med) > HAMPEL_NSIGMA * 1.4826 * mad:
            out[i] = med
    return out


def _hygiene(ts: np.ndarray, xy: np.ndarray) -> list:
    """Teleport-SPLIT (an intra-item ID swap must not be welded), Hampel
    replace, speed-gate backstop, endpoint drop."""
    dt = np.diff(ts) / 1e6
    step = np.linalg.norm(np.diff(xy, axis=0), axis=1)
    with np.errstate(divide='ignore', invalid='ignore'):
        speed = np.where(dt > 0, step / dt, np.inf)
    teleport = step > np.maximum(2.5, TELEPORT_SPEED * dt)
    cut_points = list(np.where(teleport)[0] + 1)
    pieces = []
    prev = 0
    for c in cut_points + [len(ts)]:
        if c - prev >= MIN_FRAGMENT_SAMPLES:
            pieces.append((ts[prev:c], xy[prev:c]))
        prev = c

    out = []
    for f_ts, f_xy in pieces:
        f_xy = np.column_stack([_hampel(f_xy[:, 0]), _hampel(f_xy[:, 1])])
        # speed-gate backstop: drop samples that still imply >11 m/s
        while len(f_ts) >= MIN_FRAGMENT_SAMPLES:
            fdt = np.diff(f_ts) / 1e6
            fsp = np.linalg.norm(np.diff(f_xy, axis=0), axis=1) / np.maximum(fdt, 1e-9)
            bad = np.where(fsp > SPEED_GATE)[0]
            if len(bad) == 0:
                break
            drop = bad[0] + 1  # drop the arrival sample of the violation
            f_ts = np.delete(f_ts, drop)
            f_xy = np.delete(f_xy, drop, axis=0)
        if len(f_ts) >= MIN_FRAGMENT_SAMPLES:
            out.append((f_ts, f_xy))
    return out


# ── Stitching (global edge matching, velocity-projected gates) ───────────────

def _endpoint_velocity(ts: np.ndarray, xy: np.ndarray, head: bool) -> np.ndarray:
    """LS line-fit velocity over the first/last ≤5 samples (m/s)."""
    k = min(5, len(ts))
    sl = slice(0, k) if head else slice(-k, None)
    t = (ts[sl] - ts[sl][0]) / 1e6
    if t[-1] <= 0:
        return np.zeros(2)
    vx = np.polyfit(t, xy[sl][:, 0], 1)[0]
    vy = np.polyfit(t, xy[sl][:, 1], 1)[0]
    return np.array([vx, vy])


def stitch(fragments: list) -> list[tuple[np.ndarray, np.ndarray]]:
    """Global edge matching: enumerate all gate-passing (i_end -> j_start)
    bridges, sort by projected distance, accept greedily iff both endpoints
    are unclaimed AND the margin against the next-best edge touching either
    endpoint holds. Order-independent — a chain started earlier can no longer
    steal another chain's true continuation (first-chain-wins bug)."""
    import bisect

    frags = sorted(fragments, key=lambda f: int(f[0][0]))
    n = len(frags)
    starts = [int(f[0][0]) for f in frags]
    v_head = [_endpoint_velocity(ts, xy, head=True) for ts, xy in frags]
    v_tail = [_endpoint_velocity(ts, xy, head=False) for ts, xy in frags]

    edges = []  # (proj_dist, i, j)
    per_end: dict[int, list[float]] = {}
    per_start: dict[int, list[float]] = {}
    for i in range(n):
        ts_end = int(frags[i][0][-1])
        pos_end = frags[i][1][-1]
        j0 = bisect.bisect_right(starts, ts_end)
        j1 = bisect.bisect_right(starts, ts_end + int(STITCH_MAX_GAP_S * 1e6))
        for j in range(j0, j1):
            gap = (starts[j] - ts_end) / 1e6
            if gap <= 0:
                continue
            gate = GATE_BASE_M + 0.5 * GATE_ACCEL * gap * gap
            # forward projection of i's end
            pred = pos_end + v_tail[i] * gap
            d_fwd = float(np.linalg.norm(frags[j][1][0] - pred))
            if d_fwd > gate:
                continue
            # velocity continuity: a sprinter must not bridge to a stander
            if float(np.linalg.norm(v_tail[i] - v_head[j])) > VEL_CONTINUITY:
                continue
            # reverse check: back-project j's start onto i's end
            back = frags[j][1][0] - v_head[j] * gap
            if float(np.linalg.norm(back - pos_end)) > gate:
                continue
            edges.append((d_fwd, i, j))
            per_end.setdefault(i, []).append(d_fwd)
            per_start.setdefault(j, []).append(d_fwd)

    edges.sort()
    next_of = {}
    prev_of = {}
    for d, i, j in edges:
        if i in next_of or j in prev_of:
            continue
        # ambiguity: the next-best edge touching either endpoint must be
        # clearly worse, else refuse the bridge (no-follow beats wrong-follow)
        rivals = [x for x in per_end.get(i, []) if x > d] + \
                 [x for x in per_start.get(j, []) if x > d]
        if rivals and min(rivals) < max(AMBIGUITY_RATIO * d,
                                        d + AMBIGUITY_FLOOR_M):
            continue
        next_of[i] = j
        prev_of[j] = i

    chains_idx = []
    for i in range(n):
        if i in prev_of:
            continue
        chain = [i]
        while chain[-1] in next_of:
            chain.append(next_of[chain[-1]])
        chains_idx.append(chain)

    out = []
    for chain in chains_idx:
        ts = np.concatenate([frags[i][0] for i in chain])
        xy = np.concatenate([frags[i][1] for i in chain])
        order = np.argsort(ts)
        ts, xy = ts[order], xy[order]
        keep = np.concatenate([[True], np.diff(ts) > 0])
        ts, xy = ts[keep], xy[keep]
        if (ts[-1] - ts[0]) / 1e6 >= MIN_CHAIN_SPAN_S:
            out.append((ts, xy))
    return out


# ── Pitch filtering ──────────────────────────────────────────────────────────

def filter_on_pitch(fragments: list, lo, hi, apron: float = PITCH_APRON_M) -> list:
    """PRE-stitch: drop fragments whose median sits outside the pitch rect
    EXPANDED by an apron — a keeper stepping off for a ball must not shatter
    their chain. The exact-rect test runs on whole chains post-stitch."""
    lo = np.asarray(lo) - apron
    hi = np.asarray(hi) + apron
    out = []
    for ts, xy in fragments:
        med = np.median(xy, axis=0)
        if np.all(med > lo) and np.all(med < hi):
            out.append((ts, xy))
    return out


def filter_chains_on_pitch(chains: list, lo, hi) -> list:
    """POST-stitch exact-rect median test: spectators/staff are static for
    the whole match and fail this even though single fragments squeaked
    through the aproned pre-filter."""
    lo = np.asarray(lo)
    hi = np.asarray(hi)
    out = []
    for ts, xy in chains:
        med = np.median(xy, axis=0)
        if np.all(med > lo) and np.all(med < hi):
            out.append((ts, xy))
    return out


# ── Kalman + RTS smoothing ───────────────────────────────────────────────────

def _kf_rts(ts: np.ndarray, xy: np.ndarray):
    """Constant-velocity Kalman forward pass + Rauch-Tung-Striebel backward
    smoothing, per-sample dt (irregular sampling + bridged gaps coast with
    growing covariance instead of smearing). Innovation gating skips
    measurement updates whose Mahalanobis distance exceeds chi2(2, 99%)."""
    n = len(ts)
    t = (ts - ts[0]) / 1e6
    H = np.array([[1, 0, 0, 0], [0, 1, 0, 0]], float)
    R = np.eye(2) * KF_SIGMA_M ** 2

    x = np.zeros(4)
    dt0 = max(t[1] - t[0], 1e-3)
    x[:2] = xy[0]
    x[2:] = (xy[1] - xy[0]) / dt0
    P = np.diag([KF_SIGMA_M ** 2, KF_SIGMA_M ** 2, 4.0, 4.0])

    xs_f = np.zeros((n, 4))
    Ps_f = np.zeros((n, 4, 4))
    xs_p = np.zeros((n, 4))
    Ps_p = np.zeros((n, 4, 4))
    Fs = np.zeros((n, 4, 4))
    xs_f[0], Ps_f[0] = x, P
    xs_p[0], Ps_p[0], Fs[0] = x, P, np.eye(4)

    for k in range(1, n):
        dt = max(t[k] - t[k - 1], 1e-3)
        F = np.eye(4)
        F[0, 2] = F[1, 3] = dt
        q = KF_SIGMA_A ** 2
        Qb = np.array([[dt ** 4 / 4, dt ** 3 / 2], [dt ** 3 / 2, dt ** 2]]) * q
        Q = np.zeros((4, 4))
        Q[np.ix_([0, 2], [0, 2])] = Qb
        Q[np.ix_([1, 3], [1, 3])] = Qb
        xp = F @ x
        Pp = F @ P @ F.T + Q
        nu = xy[k] - H @ xp
        S = H @ Pp @ H.T + R
        if float(nu @ np.linalg.solve(S, nu)) <= 9.21:  # chi2(2, 0.99)
            K = Pp @ H.T @ np.linalg.inv(S)
            x = xp + K @ nu
            P = (np.eye(4) - K @ H) @ Pp
        else:
            x, P = xp, Pp  # gated: coast
        xs_p[k], Ps_p[k], Fs[k] = xp, Pp, F
        xs_f[k], Ps_f[k] = x, P

    xs_s = xs_f.copy()
    Ps_s = Ps_f.copy()
    for k in range(n - 2, -1, -1):
        C = Ps_f[k] @ Fs[k + 1].T @ np.linalg.inv(Ps_p[k + 1])
        xs_s[k] = xs_f[k] + C @ (xs_s[k + 1] - xs_p[k + 1])
        Ps_s[k] = Ps_f[k] + C @ (Ps_s[k + 1] - Ps_p[k + 1]) @ C.T
    return xs_s


def smooth_and_resample(ts: np.ndarray, xy: np.ndarray):
    """RTS-smooth, then resample onto the uniform 0.2s grid (so published t
    values round exactly and the client lerps clean 5Hz data)."""
    xs = _kf_rts(ts, xy)
    t = ts / 1e6
    t0 = np.ceil(t[0] / SAMPLE_DT) * SAMPLE_DT
    t1 = np.floor(t[-1] / SAMPLE_DT) * SAMPLE_DT
    if t1 - t0 < MIN_CHAIN_SPAN_S:
        return None
    grid = np.arange(t0, t1 + SAMPLE_DT / 2, SAMPLE_DT)
    gx = np.interp(grid, t, xs[:, 0])
    gy = np.interp(grid, t, xs[:, 1])
    return grid, np.column_stack([gx, gy])


# ── Payload ──────────────────────────────────────────────────────────────────

def build_payload(chains: list, H: np.ndarray, start_time_us: int,
                  diag: dict) -> dict:
    """Chains + homography -> the public tracklets.json payload.

    t is seconds on the produced-video clock (assumes the produced video
    starts at the stream start — the aim-track pipeline's validated base);
    t0OffsetSec lets a future per-game correction shift it client-side."""
    chains = sorted(chains, key=lambda c: -(int(c[0][-1]) - int(c[0][0])))
    total = sum(len(c[0]) for c in chains)
    step = 2 if total > MAX_TOTAL_POINTS else 1

    objects = []
    start_s = start_time_us / 1e6
    for i, (ts, xy) in enumerate(chains):
        sm = smooth_and_resample(ts, xy)
        if sm is None:
            continue
        grid, gxy = sm
        grid, gxy = grid[::step], gxy[::step]
        if len(grid) < 3:
            continue
        rn = cv2.perspectiveTransform(
            gxy[None].astype(np.float32), H.astype(np.float64))[0]
        pan, tilt = rayn_pan_tilt_deg(rn.astype(np.float64))
        t_round = np.round(grid - start_s, 2)
        keep = np.concatenate([[True], np.diff(t_round) > 0])
        objects.append({
            'id': f'o{i}',
            't': [float(v) for v in t_round[keep]],
            'pan': [round(float(v), 2) for v in pan[keep]],
            'tilt': [round(float(v), 2) for v in tilt[keep]],
        })

    return {
        'version': 1,
        'sampleFps': (1 / SAMPLE_DT) / step,
        't0OffsetSec': 0.0,
        'objects': objects,
        'meta': {
            'hMedianRes': round(diag['median_res'], 5),
            'matchedFrames': diag['matched_frames'],
            'nObjects': len(objects),
            'downsampled': step > 1,
        },
    }

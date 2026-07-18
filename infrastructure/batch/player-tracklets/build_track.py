"""Parse tracklet items into per-fragment series, stitch by velocity-projected
proximity (global edge matching), RTS-smooth per chain, and convert to the
player's pan/tilt space.

Data model (re-verified on the pilot game with the CORRECT item cadence,
2026-07-15 late):
- Item cadence is PER-STREAM, not a constant: abs ts = startTime +
  idx*cadence + timeOffset. Every current stream measures 16s/item
  (longestItemLength), but the b923 research assumed 10s — that wrong cadence
  compressed the reconstructed timeline ~40% and manufactured the earlier
  "overlapping re-computations / per-window uuids" model: samples compared
  "at the same timestamp" were really ~6s apart. estimate_cadence_us derives
  the cadence from stream metadata + the last item's content span; the
  entrypoint's det<->trk lag gate is the canary if Spiideo ever changes it.
- objectUUIDs ARE persistent across adjacent items (measured: 0.29m median
  seam jump over 0.24s, 0% >3m, n=3122). parse_items merges same-uuid across
  ADJACENT items under a continuity gate; a uuid reappearing after a missing
  item or a >1s gap starts a new fragment. The position/velocity stitcher
  remains for genuine tracker identity breaks.
- Spiideo NEVER re-links an identity across a real break (measured 2026-07-15,
  uuid_reuse.py, 3 games): the longest intra-uuid gap anywhere is 1.6s and
  there are ZERO re-appearances past 2s, so once a player is lost for more
  than ~2s they come back as a brand-new uuid. Re-appearances within 1.6s are
  genuine (100% physically reachable vs 28-74% for a same-instant null), but
  they are rare (~1.4% of deaths). The tracker mints a fresh id roughly every
  22s per player and never takes it back — that, not our gates, is why chains
  are short, and no amount of stitching recovers an identity the upstream
  never kept.
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
DEFAULT_CADENCE_US = 16_000_000
# uuid seam continuity: measured seam gaps are one 5Hz step (0.2-0.25s);
# anything past 1s means the tracker lost the object — don't trust the uuid.
SEAM_MAX_GAP_US = 1_000_000
SEAM_BASE_M = 2.5
SEAM_SPEED = 12.0          # m/s — same ceiling as TELEPORT_SPEED
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
# Extended range (2026-07-15). Measured on 4 games / 3 venues: Spiideo mints a
# fresh uuid every ~22s per player and NEVER re-links it (max intra-uuid gap
# 1.6s), and 70-86% of chain deaths have their nearest plausible continuation
# 1.5-5s out — i.e. the 1.5s ceiling, not the ambiguity gate, is what kills
# chains (the gate fires on 0.0-0.2% of deaths).
# The accel gate cannot be reused out here: it reaches 13m at 2.5s and 51m at
# 5s, wider than the pitch. A player cannot sustain 4 m/s² for seconds — they
# saturate — so past the accel ceiling the envelope goes LINEAR in gap.
# Held-out check (ceiling_eval.py): a UNIQUE candidate inside this envelope is
# the right player 98% of the time at 2s, ~95% at 3s — on injected breaks that
# are ~2x less crowded than real ones, so read those as upper bounds. 2.5s is
# the conservative pick; the ambiguity gate (dead code until now) does the
# refusing out here, which is exactly what it was written for.
STITCH_EXT_GAP_S = 2.5     # hard ceiling once the linear envelope takes over
STITCH_EXT_SLOPE = 1.5     # m/s — deviation budget vs the CV prediction
VEL_CONTINUITY = 4.0       # m/s — |v_end − v_start| ceiling
AMBIGUITY_RATIO = 1.5
AMBIGUITY_FLOOR_M = 0.5
PITCH_APRON_M = 2.0        # pre-stitch filter uses an expanded rect
# Kalman (constant velocity, white-acceleration process noise)
KF_SIGMA_M = 0.3           # m — measurement noise (pilot MAD estimate)
KF_SIGMA_A = 3.0           # m/s² — process noise (follows sprints, kills jitter)
# Artifact size budget — beyond this, halve the sample rate (client lerps).
MAX_TOTAL_POINTS = 700_000
# Client self-DoS caps (src/lib/panorama/tracklets.ts): parseTracklets()
# returns null — Spotlight silently dead — on any artifact beyond these. The
# HCT stadium-bowl incident: 26,461 objects / 1.11M pts published, over the
# then-5k/800k caps. Step-halving alone cannot guarantee the points cap
# (it halves ONCE); motion-adaptive decimation + the tightening backstop in
# build_payload does.
PAYLOAD_MAX_OBJECTS = 40_000
PAYLOAD_MAX_POINTS = 800_000
# Motion-adaptive decimation (validated on HCT, 2026-07-17 eyes-on): keep a
# sample iff it moved >= MOVE_DEG (|dpan|+|dtilt|) since the last kept one OR
# HOLD_S elapsed (lerp across a held pose stays anchored); endpoints always.
# Stationary crowd collapses to a few points; movers keep full rate.
DECIMATE_MOVE_DEG = 0.12
DECIMATE_HOLD_S = 4.0

# Roster cardinality (Tier 2a): estimate N = players on the pitch, so the client
# can cap the visible trackers at N ("never more trackers than players"). N is
# the PCT percentile of the DE-DUPLICATED concurrent on-pitch count over the
# match — NOT one frame (kickoff clusters occlude → undercount) and NOT the
# median (fragments leave several players mid-gap each instant). De-dup at
# CLUSTER_M so two fragments on one body count once. Refs are on-pitch and are
# NOT removed, so N includes on-field officials (loose by 1-3 is fine — a cap
# that loose still kills the gross duplicates/phantoms).
ROSTER_CLUSTER_M = 1.7      # COUNTING radius — deliberately loose (over-merge is
#                             harmless when only counting bodies). NOT for merging.
ROSTER_PCT = 95
ROSTER_SAMPLES = 240
# MERGING is a different risk tolerance: an over-merge DESTROYS an identity (a
# player vanishes from the overlay). A true two-fragments-on-one-body duplicate
# separates only by detector+H noise (~0.2-0.5m); two DISTINCT players in close
# marking / a wall / a scrum sit ~0.8-1.7m apart and sustain it for seconds. So
# merge on a TIGHT radius, well below the marking regime, and gate on the HIGH
# percentile of separation (a duplicate stays tiny the WHOLE overlap; a marking
# pair exceeds it) — not the median, which passes sustained proximity.
DEDUP_MERGE_M = 0.9         # merge radius (≪ ROSTER_CLUSTER_M) — duplicate-grade only
DEDUP_SEP_PCT = 90          # p90 separation over the overlap must stay under merge_m
DEDUP_MIN_OVERLAP_S = 2.0   # ignore transient brushes (co-located < this = a cross)
DEDUP_TS_TOL_US = 50_000    # collapse near-coincident samples (<50ms) on merge, so
#                             two interleaved uuids can't seed a huge KF start velocity


# ── Parsing + per-fragment hygiene ───────────────────────────────────────────

def estimate_cadence_us(stream: dict, items: list[tuple[int, bytes]]) -> int:
    """Per-stream item cadence from metadata + the last item's content span:
    cadence = (stopTime - startTime - last_item_span) / last_item_idx.

    Snapped to 500ms: cadences are engineered values (16s everywhere today),
    and the coarse grid absorbs the estimator's known bias sources — an
    empty/short LAST item (post-final-whistle recording) or a few trailing
    missing items each shift the raw estimate by <= ~0.3s at real item
    counts, which a 100ms grid would faithfully preserve as a 20s+ timeline
    drift. The entrypoint's lag gate arbitrates anything the snap can't."""
    fallback = int(stream.get('longestItemLength') or DEFAULT_CADENCE_US)
    start = stream.get('startTime')
    stop = stream.get('stopTime')
    if not items or items[-1][0] < 1 or start is None or stop is None:
        return fallback
    last_idx, last_raw = items[-1]
    last_span = 0
    try:
        data = json.loads(last_raw)
        if isinstance(data, dict):
            offs = [int(round(p['timeOffset'])) for pts in data.values()
                    if isinstance(pts, list) for p in pts
                    if isinstance(p, dict) and 'timeOffset' in p]
            if offs:
                last_span = max(offs)
    except (ValueError, TypeError):
        pass
    raw = (int(stop) - int(start) - last_span) / last_idx
    snapped = int(round(raw / 500_000) * 500_000)
    if not 2_000_000 <= snapped <= 60_000_000:
        return fallback
    return snapped


def parse_items(items: list[tuple[int, bytes]], start_time_us: int,
                cadence_us: int = DEFAULT_CADENCE_US) -> list:
    """(index, raw json bytes) -> hygienic per-uuid FRAGMENTS
    [(ts_us[], xy[]), ...]. Same-uuid samples are merged across ADJACENT
    items when the seam passes the continuity gate; a missing item, a >1s
    seam gap, or a discontinuous jump starts a new fragment."""
    fragments = []
    # uuid -> (last_item_idx, last_ts, last_xy, seq {ts: (x, y)})
    open_series: dict = {}

    def close(uuid_key):
        seq = open_series.pop(uuid_key)[3]
        if len(seq) < MIN_FRAGMENT_SAMPLES:
            return
        ts = np.array(sorted(seq), np.int64)
        xy = np.array([seq[t] for t in ts], np.float64)
        for f_ts, f_xy in _hygiene(ts, xy):
            fragments.append((f_ts, f_xy))

    for idx, raw in sorted(items, key=lambda it: it[0]):
        base = start_time_us + idx * cadence_us
        try:
            data = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(data, dict):
            continue  # shape drift — skip the item, don't crash the run
        # close series whose uuid did not continue into this item
        for u in [u for u, (li, _, _, _) in open_series.items() if li < idx - 1]:
            close(u)
        for uuid_key, pts in data.items():
            if not isinstance(pts, list):
                continue
            seq = {}
            for p in pts:
                try:
                    seq[base + int(round(p['timeOffset']))] = (
                        float(p['x']), float(p['y']))
                except (KeyError, TypeError, ValueError):
                    continue
            if not seq:
                continue
            first_ts = min(seq)
            prev = open_series.get(uuid_key)
            if prev is not None:
                li, last_ts, last_xy, _ = prev
                gap_us = first_ts - last_ts
                d = float(np.hypot(seq[first_ts][0] - last_xy[0],
                                   seq[first_ts][1] - last_xy[1]))
                gate = max(SEAM_BASE_M, SEAM_SPEED * max(gap_us, 0) / 1e6)
                # gap <= 0 = same-instant boundary re-estimate: merge (the
                # newer item's value wins via dict update), no distance test
                if li != idx - 1 or gap_us > SEAM_MAX_GAP_US \
                        or (gap_us > 0 and d > gate):
                    close(uuid_key)
                    prev = None
            if prev is None:
                open_series[uuid_key] = (idx, 0, (0.0, 0.0), {})
            _, _, _, seq_all = open_series[uuid_key]
            seq_all.update(seq)
            last_ts = max(seq)
            open_series[uuid_key] = (idx, last_ts, seq[last_ts], seq_all)
    for u in list(open_series):
        close(u)
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


def stitch_gate_m(gap_s: float) -> float:
    """Reach envelope at a given gap: how far the head may sit from the tail's
    constant-velocity prediction. Acceleration-shaped while that is physical,
    then linear once a player would have saturated their top speed.

    The envelope DROPS at the handover (5.30m at 1.5s -> 3.05m just past it)
    and is deliberately non-monotonic: the linear branch is an empirical
    precision knob, not a continuation of the accel curve. Do NOT "fix" the
    discontinuity by re-basing it at gate(1.5) — that would put the envelope at
    6.8m at 2.5s and manufacture wrong-follows. The jump is conservative: it can
    only lose bridges, never invent them. Held-out measurement is the authority
    here (ceiling_eval.py), not the shape of the curve.

    Past STITCH_EXT_GAP_S this returns -1.0, NOT inf: callers test
    `d_fwd > gate`, so a negative gate rejects every pair (distances are >= 0,
    and 0.0 > -1.0 holds), whereas inf would ACCEPT every pair — the exact
    opposite of the intent."""
    if gap_s <= STITCH_MAX_GAP_S:
        return GATE_BASE_M + 0.5 * GATE_ACCEL * gap_s * gap_s
    if gap_s <= STITCH_EXT_GAP_S:
        return GATE_BASE_M + STITCH_EXT_SLOPE * gap_s
    return -1.0


def stitch_candidates(frags: list, max_gap_s: float | None = None) -> list:
    """Every time-forward (i_end -> j_start) pair within max_gap_s, with the
    raw terms the gates read: (i, j, gap_s, d_fwd, d_back, dv). UNGATED —
    stitch_edges applies the gates, so the gate formulas live in exactly one
    place and an offline diagnostic can attribute refusals without
    reimplementing (and drifting from) them.

    frags MUST already be sorted by first timestamp. max_gap_s is a parameter
    so the diagnostic can ask what lies BEYOND the production ceiling; it
    defaults to None and resolves at CALL time, because a default of
    `STITCH_EXT_GAP_S` would freeze at import and silently ignore any later
    change to the ceiling — the same symbol would then mean two different
    things in this module."""
    import bisect

    if max_gap_s is None:
        max_gap_s = STITCH_EXT_GAP_S
    n = len(frags)
    starts = [int(f[0][0]) for f in frags]
    v_head = [_endpoint_velocity(ts, xy, head=True) for ts, xy in frags]
    v_tail = [_endpoint_velocity(ts, xy, head=False) for ts, xy in frags]

    out = []
    for i in range(n):
        ts_end = int(frags[i][0][-1])
        pos_end = frags[i][1][-1]
        j0 = bisect.bisect_right(starts, ts_end)
        j1 = bisect.bisect_right(starts, ts_end + int(max_gap_s * 1e6))
        for j in range(j0, j1):
            gap = (starts[j] - ts_end) / 1e6
            if gap <= 0:
                continue
            pos_start = frags[j][1][0]
            # forward projection of i's end
            d_fwd = float(np.linalg.norm(
                pos_start - (pos_end + v_tail[i] * gap)))
            # reverse check: back-project j's start onto i's end
            d_back = float(np.linalg.norm(
                (pos_start - v_head[j] * gap) - pos_end))
            # a sprinter must not bridge to a stander
            dv = float(np.linalg.norm(v_tail[i] - v_head[j]))
            out.append((i, j, gap, d_fwd, d_back, dv))
    return out


def stitch_edges(frags: list) -> list[tuple[float, int, int]]:
    """Gate-passing bridges as (cost, i, j). The ONLY place the hard gates
    live. Cost is the constant-velocity prediction residual — note this is
    NOT a plain distance: the tail's velocity is already in it."""
    out = []
    # read the ceiling at CALL time, not via a frozen default argument
    for i, j, gap, d_fwd, d_back, dv in stitch_candidates(frags,
                                                          STITCH_EXT_GAP_S):
        gate = stitch_gate_m(gap)
        if d_fwd > gate or dv > VEL_CONTINUITY or d_back > gate:
            continue
        out.append((d_fwd, i, j))
    return out


def stitch_assign(n: int, edges: list) -> dict[int, int]:
    """Gate-passing edges -> next_of {tail i: head j}.

    Sort by cost and accept greedily iff both endpoints are unclaimed AND no
    rival edge touching either endpoint is close enough to make the choice a
    guess (no-follow beats wrong-follow). Order-independent — a chain started
    earlier cannot steal another chain's true continuation.

    A rival is any OTHER edge competing for i or j that is still claimable.
    Two subtleties, both of which were bugs before 2026-07-15:

    - Rivals must not be filtered to the strictly-worse (`x > d`). Refusing an
      edge does not claim its endpoints, so the loop went on to reach the
      runner-up — whose worse-only filter could not see the better edge just
      rejected. Its rival list came up empty and it was accepted. The gate
      therefore did not refuse ambiguous bridges at all: it DEMOTED the best
      candidate and took the second-best, i.e. it reliably chose wrong exactly
      where it had judged the choice unsafe. Measured at 3.6-5.4% of all
      bridges on 3 games before the fix.
    - An edge whose far endpoint is already claimed by a better bridge is not
      an available alternative, so it cannot make anything ambiguous. Counting
      it killed both endpoints over a rival that did not exist.

    Edges are strictly time-forward (starts[j] > ts_end[i]), so next_of is
    acyclic and the caller's chain walk terminates. A cycle here would be an
    infinite loop inside a Fargate job — the acyclicity is load-bearing."""
    per_end: dict[int, list[tuple[float, int]]] = {}
    per_start: dict[int, list[tuple[float, int]]] = {}
    for d, i, j in edges:
        per_end.setdefault(i, []).append((d, j))
        per_start.setdefault(j, []).append((d, i))

    next_of: dict[int, int] = {}
    prev_of: dict[int, int] = {}
    for d, i, j in sorted(edges):
        if i in next_of or j in prev_of:
            continue
        rivals = [x for x, k in per_end.get(i, [])
                  if k != j and k not in prev_of] + \
                 [x for x, k in per_start.get(j, [])
                  if k != i and k not in next_of]
        if rivals and min(rivals) < max(AMBIGUITY_RATIO * d,
                                        d + AMBIGUITY_FLOOR_M):
            continue
        next_of[i] = j
        prev_of[j] = i
    return next_of


def stitch(fragments: list) -> list[tuple[np.ndarray, np.ndarray]]:
    """Fragments -> chains, via gate-passing edges and a greedy assignment
    that refuses ambiguous bridges. See stitch_candidates/edges/assign."""
    frags = sorted(fragments, key=lambda f: int(f[0][0]))
    n = len(frags)
    next_of = stitch_assign(n, stitch_edges(frags))
    prev_of = {j: i for i, j in next_of.items()}

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


# ── Roster cardinality (Tier 2a) ─────────────────────────────────────────────

def _cluster_count(pts: list, r: float) -> int:
    """Greedy single-pass cluster count: a point within r (metres) of an
    already-seen cluster centre joins it, so two fragments on one body count
    once. Order-dependent, but adequate as an input to a percentile taken over
    many instants."""
    r2 = r * r
    centres: list = []
    for x, y in pts:
        if not any((x - cx) ** 2 + (y - cy) ** 2 < r2 for cx, cy in centres):
            centres.append((x, y))
    return len(centres)


def estimate_roster_n(chains: list, cluster_m: float = ROSTER_CLUSTER_M,
                      pct: float = ROSTER_PCT,
                      n_samples: int = ROSTER_SAMPLES) -> int:
    """N = the number of players on the pitch, for the client's tracker cap.

    Sample `n_samples` instants over the tracked span; at each, take every
    active (already on-pitch) chain's interpolated position, de-duplicate at
    `cluster_m`, and count bodies. N = the `pct` percentile of those counts —
    high enough to catch the instants where nearly everyone is in a live
    fragment (robust to kickoff clustering and to players briefly mid-gap),
    while the de-dup removes the two-fragments-on-one-player inflation. `chains`
    are already on-pitch, so this needs no bounds. Includes on-field officials."""
    if not chains:
        return 0
    t0 = min(int(c[0][0]) for c in chains)
    t1 = max(int(c[0][-1]) for c in chains)
    if t1 <= t0:
        pts = [(float(xy[0, 0]), float(xy[0, 1])) for _, xy in chains]
        return _cluster_count(pts, cluster_m)
    counts = []
    for s in np.linspace(t0, t1, n_samples):
        pts = []
        for ts, xy in chains:
            if ts[0] <= s <= ts[-1]:
                pts.append((float(np.interp(s, ts, xy[:, 0])),
                            float(np.interp(s, ts, xy[:, 1]))))
        counts.append(_cluster_count(pts, cluster_m))
    return int(round(float(np.percentile(counts, pct))))


# ── Concurrent de-duplication (spotlight overlay: two-dots-on-one-body fix) ───

_SEP_GRID_CAP = 128  # separation percentile needs no more; caps per-pair cost


def _overlap_sep(a: tuple, b: tuple, pct: float):
    """p-th percentile of metric separation between two chains over their TEMPORAL
    overlap (µs), on a grid capped at _SEP_GRID_CAP points. Returns None when they
    do not overlap. The high percentile is the safety knob: a true duplicate stays
    tiny the WHOLE overlap, so its p90 is small; two distinct players brushing
    close exceed it the moment they separate, so their p90 rejects the merge."""
    ts_a, xy_a = a
    ts_b, xy_b = b
    lo = max(ts_a[0], ts_b[0])
    hi = min(ts_a[-1], ts_b[-1])
    if hi <= lo:
        return None
    npts = int(min(_SEP_GRID_CAP, max(2, (hi - lo) / 1e6 / SAMPLE_DT)))
    grid = np.linspace(lo, hi, npts)
    ga = np.column_stack([np.interp(grid, ts_a, xy_a[:, 0]),
                          np.interp(grid, ts_a, xy_a[:, 1])])
    gb = np.column_stack([np.interp(grid, ts_b, xy_b[:, 0]),
                          np.interp(grid, ts_b, xy_b[:, 1])])
    return float(np.percentile(np.linalg.norm(ga - gb, axis=1), pct))


def dedup_concurrent(chains: list, merge_m: float = DEDUP_MERGE_M,
                     sep_pct: float = DEDUP_SEP_PCT,
                     min_overlap_s: float = DEDUP_MIN_OVERLAP_S) -> list:
    """Merge chains that are the SAME BODY seen twice — the two-fragments-on-one-
    body duplicates the spotlight draws as two dots. A pair is duplicate-grade iff
    it overlaps in time for >= min_overlap_s AND its p`sep_pct` separation stays
    under `merge_m` (a TIGHT radius, well below the ~0.8-1.7m marking/wall regime —
    see the DEDUP_* constants).

    Two safety properties, both load-bearing (a wrong merge silently DELETES a
    player from the overlay — worse than any duplicate):
    - **Concurrent only** — temporally DISJOINT chains are NEVER merged. Merging
      across a gap is cross-gap identity bridging, measured too swap-prone on dense
      play (8-22% wrong-body); see `scripts/player-identity/tier2b/RECORD.md`.
    - **Temporal-clique cohesion** — a group is merged only if EVERY overlapping
      pair in it is duplicate-grade. Plain union-find is transitive, so A~B and B~C
      would collapse a wall/huddle/line of DISTINCT players (A far from C) into one
      dot at exactly the goal moment. The clique check rejects any group that isn't
      a single tight body; a rejected group is left un-merged (safe over clean).
      Members that overlap no one else in the group (a duplicate bridged by a
      continuous member across its own gap) are allowed — that is not bridging."""
    n = len(chains)
    if n < 2:
        return list(chains)
    parent = list(range(n))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    # sweep by start time; each chain compares only to still-active earlier chains
    order = sorted(range(n), key=lambda i: chains[i][0][0])
    active: list[int] = []
    for idx in order:
        s_i = chains[idx][0][0]
        active = [k for k in active if chains[k][0][-1] >= s_i]
        for k in active:
            ov = (min(chains[idx][0][-1], chains[k][0][-1]) - s_i) / 1e6
            if ov < min_overlap_s:
                continue
            sep = _overlap_sep(chains[idx], chains[k], sep_pct)
            if sep is not None and sep < merge_m:
                union(idx, k)
        active.append(idx)

    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)

    out = []
    for members in groups.values():
        if len(members) == 1:
            out.append(chains[members[0]])
            continue
        # cohesion: reject the group unless every OVERLAPPING pair is
        # duplicate-grade (kills transitive huddle/line collapse)
        cohesive = True
        for a in range(len(members)):
            for b in range(a + 1, len(members)):
                sep = _overlap_sep(chains[members[a]], chains[members[b]], sep_pct)
                if sep is not None and sep >= merge_m:
                    cohesive = False
                    break
            if not cohesive:
                break
        if not cohesive:
            out.extend(chains[m] for m in members)
            continue
        ts = np.concatenate([chains[m][0] for m in members])
        xy = np.concatenate([chains[m][1] for m in members])
        o = np.argsort(ts, kind='stable')
        ts, xy = ts[o], xy[o]
        # tolerance de-dup: drop samples <DEDUP_TS_TOL_US apart so two interleaved
        # uuids can't seed a huge start velocity in the KF (Δpos / ~µs)
        keep = np.concatenate([[True], np.diff(ts) > DEDUP_TS_TOL_US])
        out.append((ts[keep], xy[keep]))
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
                  diag: dict, roster_n: int | None = None) -> dict:
    """Chains + homography -> the public tracklets.json payload.

    t is seconds on the produced-video clock (assumes the produced video
    starts at the stream start — the aim-track pipeline's validated base);
    t0OffsetSec lets a future per-game correction shift it client-side.

    `roster_n` overrides the cap; pass the PRE-dedup estimate so the loose-high
    count is not tightened by concurrent de-dup (dedup can only lower it). When
    None it is estimated from `chains` (backward-compatible)."""
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

    # Motion-adaptive decimation, tightened until the CLIENT caps hold — an
    # over-cap artifact must never be built (a stadium-bowl venue's 26k
    # chains beat step-halving alone; see the constants block).
    move_deg, hold_s = DECIMATE_MOVE_DEG, DECIMATE_HOLD_S
    for _ in range(5):
        _decimate_objects(objects, move_deg, hold_s)
        if sum(len(o['t']) for o in objects) <= PAYLOAD_MAX_POINTS:
            break
        move_deg *= 1.5
        hold_s *= 1.5
    if sum(len(o['t']) for o in objects) > PAYLOAD_MAX_POINTS \
            or len(objects) > PAYLOAD_MAX_OBJECTS:
        raise RuntimeError(
            f'payload over client caps after decimation: {len(objects)} '
            f'objects / {sum(len(o["t"]) for o in objects)} points')

    return {
        'version': 1,
        'sampleFps': (1 / SAMPLE_DT) / step,
        't0OffsetSec': 0.0,
        'objects': objects,
        'meta': {
            'hMedianRes': round(diag['median_res'], 5),
            'matchedFrames': diag['matched_frames'],
            'evalRate': round(diag['eval']['rate'], 3) if diag.get('eval') else None,
            'nObjects': len(objects),
            # Roster cap (Tier 2a): the client shows at most this many trackers.
            # From ALL on-pitch chains PRE-dedup (dedup can only lower the count).
            'rosterN': roster_n if roster_n is not None
            else estimate_roster_n(chains),
            'officialsIncluded': True,
            'downsampled': step > 1,
            'adaptiveDecimation': {'moveDeg': round(move_deg, 4),
                                   'holdS': round(hold_s, 2)},
        },
    }


def _decimate_objects(objects: list, move_deg: float, hold_s: float) -> None:
    """In-place motion-adaptive decimation (idempotent for fixed params —
    re-running on decimated arrays keeps the same subset, so the tightening
    loop in build_payload composes)."""
    for o in objects:
        t, pan, tilt = o['t'], o['pan'], o['tilt']
        keep = [0]
        for i in range(1, len(t) - 1):
            k = keep[-1]
            if (abs(pan[i] - pan[k]) + abs(tilt[i] - tilt[k]) >= move_deg
                    or t[i] - t[k] >= hold_s):
                keep.append(i)
        if len(t) > 1:
            keep.append(len(t) - 1)
        o['t'] = [t[i] for i in keep]
        o['pan'] = [pan[i] for i in keep]
        o['tilt'] = [tilt[i] for i in keep]

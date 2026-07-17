"""Unit tests for the player-tracklets solve pipeline (2026-07-15 time-base
+ seed fixes). Run locally: python3 -m pytest test_pipeline.py -q
Not shipped in the Docker image (Dockerfile COPYes modules explicitly).
"""
import json

import numpy as np
import cv2
import pytest

import build_track
import detections
import solve_h


# ── cadence estimation ────────────────────────────────────────────────────────

def _item(idx: int, uuids: dict) -> tuple[int, bytes]:
    return idx, json.dumps(uuids).encode()


def _pts(offsets_s, xs, ys):
    return [{'timeOffset': int(o * 1e6), 'x': float(x), 'y': float(y),
             'z': 0.0} for o, x, y in zip(offsets_s, xs, ys)]


def test_cadence_16s_stream():
    # 211 items, last item holds 0.4s of content, span 3360.4s -> 16.0s
    stream = {'startTime': 0, 'stopTime': int(3360.4e6),
              'longestItemLength': 16_000_000}
    items = [_item(i, {}) for i in range(210)] + [
        _item(210, {'u': _pts([0.2, 0.4], [0, 0], [0, 0])})]
    assert build_track.estimate_cadence_us(stream, items) == 16_000_000


def test_cadence_10s_stream():
    stream = {'startTime': 0, 'stopTime': int(2100.5e6),
              'longestItemLength': 16_000_000}
    items = [_item(i, {}) for i in range(210)] + [
        _item(210, {'u': _pts([0.5], [0], [0])})]
    assert build_track.estimate_cadence_us(stream, items) == 10_000_000


def test_cadence_fallback_without_metadata():
    stream = {'longestItemLength': 16_000_000}
    items = [_item(0, {}), _item(1, {})]
    assert build_track.estimate_cadence_us(stream, items) == 16_000_000
    assert build_track.estimate_cadence_us({}, items) \
        == build_track.DEFAULT_CADENCE_US


def test_cadence_rejects_absurd_values():
    stream = {'startTime': 0, 'stopTime': int(9e12),  # 104 days
              'longestItemLength': 16_000_000}
    items = [_item(i, {}) for i in range(3)]
    assert build_track.estimate_cadence_us(stream, items) == 16_000_000


def test_cadence_empty_last_item_still_snaps_true():
    # post-final-whistle recording: last item empty, stream stop runs ~16s
    # past the last content — the raw estimate is biased +cadence/last_idx;
    # the 500ms snap grid must absorb it (100ms would emit 16.1s -> 21s
    # drift -> deterministic lag-gate failure on a GOOD game)
    stream = {'startTime': 0, 'stopTime': int(3376.6e6),
              'longestItemLength': 16_000_000}
    items = [_item(i, {}) for i in range(211)]  # all empty, last_span=0
    assert build_track.estimate_cadence_us(stream, items) == 16_000_000


def test_cadence_trailing_missing_items():
    # three trailing items missing entirely (pitch emptied): span still runs
    # to stopTime, bias ~= 3*16/207 = 0.23s -> must still snap to 16.0
    stream = {'startTime': 0, 'stopTime': int(3360.4e6),
              'longestItemLength': 16_000_000}
    items = [_item(i, {}) for i in range(207)] + [
        _item(207, {'u': _pts([0.2], [0], [0])})]
    assert build_track.estimate_cadence_us(stream, items) == 16_000_000


# ── parse_items uuid merge ────────────────────────────────────────────────────

CAD = 16_000_000


def test_uuid_merges_across_adjacent_items():
    # one player walking through two items -> ONE fragment
    a = _pts(np.arange(0.2, 16.01, 0.2), np.linspace(0, 3, 80),
             np.zeros(80))
    b = _pts(np.arange(0.2, 8.01, 0.2), np.linspace(3.05, 4.5, 40),
             np.zeros(40))
    frags = build_track.parse_items(
        [_item(0, {'u1': a}), _item(1, {'u1': b})], 0, CAD)
    assert len(frags) == 1
    ts, xy = frags[0]
    assert ts[0] == 200_000 and ts[-1] == CAD + 8_000_000
    assert len(ts) == 120


def test_uuid_split_on_missing_item():
    a = _pts([0.2, 0.4, 0.6], [0, 0.1, 0.2], [0, 0, 0])
    c = _pts([0.2, 0.4, 0.6], [0.3, 0.4, 0.5], [0, 0, 0])
    frags = build_track.parse_items(
        [_item(0, {'u1': a}), _item(2, {'u1': c})], 0, CAD)
    assert len(frags) == 2


def test_uuid_split_on_discontinuous_seam():
    # same uuid teleports 20m across the seam -> two fragments
    a = _pts(np.arange(15.0, 16.01, 0.2), np.full(6, 0.0), np.zeros(6))
    b = _pts(np.arange(0.2, 1.21, 0.2), np.full(6, 20.0), np.zeros(6))
    frags = build_track.parse_items(
        [_item(0, {'u1': a}), _item(1, {'u1': b})], 0, CAD)
    assert len(frags) == 2


def test_boundary_duplicate_sample_merges():
    # last sample of item 0 at offset 16.0s == first of item 1 at 0.0s
    a = _pts(np.arange(15.0, 16.01, 0.2), np.linspace(0, 0.5, 6), np.zeros(6))
    b = _pts(np.arange(0.0, 1.01, 0.2), np.linspace(0.5, 1.0, 6), np.zeros(6))
    frags = build_track.parse_items(
        [_item(0, {'u1': a}), _item(1, {'u1': b})], 0, CAD)
    assert len(frags) == 1
    ts, _ = frags[0]
    assert len(ts) == len(set(ts.tolist()))  # deduped on abs ts


def test_wrong_cadence_would_shift_timeline():
    # regression guard for the 10s-vs-16s bug: same items, two cadences,
    # the absolute timestamps of item-1 content must differ by 6s
    b = _pts([1.0], [0], [0])
    items = [_item(1, {'u1': _pts([1.0, 1.2, 1.4], [0, 0.1, 0.2],
                                  [0, 0, 0])})]
    f16 = build_track.parse_items(items, 0, 16_000_000)
    f10 = build_track.parse_items(items, 0, 10_000_000)
    assert f16[0][0][0] - f10[0][0][0] == 6_000_000


# ── stitching: gates + assignment ────────────────────────────────────────────

def _line_frag(t0_s, dur_s, p0, v, dt=0.2):
    """Constant-velocity fragment on the 5Hz grid."""
    n = int(round(dur_s / dt)) + 1
    ts = np.array([int(round((t0_s + k * dt) * 1e6)) for k in range(n)],
                  np.int64)
    xy = np.array([[p0[0] + v[0] * k * dt, p0[1] + v[1] * k * dt]
                   for k in range(n)], np.float64)
    return ts, xy


def _cut(frag, t_cut_s, gap_s):
    """Excise a gap -> (before, after). The break-injection primitive."""
    ts, xy = frag
    cut = ts[0] + int(t_cut_s * 1e6)
    end = cut + int(gap_s * 1e6)
    a, b = ts <= cut, ts >= end
    return (ts[a], xy[a]), (ts[b], xy[b])


def test_stitch_bridges_easy_single_gap():
    # a lone player, one clean break: the bridge is unambiguous
    a, b = _cut(_line_frag(0, 12, (0, 0), (2, 0)), 6.0, 0.6)
    chains = build_track.stitch([a, b])
    assert len(chains) == 1
    assert (chains[0][0][-1] - chains[0][0][0]) / 1e6 == pytest.approx(12, abs=0.3)


def test_stitch_refuses_beyond_gap_ceiling():
    # 3.0s > STITCH_EXT_GAP_S: past the extended ceiling, nothing bridges
    a, b = _cut(_line_frag(0, 16, (0, 0), (2, 0)), 6.0, 3.0)
    assert len(build_track.stitch([a, b])) == 2


def test_stitch_bridges_into_the_extended_range():
    # 2.0s sits in the linear envelope: unreachable before 2026-07-15, and the
    # 70-86% of real deaths that need 1.5-5s live here
    a, b = _cut(_line_frag(0, 14, (0, 0), (2, 0)), 6.0, 2.0)
    assert len(build_track.stitch([a, b])) == 1


def test_gate_rejects_past_the_ceiling_even_at_zero_distance():
    # regression: the beyond-ceiling gate must REJECT. Returning inf here (the
    # intuitive "no limit") inverts the `d_fwd > gate` test and accepts every
    # pair on the pitch — a perfect prediction (d_fwd == 0.0) must still fail.
    # This assertion is the ONLY thing that catches that inversion: a pair past
    # the ceiling is never enumerated, so the end-to-end test cannot see it.
    assert build_track.stitch_gate_m(3.0) < 0.0
    assert build_track.stitch_gate_m(float('nan')) < 0.0
    assert build_track.stitch_gate_m(1.0) == pytest.approx(2.8)
    assert build_track.stitch_gate_m(2.0) == pytest.approx(3.8)


def test_gate_step_down_at_the_handover_is_deliberate():
    # The envelope DROPS 5.30 -> 3.05 at 1.5s and is non-monotonic. The linear
    # branch is an empirical precision knob, not a continuation of the accel
    # curve. Pinned because the tempting "fix" — re-basing at gate(1.5) so it
    # joins up — would put the envelope at 6.8m at 2.5s and manufacture
    # wrong-follows. If this fails, someone smoothed the join: read
    # ceiling_eval.py before touching it.
    assert build_track.stitch_gate_m(1.5) == pytest.approx(5.3)
    assert build_track.stitch_gate_m(1.5 + 1e-9) == pytest.approx(3.05)
    assert build_track.stitch_gate_m(1.5) > build_track.stitch_gate_m(1.5 + 1e-9)
    assert build_track.stitch_gate_m(2.5) == pytest.approx(4.55)


def _two_head_race(sep_m):
    """One tail, two heads at the SAME instant in the extended range, the
    rival sep_m off the perfect prediction."""
    tail = _line_frag(0, 6, (0, 0), (2, 0))          # ends (12,0) at t=6, v=(2,0)
    h1 = _line_frag(8.0, 6, (16.0, 0.0), (2, 0))     # gap 2.0s, d_fwd = 0
    h2 = _line_frag(8.0, 6, (16.0, sep_m), (2, 0))   # d_fwd = sep_m
    frags = sorted([tail, h1, h2], key=lambda f: int(f[0][0]))
    return build_track.stitch_assign(3, build_track.stitch_edges(frags))


def test_stitch_extended_range_refuses_a_close_rival():
    # out here the ambiguity gate finally earns its keep — it fires on 0.0-0.2%
    # of real deaths today only because the 1.5s ceiling gets there first
    assert _two_head_race(0.3) == {}


def test_stitch_ambiguity_margin_is_half_a_metre_absolute():
    # characterisation, not endorsement: max(1.5*d, d + AMBIGUITY_FLOOR_M) is
    # the d+0.5 branch for any d < 1m, so "ambiguous" means "a rival within
    # 0.5m". Two players a body-width apart (0.9m) do NOT trip it — at a 2.0s
    # gap that is a thin margin, and it is a known open item: the floor was
    # calibrated for sub-metre residuals at gap->0 (sigma(d_fwd) ~ 0.09m) and
    # the extended range operates where residuals reach metres.
    # Assert the exact winner, not just non-empty: `!= {}` would also pass for
    # {0: 2}, i.e. a bridge to the WRONG head — a demotion test blind to
    # demotions, which is the precise bug this file exists to pin.
    assert _two_head_race(0.9) == {0: 1}


def _stander_to_mover(head_speed):
    """A stander, then a head leaving its exact predicted point at head_speed.
    d_fwd == 0 by construction, and d_back == head_speed * gap, so at gap 0.2
    (gate 0.88) the ONLY gate that can bite up to 4.4 m/s is VEL_CONTINUITY.
    Isolating it needs this geometry: whenever d_fwd == 0, d_back == dv * gap,
    so a coarser fixture trips the reverse check too and passes even with the
    velocity gate deleted."""
    tail = _line_frag(0, 5, (0, 0), (0, 0))
    head = _line_frag(5.2, 5, (0, 0), (head_speed, 0))
    return sorted([tail, head], key=lambda f: int(f[0][0]))


def test_stitch_refuses_velocity_discontinuity():
    # 4.2 > VEL_CONTINUITY (4.0) -> rejected, and d_back = 0.84 <= gate 0.88
    # so nothing ELSE can be doing the rejecting
    assert build_track.stitch_edges(_stander_to_mover(4.2)) == []


def test_stitch_allows_velocity_just_inside_continuity():
    # matched pair for the test above: 3.8 < 4.0 -> the edge survives. If this
    # regresses the fixture has drifted and its twin proves nothing.
    assert len(build_track.stitch_edges(_stander_to_mover(3.8))) == 1


def test_stitch_ignores_a_rival_whose_head_is_already_claimed():
    # i's rival edge to k must not veto i->j once k belongs to a strictly
    # better bridge: a claimed head is not an available alternative, so it
    # cannot make anything ambiguous. Before the fix this killed BOTH of i's
    # endpoints over a rival that no longer existed.
    i = _line_frag(0, 5, (0, 0), (0, 0))        # idx 0, ends (0, 0)
    m = _line_frag(0, 5, (0, 0.65), (0, 0))     # idx 1, ends (0, 0.65)
    j = _line_frag(5.4, 5, (0.30, 0), (0, 0))   # idx 2, d(i->j) = 0.30
    k = _line_frag(5.4, 5, (0, 0.60), (0, 0))   # idx 3, d(m->k) = 0.05
    frags = sorted([i, m, j, k], key=lambda f: int(f[0][0]))
    next_of = build_track.stitch_assign(4, build_track.stitch_edges(frags))
    # m->k wins k (0.05); i->j is then unambiguous because i->k (0.60) is dead
    assert next_of == {0: 2, 1: 3}


def test_stitch_chains_partition_fragments():
    # every input sample lands in exactly one chain, each chain time-ordered
    _, fragments, _ = _synthetic_world()
    frags = []
    for k, f in enumerate(fragments):
        a, b = _cut(f, 10.0 + k * 0.5, 0.4)
        frags += [a, b]
    chains = build_track.stitch(frags)
    for ts, xy in chains:
        assert np.all(np.diff(ts) > 0)
        assert len(ts) == len(xy)
    total_in = sum(len(f[0]) for f in frags)
    total_out = sum(len(ts) for ts, _ in chains)
    assert total_out == total_in, (total_out, total_in)


# ── synthetic geometry: seed + solve + gates ─────────────────────────────────

def _synthetic_world(n_frames=240, n_players=12, rot_deg=90.0, seed=7):
    """Players random-walking a 40x60 pitch, viewed through a projective H
    whose orientation includes the rotation the old bbox seed could not
    represent. Returns (det_frames, fragments, H_true)."""
    rng = np.random.default_rng(seed)
    a = np.radians(rot_deg)
    R = np.array([[np.cos(a), -np.sin(a), 0],
                  [np.sin(a), np.cos(a), 0], [0, 0, 1]])
    P = np.array([[0.02, 0.001, 0.1], [0.002, 0.014, 0.9],
                  [0.001, 0.004, 1.0]])
    H_true = P @ R
    pos = rng.uniform([-18, -28], [18, 28], (n_players, 2))
    vel = rng.normal(0, 1.2, (n_players, 2))
    det_frames = {}
    tracks = [[] for _ in range(n_players)]
    for k in range(n_frames):
        ts = int(k * 200_000)
        vel = 0.95 * vel + rng.normal(0, 0.35, (n_players, 2))
        pos = np.clip(pos + vel * 0.2, [-19, -29], [19, 29])
        rn = cv2.perspectiveTransform(pos[None], H_true)[0]
        rn = rn + rng.normal(0, 0.002, rn.shape)
        fake_uv = np.column_stack([np.full(n_players, 0.5),
                                   np.full(n_players, 0.5)])
        det_frames[ts] = (fake_uv, rn)
        for i in range(n_players):
            tracks[i].append((ts, pos[i, 0], pos[i, 1]))
    fragments = []
    for tr in tracks:
        ts = np.array([t for t, _, _ in tr], np.int64)
        xy = np.array([(x, y) for _, x, y in tr], np.float64)
        fragments.append((ts, xy))
    return det_frames, fragments, H_true


def test_solve_recovers_rotated_homography():
    det_frames, fragments, H_true = _synthetic_world()
    diag = solve_h.solve(det_frames, fragments)
    ev = diag['eval']
    assert ev['rate'] > 0.5, ev
    assert ev['median'] < 0.01, ev
    # projected corners agree with the true H
    corners = np.array([[-18, -28], [18, -28], [18, 28], [-18, 28]],
                       np.float64)
    p_true = cv2.perspectiveTransform(corners[None], H_true)[0]
    p_sol = cv2.perspectiveTransform(corners[None],
                                     np.asarray(diag['H'], np.float64))[0]
    assert np.median(np.linalg.norm(p_true - p_sol, axis=1)) < 0.02


def test_evaluate_fails_sheared_h():
    det_frames, fragments, H_true = _synthetic_world()
    lo, hi = solve_h.pitch_rect_metric(fragments)
    pairs = solve_h.time_paired_sets(det_frames, fragments, lo, hi)
    shear = np.array([[1.0, 0.35, 0.05], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]])
    ev_good = solve_h.evaluate(H_true, pairs, lo, hi)
    ev_bad = solve_h.evaluate(H_true @ shear, pairs, lo, hi)
    assert ev_good['rate'] > 0.5
    assert ev_bad['rate'] < 0.2
    assert all(r['n'] >= 25 for r in ev_good['regions'].values())
    assert all(r['bias'] < 0.008 for r in ev_good['regions'].values())


def test_signed_bias_catches_mild_shear():
    # a shear mild enough to keep decent match rates still leaves a coherent
    # signed offset — the bias gate is the tell the magnitude gates miss
    det_frames, fragments, H_true = _synthetic_world()
    lo, hi = solve_h.pitch_rect_metric(fragments)
    pairs = solve_h.time_paired_sets(det_frames, fragments, lo, hi)
    shear = np.array([[1.0, 0.06, 0.008], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]])
    ev = solve_h.evaluate(H_true @ shear, pairs, lo, hi)
    matched_regions = [r for r in ev['regions'].values() if r['n'] >= 25]
    assert matched_regions, ev
    assert max(r['bias'] for r in matched_regions) > 0.012, ev


def test_interp_masks_dropout_gaps():
    # fragment with a 3s intra-item dropout while moving: no invented
    # positions inside the gap
    ts = np.concatenate([np.arange(0, 1_000_001, 200_000),
                         np.arange(4_000_000, 5_000_001, 200_000)]).astype(np.int64)
    xy = np.column_stack([np.linspace(0, 15, len(ts)), np.zeros(len(ts))])
    frames = {2_500_000: (np.full((5, 2), 0.5),
                          np.random.default_rng(0).normal(0, 1, (5, 2)))}
    pairs = solve_h.time_paired_sets(frames, [(ts, xy)], [-50, -50], [50, 50])
    assert pairs == []  # the only tracklet position falls in the gap


def test_pick_windows_avoids_halftime():
    # two active halves with a dead 400s break in the middle: the solve
    # window must not straddle the break, and at least one eval window exists
    rng = np.random.default_rng(1)
    fragments = []
    for half0 in (0, 1_600_000_000):
        for i in range(8):
            ts = (half0 + np.arange(0, 1_200_000_001, 200_000)).astype(np.int64)
            steps = rng.normal(0, 0.4, (len(ts), 2))
            xy = np.cumsum(steps, axis=0)
            fragments.append((ts, xy))
    w = solve_h.pick_windows(fragments, 185.0, 65.0)
    s0, s1 = w['solve']
    dead = (1_200_000_000, 1_600_000_000)
    assert not (s0 < dead[1] and s1 > dead[0]), w  # no overlap with the break
    assert any(k != 'solve' for k in w)


def test_seed_candidates_dedupe_mirror():
    # candidates must span >1 orientation basin so the time-paired arbiter
    # can see the true H even when a mirror basin wins chamfer
    det_frames, fragments, _ = _synthetic_world()
    lo, hi = solve_h.pitch_rect_metric(fragments)
    pairs = solve_h.time_paired_sets(det_frames, fragments, lo, hi)
    Mc = solve_h._robust_core(np.vstack([m for _, m in pairs]))
    Rc = solve_h._robust_core(np.vstack([d for d, _ in pairs]))
    cands = solve_h._seed_candidates(Mc, Rc)
    assert len(cands) >= 2
    corners = np.array([[Mc[:, 0].min(), Mc[:, 1].min()],
                        [Mc[:, 0].max(), Mc[:, 1].max()]], np.float64)
    projs = [cv2.perspectiveTransform(corners[None], H.astype(np.float64))[0]
             for H in cands]
    dists = [np.linalg.norm(projs[0] - p) for p in projs[1:]]
    assert max(dists) > 0.05  # not all clones of one basin


def test_lag_peak_detects_time_shift():
    det_frames, fragments, _ = _synthetic_world(n_frames=1200)
    lag0, r0 = solve_h.lag_peak_s(det_frames, fragments, max_lag_s=30)
    assert abs(lag0) <= 1.0 and r0 > 0.3, (lag0, r0)
    # tracklet events shifted 12s LATER appear at trk bin = det bin + 12,
    # so the peak sits at lag = +12 (dprof[k] pairs with tprof[k + lag])
    shifted = [(ts + 12_000_000, xy) for ts, xy in fragments]
    lag1, r1 = solve_h.lag_peak_s(det_frames, shifted, max_lag_s=30)
    assert abs(lag1 - 12.0) <= 1.0, (lag1, r1)


# ── detections window fetch ──────────────────────────────────────────────────

def test_fetch_window_items_dense_contiguous():
    stream = {'id': 's', 'startTime': 0, 'stopTime': int(3360e6),
              'numItems': 637}
    cad = 3360e6 / 637
    fetched = []

    def fetch(idx):
        fetched.append(idx)
        ts0 = int(idx * cad)
        return json.dumps({'camera_results': [{'results': [
            {'timestamp': ts0, 'detections': []}]}]}).encode()

    w = (int(1000e6), int(1185e6))
    items = detections.fetch_window_items('g', stream, w, fetch=fetch)
    idxs = [i for i, _ in items]
    assert idxs == list(range(min(idxs), max(idxs) + 1))  # contiguous
    ts_lo = min(idxs) * cad
    ts_hi = max(idxs) * cad
    assert ts_lo <= w[0] and ts_hi + cad >= w[1] - cad  # covers the window
    assert len(idxs) <= 42


def test_fetch_window_items_missing_metadata():
    assert detections.fetch_window_items(
        'g', {'id': 's'}, (0, int(100e6)), fetch=lambda i: None) == []


# ── roster cardinality N estimate (Tier 2a) ───────────────────────────────────

def _roster_chain(t0_s, t1_s, x, y, n=24):
    ts = np.linspace(t0_s, t1_s, n) * 1e6
    xy = np.column_stack([np.full(n, float(x)), np.full(n, float(y))])
    return (ts, xy)


def test_estimate_roster_n_counts_distinct_players():
    # 10 players, each a full-span chain at a spot well past the cluster radius.
    chains = [_roster_chain(0, 60, 5 * i, 0) for i in range(10)]
    assert build_track.estimate_roster_n(chains) == 10


def test_estimate_roster_n_dedups_two_fragments_on_one_body():
    # A duplicate fragment 0.5 m from player 0 must NOT inflate the count.
    chains = [_roster_chain(0, 60, 5 * i, 0) for i in range(10)]
    chains.append(_roster_chain(0, 60, 0.5, 0))
    assert build_track.estimate_roster_n(chains) == 10


def test_estimate_roster_n_is_high_percentile_not_median():
    # 10 players all match + 2 subs present ~15% of the time (well separated).
    # The median would miss the subs; p95 sees the full field.
    chains = [_roster_chain(0, 100, 5 * i, 0) for i in range(10)]
    chains.append(_roster_chain(0, 15, 100, 0))
    chains.append(_roster_chain(0, 15, 110, 0))
    assert build_track.estimate_roster_n(chains) == 12


def test_estimate_roster_n_empty_and_degenerate():
    assert build_track.estimate_roster_n([]) == 0
    # single-instant span (t1<=t0) still counts deduped bodies
    ts = np.array([1000, 1000], dtype=float)
    a = (ts, np.array([[0.0, 0.0], [0.0, 0.0]]))
    b = (ts, np.array([[20.0, 0.0], [20.0, 0.0]]))
    assert build_track.estimate_roster_n([a, b]) == 2

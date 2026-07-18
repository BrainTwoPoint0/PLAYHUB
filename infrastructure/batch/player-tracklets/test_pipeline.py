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


def test_solve_arbitrates_basins_by_final_eval_not_subsample_score():
    # The 2026-07-17 HCT x86 incident: two seed basins near-tie on the
    # one-round subsample score and the argmax flips across platforms,
    # while the FINAL eval rates differ ~2x. Force the incident geometry:
    # candidates = [180° mirror (a REAL wrong basin — full-refines to rate
    # ~0.11), true], with the subsample score pinned constant so the stable
    # sort keeps the mirror FIRST. A refine-only-scored[0] mutant returns
    # the mirror (rate ~0.11) and fails; the final-eval arbitration refines
    # both and returns the true basin. (Recipe verified against the mutant
    # in review — a plain shear is NOT a refinement basin and made the
    # earlier version of this test vacuous.)
    det_frames, fragments, H_true = _synthetic_world()
    mirror = H_true @ np.diag([-1.0, -1.0, 1.0])
    orig_seed = solve_h._seed_candidates
    orig_score = solve_h._subsample_score
    solve_h._seed_candidates = lambda Mc, Rc: [mirror, H_true]
    solve_h._subsample_score = lambda H, pairs, **kw: 100
    try:
        diag = solve_h.solve(det_frames, fragments)
    finally:
        solve_h._seed_candidates = orig_seed
        solve_h._subsample_score = orig_score
    assert diag['eval']['rate'] > 0.5, diag['eval']
    assert len(diag['basin_rates']) >= 2
    assert diag['basin_rates'][0] == max(diag['basin_rates'])
    assert min(diag['basin_rates']) < 0.3   # the mirror stayed wrong


def test_solve_survives_one_starving_candidate():
    # a candidate whose refinement starves must be skipped, not fatal, when
    # another candidate refines fine
    det_frames, fragments, H_true = _synthetic_world()
    junk = np.array([[1e-6, 0.0, 99.0], [0.0, 1e-6, 99.0], [0.0, 0.0, 1.0]])
    orig = solve_h._seed_candidates
    solve_h._seed_candidates = lambda Mc, Rc: [junk, H_true]
    try:
        diag = solve_h.solve(det_frames, fragments)
    finally:
        solve_h._seed_candidates = orig
    assert diag['eval']['rate'] > 0.5


def test_validation_panel_picks_only_video_covered_timestamps():
    import validate_render
    start = 1_000_000_000
    dts = [start + int(s * 1e6) for s in (10, 100, 5000, 7000, 8000)]
    # video covers 5400s of the stream: 7000/8000s picks must be dropped
    assert validate_render._covered(dts, start, 5400.0) == dts[:3]
    # unknown duration -> no filtering (old behavior)
    assert validate_render._covered(dts, start, None) == dts
    # nothing covered -> empty (caller raises its loud error)
    assert validate_render._covered(dts, start + int(9e9), 5400.0) == []


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


# ── multi-camera det-uv layout (stacked strips) ──────────────────────────────

def _det_item_bytes(ts, feet):
    dets = [{'bounding_box': {'x': u - 0.01, 'y': v - 0.05,
                              'width': 0.02, 'height': 0.05}, 'label': 1}
            for u, v in feet]
    return json.dumps({'camera_results': [{'results': [
        {'timestamp': ts, 'detections': dets}]}]}).encode()


def test_strip_candidates_single_stream_identity_only():
    # single-camera scenes must be byte-identical to the pre-fix behavior
    assert detections.strip_candidates([{'id': 'a'}]) == [('identity', None)]
    assert detections.strip_candidates([]) == [('identity', None)]


def test_strip_candidates_two_streams_offers_both_assignments():
    out = detections.strip_candidates([{'id': 'aaaa'}, {'id': 'bbbb'}])
    assert out[0] == ('identity', None)
    assert len(out) == 3
    pts = np.array([[0.3, 0.4]])
    for _, tf in out[1:]:
        va, vb = tf['aaaa'](pts)[0], tf['bbbb'](pts)[0]
        assert va[0] == 0.3 and vb[0] == 0.3          # u untouched
        # one stream to the top strip, the other to the bottom
        assert {round(va[1], 2), round(vb[1], 2)} == {0.2, 0.7}
    # the two permutations assign stream 'aaaa' to DIFFERENT strips
    a_vs = sorted(round(tf['aaaa'](pts)[0][1], 2) for _, tf in out[1:])
    assert a_vs == [0.2, 0.7]


def test_strip_candidates_transform_does_not_mutate_input():
    _, tf = detections.strip_candidates([{'id': 'a'}, {'id': 'b'}])[1]
    pts = np.array([[0.3, 0.4]])
    tf['a'](pts)
    assert pts[0, 1] == 0.4


def test_parse_uv_transform_stores_vp_frame_and_drops_lens_fence():
    # 0.2 sits just above the lens fence (0.18) and must be KEPT — pins the
    # fence threshold itself, not merely its existence
    feet = [(0.2, 0.6), (0.4, 0.6), (0.6, 0.6), (0.8, 0.2), (0.5, 0.1)]
    items = [(0, _det_item_bytes(1000, feet))]
    tf = detections._strip_transform(1, 2)   # bottom strip
    frames = detections.parse_detection_items(
        items, lambda p: p.copy(), uv_transform=tf)
    fuv, rn = frames[1000]
    # the lens v=0.1 foot is a fence row in ITS OWN lens frame — dropped
    # pre-transform (post-transform it would sit at VP v=0.55 and sail past
    # any VP-frame fence mask)
    assert len(fuv) == 4
    assert np.allclose(sorted(fuv[:, 1]), [0.6, 0.8, 0.8, 0.8])  # VP-frame
    assert np.allclose(rn, fuv)              # rayn queried with VP-frame uv


def test_parse_without_transform_unchanged():
    feet = [(0.2, 0.6), (0.4, 0.6), (0.6, 0.6), (0.8, 0.1)]
    items = [(0, _det_item_bytes(1000, feet))]
    frames = detections.parse_detection_items(items, lambda p: p.copy())
    fuv, _ = frames[1000]
    assert len(fuv) == 4                     # no lens fence without transform
    assert np.allclose(fuv[3], [0.8, 0.1])   # uv stored as-is


def _mk_windows(frames):
    return {'solve': frames}


def test_choose_layout_nan_never_wins_and_first_real_replaces_nan():
    cands = [('identity', None), ('strips:a', {'a': 1}), ('strips:b', {'b': 1})]
    scores = {'identity': (0.0, float('nan')),
              'strips:a': (0.0, 0.3), 'strips:b': (0.0, 0.2)}
    calls = []

    def build(tf):
        calls.append(tf)
        return _mk_windows({1: 'frames'})
    label, tf, dw, diag = detections.choose_layout(
        cands, build, lambda pooled: scores[cands[len(calls) - 1][0]])
    assert label == 'strips:a' and tf == {'a': 1}
    assert diag['identity'] == {'lag_s': None, 'lag_r': None}
    assert diag['strips:a'] == {'lag_s': 0.0, 'lag_r': 0.3}


def test_choose_layout_all_nan_keeps_identity():
    cands = [('identity', None), ('strips:a', {'a': 1})]
    label, tf, _, _ = detections.choose_layout(
        cands, lambda t: _mk_windows({1: 'f'}),
        lambda pooled: (0.0, float('nan')))
    assert label == 'identity' and tf is None


def test_choose_layout_tie_keeps_earlier_candidate():
    cands = [('identity', None), ('strips:a', {'a': 1})]
    label, tf, _, _ = detections.choose_layout(
        cands, lambda t: _mk_windows({1: 'f'}), lambda pooled: (0.0, 0.4))
    assert label == 'identity'


def test_choose_layout_empty_parse_scores_nan_not_zero():
    # a candidate that parses ZERO frames must not outrank a NaN identity
    # (lag_peak_s({}) returns a REAL 0.0 — senior review finding)
    cands = [('identity', None), ('strips:a', {'a': 1})]

    def build(tf):
        return _mk_windows({} if tf else {1: 'f'})
    label, tf, _, diag = detections.choose_layout(
        cands, build, lambda pooled: (0.0, float('nan')))
    assert label == 'identity'
    assert diag['strips:a'] == {'lag_s': None, 'lag_r': None}


def test_choose_layout_arbitrates_on_the_real_scorer():
    # End-to-end on the ACTUAL scorer. 'bad' is the same world shifted +30s:
    # under the CONSTRAINED scan (|lag| <= 1.5s) it scores a real but low r,
    # so 'good' must win — and because 'bad' is ordered FIRST, this dies if
    # the comparison flips OR if the scan constraint is removed ('bad' would
    # then find its true peak at lag 30 and tie-keep-earlier would pick it).
    det_frames, fragments, _ = _synthetic_world(n_frames=1200)
    shifted = {ts + 30_000_000: v for ts, v in det_frames.items()}
    frames_by = {'good': det_frames, 'bad': shifted}
    label, _, _, diag = detections.choose_layout(
        [('bad', {'x': 1}), ('good', {'y': 1})],
        lambda tf: _mk_windows(frames_by['good' if tf == {'y': 1} else 'bad']),
        lambda pooled: solve_h.lag_peak_s(pooled, fragments, max_lag_s=1.5))
    assert label == 'good', diag


def test_time_paired_sets_fence_premasked_skips_vp_mask():
    det_frames, fragments, _ = _synthetic_world(n_frames=60)
    # move every stored uv above the VP fence line: default masks ALL feet,
    # premasked keeps them
    low_uv = {ts: (np.full_like(fuv, 0.05), rn)
              for ts, (fuv, rn) in det_frames.items()}
    lo, hi = solve_h.pitch_rect_metric(fragments)
    assert solve_h.time_paired_sets(low_uv, fragments, lo, hi) == []
    pairs = solve_h.time_paired_sets(low_uv, fragments, lo, hi,
                                     fence_premasked=True)
    assert len(pairs) > 0


def test_stacked_layout_correct_transform_recovers_geometry():
    # A stacked-mesh-like uv_to_rayn: the two strips are DIFFERENT lenses
    # looking at different parts of the world. Per-lens uv fed as identity
    # routes lens-frame v<0.5 content through the TOP lens's geometry.
    def uv_to_rayn(pts):
        out = np.empty_like(pts)
        top = pts[:, 1] < 0.5
        out[top] = pts[top] * [1.0, 2.0]
        out[~top] = (pts[~top] - [0.0, 0.5]) * [1.0, 2.0] + [10.0, 0.0]
        return out

    feet = [(0.2, 0.45), (0.4, 0.45), (0.6, 0.45), (0.8, 0.45)]
    items = [(0, _det_item_bytes(1000, feet))]
    # these feet belong to the BOTTOM camera: correct rayn is the +10 region
    tf = detections._strip_transform(1, 2)
    _, rn_ok = detections.parse_detection_items(
        items, uv_to_rayn, uv_transform=tf)[1000]
    assert np.all(rn_ok[:, 0] > 9.0)
    # identity mismaps them through the top lens — wrong world region
    _, rn_bad = detections.parse_detection_items(items, uv_to_rayn)[1000]
    assert np.all(rn_bad[:, 0] < 1.0)


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


def test_dedup_merges_two_overlapping_colocated_chains():
    # two fragments on ONE body (0.4 m apart, duplicate-grade), same span -> one
    a = _roster_chain(0, 60, 0.0, 0.0)
    b = _roster_chain(0, 60, 0.4, 0.0)
    out = build_track.dedup_concurrent([a, b])
    assert len(out) == 1


def test_dedup_keeps_two_distinct_separated_players():
    a = _roster_chain(0, 60, 0.0, 0.0)
    b = _roster_chain(0, 60, 20.0, 0.0)
    out = build_track.dedup_concurrent([a, b])
    assert len(out) == 2


def test_dedup_NEVER_bridges_temporally_disjoint_chains():
    # SAME position but DISJOINT in time = a slot re-use / a real gap. Merging
    # this is cross-gap identity bridging (unsafe) — dedup must NOT do it.
    a = _roster_chain(0, 10, 0.0, 0.0)
    b = _roster_chain(20, 30, 0.0, 0.0)
    assert len(build_track.dedup_concurrent([a, b])) == 2


def test_dedup_touching_chains_not_merged():
    # a.end == b.start: zero overlap (the realistic slot-reuse case) -> not merged
    a = _roster_chain(0, 10, 0.0, 0.0)
    b = _roster_chain(10, 20, 0.0, 0.0)
    assert len(build_track.dedup_concurrent([a, b])) == 2


def test_dedup_ignores_a_transient_cross():
    # two DIFFERENT players brushing close only briefly must not merge.
    a = _roster_chain(0, 60, 0.0, 0.0, n=240)
    tb = np.linspace(0, 60, 240) * 1e6
    xb = np.linspace(-30, 30, 240)           # sweeps through x=0 briefly
    b = (tb, np.column_stack([xb, np.zeros(240)]))
    assert len(build_track.dedup_concurrent([a, b])) == 2


def test_dedup_keeps_sustained_marking_pair():
    # two DISTINCT players tight-marking at 1.2 m for the whole 8 s: > the merge
    # radius, so they must NOT collapse (the close-marking identity-loss risk).
    a = _roster_chain(0, 8, 0.0, 0.0)
    b = _roster_chain(0, 8, 1.2, 0.0)
    assert len(build_track.dedup_concurrent([a, b])) == 2


def test_dedup_rejects_transitive_line_collapse():
    # a wall/line of DISTINCT players 0.6 m apart: consecutive pairs are
    # duplicate-grade but the ends are 1.2 m apart. Transitive union-find would
    # collapse them to one dot at the goal moment — the cohesion guard must not.
    chains = [_roster_chain(0, 10, 0.6 * i, 0.0) for i in range(3)]
    assert len(build_track.dedup_concurrent(chains)) == 3


def test_dedup_neighbour_of_a_duplicate_is_not_swallowed():
    # P at 0, its duplicate D at 0.4, a distinct neighbour Q at 1.0. Q must NOT
    # be merged away (invisible loss). The whole non-cohesive group is left
    # un-merged — safe over clean.
    P = _roster_chain(0, 10, 0.0, 0.0)
    D = _roster_chain(0, 10, 0.4, 0.0)
    Q = _roster_chain(0, 10, 1.0, 0.0)
    out = build_track.dedup_concurrent([P, D, Q])
    assert len(out) == 3


def test_dedup_tolerance_collapses_near_coincident_samples():
    # two interleaved uuids 0.4 m apart, timestamps offset 200 µs: the merged
    # chain must not carry <tolerance-dt sample pairs (they seed a huge KF speed).
    a = _roster_chain(0, 8, 0.0, 0.0, n=40)
    tb = np.linspace(0, 8, 40) * 1e6 + 200.0   # +200 µs
    b = (tb, np.column_stack([np.full(40, 0.4), np.zeros(40)]))
    out = build_track.dedup_concurrent([a, b])
    assert len(out) == 1
    ts = out[0][0]
    assert np.all(np.diff(ts) > build_track.DEDUP_TS_TOL_US)


def test_dedup_singleton_and_empty_passthrough():
    assert build_track.dedup_concurrent([]) == []
    one = [_roster_chain(0, 10, 0.0, 0.0)]
    assert build_track.dedup_concurrent(one) == one


def test_dedup_merged_body_count_matches_roster_estimate():
    # 10 players + 1 duplicate fragment -> dedup removes the duplicate, and the
    # roster estimate (which dedups for COUNTING) is unchanged by the merge.
    chains = [_roster_chain(0, 60, 5 * i, 0) for i in range(10)]
    chains.append(_roster_chain(0, 60, 0.4, 0))   # dup of player 0
    deduped = build_track.dedup_concurrent(chains)
    assert len(deduped) == 10
    assert build_track.estimate_roster_n(deduped) == 10


# ── Calibrated field-of-play filter ──────────────────────────────────────────

def _affine_h(rot_deg=30.0, tx=12.0, ty=-7.0):
    """Homogeneous tracker-metric -> pitch-metres map (rotation+translation)."""
    c, s = np.cos(np.radians(rot_deg)), np.sin(np.radians(rot_deg))
    return np.array([[c, -s, tx], [s, c, ty], [0.0, 0.0, 1.0]])


def test_pitch_frame_map_recovers_the_metric_to_pitch_transform():
    # Construct H_cal (pitch->ray) arbitrarily and H_job = H_cal @ T so the
    # composition must recover T exactly (up to homogeneous scale).
    T = _affine_h()
    H_cal = np.array([[0.02, 0.001, -0.4],
                      [0.002, -0.015, 0.3],
                      [0.0001, 0.0004, 1.0]])
    H_job = H_cal @ T
    P = build_track.pitch_frame_map(H_job, H_cal.tolist())
    for pt in [(0.0, 0.0), (30.0, 18.0), (-11.0, 4.5)]:
        v = P @ np.array([pt[0], pt[1], 1.0])
        expect = T @ np.array([pt[0], pt[1], 1.0])
        assert np.allclose(v / v[2], expect / expect[2], atol=1e-9)


def test_pitch_frame_map_raises_on_singular_h_cal():
    with pytest.raises(np.linalg.LinAlgError):
        build_track.pitch_frame_map(np.eye(3), np.zeros((3, 3)))


def test_filter_on_pitch_calibrated_keeps_inside_drops_outside():
    # Identity map: tracker metric IS the pitch frame (L=100, W=60).
    P = np.eye(3)
    inside = _line_frag(0, 10, (50, 30), (0.5, 0))
    outside = _line_frag(0, 10, (50, 75), (0.5, 0))   # 15 m past the far line
    out = build_track.filter_on_pitch_calibrated(
        [inside, outside], P, 100.0, 60.0, apron=0.0)
    assert out == [inside]


def test_filter_on_pitch_calibrated_apron_is_lenient():
    P = np.eye(3)
    keeper_off = _line_frag(0, 10, (-1.2, 30), (0, 0))  # 1.2 m off the goal line
    strict = build_track.filter_on_pitch_calibrated(
        [keeper_off], P, 100.0, 60.0, apron=0.0)
    lenient = build_track.filter_on_pitch_calibrated(
        [keeper_off], P, 100.0, 60.0, apron=build_track.PITCH_APRON_M)
    assert strict == []
    assert lenient == [keeper_off]


def test_filter_on_pitch_calibrated_through_a_real_transform():
    # Points expressed in tracker metric, pitch frame reached via T: an
    # on-pitch player and a spectator 10 m beyond the touchline (in PITCH
    # coords) must be classified by their PITCH positions, not tracker ones.
    T = _affine_h()
    Tinv = np.linalg.inv(T)

    def tracker(px, py):
        v = Tinv @ np.array([px, py, 1.0])
        return v[0] / v[2], v[1] / v[2]

    player = _line_frag(0, 10, tracker(40.0, 20.0), (0, 0))
    fan = _line_frag(0, 10, tracker(40.0, 70.0), (0, 0))
    out = build_track.filter_on_pitch_calibrated(
        [player, fan], T, 100.0, 60.0, apron=0.0)
    assert out == [player]


def test_filter_on_pitch_calibrated_drops_degenerate_projection():
    # A map sending the point to w≈0 must drop it, not crash or keep it.
    P = np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 1.0, -30.0]])
    frag = _line_frag(0, 10, (10.0, 30.0), (0, 0))   # w = 30 - 30 = 0
    assert build_track.filter_on_pitch_calibrated(
        [frag], P, 100.0, 60.0, apron=0.0) == []


# ── Calibration usability gate ───────────────────────────────────────────────

def _cal(err=10.0, diag_scale=1.0, **over):
    marks = [
        {'name': 'corner_nw', 'uv': [500 * diag_scale, 400]},
        {'name': 'corner_ne', 'uv': [3300 * diag_scale, 420]},
        {'name': 'corner_se', 'uv': [3500 * diag_scale, 1900]},
        {'name': 'corner_sw', 'uv': [300 * diag_scale, 1850]},
        {'name': 'midline_n', 'uv': [1900, 410]},
    ]
    cal = {'solver_version': 1, 'homography': np.eye(3).tolist(),
           'pitch_length_m': 100.0, 'pitch_width_m': 60.0,
           'reprojection_error_px': err, 'marks': marks}
    cal.update(over)
    return cal


def test_calibration_gate_accepts_good_band():
    assert build_track.calibration_unusable_reason(_cal(err=10.0)) is None


def test_calibration_gate_rejects_red_band():
    # ~3300 px corner diagonal -> 1.5% boundary ≈ 50 px; 137 px is red
    # (the live Football Plus case must stay on the percentile rect).
    reason = build_track.calibration_unusable_reason(_cal(err=137.5))
    assert reason is not None and 'red band' in reason


def test_calibration_gate_rejects_missing_and_malformed():
    assert build_track.calibration_unusable_reason(None) is not None
    assert build_track.calibration_unusable_reason(
        _cal(solver_version=2)) is not None
    assert build_track.calibration_unusable_reason(
        _cal(homography=None)) is not None
    assert build_track.calibration_unusable_reason(
        _cal(pitch_length_m=None)) is not None
    assert build_track.calibration_unusable_reason(
        _cal(reprojection_error_px='nan')) is not None


def test_calibration_gate_absolute_fallback_without_corner_marks():
    # No corner marks -> no diagonal -> absolute threshold applies.
    no_corners = _cal(err=60.0, marks=[{'name': 'midline_n', 'uv': [1, 2]}])
    assert build_track.calibration_unusable_reason(no_corners) is not None
    ok_abs = _cal(err=20.0, marks=[{'name': 'midline_n', 'uv': [1, 2]}])
    assert build_track.calibration_unusable_reason(ok_abs) is None


def test_filter_on_pitch_calibrated_drops_mirrored_negative_w():
    # A point past the composed map's horizon mirrors through the origin and
    # would land INSIDE the box if dehomogenized: w = 0.1*(-30) - 2 = -5,
    # (x, y) = (10, 6). The filter must reject w <= eps, not |w| ~ 0.
    P = np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.1, -2.0]])
    frag = _line_frag(0, 10, (-50.0, -30.0), (0, 0))
    assert build_track.filter_on_pitch_calibrated(
        [frag], P, 100.0, 60.0, apron=0.0) == []


def test_pitch_frame_map_reference_fixes_sign():
    # Same composition scaled by -1 (projectively identical): without the
    # reference the on-pitch point lands at negative w; with it, positive.
    T = _affine_h()
    H_cal = np.array([[0.02, 0.001, -0.4],
                      [0.002, -0.015, 0.3],
                      [0.0001, 0.0004, 1.0]])
    H_job = (-1.0) * (H_cal @ T)
    Tinv = np.linalg.inv(T)
    v_ref = Tinv @ np.array([50.0, 30.0, 1.0])   # tracker point == pitch centre
    ref = (v_ref[0] / v_ref[2], v_ref[1] / v_ref[2])
    P = build_track.pitch_frame_map(H_job, H_cal, ref_metric_xy=ref)
    w = P[2] @ np.array([ref[0], ref[1], 1.0])
    assert w == pytest.approx(1.0)
    frag = _line_frag(0, 10, ref, (0, 0))
    assert build_track.filter_on_pitch_calibrated(
        [frag], P, 100.0, 60.0, apron=0.0) == [frag]


def test_field_chain_apron_keeps_assistant_referee():
    # A chain median 0.8 m outside the touchline (assistant referee) must be
    # kept at the shipped FIELD_CHAIN_APRON_M and dropped at apron=0 — pins
    # the decision that the chain filter ships at the VALIDATED +2m config.
    P = np.eye(3)
    ar = _line_frag(0, 10, (50.0, -0.8), (0.5, 0))
    assert build_track.filter_on_pitch_calibrated(
        [ar], P, 100.0, 60.0, apron=0.0) == []
    assert build_track.filter_on_pitch_calibrated(
        [ar], P, 100.0, 60.0,
        apron=build_track.FIELD_CHAIN_APRON_M) == [ar]


def test_calibration_gate_relative_band_rejects_small_pitch():
    # 20px error is fine on a ~4400px diagonal but RED on a ~1000px one —
    # kills the "always use the absolute threshold" mutant (the relative
    # band is the load-bearing design decision).
    small_marks = [
        {'name': 'corner_nw', 'uv': [1000, 1000]},
        {'name': 'corner_ne', 'uv': [1800, 1020]},
        {'name': 'corner_se', 'uv': [1850, 1500]},
        {'name': 'corner_sw', 'uv': [950, 1480]},
    ]
    small = _cal(err=20.0, marks=small_marks)   # diag ~986px -> 2.0% = red
    reason = build_track.calibration_unusable_reason(small)
    assert reason is not None and 'red band' in reason
    big = _cal(err=20.0)                        # diag ~3300px -> 0.6% = ok
    assert build_track.calibration_unusable_reason(big) is None


def test_choose_filter_decision_table():
    # dry-run scenes never use the polygon and never "fall back"
    assert build_track.choose_filter(False, 1000, 10) == (False, False)
    assert build_track.choose_filter(False, 1000, 900, span_ok=False) == \
        (False, False)
    # enabled + healthy -> polygon ships (incl. a stadium-scale 73% drop)
    assert build_track.choose_filter(True, 26461, 7077) == (True, False)
    # enabled + near-total collapse (<5% of rect) -> loud fallback
    assert build_track.choose_filter(True, 1000, 49) == (False, True)
    assert build_track.choose_filter(True, 1000, 50) == (True, False)
    # enabled + span premise failed -> loud fallback even with sane counts
    assert build_track.choose_filter(True, 1000, 700, span_ok=False) == \
        (False, True)
    # empty rect edge: no count baseline -> polygon ships if span holds
    assert build_track.choose_filter(True, 0, 12) == (True, False)


def test_pitch_span_m_measures_kept_cloud():
    P = np.eye(3)
    chains = [_line_frag(0, 5, (2.0, 3.0), (0, 0)),
              _line_frag(0, 5, (95.0, 55.0), (0, 0))]
    dx, dy = build_track.pitch_span_m(chains, P)
    assert dx == pytest.approx(93.0, abs=0.5)
    assert dy == pytest.approx(52.0, abs=0.5)
    assert build_track.pitch_span_m([], P) == (0.0, 0.0)

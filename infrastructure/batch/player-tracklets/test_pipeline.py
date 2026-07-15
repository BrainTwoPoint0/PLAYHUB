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

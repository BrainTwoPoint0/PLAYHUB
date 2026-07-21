"""Unit tests for the goal-detect port: projection round-trip + sign
handling, chain determinism, and frozen-pkl load smoke under the pinned
sklearn (InconsistentVersionWarning = failure).

The pkl-dependent tests locate the frozen artifacts via GOAL_DETECT_PKL_DIR
(defaults to the research tree for local runs) and skip when absent.
Run: python -m pytest infrastructure/batch/goal-detect/ -q
"""
from __future__ import annotations

import os
import warnings

import numpy as np
import pytest

import chain as chain_mod
import projection

HERE = os.path.dirname(os.path.abspath(__file__))
_ET = os.path.normpath(os.path.join(
    HERE, '..', '..', '..', 'scripts', 'event-tagging'))
PKL_DIR = os.environ.get('GOAL_DETECT_PKL_DIR', _ET)


def _pkls():
    paths = {
        'stoppage': os.path.join(PKL_DIR, 'stoppage_clf_full.pkl'),
        'kickoff': os.path.join(PKL_DIR, 'spiideo-goal-pilot-v2',
                                'kickoff_clf.pkl'),
        'period': os.path.join(PKL_DIR, 'period_gap_clf.pkl'),
    }
    if os.environ.get('GOAL_DETECT_PKL_DIR'):
        paths['kickoff'] = os.path.join(PKL_DIR, 'kickoff_clf.pkl')
    if not all(os.path.exists(p) for p in paths.values()):
        pytest.skip('frozen pkls not available')
    return paths


# ── synthetic geometry ─────────────────────────────────────────────────────

L, W = 60.0, 40.0
# A plausible pitch-metres -> ray homography: camera off the touchline.
H_CAL = np.array([
    [0.018, 0.002, -0.55],
    [0.001, 0.006, -0.35],
    [0.0006, 0.011, 1.0],
])


def _pan_tilt_from_metres(pts):
    """Invert the projection convention: metres -> ray via H_CAL -> pan/tilt
    degrees (rx = -tan(pan), ry = -tan(tilt)/cos(pan))."""
    p = np.column_stack([pts, np.ones(len(pts))]) @ H_CAL.T
    rays = p / p[:, 2:3]
    pan = np.arctan(-rays[:, 0])
    tilt = np.arctan(-rays[:, 1] * np.cos(pan))
    return np.degrees(pan), np.degrees(tilt)


def _artifact_from_tracks(tracks):
    """tracks: list of (ts, metres[n,2]) -> tracklets.json-shaped dict."""
    objects = []
    for ts, xy in tracks:
        pan, tilt = _pan_tilt_from_metres(np.asarray(xy, float))
        objects.append({'id': f'o{len(objects)}',
                        't': [round(float(t), 2) for t in ts],
                        'pan': pan.tolist(), 'tilt': tilt.tolist()})
    return {'version': 1, 'objects': objects, 'meta': {}}


def test_projection_roundtrip():
    rng = np.random.default_rng(3)
    pts = np.column_stack([rng.uniform(2, L - 2, 40),
                           rng.uniform(2, W - 2, 40)])
    art = _artifact_from_tracks([(np.arange(40) * 0.2, pts)])
    shim = projection.load_pitch_frames(art, H_CAL, L, W)
    got = []
    for t in sorted(shim.frames):
        for r in shim.frames[t]:
            got.append((r[2] * L, r[3] * W))
    got = np.asarray(sorted(got))
    want = np.asarray(sorted(map(tuple, pts)))
    assert len(got) == len(want)
    assert np.abs(got - want).max() < 1e-6


def test_projection_sign_flip_invariant():
    """A globally negated H_cal must produce the identical shim — the sign
    normalization step, not luck, guarantees it."""
    rng = np.random.default_rng(4)
    pts = np.column_stack([rng.uniform(2, L - 2, 30),
                           rng.uniform(2, W - 2, 30)])
    art = _artifact_from_tracks([(np.arange(30) * 0.2, pts)])
    a = projection.load_pitch_frames(art, H_CAL, L, W)
    b = projection.load_pitch_frames(art, -H_CAL, L, W)
    assert a.frame_times == b.frame_times
    for t in a.frame_times:
        assert np.allclose(a.frames[t], b.frames[t])


def test_projection_garbage_rejected():
    """A wrong-scale H that lands everything off-pitch must raise, not
    silently detect on garbage geometry."""
    rng = np.random.default_rng(5)
    pts = np.column_stack([rng.uniform(2, L - 2, 30),
                           rng.uniform(2, W - 2, 30)])
    art = _artifact_from_tracks([(np.arange(30) * 0.2, pts)])
    bad = H_CAL.copy()
    bad[:2, :] *= 40.0   # blows every projected point past the apron
    with pytest.raises(projection.ProjectionError):
        projection.load_pitch_frames(art, bad, L, W)


# ── chain (needs the frozen pkls) ──────────────────────────────────────────

def _synthetic_match(seed=0, dur_s=900.0):
    """10 players random-walking on the pitch for dur_s at 5 Hz — no goals
    expected, just a structurally valid match for determinism runs."""
    rng = np.random.default_rng(seed)
    n = 10
    pos = np.column_stack([rng.uniform(5, L - 5, n),
                           rng.uniform(5, W - 5, n)])
    ts = np.arange(0.0, dur_s, 0.2)
    tracks = [[] for _ in range(n)]
    for _ in ts:
        pos = np.clip(pos + rng.normal(0, 0.25, pos.shape),
                      [1, 1], [L - 1, W - 1])
        for i in range(n):
            tracks[i].append(pos[i].copy())
    return _artifact_from_tracks(
        [(ts, np.asarray(tr)) for tr in tracks])


def test_chain_deterministic():
    import joblib
    import kickoff as ko_mod
    paths = _pkls()
    stoppage = joblib.load(paths['stoppage'])
    period = joblib.load(paths['period'])
    kom = ko_mod.load_models(paths['kickoff'])
    art = _synthetic_match()
    outs = []
    for _ in range(2):
        shim = projection.load_pitch_frames(art, H_CAL, L, W)
        eps, surv, env0, env1 = chain_mod.run_chain(shim, stoppage, kom,
                                                    period)
        outs.append((
            [(e['t0'], e['t1'], e['pko'], e['ev'], e.get('drop'))
             for e in eps],
            [(e['anchor'], e.get('p_period')) for e in surv],
            env0, env1))
    assert outs[0] == outs[1]


def test_pkl_smoke_pinned_versions():
    """Load + predict every frozen artifact with warnings-as-errors: an
    InconsistentVersionWarning (sklearn drift vs the training env) must fail
    loudly here, not silently shift predictions in production."""
    import joblib
    import kickoff as ko_mod
    paths = _pkls()
    with warnings.catch_warnings():
        warnings.simplefilter('error')
        s = joblib.load(paths['stoppage'])
        p = joblib.load(paths['period'])
        k = ko_mod.load_models(paths['kickoff'])
        n_cols = int(np.asarray(s['cmask']).sum())
        assert 0.0 <= float(
            s['clf'].predict_proba(np.zeros((1, n_cols)))[0, 1]) <= 1.0
        assert p['feats'] == ['dead_dur', 'since_live', 'pos',
                              'n_trail', 'n_min']
        assert 'kick_off' in list(k['rolefree12'].classes_)
        assert 0.0 <= ko_mod.p_kickoff(
            [(0.5 + 0.01 * i, 0.5) for i in range(8)], k) <= 1.0

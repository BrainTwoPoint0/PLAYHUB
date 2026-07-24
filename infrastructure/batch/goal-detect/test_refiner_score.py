"""Unit tests for the vendored refiner confidence scorer.

The load-bearing one is the PARITY test: the vendored episode extractor
must produce byte-identical vectors to the research source
(scripts/event-tagging/refiner/features.py) — vendored-copy drift is this
workstream's documented bug class, and a drifted feature silently shifts
every confidence the model emits.

Run: python -m pytest infrastructure/batch/goal-detect/ -q
"""
from __future__ import annotations

import importlib.util
import os

import joblib
import numpy as np
import pytest

import chain as chain_mod
import refiner_score

HERE = os.path.dirname(os.path.abspath(__file__))
RESEARCH_FEATURES = os.path.normpath(os.path.join(
    HERE, '..', '..', '..', 'scripts', 'event-tagging', 'refiner',
    'features.py'))
RESEARCH_PKL = os.path.normpath(os.path.join(
    HERE, '..', '..', '..', 'scripts', 'event-tagging', 'refiner',
    'refiner_confidence.pkl'))


def _load_research():
    if not os.path.exists(RESEARCH_FEATURES):
        pytest.skip('research features.py not available')
    spec = importlib.util.spec_from_file_location(
        'refiner_research_features', RESEARCH_FEATURES)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _synth_inputs(seed=3):
    """Structured synthetic decode: grid series with a dead ramp + two
    episodes, irregular-ish frame channels, med-dead spells."""
    rng = np.random.default_rng(seed)
    grid = np.arange(0.0, 600.0, 1.0)
    dctx = np.clip(rng.normal(0.4, 0.2, len(grid)), 0, 1)
    dctx[180:240] = np.clip(rng.normal(0.9, 0.05, 60), 0, 1)   # dead spell
    dctx[300:310] = np.nan
    pko = np.clip(rng.normal(0.2, 0.15, len(grid)), 0, 1)
    pko[220:226] = 0.8
    ev = np.clip(dctx + rng.normal(0, 0.02, len(grid)), 0, 1)
    ts = np.arange(0.0, 600.0, 0.2)
    med = np.abs(rng.normal(1.0, 0.4, len(ts)))
    med[900:1150] = 0.05                                        # lull
    nch = rng.integers(6, 12, len(ts)).astype(float)
    spells = [(180.0, 230.0), (400.0, 410.0)]
    e1 = dict(t0=220.0, t1=260.0, anchor=220.0, ts=[220.0, 240.0, 260.0],
              ps=[0.8, 0.6, 0.55], pko=0.8, ev=0.95, p_period=0.1,
              sub_anchors=[220.0, 260.0], sub_anchor_pko=[0.8, 0.55])
    e2 = dict(t0=430.0, t1=430.0, anchor=430.0, ts=[430.0], ps=[0.62],
              pko=0.62, ev=0.9, p_period=0.05, sub_anchors=[430.0],
              sub_anchor_pko=[0.62])
    dropped = dict(t0=50.0, t1=55.0, anchor=50.0, ts=[50.0], ps=[0.5],
                   pko=0.5, ev=0.85, drop='opening',
                   sub_anchors=[50.0], sub_anchor_pko=[0.5])
    all_eps = [dropped, e1, e2]
    return dict(grid=grid, pko=pko, dctx=dctx, ev=ev, ts=ts, med=med,
                nch=nch, spells=spells, survivors=[e1, e2],
                all_eps=all_eps, env0=10.0, env1=580.0)


def _geom12(t):
    rng = np.random.default_rng(int(t))
    v = rng.uniform(0, 1, len(refiner_score.GEOM12_KEYS))
    v[0] = 10.0
    return v


def test_episode_features_parity_with_research_source():
    research = _load_research()
    s = _synth_inputs()
    n_med, med_med = 8.0, float(np.nanmedian(s['med']))
    dctx_sorted = np.sort(s['dctx'][np.isfinite(s['dctx'])])
    assert refiner_score.EP_KEYS == research.EP_KEYS
    assert refiner_score.EP_ABS_DCTX == research.EP_ABS_DCTX
    for e in s['survivors']:
        a = refiner_score.episode_features(
            e, s['grid'], s['pko'], s['dctx'], s['ev'], s['ts'], s['med'],
            s['nch'], s['env0'], s['env1'], s['spells'], s['all_eps'],
            n_med, med_med, dctx_sorted, _geom12)
        b = research.episode_features(
            e, s['grid'], s['pko'], s['dctx'], s['ev'], s['ts'], s['med'],
            s['nch'], s['env0'], s['env1'], s['spells'], s['all_eps'],
            n_med, med_med, dctx_sorted, _geom12)
        np.testing.assert_array_equal(a, b)


def test_constants_match_chain():
    assert refiner_score.FRAME_TOL_S == chain_mod.FRAME_TOL_S
    assert refiner_score.MIN_PLAYERS == chain_mod.MIN_PLAYERS


class _DummyClf:
    def predict_proba(self, X):
        assert X.shape == (1, len(refiner_score.NORM_ONLY_KEYS))
        return np.array([[0.3, 0.7]])


def test_score_episodes_scores_and_degrades_per_episode():
    s = _synth_inputs()
    X = np.zeros((len(s['ts']), len(chain_mod.CHANNELS)))
    X[:, refiner_score.I_MED] = s['med']
    X[:, refiner_score.I_N] = s['nch']
    series = (s['grid'], s['pko'], s['dctx'], s['ev'], s['ts'], X)
    broken = dict(s['survivors'][1])
    del broken['pko']                       # KeyError inside the extractor
    survivors = [s['survivors'][0], broken]
    art = dict(clf=_DummyClf(), variant='norm_only')
    out = refiner_score.score_episodes(
        art, survivors, s['all_eps'], s['env0'], s['env1'], series,
        lambda t: np.full(len(refiner_score.GEOM12_KEYS), np.nan))
    assert out[220.0] == pytest.approx(0.7)
    assert out[broken['anchor']] is None    # degraded, not raised


def test_load_model_fails_closed_on_key_skew(tmp_path):
    fp = tmp_path / 'skewed.pkl'
    joblib.dump(dict(clf=object(), ep_keys=['wrong', 'keys'],
                     variant='norm_only'), fp)
    with pytest.raises(ValueError, match='feature skew'):
        refiner_score.load_model(str(fp))
    ok = tmp_path / 'ok.pkl'
    joblib.dump(dict(clf=object(), ep_keys=refiner_score.NORM_ONLY_KEYS,
                     variant='norm_only'), ok)
    assert refiner_score.load_model(str(ok))['variant'] == 'norm_only'


def test_banked_pickle_passes_skew_check_and_scores():
    """The ACTUAL banked artifact must load under the shipped module and
    emit probabilities — catches an image/pickle mismatch before deploy."""
    if not os.path.exists(RESEARCH_PKL):
        pytest.skip('refiner_confidence.pkl not built')
    art = refiner_score.load_model(RESEARCH_PKL)
    s = _synth_inputs()
    X = np.zeros((len(s['ts']), len(chain_mod.CHANNELS)))
    X[:, refiner_score.I_MED] = s['med']
    X[:, refiner_score.I_N] = s['nch']
    series = (s['grid'], s['pko'], s['dctx'], s['ev'], s['ts'], X)
    out = refiner_score.score_episodes(
        art, s['survivors'], s['all_eps'], s['env0'], s['env1'], series,
        _geom12)
    for e in s['survivors']:
        v = out[e['anchor']]
        assert v is not None and 0.0 <= v <= 1.0


class _Shim:
    def __init__(self, frames):
        self.frames = frames
        self.frame_times = sorted(frames)


def test_geom12_from_shim_frame_pick_and_projection():
    """Pins geom12_from_shim to chain.series' frame-pick semantics (best
    of the two neighbors within FRAME_TOL_S by player count, n >=
    MIN_PLAYERS) and to the restart_geometry rolefree12 projection."""
    from restart_geometry import feats as rg_feats, FEATURE_KEYS as RG_KEYS
    rows8 = [[i, 1, 0.1 * i + 0.05, 0.5] for i in range(8)]
    rows5 = [[i, 1, 0.2, 0.2] for i in range(5)]
    g = refiner_score.geom12_from_shim(
        _Shim({10.0: rows5, 10.3: rows8, 50.0: rows5}))
    v = g(10.2)          # both neighbors in tolerance -> larger-n frame
    f = rg_feats([[i, 1, float(r[2]), float(r[3])]
                  for i, r in enumerate(rows8)])
    exp = [f[k] for k in RG_KEYS if k not in ("gk_min_dgl", "gk_cy")]
    np.testing.assert_allclose(v, exp)
    assert np.isnan(g(50.0)).all()      # 5 players < MIN_PLAYERS
    assert np.isnan(g(30.0)).all()      # no frame within FRAME_TOL_S


def test_run_chain_default_shape_unchanged():
    """The additive return_series kwarg must not change the default
    4-tuple contract (all production/test callers unpack 4)."""
    import inspect
    sig = inspect.signature(chain_mod.run_chain)
    assert sig.parameters['return_series'].default is False
    # and the series variant appends exactly one element (the 6-tuple)
    import test_chain as tc
    import kickoff as ko_mod
    paths = tc._pkls()
    stoppage = joblib.load(paths['stoppage'])
    period = joblib.load(paths['period'])
    kom = ko_mod.load_models(paths['kickoff'])
    art = tc._synthetic_match()
    import projection
    shim = projection.load_pitch_frames(art, tc.H_CAL, tc.L, tc.W)
    out4 = chain_mod.run_chain(shim, stoppage, kom, period)
    out5 = chain_mod.run_chain(shim, stoppage, kom, period,
                               return_series=True)
    assert len(out4) == 4 and len(out5) == 5
    assert len(out5[4]) == 6
    # decode identical either way
    assert [(e['t0'], e['t1'], e.get('drop')) for e in out4[0]] == \
           [(e['t0'], e['t1'], e.get('drop')) for e in out5[0]]

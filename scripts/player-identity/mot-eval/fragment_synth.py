"""Synthesize Spiideo-like fragmentation on Veo GT runs.

The load-bearing requirement (locked contract): cuts must be
CROSSING-CORRELATED — 59% of real Spiideo chain deaths happen with
another player nearby (metric proxy: < 2m, the ceiling_eval definition
that matched real deaths at 51-83%). Uniform-random cuts would produce
mostly easy isolated-player gaps and inflate every score.

Hazard model: per-sample death probability q(t) = q0 * (1 + beta *
crowded(t)). Two moment conditions identify (q0, beta):
    mean fragment lifetime  ~ LIFE_S      (Spiideo mints a fresh uuid
                                           every ~22s per player)
    crowded-death fraction  ~ CROWD_FRAC  (~0.59)
Closed-form init, then a short simulation polish. Gap lengths are drawn
INDEPENDENTLY from the measured shape (mass at 1.5-5s = the 70-86% of
deaths whose continuation is beyond the stitch ceiling, plus a
bridgeable <=1.5s share). Marginals are validated against the measured
targets before any score may be quoted — validate_marginals is a HARD
GATE, not a report.

Noise: Veo positions carry their own noise; adding the full Spiideo
sigma would double-count. estimate_veo_sigma measures Veo's floor on
near-stationary windows (4th-difference kernel — lower-order diffs eat
real acceleration at 0.4s spacing) and the synthesizer tops up in
quadrature to SIGMA_TARGET_M. A zero-added-noise arm belongs in the
baseline runs; if rankings are insensitive, the question is closed.
"""
from __future__ import annotations

from collections import defaultdict

import numpy as np

DT_S = 0.4                 # the 2.5Hz lattice
LIFE_S = 22.0              # measured: fresh uuid every ~22s per player
CROWD_FRAC = 0.59          # measured: deaths with another player nearby
CROWD_D_M = 2.0            # metric crowding proxy (ceiling_eval def)
SIGMA_TARGET_M = 0.06      # Spiideo noise floor (on smoothed output)
MIN_FRAG_SAMPLES = 3       # matches build_track.MIN_FRAGMENT_SAMPLES
# Gap mixture: (weight, lo_s, hi_s). Shape, not precise numbers (the
# measured 70-86% beyond-ceiling figure carries its own caveat).
GAP_MIX = ((0.25, 0.4, 1.5), (0.60, 1.5, 5.0), (0.15, 5.0, 12.0))


def frame_index(runs: list) -> dict:
    """{t_us: [(gid, xy)]} across all runs — the shared per-frame world."""
    idx = defaultdict(list)
    for gid, ts, xy in runs:
        for i in range(len(ts)):
            idx[int(ts[i])].append((gid, xy[i]))
    return idx


def crowded_mask(runs: list, idx: dict, d_m: float = CROWD_D_M) -> list:
    """Per-run boolean arrays: sample has ANOTHER gid within d_m."""
    out = []
    for gid, ts, xy in runs:
        m = np.zeros(len(ts), bool)
        for i in range(len(ts)):
            for g2, p2 in idx[int(ts[i])]:
                if g2 != gid and np.hypot(*(p2 - xy[i])) < d_m:
                    m[i] = True
                    break
        out.append(m)
    return out


def fit_hazard(crowd: list, life_s: float = LIFE_S,
               crowd_frac: float = CROWD_FRAC) -> tuple:
    """(q0, beta) from the two moment conditions. p = crowded occupancy.
    crowded-death fraction = p(1+b)/(1+pb); mean lifetime = dt/(q0(1+pb))."""
    total = sum(len(m) for m in crowd)
    p = sum(int(m.sum()) for m in crowd) / max(total, 1)
    if not p < crowd_frac:
        # occupancy already exceeds the death fraction — crowding needs no
        # boost (or the proxy distance is too wide for this match)
        return DT_S / life_s, 0.0, p
    beta = (crowd_frac - p) / (p * (1.0 - crowd_frac))
    q0 = DT_S / (life_s * (1.0 + p * beta))
    return q0, beta, p


def estimate_veo_sigma(runs: list) -> float:
    """Veo's own noise floor from near-stationary windows via the
    4th-difference kernel (var(d4) = 70 sigma^2 for white noise; lower
    orders eat real acceleration at 0.4s spacing)."""
    d4s = []
    for _, ts, xy in runs:
        if len(ts) < 12:
            continue
        for s in range(0, len(ts) - 10, 10):
            w = xy[s:s + 10]
            if np.linalg.norm(w[-1] - w[0]) < 0.5:   # near-stationary
                for axis in range(2):
                    d4 = np.diff(w[:, axis], n=4)
                    d4s.extend(d4.tolist())
    if len(d4s) < 50:
        return 0.0
    return float(np.std(d4s) / np.sqrt(70.0))


def sample_gap_s(rng) -> float:
    r = rng.random()
    acc = 0.0
    for w, lo, hi in GAP_MIX:
        acc += w
        if r <= acc:
            return rng.uniform(lo, hi)
    return rng.uniform(*GAP_MIX[-1][1:])


def synthesize(runs: list, crowd: list, q0: float, beta: float,
               sigma_add_m: float, seed: int = 0) -> tuple:
    """-> (fragments [(ts_us, xy)], frag_gids [gid per fragment],
    cut_records [(gid, t_us, crowded)]).

    Walks each GT run; each sample dies with probability
    q0*(1+beta*crowded); a death opens a gap (samples dropped) drawn from
    GAP_MIX, then a new fragment begins. Same-gid fragments NEVER re-link
    here — that is the stitcher's job to attempt and the scorer's job to
    judge. Added noise is white; fragments shorter than MIN_FRAG_SAMPLES
    are dropped (as production's parse does).
    """
    rng = np.random.default_rng(seed)
    fragments, frag_gids, cuts = [], [], []
    for (gid, ts, xy), cm in zip(runs, crowd):
        noisy = xy + rng.normal(0.0, sigma_add_m, xy.shape) \
            if sigma_add_m > 0 else xy
        i, n = 0, len(ts)
        while i < n:
            j = i
            while j < n:
                if rng.random() < q0 * (1.0 + beta * float(cm[j])):
                    cuts.append((gid, int(ts[j]), bool(cm[j])))
                    break
                j += 1
            # fragment = [i, j) inclusive of j? the death sample is the
            # LAST observed sample (the tracker saw them, then lost them)
            end = min(j + 1, n)
            if end - i >= MIN_FRAG_SAMPLES:
                fragments.append((ts[i:end].copy(), noisy[i:end].copy()))
                frag_gids.append(gid)
            if j >= n:
                break
            gap = sample_gap_s(rng)
            t_resume = ts[j] + gap * 1e6
            i = int(np.searchsorted(ts, t_resume))
            if i <= j:
                i = j + 1
    order = np.argsort([int(f[0][0]) for f in fragments])
    fragments = [fragments[k] for k in order]
    frag_gids = [frag_gids[k] for k in order]
    return fragments, frag_gids, cuts


def validate_marginals(fragments: list, frag_gids: list, cuts: list,
                       runs: list) -> dict:
    """HARD GATE: synthetic marginals vs measured targets. Raises on
    violation — no score may be quoted from an unvalidated synthesis."""
    durs = sorted((f[0][-1] - f[0][0]) / 1e6 for f in fragments)
    med_dur = durs[len(durs) // 2]
    mean_life = float(np.mean([(f[0][-1] - f[0][0]) / 1e6 + DT_S
                               for f in fragments]))
    crowded_deaths = sum(1 for _, _, c in cuts if c) / max(len(cuts), 1)
    # per-gid gap lengths between consecutive fragments
    per_gid = defaultdict(list)
    for f, g in zip(fragments, frag_gids):
        per_gid[g].append((int(f[0][0]), int(f[0][-1])))
    gaps = []
    for g, spans in per_gid.items():
        spans.sort()
        for a, b in zip(spans, spans[1:]):
            gaps.append((b[0] - a[1]) / 1e6)
    gaps = np.asarray(gaps) if gaps else np.asarray([0.0])
    beyond_ceiling = float(np.mean((gaps > 1.5) & (gaps <= 5.0)))
    table = {
        'fragments': len(fragments),
        'fragMedianDurS': round(med_dur, 1),        # target ~8-16
        'fragMeanLifeS': round(mean_life, 1),       # target ~22
        'crowdedDeathFrac': round(crowded_deaths, 3),  # target ~0.59
        'gapMass_1.5_5s': round(beyond_ceiling, 3),    # target ~0.6-0.86
        'gapMedianS': round(float(np.median(gaps)), 2),
    }
    print('synth marginals:', table)
    assert 6.0 <= med_dur <= 20.0, f'fragment duration median {med_dur}'
    assert 14.0 <= mean_life <= 30.0, f'mean fragment life {mean_life}'
    assert 0.45 <= crowded_deaths <= 0.72, \
        f'crowded-death fraction {crowded_deaths}'
    assert beyond_ceiling >= 0.45, f'gap mass 1.5-5s {beyond_ceiling}'
    return table

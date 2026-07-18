"""Kit change-point chain SPLITTING — conservative repair of body-impure
chains (green-field for B3; B2 only REFUSED them).

A chain whose own crops disagree about what kit they show has crossed bodies
(wrong stitch bridge / association steal — measured: 10-21% per-bridge swap
compounding makes body-impure chains COMMON). B2's kit-consistency gate
refuses such chains any label. Splitting recovers the honest case: when the
kit sequence flips EXACTLY ONCE and the flip coincides with a stitch seam,
cut the chain there and both segments become independently labelable.

Design rule (§3): prefer honest refusal over a wrong split. ALL of these must
hold or the chain stays whole (and label-refused by the consistency gate):

  1. Exactly one change-point: the time-ordered crop kits partition into two
     segments, each with >= MIN_SEG_CROPS crops at >= SEG_CONSISTENCY
     majority consistency, with DIFFERENT majority kits — and every valid
     boundary position agrees on the same (kitA, kitB) pair and forms one
     contiguous run (two flips / noise -> refuse).
  2. The flip snaps to a plausible stitch seam: exactly ONE time gap
     > SEAM_GAP_US in the chain's samples STRICTLY INSIDE the flip bracket
     [flip_lo, flip_hi] (the body swap is inside the bracket by
     construction — the clocks share a base, so any tolerance beyond it
     only ever admits wrong cuts; no seam inside means kit-feature noise;
     several means the cut point is ambiguous) -> refuse.
  3. Both resulting segments still span >= min_span_s (else the short side
     would be silently dropped downstream) -> refuse.

Every decision — accepted and refused, with evidence — is returned for the
provenance log (`jersey-labels.json`), the eyes-on audit trail.
"""
from __future__ import annotations

from collections import Counter

import numpy as np

MIN_SEG_CROPS = 3
SEG_CONSISTENCY = 0.9
# Just above the nominal 2.5Hz step (0.4s): real stitch bridges span
# 0.4-2.5s, and most are SHORT — a higher floor (the first cut used 1.2s)
# missed the true joint and let an unrelated far gap take the cut. A low
# floor admits more candidate seams, and with the strictly-inside-bracket
# rule more candidates can only produce more ambiguity REFUSALS — the
# conservative direction (CV review, 2026-07-18).
SEAM_GAP_US = 0.5e6


def _majority(kits: list) -> tuple:
    """(majority kit, consistency fraction)."""
    top, n = Counter(kits).most_common(1)[0]
    return top, n / len(kits)


def find_change_point(crop_ts: list, crop_kits: list) -> dict:
    """Locate a single kit change-point in the time-ordered crop sequence.

    Returns {'found': bool, 'reason': str, ...}; on success adds
    'kit_a', 'kit_b', 'flip_lo_us', 'flip_hi_us' (the bracket within which
    the body swap happened).
    """
    order = np.argsort(crop_ts)
    ts = [crop_ts[i] for i in order]
    ks = [crop_kits[i] for i in order]
    n = len(ks)
    if n < 2 * MIN_SEG_CROPS:
        return {'found': False, 'reason': f'too few crops ({n})'}

    candidates = []
    pairs = set()
    for b in range(MIN_SEG_CROPS, n - MIN_SEG_CROPS + 1):
        ka, fa = _majority(ks[:b])
        kb, fb = _majority(ks[b:])
        if ka == kb or fa < SEG_CONSISTENCY or fb < SEG_CONSISTENCY:
            continue
        candidates.append(b)
        pairs.add((ka, kb))
    if not candidates:
        return {'found': False, 'reason': 'no consistent two-kit partition'}
    if len(pairs) > 1:
        return {'found': False,
                'reason': f'multiple change-points ({sorted(pairs)})'}
    if candidates != list(range(candidates[0], candidates[-1] + 1)):
        return {'found': False, 'reason': 'non-contiguous boundary run'}
    ka, kb = next(iter(pairs))
    return {'found': True, 'reason': 'ok', 'kit_a': ka, 'kit_b': kb,
            'flip_lo_us': float(ts[candidates[0] - 1]),
            'flip_hi_us': float(ts[candidates[-1]])}


def seam_indices(ts: np.ndarray) -> list:
    """Sample indices i where the gap ts[i+1]-ts[i] exceeds SEAM_GAP_US —
    the bridged stitch joints (raw chains keep real timestamps; bridges are
    only interpolated later in smooth_and_resample)."""
    dt = np.diff(np.asarray(ts, float))
    return [int(i) for i in np.nonzero(dt > SEAM_GAP_US)[0]]


def propose_split(chain: tuple, crop_ts: list, crop_kits: list,
                  min_span_s: float) -> dict:
    """Full split decision for one chain. Returns a decision dict:
    {'accepted': bool, 'reason': str, ...}; on acceptance adds 'seam_idx'
    (split AFTER this sample index), 'split_t_us', 'kit_a', 'kit_b'."""
    ts = np.asarray(chain[0], float)
    cp = find_change_point(crop_ts, crop_kits)
    if not cp['found']:
        return {'accepted': False, 'reason': cp['reason']}

    # STRICTLY inside the flip bracket — the swap happened between the last
    # kit-A crop and the first kit-B crop; a seam outside that window is
    # provably not the swap.
    lo = cp['flip_lo_us']
    hi = cp['flip_hi_us']
    near = [i for i in seam_indices(ts)
            if lo < (ts[i] + ts[i + 1]) / 2 < hi]
    if len(near) == 0:
        return {'accepted': False,
                'reason': 'no stitch seam inside the kit flip (feature noise?)',
                'kit_a': cp['kit_a'], 'kit_b': cp['kit_b']}
    if len(near) > 1:
        return {'accepted': False,
                'reason': f'{len(near)} seams inside the flip — ambiguous cut',
                'kit_a': cp['kit_a'], 'kit_b': cp['kit_b']}
    i = near[0]
    split_t = (ts[i] + ts[i + 1]) / 2
    span_a = (ts[i] - ts[0]) / 1e6
    span_b = (ts[-1] - ts[i + 1]) / 1e6
    if span_a < min_span_s or span_b < min_span_s:
        return {'accepted': False,
                'reason': f'segment too short ({span_a:.1f}s / {span_b:.1f}s)',
                'kit_a': cp['kit_a'], 'kit_b': cp['kit_b']}
    return {'accepted': True, 'reason': 'ok', 'seam_idx': i,
            'split_t_us': float(split_t),
            'kit_a': cp['kit_a'], 'kit_b': cp['kit_b'],
            'span_a_s': round(span_a, 1), 'span_b_s': round(span_b, 1)}


def apply_splits(chains: list, decisions: dict) -> tuple:
    """Apply accepted split decisions ({chain_idx: decision}) to the chain
    list. Returns (new_chains, index_map) where index_map[old_idx] is either
    a single new index (unsplit) or (idx_a, idx_b, split_t_us)."""
    new_chains: list = []
    index_map: dict = {}
    for ci, (ts, xy) in enumerate(chains):
        d = decisions.get(ci)
        if not d or not d.get('accepted'):
            index_map[ci] = len(new_chains)
            new_chains.append((ts, xy))
            continue
        i = d['seam_idx']
        a = (ts[:i + 1], xy[:i + 1])
        b = (ts[i + 1:], xy[i + 1:])
        index_map[ci] = (len(new_chains), len(new_chains) + 1,
                         d['split_t_us'])
        new_chains.append(a)
        new_chains.append(b)
    return new_chains, index_map


def remap_records(records: list, index_map: dict) -> None:
    """Reassign crop records' chain ids in place after apply_splits: a crop
    on a split chain lands in the segment its timestamp falls in."""
    for r in records:
        m = index_map.get(r['chain'])
        if m is None:
            continue
        if isinstance(m, tuple):
            ia, ib, split_t = m
            r['chain'] = ia if r['t_us'] <= split_t else ib
        else:
            r['chain'] = m

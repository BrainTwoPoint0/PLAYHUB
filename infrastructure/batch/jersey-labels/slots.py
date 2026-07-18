"""Strict chain labelling + (number, kit) slot assembly (B2, measured).

The deployment read population (twice-earned rule): solo, on-pitch, in-match,
conf >= 0.9, legibility >= LEG_GATE, within the play gate, and the read's own
crop-kit must match its chain's majority kit. STRICT chain label = >= 2 reads
AND a strict majority — a single read carries ~9% error into ~35 occupied
numbers, so single-read labels are guesses and a guess stays honest-unlabelled.

Kit-consistency gate: a chain with >= MIN_KIT_CROPS crop-kit assignments whose
majority fraction < KIT_CONSISTENCY_MIN crossed bodies -> REFUSES any label
(split.py may have repaired it first; whatever remains inconsistent is refused).

Slot key = (number, kit cluster). Slot ids are the client-facing strings:
kit-cluster letter ('a', 'b', ...) + number, e.g. "a10". Cluster -1 ('other'
kit) never receives a slot — merging unknown-kit strangers under one number
is exactly the wrong-body failure the kit key exists to prevent.

Within-slot concurrency splitting (the duplicate-'10' reality): two co-slot
chains overlapping >= OVLP_S with median separation > SEP_M are two BODIES
wearing the same (number, kit). The slot is split into per-body sub-slots
("a10", "a10-2") via connected components of the duplicate-fragment relation
(sep <= SEP_M = same body), so a follow never teleports between two real
players who share a shirt number.
"""
from __future__ import annotations

from collections import Counter, defaultdict

import numpy as np

CONF = 0.9
LEG_GATE = 0.6
PLAY_GATE_M = 25.0
OVLP_S = 2.0
SEP_M = 3.0
KIT_CONSISTENCY_MIN = 0.8
MIN_KIT_CROPS = 3


def confident(records: list) -> list:
    return [r for r in records
            if r.get('conf', 0.0) >= CONF and str(r.get('read', '')).isdigit()
            and 1 <= len(str(r['read'])) <= 2
            and r.get('on_pitch') and r.get('in_match')
            and r.get('leg', 0.0) >= LEG_GATE]


def deployment_reads(records: list) -> list:
    """Confident + play-gated, deduped per (chain, second) keeping max conf."""
    ok = [r for r in confident(records)
          if r.get('play_dist') is not None
          and r['play_dist'] <= PLAY_GATE_M]
    best: dict = {}
    for r in ok:
        k = (r['chain'], int(r['t_vp']))
        if k not in best or r['conf'] > best[k]['conf']:
            best[k] = r
    return list(best.values())


def chain_kit_profile(records: list) -> dict:
    """{chain: (majority crop-kit, consistency fraction, n crops)} over
    records carrying a 'kit' assignment."""
    per = defaultdict(list)
    for r in records:
        k = r.get('kit')
        if k is not None:
            per[r['chain']].append(k)
    out = {}
    for c, ks in per.items():
        top, n = Counter(ks).most_common(1)[0]
        out[c] = (top, n / len(ks), len(ks))
    return out


def kit_inconsistent_chains(kit_prof: dict) -> set:
    return {c for c, (_, frac, n) in kit_prof.items()
            if n >= MIN_KIT_CROPS and frac < KIT_CONSISTENCY_MIN}


def chain_label(reads_of_chain: list, kit_of_chain: int):
    """STRICT label (number, kit) or None. >= 2 reads, strict majority,
    unique top."""
    if not reads_of_chain:
        return None
    cnt = Counter(str(r['read']) for r in reads_of_chain)
    num, top = cnt.most_common(1)[0]
    if (len(reads_of_chain) < 2 or top * 2 <= len(reads_of_chain)
            or sum(1 for v in cnt.values() if v == top) > 1):
        return None
    return (num, kit_of_chain)


def build_labels(records: list) -> tuple:
    """records (post-split remap, with read/conf/leg/kit/on_pitch/in_match/
    play_dist) -> ({chain: (number, kit)}, diagnostics dict).

    Applies: deployment gates, kit-consistency refusal, per-read kit-match
    gate, strict majority. Chains with kit -1 or no kit profile get NO label.
    """
    kit_prof = chain_kit_profile(records)
    impure = kit_inconsistent_chains(kit_prof)

    def gated(reads):
        return [r for r in reads if r['chain'] not in impure
                and r.get('kit') is not None
                and r['kit'] == kit_prof.get(r['chain'], (None,))[0]]

    dep = deployment_reads(records)
    n_dep0 = len(dep)
    dep = gated(dep)
    by_chain = defaultdict(list)
    for r in dep:
        by_chain[r['chain']].append(r)
    # The same population WITHOUT the legibility gate: removing reads is not
    # purely conservative under strict-majority (dropping a tied rival can
    # MINT a label the ungated set refused) — a label must hold as a strict
    # majority in both views (CV review, 2026-07-18).
    saved = globals()['LEG_GATE']
    globals()['LEG_GATE'] = 0.0
    try:
        noleg_by_chain = defaultdict(list)
        for r in gated(deployment_reads(records)):
            noleg_by_chain[r['chain']].append(r)
    finally:
        globals()['LEG_GATE'] = saved

    labels: dict = {}
    n_weak = 0
    for c, rs in by_chain.items():
        kc = kit_prof.get(c, (-1,))[0]
        if kc is None or kc < 0:
            continue
        lab = chain_label(rs, kc)
        if lab is not None:
            ungated = chain_label(noleg_by_chain.get(c, []), kc)
            if ungated is None or ungated[0] != lab[0]:
                n_weak += 1  # only-with-gate mint — refuse
                continue
            labels[c] = lab
        else:
            n_weak += 1
    diag = {
        'kitInconsistentRefused': len(impure),
        'deploymentReads': n_dep0,
        'kitMatchedReads': len(dep),
        'labelledChains': len(labels),
        'weakUnlabelled': n_weak,
    }
    return labels, diag


def overlap_sep(chain_a: tuple, chain_b: tuple):
    """(overlap_s, median metric separation) over the common time window."""
    ta, xa = chain_a
    tb, xb = chain_b
    lo = max(ta[0], tb[0])
    hi = min(ta[-1], tb[-1])
    if hi - lo < OVLP_S * 1e6:
        return 0.0, None
    grid = np.linspace(lo, hi, max(int((hi - lo) / 1e6 * 2), 4))
    pa = np.stack([np.interp(grid, ta, xa[:, 0]),
                   np.interp(grid, ta, xa[:, 1])], axis=1)
    pb = np.stack([np.interp(grid, tb, xb[:, 0]),
                   np.interp(grid, tb, xb[:, 1])], axis=1)
    sep = float(np.median(np.linalg.norm(pa - pb, axis=1)))
    return (hi - lo) / 1e6, sep


def slot_letter(kit_cluster: int) -> str:
    return chr(ord('a') + kit_cluster)


def assign_slots(labels: dict, chains: list) -> tuple:
    """{chain: slot_id_string} + diagnostics. Within one (number, kit) group,
    chains are partitioned into BODIES: connected components under
    "concurrent within SEP_M" (duplicate fragments of one body). Components
    that overlap in time but sit apart are different bodies -> distinct
    sub-slot ids ("a10", "a10-2"). Non-overlapping chains join the largest
    component (the label's whole point: identity across gaps)."""
    groups = defaultdict(list)
    for c, (num, kc) in labels.items():
        groups[(num, kc)].append(c)

    slot_of: dict = {}
    n_conflict_groups = 0
    for (num, kc), cs in sorted(groups.items()):
        base = f'{slot_letter(kc)}{num}'
        # adjacency: concurrent + close = same body
        parent = {c: c for c in cs}

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        conflict_pairs = []
        has_overlap_evidence = set()
        for i in range(len(cs)):
            for j in range(i + 1, len(cs)):
                ov, sep = overlap_sep(chains[cs[i]], chains[cs[j]])
                if ov < OVLP_S or sep is None:
                    continue
                has_overlap_evidence.add(cs[i])
                has_overlap_evidence.add(cs[j])
                if sep <= SEP_M:
                    parent[find(cs[i])] = find(cs[j])
                else:
                    conflict_pairs.append((cs[i], cs[j]))
        comps = defaultdict(list)
        for c in cs:
            comps[find(c)].append(c)

        if not conflict_pairs:
            # one body (possibly several duplicate components with no
            # concurrent contradiction) — one slot
            for c in cs:
                slot_of[c] = base
            continue
        n_conflict_groups += 1
        # Multiple bodies proven (the duplicate-'10' reality). §3 rules:
        #  - a component whose OWN members contain a concurrent >SEP_M
        #    contradiction (transitive close-edges chained two bodies
        #    together) is internally impure -> NO slot for any member;
        #  - a chain with NO temporal-overlap evidence against any co-group
        #    chain is genuinely ambiguous between the bodies -> keeps its
        #    jersey but gets NO slot (a guessed sub-slot would teleport the
        #    follow to the wrong '10');
        #  - clean evidence-bearing components get deterministic sub-slot
        #    ids by earliest start time.
        comp_of = {c: find(c) for c in cs}
        contradicted = {comp_of[a] for a, b in conflict_pairs
                        if comp_of[a] == comp_of[b]}
        comp_list = sorted(
            (comp for root, comp in comps.items()
             if root not in contradicted
             and any(c in has_overlap_evidence for c in comp)),
            key=lambda comp: min(int(chains[c][0][0]) for c in comp))
        for k, comp in enumerate(comp_list):
            sid = base if k == 0 else f'{base}-{k + 1}'
            for c in comp:
                slot_of[c] = sid
    diag = {'slots': len(set(slot_of.values())),
            'labelledChains': len(slot_of),
            'duplicateNumberGroups': n_conflict_groups}
    return slot_of, diag

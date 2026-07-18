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

from kit import K_RANGE

CONF = 0.9
LEG_GATE = 0.6
PLAY_GATE_M = 25.0
OVLP_S = 2.0
SEP_M = 3.0
KIT_CONSISTENCY_MIN = 0.8
MIN_KIT_CROPS = 3

# ── Synthetic goalkeeper slots (zone identity, 2026-07-18) ───────────────
# Keepers are structurally unlabelled (play-anchored harvest rarely windows
# the goal; kit clustering excludes the GK's third kit), yet they are the one
# position identifiable by pure geometry: goal-cell residency over a half.
GK_BAND_M = 18.0        # goal band depth (penalty box 16.5m + margin)
GK_BAND_APRON_M = 2.0   # behind-the-line apron (keepers retrieve balls)
GK_Y_HALF_SPAN_M = 20.0  # central band only — touchline warmup traffic out
GK_RES_FRAC = 0.6       # duration-weighted fraction of samples in the band
# Per-CHAIN persistence bar (measured on HCT, 2026-07-18): box-siege traffic
# never holds 30s in-band at frac>=0.6 (a 9s box visit has frac 1.0 — the
# frac alone is meaningless for short chains), while the keeper's real
# fragment relay runs 31-59s. A component-UNION bar was measured wrong: the
# relay is sequential singles, so a 45s union bar refused the keeper.
GK_MIN_CHAIN_S = 30.0
# Refuting evidence bar (CV review): a sub-bar keeper fragment (short but
# box-resident at the same frac) must still be able to REFUTE a parked
# defender who alone passes the 30s bar — otherwise the guard is blind
# exactly when the keeper is occluded/fragmented. Passing attackers don't
# reach this pool: their chains extend beyond the box, so frac stays low.
GK_REFUTE_MIN_S = 10.0
GK_SLOT_LETTER = 'g'
# Kit slot letters mint chr(ord('a') + cluster) for clusters 0..max(K_RANGE)-1
# (a..f today). The GK letter must stay outside that namespace — one K_RANGE
# edit away from a silent collision otherwise. Explicit raise, not assert:
# an -O interpreter must not strip the guard.
if ord('a') + max(K_RANGE) - 1 >= ord(GK_SLOT_LETTER):
    raise RuntimeError(
        'GK_SLOT_LETTER collides with the kit slot-letter namespace')


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


# Plausibility floors for phase-event tagging noise (CV review): a bogus
# kick_off at t~0 would widen half 1 into pre-match warmup — where sub
# keepers take shooting drills IN the goalmouth (the canonical wrong-body
# input). A missing full_time must not extend half 2 to the end of the
# banked file (post-match shootarounds put non-keepers in the goal).
HALF_MIN_S = 900.0          # a real half is at least 15 min
BREAK_MAX_S = 3600.0        # a real half-time break is under an hour
FT_FALLBACK_SLACK_S = 600.0  # half-2 <= half-1 + 10 min when FT untagged


def half_bounds_from_events(events: list, start_us: int, end_s: float):
    """Pure ordering/validation of admin-tagged phase events →
    [(lo_us, hi_us), (lo_us, hi_us)] on the chain µs clock, or None.

    Requires exactly one half_time, a kick_off on each side of it in strict
    order (KO1 < HT < KO2 < FT-or-capped-end), and plausible durations
    (HALF_MIN_S / BREAK_MAX_S). Extra kick_offs AFTER the ones used are
    tolerated (venues may tag restarts); near-zero timestamps are dropped
    as bogus markers. Anything else is ambiguous and returns None: keepers
    swap ends at half time, so a wrong boundary silently swaps bodies."""
    def stamps(kind):
        out = []
        for e in events:
            if e.get('event_type') != kind:
                continue
            try:
                t = float(e.get('timestamp_seconds'))
            except (TypeError, ValueError):
                continue
            if t > 0.5:   # t~0 markers are tagging noise, not kick-offs
                out.append(t)
        return sorted(out)

    kos, hts, fts = stamps('kick_off'), stamps('half_time'), stamps('full_time')
    if len(hts) != 1 or len(kos) < 2:
        return None
    ko1, ht = kos[0], hts[0]
    ko2 = next((k for k in kos if k > ht), None)
    if ko2 is None:
        return None
    if ht - ko1 < HALF_MIN_S or ko2 - ht > BREAK_MAX_S:
        return None
    ft = next((f for f in fts if f > ko2), None)
    if ft is None:
        # cap the fallback: half 2 is about as long as half 1, never
        # "until the file ends"
        ft = min(end_s, ko2 + (ht - ko1) + FT_FALLBACK_SLACK_S)
    if not ko1 < ht < ko2 < ft:
        return None
    return [(start_us + ko1 * 1e6, start_us + ht * 1e6),
            (start_us + ko2 * 1e6, start_us + ft * 1e6)]


def halves_from_spans(spans: list, start_us: int):
    """Fallback halves from the harvest's activity spans — accepted ONLY
    when the 2-span shape is plausible as two halves (senior review): both
    at least HALF_MIN_S and within 2x of each other. A warmup merged into
    span 1 or a mid-half stoppage split fails the shape and returns None."""
    if len(spans) != 2:
        return None
    (lo1, hi1), (lo2, hi2) = spans
    d1, d2 = hi1 - lo1, hi2 - lo2
    if d1 < HALF_MIN_S or d2 < HALF_MIN_S:
        return None
    if not (0.5 <= d1 / d2 <= 2.0):
        return None
    return [(start_us + lo1 * 1e6, start_us + hi1 * 1e6),
            (start_us + lo2 * 1e6, start_us + hi2 * 1e6)]


def _pitch_points(chain: tuple, pmap: np.ndarray):
    """Map every sample into pitch metres. Returns (P Nx2 with NaN where
    invalid, valid mask). w <= eps = beyond the composed horizon (mirrored
    garbage) — invalid, never dehomogenized."""
    _, xy = chain
    v = np.concatenate([xy, np.ones((len(xy), 1))], axis=1) @ np.asarray(
        pmap, float).T
    w = v[:, 2]
    valid = np.isfinite(w) & (w > 1e-6)
    pts = np.full((len(xy), 2), np.nan)
    pts[valid] = v[valid, :2] / w[valid, None]
    return pts, valid


def _inband_segments(chain: tuple, in_band: np.ndarray) -> list:
    """[(t_lo_us, t_hi_us)] segments where consecutive samples are both
    inside the band — the duration-weighted residency basis (sample counts
    would mis-weight irregular post-hygiene timestamps). `in_band` must
    already include the validity mask."""
    ts = chain[0]
    segs = []
    for i in range(len(ts) - 1):
        if in_band[i] and in_band[i + 1]:
            lo, hi = float(ts[i]), float(ts[i + 1])
            if segs and lo <= segs[-1][1]:
                segs[-1][1] = max(segs[-1][1], hi)
            else:
                segs.append([lo, hi])
    return segs


def _clip_segments(segs: list, lo: float, hi: float) -> list:
    """Intersect segments with [lo, hi] — residency must only count time
    INSIDE the routed half (CV review: a chain straddling kick-off must not
    credit warmup/break goalmouth time toward the persistence bar)."""
    out = []
    for a, b in segs:
        a2, b2 = max(a, lo), min(b, hi)
        if b2 > a2:
            out.append([a2, b2])
    return out


def _union_seconds(segs: list) -> float:
    total, prev_hi = 0.0, None
    for lo, hi in sorted(segs):
        if prev_hi is None or lo > prev_hi:
            total += hi - lo
            prev_hi = hi
        elif hi > prev_hi:
            total += hi - prev_hi
            prev_hi = hi
    return total / 1e6


def assign_gk_slots(chains: list, pmap: np.ndarray, length_m: float,
                    width_m: float, half_bounds_us: list,
                    taken: set) -> tuple:
    """Synthetic goalkeeper slots by goal-cell residency: {chain_idx:
    'g1'..'g4'} + diagnostics.

    Zone + persistence IS the identity evidence here — this deliberately
    relaxes assign_slots' temporal-overlap-evidence rule (which exists
    because a jersey NUMBER alone can be two bodies; a body resident in one
    goal cell for most of a half is the keeper). The §3 guard survives as
    the contradiction check: two components concurrently in the same cell
    but far apart are two real bodies (keeper + parked defender) and BOTH
    are refused for that group — a guessed slot would teleport the follow.

    Slot ids are per (end, half) — 'g1'/'g2' the two ends of half 1,
    'g3'/'g4' half 2. No cross-half linking: keepers swap ends at half time
    and linking would need kit/team evidence; a follow through the break
    honestly ends. Chains in `taken` (jersey-slotted) are excluded.

    KNOWN SEMANTIC (documented, accepted for the pilot): a g-slot is ZONE
    identity — "the keeper defending that end that half". A mid-half keeper
    substitution rides the slot silently (two sequential uncontradicted
    components share the sid). Kit-based within-slot linking is the future
    tightening if it ever bites.
    """
    # Small-pitch guard (CV review): below this the two x-bands overlap /
    # cover most of the pitch and "goal-cell residency" stops meaning
    # keeper. Latent until a small venue joins the allowlist — refuse
    # loudly rather than mint noise.
    if length_m < 2 * GK_BAND_M + 10 or width_m < 30:
        return {}, {'gkSlots': 0, 'gkChains': 0,
                    'gkSkippedPitch': f'{length_m:.0f}x{width_m:.0f}m'}

    groups: dict = defaultdict(list)     # (half, end) -> [(idx, segs, dist)]
    refuters: dict = defaultdict(list)   # (half, end) -> [(idx, dist)]
    n_skipped_invalid = 0
    y_lo = max(0.0, width_m / 2 - GK_Y_HALF_SPAN_M)
    y_hi = min(width_m, width_m / 2 + GK_Y_HALF_SPAN_M)
    goal_x = (0.0, length_m)
    for idx, chain in enumerate(chains):
        if idx in taken:
            continue
        ts = chain[0]
        mid = (float(ts[0]) + float(ts[-1])) / 2
        half = next((h for h, (lo, hi) in enumerate(half_bounds_us)
                     if lo <= mid <= hi), None)
        if half is None:
            continue
        h_lo, h_hi = half_bounds_us[half]
        pts, valid = _pitch_points(chain, pmap)
        if valid.sum() < max(2, len(valid) * 0.5):
            n_skipped_invalid += 1
            continue
        on_y = (pts[:, 1] >= y_lo) & (pts[:, 1] <= y_hi)
        # Residency counts ONLY time inside the routed half: both the
        # segments and the denominator are clipped, so a chain straddling
        # kick-off cannot credit warmup/break goalmouth time.
        span_lo = max(float(ts[0]), h_lo)
        span_hi = min(float(ts[-1]), h_hi)
        total_s = (span_hi - span_lo) / 1e6
        if total_s <= 0:
            continue
        for end, in_x in enumerate((
                (pts[:, 0] >= -GK_BAND_APRON_M) & (pts[:, 0] <= GK_BAND_M),
                (pts[:, 0] >= length_m - GK_BAND_M)
                & (pts[:, 0] <= length_m + GK_BAND_APRON_M))):
            in_band = in_x & on_y & valid
            segs = _clip_segments(_inband_segments(chain, in_band),
                                  h_lo, h_hi)
            band_s = _union_seconds(segs)
            if band_s <= 0 or band_s / total_s < GK_RES_FRAC:
                continue
            # median distance to THIS end's goal centre — the keeper prior
            # that arbitrates sub-bar refutations below
            dist = float(np.nanmedian(np.hypot(
                pts[:, 0] - goal_x[end], pts[:, 1] - width_m / 2)))
            if band_s >= GK_REFUTE_MIN_S:
                refuters[(half, end)].append((idx, dist))
            if band_s >= GK_MIN_CHAIN_S:
                groups[(half, end)].append((idx, segs, dist))

    slot_of: dict = {}
    coverage: dict = {}
    n_refused_components = 0
    for (half, end), members in sorted(groups.items()):
        cs = [idx for idx, _, _ in members]
        segs_of = {idx: segs for idx, segs, _ in members}
        dist_of = {idx: d for idx, _, d in members}
        cs_set = set(cs)
        parent = {c: c for c in cs}

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        # Link duplicates among the qualified; collect contradiction
        # evidence from the WIDER refuter pool (a sub-bar keeper fragment
        # must still refute a parked defender — CV review). A sub-bar
        # refuter only refutes when it sits CLOSER to the goal centre than
        # the qualified chain: in the parked-defender failure the occluded
        # keeper's shrapnel is the goalmouth-deep one; in an ordinary
        # attack the box visitor is the shallow one and the resident keeper
        # keeps the slot (measured: without this asymmetry, routine attacks
        # refused the keeper's own relay and halved coverage).
        conflicted_members = set()
        internal_pairs = []
        for c in cs:
            for r, r_dist in refuters[(half, end)]:
                if r == c or (r in cs_set and r <= c):
                    continue  # each qualified pair once; refuters always
                ov, sep = overlap_sep(chains[c], chains[r])
                if ov < OVLP_S or sep is None:
                    continue
                if sep <= SEP_M:
                    if r in cs_set:
                        parent[find(c)] = find(r)
                    # a close sub-bar refuter is the keeper's own duplicate
                    # shrapnel — supporting, not refuting
                elif r in cs_set:
                    internal_pairs.append((c, r))
                elif r_dist < dist_of[c]:
                    conflicted_members.add(c)
        comps = defaultdict(list)
        for c in cs:
            comps[find(c)].append(c)
        comp_of = {c: find(c) for c in cs}
        # Contradicted = every component with a proven far-concurrent body
        # in the cell (qualified-vs-qualified pairs incl. internal
        # transitive contradictions, plus qualified-vs-refuter evidence).
        contradicted = set()
        for a, b in internal_pairs:
            contradicted.add(comp_of[a])
            contradicted.add(comp_of[b])
        for c in conflicted_members:
            contradicted.add(comp_of[c])
        n_refused_components += len(
            {root for root in comps if root in contradicted})
        sid = f'{GK_SLOT_LETTER}{half * 2 + end + 1}'
        for root, comp in comps.items():
            if root in contradicted:
                continue
            comp_segs = [s for c in comp for s in segs_of[c]]
            for c in comp:
                slot_of[c] = sid
            coverage[sid] = round(
                coverage.get(sid, 0.0) + _union_seconds(comp_segs), 1)
    diag = {'gkSlots': len(set(slot_of.values())),
            'gkChains': len(slot_of),
            'gkRefusedComponents': n_refused_components,
            'gkSkippedInvalid': n_skipped_invalid,
            'gkCoverageS': coverage}
    return slot_of, diag

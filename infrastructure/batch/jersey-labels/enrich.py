"""Enriched artifact assembly: production build_payload + jersey/slot attach
+ hard client caps. (Motion-adaptive decimation lives in the SHARED
build_track.build_payload — single source; this module only verifies caps.)

The attach is deterministic BY CONSTRUCTION: build_payload ids objects
`o{i}` where i is the chain's position in ITS OWN span-sorted list (skipped
too-short chains leave id gaps, never remap). We replicate the identical sort
here on the SAME chain list we pass in, so label -> object id is exact.
A sidecar keyed on ids from some OTHER build would risk wrong-body labels;
this module only ever labels a payload built from the chains in hand.

Caps are asserted, not truncated: publishing an over-cap artifact silently
kills the client Spotlight (parseTracklets -> null, the HCT incident), and
silently dropping objects would break instantaneous overlay coverage — either
way the job must FAIL LOUDLY instead.
"""
from __future__ import annotations

import numpy as np

# Client self-DoS caps (src/lib/panorama/tracklets.ts) — must never publish
# beyond these. build_payload enforces them too; this is the belt to its
# braces (the publish path must fail loudly even if build_track drifts).
CLIENT_MAX_OBJECTS = 40_000
CLIENT_MAX_POINTS = 800_000


def span_order(chains: list) -> list:
    """Positions of chains in build_payload's span-sorted order:
    span_order(chains)[pos] = original index of the chain with id o{pos}.
    Ties broken by original index — Python's sort is stable and
    build_payload sorts the same way."""
    return sorted(range(len(chains)),
                  key=lambda k: -(int(chains[k][0][-1])
                                  - int(chains[k][0][0])))


def attach_labels(payload: dict, chains: list, labels: dict,
                  slot_of: dict) -> int:
    """Attach `jersey` + `slot` to the payload objects built from `chains`.
    labels: {chain_idx: (number, kit)}; slot_of: {chain_idx: slot_id}.
    Returns the number of labelled objects."""
    order = span_order(chains)
    by_oid = {}
    for pos, orig in enumerate(order):
        if orig in labels and orig in slot_of:
            by_oid[f'o{pos}'] = (str(labels[orig][0]), slot_of[orig])
    attached = 0
    for o in payload['objects']:
        j = by_oid.get(o['id'])
        if j is not None:
            o['jersey'], o['slot'] = j
            attached += 1
    return attached


def attach_slots(payload: dict, chains: list, slot_of: dict) -> int:
    """Attach `slot` ONLY (no jersey) to payload objects — the synthetic GK
    zone-slot path. Objects already carrying a slot are never overwritten
    (jersey evidence wins). Returns the number of objects slotted."""
    order = span_order(chains)
    by_oid = {}
    for pos, orig in enumerate(order):
        if orig in slot_of:
            by_oid[f'o{pos}'] = slot_of[orig]
    attached = 0
    for o in payload['objects']:
        s = by_oid.get(o['id'])
        if s is not None and 'slot' not in o:
            o['slot'] = s
            attached += 1
    return attached


def payload_sizes(payload: dict) -> tuple:
    n_obj = len(payload['objects'])
    n_pts = sum(len(o['t']) for o in payload['objects'])
    return n_obj, n_pts


def assert_caps(payload: dict) -> None:
    n_obj, n_pts = payload_sizes(payload)
    if n_obj > CLIENT_MAX_OBJECTS or n_pts > CLIENT_MAX_POINTS:
        raise RuntimeError(
            f'enriched artifact over client caps: {n_obj} objects '
            f'(cap {CLIENT_MAX_OBJECTS}), {n_pts} points '
            f'(cap {CLIENT_MAX_POINTS}) — refusing to publish')


def stamp_meta(payload: dict, *, harvest_step_s: float, source_digest: str,
               kits: int, slots: int, labelled: int,
               split_accepted: int, split_refused: int,
               gk_slots: int = 0) -> None:
    payload['meta']['jersey'] = {
        'version': 1,
        'slots': slots,
        'labeledObjects': labelled,
        'kits': kits,
        'harvestStepS': harvest_step_s,
        'sourceDigest': source_digest,
        'splitAccepted': split_accepted,
        'splitRefused': split_refused,
        'gkSlots': gk_slots,
    }


def summarize(labels: dict, slot_of: dict) -> dict:
    """Roster summary for the provenance log."""
    from collections import defaultdict
    roster = defaultdict(list)
    for c, (num, kc) in labels.items():
        roster[kc].append(num)
    return {str(k): sorted(set(v), key=int) for k, v in roster.items()}


def median_or_none(vals: list):
    return float(np.median(vals)) if vals else None

"""Re-run reconciliation planning — pure, unit-tested (senior review #3).

The chain is deterministic: anchors move only when inputs (tracklets
artifact, calibration) changed. Matching radius = MERGE_S (45s), the chain's
own episode-identity radius — two distinct episodes can't be closer by
construction.

plan_writes returns WHAT to do; the executor in entrypoint.py owns HOW
(CAS on status in (draft, error) so a review decision is never clobbered —
a matched-but-reviewed row simply loses the CAS and is counted 'kept').

Deliberate, test-pinned behavior: a re-run that finds ZERO survivors
supersedes every unmatched draft/error row — correct (the new decode is the
truth for unreviewed rows), but exactly the kind of thing a future edit
breaks silently.
"""
from __future__ import annotations


def plan_writes(survivors: list[dict], existing: list[dict],
                reconcile_s: float = 45.0):
    """(survivors from the chain, existing candidate rows) ->
    (refreshes [(row_id, survivor)], inserts [survivor], supersede_ids).

    survivors: dicts with at least 'anchor'. existing: dicts with
    'id', 'anchor_s', 'status'. Each existing row matches at most one
    survivor (nearest-first, greedy in anchor order); unmatched draft/error
    rows are superseded; approved/rejected rows are never superseded (and a
    matched one is left to the executor's CAS to keep).
    """
    matched: set = set()
    refreshes: list = []
    inserts: list = []
    for e in sorted(survivors, key=lambda s: s['anchor']):
        near = [c for c in existing
                if abs(float(c['anchor_s']) - e['anchor']) <= reconcile_s
                and c['id'] not in matched]
        if near:
            near.sort(key=lambda c: abs(float(c['anchor_s']) - e['anchor']))
            matched.add(near[0]['id'])
            refreshes.append((near[0]['id'], e))
        else:
            inserts.append(e)
    supersede_ids = [c['id'] for c in existing
                     if c['id'] not in matched
                     and c['status'] in ('draft', 'error')]
    return refreshes, inserts, supersede_ids

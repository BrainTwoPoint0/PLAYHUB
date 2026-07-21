"""Tests for the re-run reconciliation plan (senior review #3)."""
from __future__ import annotations

from reconcile import plan_writes


def row(id_, anchor, status='draft'):
    return {'id': id_, 'anchor_s': anchor, 'status': status}


def surv(anchor):
    return {'anchor': float(anchor)}


def test_shifted_anchor_refreshes_nearest_row():
    refreshes, inserts, supersedes = plan_writes(
        [surv(1010)], [row('a', 1000), row('b', 1100)])
    assert [r[0] for r in refreshes] == ['a']
    assert inserts == []
    assert supersedes == ['b']


def test_two_survivors_near_one_row_one_refresh_one_insert():
    refreshes, inserts, supersedes = plan_writes(
        [surv(995), surv(1030)], [row('a', 1000)])
    assert [r[0] for r in refreshes] == ['a']
    assert [i['anchor'] for i in inserts] == [1030.0]
    assert supersedes == []


def test_reviewed_rows_matched_but_never_superseded():
    refreshes, inserts, supersedes = plan_writes(
        [surv(1000)], [row('a', 1000, 'approved'), row('b', 2000, 'rejected')])
    # the approved row is matched (executor's CAS will keep it untouched);
    # the unmatched rejected row is NOT superseded — review is permanent
    assert [r[0] for r in refreshes] == ['a']
    assert supersedes == []


def test_error_row_resurrected_by_matching_survivor():
    refreshes, _, supersedes = plan_writes(
        [surv(1000)], [row('a', 1005, 'error')])
    assert [r[0] for r in refreshes] == ['a']   # fields carry status=draft
    assert supersedes == []


def test_zero_survivors_supersedes_all_unreviewed():
    """PINNED deliberate behavior: an empty re-decode supersedes every
    draft/error row (the new decode is the truth for unreviewed rows)."""
    _, _, supersedes = plan_writes(
        [], [row('a', 100, 'draft'), row('b', 200, 'error'),
             row('c', 300, 'approved')])
    assert supersedes == ['a', 'b']


def test_beyond_radius_is_insert_not_refresh():
    refreshes, inserts, supersedes = plan_writes(
        [surv(1050)], [row('a', 1000)])
    assert refreshes == []
    assert [i['anchor'] for i in inserts] == [1050.0]
    assert supersedes == ['a']


def test_each_existing_row_matches_at_most_once():
    refreshes, inserts, _ = plan_writes(
        [surv(1000), surv(1044)], [row('a', 1022)])
    assert [r[0] for r in refreshes] == ['a']
    assert len(inserts) == 1

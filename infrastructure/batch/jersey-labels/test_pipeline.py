"""Unit tests for the jersey-labels pipeline (no torch/ultralytics needed —
the DL stack is injected/lazy). Run: python -m pytest test_pipeline.py -q

The enrich contract test imports the SHARED production build_track module
from ../player-tracklets (the deploy zip stages it next to these files)."""
import os
import sys

import numpy as np
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, '..', 'player-tracklets'))

import enrich  # noqa: E402
import harvest  # noqa: E402
import kit  # noqa: E402
import slots  # noqa: E402
import split  # noqa: E402


# ── helpers ──────────────────────────────────────────────────────────────────

def make_chain(t0_s, t1_s, xy_fn, hz=2.5):
    ts = np.arange(t0_s * 1e6, t1_s * 1e6, 1e6 / hz)
    xy = np.array([xy_fn(t / 1e6) for t in ts], float)
    return ts, xy


def rec(chain=0, t_vp=100.0, conf=0.95, read='10', leg=0.9, on_pitch=True,
        in_match=True, play_dist=5.0, solo=True, kit_cluster=0, h_px=120.0):
    return {'chain': chain, 't_vp': t_vp, 't_us': t_vp * 1e6, 'conf': conf,
            'read': read, 'leg': leg, 'on_pitch': on_pitch,
            'in_match': in_match, 'play_dist': play_dist, 'solo': solo,
            'kit': kit_cluster, 'h_px': h_px}


# ── harvest: play centroids + in-match spans ────────────────────────────────

def test_play_centroids_needs_min_moving_samples():
    # PLAY_MIN_MOVERS counts moving SAMPLES per bin (B2 semantics: one 2.5Hz
    # mover contributes ~5 samples/bin). A stationary chain contributes none.
    chains = [make_chain(0, 4, lambda t, i=i: (t * 2.0 + i * 5, 10.0))
              for i in range(3)]
    chains.append(make_chain(10, 14, lambda t: (30.0, 30.0)))  # stationary
    cents = harvest.play_centroids(chains, 0)
    assert 0 in cents          # moving samples present
    assert 5 not in cents      # stationary-only bin gets no centroid


def test_play_centroids_is_median_of_movers():
    chains = [make_chain(0, 4, lambda t, i=i: (t * 2.0, float(i)))
              for i in range(5)]
    cents = harvest.play_centroids(chains, 0)
    assert cents[0][1] == pytest.approx(2.0)  # median y of 0..4


def test_in_match_spans_finds_active_region():
    # quiet 0-500s, active 500-2500s, quiet after
    counts = {}
    for b in range(0, 1500):
        t = b * harvest.PLAY_BIN_S
        counts[b] = 12 if 500 <= t <= 2500 else 1
    spans = harvest.in_match_spans(counts)
    assert len(spans) == 1
    lo, hi = spans[0]
    assert lo == pytest.approx(500, abs=harvest.ACTIVITY_SMOOTH_S)
    assert hi == pytest.approx(2500, abs=harvest.ACTIVITY_SMOOTH_S)


def test_in_match_spans_closes_short_gaps_keeps_halftime_split():
    counts = {}
    for b in range(0, 2000):
        t = b * harvest.PLAY_BIN_S
        active = (200 <= t <= 1600) or (2200 <= t <= 3600)
        counts[b] = 14 if active else 0
    spans = harvest.in_match_spans(counts)  # 600s gap > MAX_GAP_S stays split
    assert len(spans) == 2


def test_in_match_spans_degrades_empty():
    assert harvest.in_match_spans({}) == []
    assert harvest.in_match_spans({b: 0 for b in range(100)}) == []


def test_in_match_spans_drops_short_bursts():
    counts = {b: (20 if b < 10 else 0) for b in range(1000)}
    # 20s of activity < MIN_SPAN_S
    assert harvest.in_match_spans(counts) == []


# ── harvest: window + box geometry ──────────────────────────────────────────

def test_window_bounds_min_size():
    pts = np.array([[1000.0, 800.0]])
    x0, y0, x1, y1 = harvest.window_bounds(pts, 3840, 2160)
    assert x1 - x0 >= harvest.WIN_MIN
    assert y1 - y0 >= harvest.WIN_MIN


def test_window_bounds_max_size_centers_on_median():
    xs = np.linspace(0, 3800, 30)
    pts = np.stack([xs, np.full(30, 1000.0)], axis=1)
    x0, y0, x1, y1 = harvest.window_bounds(pts, 3840, 2160)
    assert x1 - x0 <= harvest.WIN_MAX_W
    assert y1 - y0 <= harvest.WIN_MAX_H


def test_window_bounds_clamped_to_frame():
    pts = np.array([[10.0, 10.0], [50.0, 40.0]])
    x0, y0, x1, y1 = harvest.window_bounds(pts, 3840, 2160)
    assert x0 >= 0 and y0 >= 0 and x1 <= 3840 and y1 <= 2160


def test_filter_boxes_truth_table():
    seam = 1080.0
    boxes = [
        [100, 100, 160, 260],    # ok (h=160, aspect 0.375)
        [100, 100, 130, 150],    # too short (h=50)
        [100, 100, 400, 260],    # aspect too wide (1.875)
        [100, 1000, 160, 1160],  # straddles seam
        [100, 100, 105, 260],    # aspect too thin (0.03)
    ]
    kept = harvest.filter_boxes(np.array(boxes, float), seam)
    assert len(kept) == 1
    assert kept[0][0] == 100 and kept[0][3] == 260


def test_solo_flag():
    boxes = [[100, 100, 160, 260], [150, 100, 210, 260], [500, 500, 560, 660]]
    crop = harvest.crop_box(boxes[0], 3840, 2160)
    assert not harvest.solo_flag(0, boxes, crop)   # neighbour overlaps
    crop2 = harvest.crop_box(boxes[2], 3840, 2160)
    assert harvest.solo_flag(2, boxes, crop2)


def test_harvest_frame_associates_and_gates():
    # two chains near play, far apart in pixels; detector returns boxes at
    # their projected feet
    proj = [(0, 500.0, 500.0, 10.0, 10.0), (1, 900.0, 500.0, 12.0, 10.0),
            (2, 1300.0, 500.0, 14.0, 10.0), (3, 1700.0, 500.0, 16.0, 10.0)]
    cent = np.array([11.0, 10.0])
    img = np.zeros((2160, 3840, 3), np.uint8)

    def detect(win):
        # boxes in window coords: feet at the projected points
        return np.array([[470, 340, 530, 500], [870, 340, 930, 500]], float) \
            - 0.0

    # window will be offset; compute expected: window_bounds over all 4 near
    # points... simpler: detector returns boxes in WINDOW coords, so shift by
    # the window origin. Emulate via a closure that captures nothing and
    # returns boxes positioned so that after +x0/+y0 they land on proj feet.
    x0, y0, _, _ = harvest.window_bounds(
        np.array([[p[1], p[2]] for p in proj]), 3840, 2160)

    def detect2(win):
        return np.array([
            [500 - 30 - x0, 500 - 160 - y0, 500 + 30 - x0, 500 - y0],
            [900 - 30 - x0, 500 - 160 - y0, 900 + 30 - x0, 500 - y0],
        ], float)

    recs = harvest.harvest_frame(img, 100.0, proj, cent, detect2, 3840, 2160)
    assert {r['chain'] for r in recs} == {0, 1}
    for r in recs:
        assert r['solo']
        assert r['play_dist'] <= harvest.NEAR_PLAY_M
        assert r['crop'].size > 0


def test_harvest_frame_needs_near_play_quorum():
    proj = [(0, 500.0, 500.0, 10.0, 10.0), (1, 900.0, 500.0, 12.0, 10.0),
            (2, 1300.0, 500.0, 80.0, 10.0), (3, 1700.0, 500.0, 90.0, 10.0)]
    cent = np.array([11.0, 10.0])   # only 2 chains within 25m
    img = np.zeros((2160, 3840, 3), np.uint8)
    recs = harvest.harvest_frame(img, 100.0, proj, cent,
                                 lambda w: np.zeros((0, 4)), 3840, 2160)
    assert recs == []


# ── kit ─────────────────────────────────────────────────────────────────────

def _crop_with_shirt(shirt_bgr, grass_bgr=(40, 120, 60), h_px=120):
    h = int(h_px * (1 + 2 * harvest.MARGIN))
    w = 80
    img = np.zeros((h, w, 3), np.uint8)
    img[:, :] = grass_bgr
    pad = int(harvest.MARGIN * h_px)
    img[pad + int(0.15 * h_px):pad + int(0.45 * h_px), :] = shirt_bgr
    return img


def test_shirt_lab_separates_bright_and_dark():
    cv2 = pytest.importorskip('cv2')  # noqa: F841
    bright = kit.shirt_lab(_crop_with_shirt((240, 240, 240)), 120.0)
    dark = kit.shirt_lab(_crop_with_shirt((20, 20, 20)), 120.0)
    assert bright is not None and dark is not None
    assert bright[0] > dark[0] + 30   # dL_p80 separates


def test_kmeans_deterministic():
    rng = np.random.default_rng(0)
    X = np.vstack([rng.normal(0, 1, (20, 4)), rng.normal(50, 1, (20, 4))])
    C1, a1 = kit.kmeans(2, X)
    C2, a2 = kit.kmeans(2, X)
    assert np.allclose(C1, C2) and np.array_equal(a1, a2)


def test_cluster_kits_two_clear_clusters():
    rng = np.random.default_rng(1)
    X = np.vstack([rng.normal(0, 0.5, (10, 4)), rng.normal(60, 0.5, (10, 4))])
    C, k, sil = kit.cluster_kits(X)
    assert k == 2
    assert sil > 0.8


def test_cluster_kits_refuses_few_anchors():
    with pytest.raises(ValueError):
        kit.cluster_kits(np.zeros((3, 4)))


def test_assign_kit_outlier():
    C = np.array([[0, 0, 0, 0], [60, 0, 0, 0]], float)
    assert kit.assign_kit([1, 0, 0, 0], C) == 0
    assert kit.assign_kit([100, 100, 100, 100], C) == -1
    assert kit.assign_kit(None, C) == -1


# ── split truth-table ───────────────────────────────────────────────────────

def _chain_with_seam(seam_at_s=50.0, t0=0.0, t1=100.0):
    """2.5Hz chain with one bridged gap (2s) at seam_at_s."""
    a = np.arange(t0, seam_at_s, 0.4)
    b = np.arange(seam_at_s + 2.0, t1, 0.4)
    ts = np.concatenate([a, b]) * 1e6
    xy = np.stack([np.linspace(0, 50, len(ts)), np.zeros(len(ts))], axis=1)
    return ts, xy


def _crops(ts_s, kits):
    return [t * 1e6 for t in ts_s], list(kits)


def test_split_accepts_clean_flip_at_seam():
    chain = _chain_with_seam(50.0)
    crop_ts, crop_kits = _crops([10, 20, 30, 40, 60, 70, 80, 90],
                                [0, 0, 0, 0, 1, 1, 1, 1])
    d = split.propose_split(chain, crop_ts, crop_kits, min_span_s=3.0)
    assert d['accepted'], d
    assert d['kit_a'] == 0 and d['kit_b'] == 1
    ts = chain[0]
    assert ts[d['seam_idx'] + 1] - ts[d['seam_idx']] > split.SEAM_GAP_US


def test_split_refuses_too_few_crops():
    chain = _chain_with_seam(50.0)
    crop_ts, crop_kits = _crops([10, 20, 60, 70], [0, 0, 1, 1])
    d = split.propose_split(chain, crop_ts, crop_kits, min_span_s=3.0)
    assert not d['accepted']
    assert 'too few' in d['reason']


def test_split_refuses_mixed_segments():
    chain = _chain_with_seam(50.0)
    crop_ts, crop_kits = _crops([10, 20, 30, 40, 60, 70, 80, 90],
                                [0, 1, 0, 1, 1, 0, 1, 0])
    d = split.propose_split(chain, crop_ts, crop_kits, min_span_s=3.0)
    assert not d['accepted']


def test_split_refuses_two_flips():
    # A -> B -> A: three bodies (the chain-11259 class) must refuse
    chain = _chain_with_seam(50.0)
    crop_ts, crop_kits = _crops(
        [5, 10, 15, 20, 40, 45, 50, 55, 75, 80, 85, 90],
        [0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0])
    d = split.propose_split(chain, crop_ts, crop_kits, min_span_s=3.0)
    assert not d['accepted']


def test_split_refuses_no_seam_near_flip():
    chain = _chain_with_seam(seam_at_s=20.0)   # seam far from the flip
    crop_ts, crop_kits = _crops([30, 35, 40, 45, 60, 65, 70, 75],
                                [0, 0, 0, 0, 1, 1, 1, 1])
    d = split.propose_split(chain, crop_ts, crop_kits, min_span_s=3.0)
    assert not d['accepted']
    assert 'no stitch seam' in d['reason']


def test_split_refuses_two_seams_near_flip():
    a = np.arange(0.0, 48.0, 0.4)
    b = np.arange(50.0, 52.0, 0.4)
    c = np.arange(54.0, 100.0, 0.4)
    ts = np.concatenate([a, b, c]) * 1e6
    xy = np.stack([np.linspace(0, 50, len(ts)), np.zeros(len(ts))], axis=1)
    crop_ts, crop_kits = _crops([10, 20, 30, 40, 60, 70, 80, 90],
                                [0, 0, 0, 0, 1, 1, 1, 1])
    d = split.propose_split((ts, xy), crop_ts, crop_kits, min_span_s=3.0)
    assert not d['accepted']
    assert 'ambiguous' in d['reason']


def test_split_refuses_short_segment():
    chain = _chain_with_seam(seam_at_s=4.0, t0=0.0, t1=100.0)
    crop_ts, crop_kits = _crops([1, 2, 3, 3.5, 10, 20, 30, 40],
                                [0, 0, 0, 0, 1, 1, 1, 1])
    d = split.propose_split(chain, crop_ts, crop_kits, min_span_s=10.0)
    assert not d['accepted']
    assert 'too short' in d['reason']


def test_apply_splits_and_remap():
    chain = _chain_with_seam(50.0)
    other = make_chain(0, 20, lambda t: (t, 5.0))
    d = split.propose_split(
        chain, *_crops([10, 20, 30, 40, 60, 70, 80, 90],
                       [0, 0, 0, 0, 1, 1, 1, 1]), min_span_s=3.0)
    assert d['accepted']
    new_chains, index_map = split.apply_splits([chain, other], {0: d})
    assert len(new_chains) == 3
    assert index_map[1] == 2
    ia, ib, split_t = index_map[0]
    assert new_chains[ia][0][-1] < split_t < new_chains[ib][0][0]
    recs = [rec(chain=0, t_vp=10.0), rec(chain=0, t_vp=90.0),
            rec(chain=1, t_vp=5.0)]
    split.remap_records(recs, index_map)
    assert recs[0]['chain'] == ia
    assert recs[1]['chain'] == ib
    assert recs[2]['chain'] == 2


# ── slots ───────────────────────────────────────────────────────────────────

def test_confident_truth_table():
    good = rec()
    assert slots.confident([good]) == [good]
    for bad in (rec(conf=0.85), rec(read='ab'), rec(read='123'),
                rec(read=''), rec(on_pitch=False), rec(in_match=False),
                rec(leg=0.5)):
        assert slots.confident([bad]) == []


def test_deployment_reads_play_gate_and_dedup():
    far = rec(play_dist=40.0)
    a = rec(t_vp=100.2, conf=0.92)
    b = rec(t_vp=100.7, conf=0.97)   # same second, higher conf wins
    out = slots.deployment_reads([far, a, b])
    assert len(out) == 1 and out[0]['conf'] == 0.97


def test_chain_label_strictness():
    assert slots.chain_label([rec()], 0) is None                    # 1 read
    assert slots.chain_label([rec(), rec()], 0) == ('10', 0)        # 2 agree
    assert slots.chain_label([rec(), rec(), rec(read='7')], 0) == ('10', 0)
    assert slots.chain_label([rec(), rec(read='7')], 0) is None     # tie
    assert slots.chain_label(
        [rec(), rec(), rec(read='7'), rec(read='7')], 0) is None    # 2-2
    assert slots.chain_label([], 0) is None


def test_kit_profile_and_inconsistency():
    rs = [rec(chain=1, kit_cluster=0), rec(chain=1, kit_cluster=0),
          rec(chain=1, kit_cluster=1)]
    prof = slots.chain_kit_profile(rs)
    top, frac, n = prof[1]
    assert top == 0 and n == 3
    assert 1 in slots.kit_inconsistent_chains(prof)   # 2/3 < 0.8
    rs.append(rec(chain=1, kit_cluster=0))
    rs.append(rec(chain=1, kit_cluster=0))
    prof = slots.chain_kit_profile(rs)                # 4/5 >= 0.8
    assert 1 not in slots.kit_inconsistent_chains(prof)


def test_build_labels_refuses_other_kit_and_mismatched_reads():
    # chain 0: clean kit 0, two reads -> labelled
    # chain 1: kit -1 -> never labelled
    # chain 2: read whose own crop kit differs from chain majority -> dropped
    rs = [rec(chain=0, t_vp=10), rec(chain=0, t_vp=20),
          rec(chain=1, t_vp=10, kit_cluster=-1),
          rec(chain=1, t_vp=20, kit_cluster=-1)]
    # 4 matching crops + 1 mismatch = 0.8 consistency (passes the chain
    # gate exactly) while the mismatched read is dropped by the per-read gate
    rs2 = [rec(chain=2, t_vp=t, kit_cluster=0) for t in (10, 20, 30, 35)]
    mismatch = rec(chain=2, t_vp=40, kit_cluster=1, read='9')
    labels, diag = slots.build_labels(rs + rs2 + [mismatch])
    assert labels[0] == ('10', 0)
    assert 1 not in labels
    assert labels[2] == ('10', 0)   # the mismatched '9' read was excluded
    assert diag['labelledChains'] == 2


def test_assign_slots_duplicate_number_bodies():
    # two chains, same (10, kit 0), concurrent at 20m apart -> two sub-slots
    c0 = make_chain(0, 60, lambda t: (0.0, 0.0))
    c1 = make_chain(0, 60, lambda t: (20.0, 0.0))
    labels = {0: ('10', 0), 1: ('10', 0)}
    slot_of, diag = slots.assign_slots(labels, [c0, c1])
    assert slot_of[0] != slot_of[1]
    assert diag['duplicateNumberGroups'] == 1
    assert sorted({slot_of[0], slot_of[1]}) == ['a10', 'a10-2']


def test_assign_slots_duplicate_fragments_one_body():
    c0 = make_chain(0, 60, lambda t: (0.0, 0.0))
    c1 = make_chain(30, 90, lambda t: (1.0, 0.0))   # 1m apart = same body
    labels = {0: ('10', 0), 1: ('10', 0)}
    slot_of, diag = slots.assign_slots(labels, [c0, c1])
    assert slot_of[0] == slot_of[1] == 'a10'


def test_assign_slots_gap_bridging():
    c0 = make_chain(0, 30, lambda t: (0.0, 0.0))
    c1 = make_chain(100, 130, lambda t: (40.0, 0.0))  # no overlap
    labels = {0: ('7', 1), 1: ('7', 1)}
    slot_of, _ = slots.assign_slots(labels, [c0, c1])
    assert slot_of[0] == slot_of[1] == 'b7'


# ── slot propagation (coverage: label a crossing successor that OVERLAPS an
# already-slotted fragment; §3 empty-slot-over-guess stays sacred) ───────────

def test_propagate_single_anchor_labels_unlabelled_fragment():
    a10 = make_chain(0, 60, lambda t: (0.0, 0.0))     # slotted
    frag = make_chain(30, 90, lambda t: (1.0, 0.0))   # 1m apart, overlaps 30-60
    prop, diag = slots.propagate_slots({0: 'a10'}, [a10, frag])
    assert prop == {1: 'a10'}
    assert diag['propagatedChains'] == 1


def test_propagate_refuses_conflicting_slots():
    # an unlabelled bridge concurrent-close to TWO different slots (across a
    # gap between them, so no geometric contradiction) -> pure label conflict
    a10 = make_chain(0, 30, lambda t: (0.0, 0.0))     # slotted a10
    b7 = make_chain(60, 90, lambda t: (0.0, 0.0))     # slotted b7
    bridge = make_chain(0, 90, lambda t: (0.0, 0.0))  # overlaps both, 0m
    prop, diag = slots.propagate_slots({0: 'a10', 1: 'b7'}, [a10, b7, bridge])
    assert prop == {}
    assert diag['conflictComponents'] == 1


def test_propagate_refuses_transitive_two_body_component():
    # 0-1 close, 1-2 close, but 0-2 concurrent 5m apart -> two bodies chained
    # transitively; the whole component is refused (empty-slot over guess).
    a10 = make_chain(0, 60, lambda t: (0.0, 0.0))     # slotted a10
    u1 = make_chain(0, 60, lambda t: (2.5, 0.0))      # 2.5m from a10 (close)
    u2 = make_chain(0, 60, lambda t: (5.0, 0.0))      # 2.5m from u1, 5m from a10
    prop, diag = slots.propagate_slots({0: 'a10'}, [a10, u1, u2])
    assert prop == {}
    assert diag['contradictedComponents'] == 1


def test_propagate_refuses_transitive_hop_through_unlabelled():
    # A dies at a crossing; u1 overlaps A (same body); u2 overlaps ONLY u1 and
    # never A -> no contradiction can fire, yet u2 may be a different player.
    # A slot crosses the DIRECT A->u1 edge but NEVER the transitive u1->u2 hop.
    a = make_chain(0, 12, lambda t: (0.0, 0.0))       # slotted a10, ends ~11.6s
    u1 = make_chain(8, 20, lambda t: (0.0, 0.0))      # overlaps A [8,11.6], 0m
    u2 = make_chain(14, 30, lambda t: (1.0, 0.0))     # overlaps u1 only, not A
    prop, _ = slots.propagate_slots({0: 'a10'}, [a, u1, u2])
    assert prop == {1: 'a10'}                 # direct edge to the anchor
    assert 2 not in prop                      # transitive hop refused (stranger)


def test_propagate_labels_fragment_that_starts_before_its_anchor():
    # exercises the elif branch: the sweep yields (earlier, later), so when the
    # unlabelled fragment starts first the anchor is the SECOND element.
    frag = make_chain(0, 40, lambda t: (0.0, 0.0))    # unlabelled, starts first
    anc = make_chain(20, 60, lambda t: (0.5, 0.0))    # slotted a10, overlaps [20,40]
    prop, _ = slots.propagate_slots({1: 'a10'}, [frag, anc])
    assert prop == {0: 'a10'}


def test_propagate_refuses_sustained_stranger_beyond_prop_sep():
    # a different player parallel at 2.5m for >2s while the anchor dies: passes
    # SEP_M body-merge, no far pair -> no contradiction, but > PROP_SEP_M so the
    # identity must NOT transfer (the wrong-body path CV built live).
    a = make_chain(0, 12, lambda t: (0.0, 0.0))        # slotted a10, ends ~11.6
    stranger = make_chain(8, 25, lambda t: (2.5, 0.0))  # 2.5m sustained, no contradiction
    prop, _ = slots.propagate_slots({0: 'a10'}, [a, stranger])
    assert prop == {}


def test_propagate_keeps_true_same_body_within_prop_sep():
    a = make_chain(0, 12, lambda t: (0.0, 0.0))
    frag = make_chain(8, 25, lambda t: (0.8, 0.0))     # 0.8m = same body
    prop, _ = slots.propagate_slots({0: 'a10'}, [a, frag])
    assert prop == {1: 'a10'}


def test_propagate_never_bridges_a_pure_gap():
    a10 = make_chain(0, 30, lambda t: (0.0, 0.0))     # slotted
    frag = make_chain(60, 90, lambda t: (40.0, 0.0))  # no temporal overlap
    prop, _ = slots.propagate_slots({0: 'a10'}, [a10, frag])
    assert prop == {}


def test_propagate_leaves_slotted_chains_and_subslots_intact():
    a10 = make_chain(0, 60, lambda t: (0.0, 0.0))     # slotted a10 (body 1)
    a10b = make_chain(0, 60, lambda t: (20.0, 0.0))   # slotted a10-2 (body 2)
    frag = make_chain(0, 60, lambda t: (1.0, 0.0))    # 1m from a10, 19m from a10-2
    prop, _ = slots.propagate_slots({0: 'a10', 1: 'a10-2'}, [a10, a10b, frag])
    assert prop == {2: 'a10'}                  # frag joins body 1 only
    assert 0 not in prop and 1 not in prop     # slotted chains never re-emitted


# ── enrich ──────────────────────────────────────────────────────────────────

def _payload_chains():
    import build_track
    H = np.eye(3)
    chains = [
        make_chain(0, 120, lambda t: (t * 0.1, 5.0)),    # longest
        make_chain(0, 40, lambda t: (10.0, 10.0)),       # stationary, short
        make_chain(0, 80, lambda t: (t * 0.2, -5.0)),    # middle
    ]
    payload = build_track.build_payload(chains, H, 0, {
        'median_res': 0.005, 'matched_frames': 500,
        'eval': {'rate': 0.5}})
    return chains, payload


def test_attach_labels_matches_build_payload_ids():
    chains, payload = _payload_chains()
    # span order: chain0 (120s) -> chain2 (80s) -> chain1 (40s)
    labels = {0: ('10', 0), 2: ('7', 1), 1: ('99', 0)}
    slot_of = {0: 'a10', 2: 'b7', 1: 'a99'}
    n = enrich.attach_labels(payload, chains, labels, slot_of)
    assert n == 3
    by_id = {o['id']: o for o in payload['objects']}
    assert by_id['o0']['jersey'] == '10' and by_id['o0']['slot'] == 'a10'
    assert by_id['o1']['jersey'] == '7' and by_id['o1']['slot'] == 'b7'
    assert by_id['o2']['jersey'] == '99'


def test_attach_labels_requires_both_label_and_slot():
    chains, payload = _payload_chains()
    n = enrich.attach_labels(payload, chains, {0: ('10', 0)}, {})
    assert n == 0
    assert all('jersey' not in o for o in payload['objects'])


def test_shared_decimation_keeps_endpoints_and_bounds_holds():
    import build_track
    objects = [{
        't': [round(0.4 * i, 2) for i in range(100)],
        'pan': [10.0] * 100,          # stationary
        'tilt': [5.0] * 100,
    }]
    build_track._decimate_objects(objects, build_track.DECIMATE_MOVE_DEG,
                                  build_track.DECIMATE_HOLD_S)
    o = objects[0]
    assert o['t'][0] == 0.0 and o['t'][-1] == pytest.approx(39.6)
    assert len(o['t']) < 100
    diffs = np.diff(o['t'][:-1])      # last gap may be < HOLD_S
    assert (diffs <= build_track.DECIMATE_HOLD_S + 0.401).all()


def test_shared_decimation_keeps_moving_samples():
    import build_track
    objects = [{
        't': [round(0.4 * i, 2) for i in range(50)],
        'pan': [i * 0.2 for i in range(50)],   # fast mover
        'tilt': [0.0] * 50,
    }]
    build_track._decimate_objects(objects, build_track.DECIMATE_MOVE_DEG,
                                  build_track.DECIMATE_HOLD_S)
    assert len(objects[0]['t']) == 50


def test_shared_decimation_idempotent():
    import build_track
    objects = [{
        't': [round(0.4 * i, 2) for i in range(200)],
        'pan': [10.0 + (0.08 if i % 7 == 0 else 0.0) for i in range(200)],
        'tilt': [5.0] * 200,
    }]
    build_track._decimate_objects(objects, 0.12, 4.0)
    once = [list(objects[0]['t'])]
    build_track._decimate_objects(objects, 0.12, 4.0)
    assert objects[0]['t'] == once[0]


def test_build_payload_stamps_decimation_and_meets_caps():
    _, payload = _payload_chains()
    assert 'adaptiveDecimation' in payload['meta']
    enrich.assert_caps(payload)


def test_build_payload_stadium_scale_meets_caps():
    """The HCT failure mode: many stationary crowd chains must decimate
    under the client points cap instead of publishing an over-cap artifact."""
    import build_track
    H = np.eye(3)
    rng = np.random.default_rng(3)
    chains = []
    for i in range(600):   # 600 chains x 10 min stationary = 900k raw pts
        x0, y0 = rng.uniform(-40, 40), rng.uniform(-25, 25)
        chains.append(make_chain(0, 600, lambda t, x0=x0, y0=y0: (x0, y0)))
    payload = build_track.build_payload(chains, H, 0, {
        'median_res': 0.005, 'matched_frames': 500, 'eval': {'rate': 0.5}})
    n_pts = sum(len(o['t']) for o in payload['objects'])
    assert n_pts <= build_track.PAYLOAD_MAX_POINTS
    assert len(payload['objects']) == 600   # decimation, NOT deletion


def test_assert_caps():
    ok = {'objects': [{'t': [1, 2], 'pan': [0, 0], 'tilt': [0, 0]}],
          'meta': {}}
    enrich.assert_caps(ok)
    over = {'objects': [{'t': list(range(200)), 'pan': [0] * 200,
                         'tilt': [0] * 200}] * 4001, 'meta': {}}
    with pytest.raises(RuntimeError):
        enrich.assert_caps(over)


def test_stamp_meta_fields():
    p = {'objects': [], 'meta': {}}
    enrich.stamp_meta(p, harvest_step_s=4.0, source_digest='abc', kits=2,
                      slots=26, labelled=62, split_accepted=3,
                      split_refused=5)
    j = p['meta']['jersey']
    assert j['version'] == 1 and j['slots'] == 26 and j['kits'] == 2
    assert j['sourceDigest'] == 'abc'


# ── review-mandated truth-table additions (CV + senior, 2026-07-18) ─────────

def test_split_refuses_seam_outside_bracket():
    # seam at t=20s but the kit flip bracket is (45s, 60s) — a cut at 20s is
    # provably not the swap and must refuse
    chain = _chain_with_seam(seam_at_s=20.0)
    crop_ts, crop_kits = _crops([30, 35, 40, 45, 60, 65, 70, 75],
                                [0, 0, 0, 0, 1, 1, 1, 1])
    d = split.propose_split(chain, crop_ts, crop_kits, min_span_s=3.0)
    assert not d['accepted']


def test_split_accepts_short_gap_true_joint():
    # the true stitch joint is a SHORT 0.8s bridge (below the old 1.2s
    # floor) inside the bracket; a decoy 2s gap sits far outside it
    a = np.arange(0.0, 50.0, 0.4)
    b = np.arange(50.8, 90.0, 0.4)      # 0.8s bridge at 50s (the true joint)
    c = np.arange(92.0, 100.0, 0.4)     # 2s decoy far outside the bracket
    ts = np.concatenate([a, b, c]) * 1e6
    xy = np.stack([np.linspace(0, 50, len(ts)), np.zeros(len(ts))], axis=1)
    crop_ts, crop_kits = _crops([10, 20, 30, 45, 55, 60, 70, 80],
                                [0, 0, 0, 0, 1, 1, 1, 1])
    d = split.propose_split((ts, xy), crop_ts, crop_kits, min_span_s=3.0)
    assert d['accepted'], d
    assert abs(d['split_t_us'] / 1e6 - 50.4) < 0.5


def test_assign_slots_ambiguous_fragment_gets_no_slot():
    # duplicate-number group: A-early and B are concurrent-far (two proven
    # bodies); A-late never overlaps anything — ambiguous between them, so
    # it keeps its jersey but gets NO slot
    a_early = make_chain(0, 60, lambda t: (0.0, 0.0))
    b = make_chain(0, 60, lambda t: (20.0, 0.0))
    a_late = make_chain(100, 160, lambda t: (5.0, 0.0))
    labels = {0: ('10', 0), 1: ('10', 0), 2: ('10', 0)}
    slot_of, diag = slots.assign_slots(labels, [a_early, b, a_late])
    assert 0 in slot_of and 1 in slot_of
    assert slot_of[0] != slot_of[1]
    assert 2 not in slot_of          # honest ambiguity — no guessed body


def test_assign_slots_refuses_internally_contradicted_component():
    # transitive close-edges chain two bodies together: A~B close, B~C
    # close, but A-C concurrent-far — the merged component contains a
    # proven contradiction and must not ship a slot
    a = make_chain(0, 60, lambda t: (0.0, 0.0))
    b = make_chain(0, 60, lambda t: (2.0, 0.0))     # close to both
    c = make_chain(0, 60, lambda t: (4.5, 0.0))     # >3m from a
    labels = {0: ('9', 0), 1: ('9', 0), 2: ('9', 0)}
    slot_of, diag = slots.assign_slots(labels, [a, b, c])
    assert slot_of == {}            # whole component refused
    assert diag['duplicateNumberGroups'] == 1


def test_build_labels_leg_gate_cannot_mint_a_label():
    # gated view [10,10] would be a strict majority, but the ungated view is
    # a 2-2 tie — the gate removed the rival, and removal must not MINT
    rs = [rec(chain=5, t_vp=10), rec(chain=5, t_vp=20),
          rec(chain=5, t_vp=30, read='16', leg=0.2),
          rec(chain=5, t_vp=40, read='16', leg=0.2)]
    labels, _ = slots.build_labels(rs)
    assert 5 not in labels


def test_cluster_kits_refuses_weak_silhouette():
    rng = np.random.default_rng(5)
    X = rng.normal(0, 10, (30, 4))   # one blob — no real cluster structure
    with pytest.raises(ValueError):
        kit.cluster_kits(X)


# ── synthetic GK zone-slots ──────────────────────────────────────────────────
# pmap = identity: tests build chains directly in pitch metres (100 x 60).

GK_PMAP = np.eye(3)
GK_L, GK_W = 100.0, 60.0
# halves on the µs clock: [0, 3000s] and [3600s, 7000s]
GK_HALVES = [(0.0, 3000e6), (3600e6, 7000e6)]


def gk(chains, taken=frozenset(), halves=GK_HALVES, pmap=GK_PMAP):
    return slots.assign_gk_slots(chains, pmap, GK_L, GK_W, halves, set(taken))


def test_gk_relay_across_a_gap_shares_one_slot():
    # two sequential keeper chains at the west goal, 20s apart — the relay
    # the client's slot hand-off rides
    a = make_chain(100, 200, lambda t: (8.0, 30.0))
    b = make_chain(220, 320, lambda t: (9.0, 32.0))
    slot_of, diag = gk([a, b])
    assert slot_of == {0: 'g1', 1: 'g1'}
    assert diag['gkSlots'] == 1


def test_gk_per_chain_persistence_bar():
    # the keeper's real fragments (31-59s in-band, measured HCT) qualify;
    # box-siege shrapnel (a 20s visit at frac 1.0) does not — the frac alone
    # is meaningless for short chains
    ok = make_chain(100, 140, lambda t: (8.0, 30.0))     # 40s in-band
    short = make_chain(300, 320, lambda t: (8.0, 30.0))  # 20s, frac 1.0
    slot_of, _ = gk([ok, short])
    assert slot_of == {0: 'g1'}


def test_gk_duplicate_fragments_link_into_one_slot():
    # concurrent-close duplicates (the two-dots-on-one-keeper reality) end
    # up in ONE slot, not a contradiction
    a = make_chain(100, 140, lambda t: (8.0, 30.0))
    b = make_chain(110, 150, lambda t: (9.5, 30.5))
    slot_of, diag = gk([a, b])
    assert slot_of == {0: 'g1', 1: 'g1'}
    assert diag['gkRefusedComponents'] == 0


def test_gk_residency_fraction_excludes_visitors():
    # a fullback passing through the band (x: 5 -> 60 over 100s) never
    # qualifies despite starting deep
    a = make_chain(100, 200, lambda t: (5.0 + (t - 100) * 0.55, 30.0))
    slot_of, _ = gk([a])
    assert slot_of == {}


def test_gk_siege_contradiction_refuses_both_components_only():
    # keeper resident 100-300s; a defender parks 12m away for 60s inside the
    # band (overlapping the keeper) -> proven two bodies -> BOTH refused.
    # A later keeper chain (no overlap with the defender) keeps the slot.
    keeper = make_chain(100, 300, lambda t: (6.0, 30.0))
    defender = make_chain(200, 260, lambda t: (10.0, 45.0))  # sep ~15m
    later = make_chain(320, 400, lambda t: (6.0, 30.0))
    slot_of, diag = gk([keeper, defender, later])
    assert 0 not in slot_of and 1 not in slot_of
    assert slot_of.get(2) == 'g1'
    assert diag['gkRefusedComponents'] == 2


def test_gk_subbar_keeper_fragments_refute_a_parked_defender():
    # The keeper is occluded/fragmented (3x20s box-resident shrapnel — below
    # the 30s qualification bar but above the refute bar) while a defender
    # parks 40s in the band: the shrapnel is EVIDENCE of a second body and
    # must refuse the defender's slot (CV review C5).
    k1 = make_chain(100, 120, lambda t: (3.0, 33.0))
    k2 = make_chain(122, 142, lambda t: (3.5, 33.5))
    k3 = make_chain(144, 164, lambda t: (3.0, 34.0))
    defender = make_chain(100, 165, lambda t: (12.0, 40.0))  # ~11m away
    slot_of, diag = gk([k1, k2, k3, defender])
    assert slot_of == {}
    assert diag['gkRefusedComponents'] == 1


def test_gk_box_visitor_does_not_refute_the_resident_keeper():
    # an ordinary attack: a sub-bar box visitor (20s shrapnel, ~10m out)
    # coexists with the qualified goalmouth-deep keeper — the keeper KEEPS
    # the slot (the refuter asymmetry: only a goalmouth-DEEPER sub-bar body
    # refutes; without it, routine attacks refused the keeper's own relay)
    keeper = make_chain(100, 140, lambda t: (3.0, 30.0))
    visitor = make_chain(110, 130, lambda t: (13.0, 27.0))
    slot_of, diag = gk([keeper, visitor])
    assert slot_of == {0: 'g1'}
    assert diag['gkRefusedComponents'] == 0


def test_gk_internal_transitive_contradiction_refused():
    # A-B close, B-C close, A-C far and concurrent: transitive linking
    # chained two bodies into ONE component — internally contradicted,
    # no slot for any member.
    a = make_chain(100, 160, lambda t: (8.0, 30.0))
    b = make_chain(100, 160, lambda t: (8.0, 32.5))   # 2.5m from a
    c = make_chain(100, 160, lambda t: (8.0, 35.0))   # 2.5m from b, 5m from a
    slot_of, diag = gk([a, b, c])
    assert slot_of == {}
    assert diag['gkRefusedComponents'] == 1


def test_gk_residency_clipped_to_half_bounds():
    # a chain straddling the half-2 kickoff with goalmouth residency
    # throughout: only the in-half portion counts (CV review C4) — 20s
    # inside half 2 < 30s bar -> no slot, despite 80s of raw residency
    halves = [(0.0, 1000e6), (2000e6, 5000e6)]
    straddle = make_chain(1940, 2020, lambda t: (8.0, 30.0))
    slot_of, _ = gk([straddle], halves=halves)
    assert slot_of == {}
    # the same chain fully inside the half qualifies
    inside = make_chain(2100, 2180, lambda t: (8.0, 30.0))
    slot_of, _ = gk([inside], halves=halves)
    assert slot_of == {0: 'g3'}


def test_gk_small_pitch_guard():
    # Nazwa-class pitch: the two 18m bands overlap — refuse loudly
    slot_of, diag = slots.assign_gk_slots(
        [make_chain(100, 200, lambda t: (5.0, 8.0))], GK_PMAP, 30.0, 15.0,
        GK_HALVES, set())
    assert slot_of == {}
    assert 'gkSkippedPitch' in diag


def test_gk_half_and_end_routing():
    west_h1 = make_chain(100, 200, lambda t: (8.0, 30.0))
    east_h1 = make_chain(100, 200, lambda t: (94.0, 30.0))
    west_h2 = make_chain(3700, 3800, lambda t: (8.0, 30.0))
    in_break = make_chain(3100, 3500, lambda t: (8.0, 30.0))  # HT break
    slot_of, diag = gk([west_h1, east_h1, west_h2, in_break])
    assert slot_of == {0: 'g1', 1: 'g2', 2: 'g3'}
    assert diag['gkSlots'] == 3


def test_gk_taken_and_bounds():
    keeper = make_chain(100, 200, lambda t: (8.0, 30.0))
    # jersey evidence wins — a taken chain is never gk-slotted
    slot_of, _ = gk([keeper], taken={0})
    assert slot_of == {}
    # off the pitch width (behind the touchline) never qualifies
    off_w = make_chain(100, 200, lambda t: (8.0, -6.0))
    slot_of, _ = gk([off_w])
    assert slot_of == {}
    # behind the goal line inside the apron still counts
    on_line = make_chain(100, 200, lambda t: (-1.0, 30.0))
    slot_of, _ = gk([on_line])
    assert slot_of == {0: 'g1'}


def test_gk_beyond_horizon_samples_are_skipped():
    # a pmap that puts every sample past the horizon (w <= 0) must skip the
    # chain, never mirror it into the band
    pmap = np.array([[1.0, 0, 0], [0, 1.0, 0], [0, 0, -1.0]])
    keeper = make_chain(100, 200, lambda t: (8.0, 30.0))
    slot_of, diag = gk([keeper], pmap=pmap)
    assert slot_of == {}
    assert diag['gkSkippedInvalid'] == 1


def test_half_bounds_from_events_ordering():
    def ev(kind, t):
        return {'event_type': kind, 'timestamp_seconds': t}
    good = [ev('kick_off', 796.26), ev('half_time', 3564.6),
            ev('kick_off', 4528.7), ev('full_time', 7738.36)]
    got = slots.half_bounds_from_events(good, 0, 9000.0)
    assert got == [(796.26e6, 3564.6e6), (4528.7e6, 7738.36e6)]
    # missing full_time -> CAPPED at ko2 + half-1 duration + slack, never
    # "until the file ends" (post-match shootarounds are wrong-body input)
    got = slots.half_bounds_from_events(good[:3], 0, 9000.0)
    cap = 4528.7 + (3564.6 - 796.26) + slots.FT_FALLBACK_SLACK_S
    assert got[1] == (4528.7e6, pytest.approx(cap * 1e6))
    # start_us offsets the chain clock
    got = slots.half_bounds_from_events(good, 5e6, 9000.0)
    assert got[0][0] == 5e6 + 796.26e6
    # PostgREST numeric-as-string coerces; None timestamps are skipped
    stringy = [{**e, 'timestamp_seconds': str(e['timestamp_seconds'])}
               for e in good]
    assert slots.half_bounds_from_events(
        stringy + [ev('kick_off', None)], 0, 9000.0
    ) == slots.half_bounds_from_events(good, 0, 9000.0)
    # ambiguous/inverted inputs refuse
    assert slots.half_bounds_from_events([], 0, 9000.0) is None
    assert slots.half_bounds_from_events(good[:2], 0, 9000.0) is None
    assert slots.half_bounds_from_events(
        good + [ev('half_time', 5000.0)], 0, 9000.0) is None
    assert slots.half_bounds_from_events(
        [ev('kick_off', 4000.0), ev('half_time', 3000.0),
         ev('kick_off', 5000.0)], 0, 9000.0) is None
    # plausibility floors: a bogus t~0 kick_off is dropped, an implausibly
    # short half or long break refuses
    assert slots.half_bounds_from_events(
        [ev('kick_off', 0.2)] + good, 0, 9000.0
    ) == slots.half_bounds_from_events(good, 0, 9000.0)
    assert slots.half_bounds_from_events(
        [ev('kick_off', 3000.0), ev('half_time', 3500.0),
         ev('kick_off', 4000.0)], 0, 9000.0) is None       # 500s half
    assert slots.half_bounds_from_events(
        [ev('kick_off', 100.0), ev('half_time', 2000.0),
         ev('kick_off', 6000.0)], 0, 9000.0) is None       # 4000s break


def test_halves_from_spans_shape_gate():
    # plausible 2-span shape -> halves on the chain clock
    got = slots.halves_from_spans([(100.0, 2800.0), (3800.0, 6400.0)], 5e6)
    assert got == [(5e6 + 100.0e6, 5e6 + 2800.0e6),
                   (5e6 + 3800.0e6, 5e6 + 6400.0e6)]
    # warmup merged into span 1 (3x duration ratio) -> refuse
    assert slots.halves_from_spans([(0.0, 4500.0), (5000.0, 6400.0)],
                                   0) is None
    # a short span is not a half
    assert slots.halves_from_spans([(0.0, 500.0), (1000.0, 3000.0)],
                                   0) is None
    # only exactly-2 spans are halves
    assert slots.halves_from_spans([(0.0, 5000.0)], 0) is None
    assert slots.halves_from_spans(
        [(0.0, 2000.0), (2500.0, 4400.0), (5000.0, 7000.0)], 0) is None


def test_attach_slots_matches_build_payload_ids_and_never_overwrites():
    import build_track
    a = make_chain(0, 400, lambda t: (10.0, 10.0), hz=5)   # longest -> o0
    b = make_chain(0, 200, lambda t: (t * 0.1, 5.0), hz=5)  # -> o1
    c = make_chain(0, 100, lambda t: (30.0, 30.0), hz=5)   # -> o2
    tiny = make_chain(0, 1, lambda t: (40.0, 40.0), hz=5)  # skipped -> o3 gap
    chains = [b, a, tiny, c]   # deliberately not span-ordered
    payload = build_track.build_payload(chains, np.eye(3), 0, {
        'median_res': 0.005, 'matched_frames': 500, 'eval': {'rate': 0.5}})
    n = enrich.attach_labels(payload, chains, {1: ('10', 0)}, {1: 'a10'})
    assert n == 1
    got = enrich.attach_slots(payload, chains,
                              {1: 'g1', 0: 'g1', 3: 'g2', 2: 'g2'})
    by_id = {o['id']: o for o in payload['objects']}
    # o0 (chain index 1) already jersey-slotted -> NOT overwritten
    assert by_id['o0']['slot'] == 'a10'
    assert got == 2
    assert by_id['o1']['slot'] == 'g1' and 'jersey' not in by_id['o1']
    assert by_id['o2']['slot'] == 'g2'
    # the too-short chain was skipped by build_payload (id gap, o3 absent) —
    # its slot attaches nowhere rather than remapping onto a neighbour
    assert 'o3' not in by_id


def test_stamp_meta_carries_gk_slots():
    payload = {'meta': {}}
    enrich.stamp_meta(payload, harvest_step_s=4.0, source_digest='x',
                      kits=2, slots=5, labelled=10, split_accepted=0,
                      split_refused=0, gk_slots=3)
    assert payload['meta']['jersey']['gkSlots'] == 3

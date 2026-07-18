"""Baseline table: no-stitch / legacy 1.5s ceiling / shipped 2.5s ceiling
scored on synthetic Spiideo-like fragmentation of Veo GT.

Usage: python3 run_baselines.py <slug> [<slug> ...] [--noise0] [--gatescale X]

The production stitcher is imported UNCHANGED from the batch job; the
ceiling is toggled via the module global exactly as ceiling_eval.py does
(build_track reads STITCH_EXT_GAP_S at call time — deliberate seam).
"""
from __future__ import annotations

import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    '..', '..', '..', 'infrastructure', 'batch', 'player-tracklets'))
import build_track  # noqa: E402

import fragment_synth  # noqa: E402
import score  # noqa: E402
import veo_gt  # noqa: E402


def prepare(slug: str, add_noise: bool = True, seed: int = 0):
    trk = veo_gt.load_tracking(slug)
    grid = veo_gt.grid_check(trk)
    tracks = veo_gt.player_tracks(trk)
    gid_of, jstats = veo_gt.jersey_chain_ids(tracks)
    runs = veo_gt.contiguous_runs(tracks, gid_of, trk.get('periods', []))
    print(f'{slug}: grid {grid}')
    print(f'  jersey-chain {jstats}')
    print(f'  gt {veo_gt.gt_stats(tracks, gid_of, runs)}')

    idx = fragment_synth.frame_index(runs)
    crowd = fragment_synth.crowded_mask(runs, idx)
    q0, beta, p = fragment_synth.fit_hazard(crowd)
    sigma_veo = fragment_synth.estimate_veo_sigma(runs)
    top_up = float(np.sqrt(max(
        fragment_synth.SIGMA_TARGET_M ** 2 - sigma_veo ** 2, 0.0))) \
        if add_noise else 0.0
    print(f'  hazard q0={q0:.5f} beta={beta:.2f} crowd_occupancy={p:.3f}; '
          f'veo sigma={sigma_veo:.3f}m, top-up={top_up:.3f}m')
    frags, frag_gids, cuts = fragment_synth.synthesize(
        runs, crowd, q0, beta, top_up, seed=seed)
    fragment_synth.validate_marginals(frags, frag_gids, cuts, runs)
    return runs, frags


def stitch_variant(frags: list, ext_gap_s: float | None):
    if ext_gap_s is None:   # no-stitch: fragments ARE the chains
        return [(ts.copy(), xy.copy()) for ts, xy in frags]
    saved = build_track.STITCH_EXT_GAP_S
    build_track.STITCH_EXT_GAP_S = ext_gap_s
    try:
        return build_track.stitch([(ts.copy(), xy.copy())
                                   for ts, xy in frags])
    finally:
        build_track.STITCH_EXT_GAP_S = saved


def run_match(slug: str, add_noise: bool = True, gate_scale: float = 1.0):
    runs, frags = prepare(slug, add_noise=add_noise)
    gt_tab = score.gt_frame_table(runs)
    gate = score.GATE_M * gate_scale
    rows = []
    for name, ext in (('no-stitch', None), ('legacy-1.5s', 1.5),
                      ('shipped-2.5s', 2.5)):
        chains = stitch_variant(frags, ext)
        ch_tab = score.chain_frame_table(chains)
        m = score.run_metrics(gt_tab, ch_tab, gate_m=gate)
        curve = score.per_t_curve(gt_tab, ch_tab, chains, gate_m=gate)
        rows.append((name, len(chains), m, curve))
    print(f'\n=== {slug} (gate {gate:.2f}m'
          f'{", no added noise" if not add_noise else ""}) ===')
    hdr = (f'{"variant":>14} {"chains":>6} {"HOTA":>6} {"AssA":>6} '
           f'{"DetA":>6} {"IDF1":>6} {"MOTA":>6}')
    print(hdr)
    for name, n, m, _ in rows:
        print(f'{name:>14} {n:>6} {m["hota"]["HOTA"]:>6.3f} '
              f'{m["hota"]["AssA"]:>6.3f} {m["hota"]["DetA"]:>6.3f} '
              f'{m["identity"]["IDF1"]:>6.3f} {m["clear"]["MOTA"]:>6.3f}')
    print(f'\nper-T P(right)/P(wrong)/P(lost):')
    print(f'{"variant":>14} ' + ' '.join(f'{f"T={int(T)}s":>20}'
                                         for T in score.PER_T_S))
    for name, _, _, curve in rows:
        cells = ' '.join(
            f'{curve[T]["right"]:.2f}/{curve[T]["wrong"]:.2f}'
            f'/{curve[T]["lost"]:.2f}'.rjust(20) for T in score.PER_T_S)
        print(f'{name:>14} {cells}')
    return rows


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    add_noise = '--noise0' not in sys.argv
    gate_scale = 1.0
    for a in sys.argv[1:]:
        if a.startswith('--gatescale'):
            gate_scale = float(a.split('=')[1])
    for slug in args:
        run_match(slug, add_noise=add_noise, gate_scale=gate_scale)

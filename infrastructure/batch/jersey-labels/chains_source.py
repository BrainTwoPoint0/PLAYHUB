"""Reconstruct the EXACT production chains from archived provenance —
`tracklets-raw.tar.gz` + `tracklets-solve.json` (the reconstruct_chains.py
path, proven byte-exact against the live pipeline).

start_time_us: newer solve docs carry it (added alongside this job); older
ones do not — then chains are built on the RELATIVE clock (start_us=0),
which produces the same continuous trajectories and the same produced-video
`t` values up to sub-SAMPLE_DT grid phase (the grid snaps to 0.2s lattices
in whichever clock is used; positions are interpolated identically).
"""
from __future__ import annotations

import hashlib
import json
import tarfile
from pathlib import Path

import numpy as np

import build_track


def load_provenance(data_dir: str) -> tuple:
    """(solve_doc, items, sha256 digest over both artifacts)."""
    d = Path(data_dir)
    solve_bytes = (d / 'tracklets-solve.json').read_bytes()
    solve = json.loads(solve_bytes)
    h = hashlib.sha256(solve_bytes)
    items = []
    tar_path = d / 'tracklets-raw.tar.gz'
    h.update(tar_path.read_bytes())
    with tarfile.open(tar_path) as tf:
        for m in tf.getmembers():
            if not m.name.endswith('.json'):
                continue
            idx = int(Path(m.name).stem.split('-')[-1])
            items.append((idx, tf.extractfile(m).read()))
    return solve, items, h.hexdigest()


def build_chains(solve: dict, items: list) -> tuple:
    """(chains, H, start_us) — the production pipeline, unchanged."""
    cadence_us = int(solve['cadence_us'])
    pitch_lo = np.asarray(solve['pitch_lo'], float)
    pitch_hi = np.asarray(solve['pitch_hi'], float)
    H = np.asarray(solve['H'], float)
    start_us = int(solve.get('start_time_us', 0))
    frags = build_track.parse_items(items, start_us, cadence_us)
    on_pitch = build_track.filter_on_pitch(frags, pitch_lo, pitch_hi)
    chains = build_track.stitch(on_pitch)
    chains = build_track.filter_chains_on_pitch(chains, pitch_lo, pitch_hi)
    return chains, H, start_us

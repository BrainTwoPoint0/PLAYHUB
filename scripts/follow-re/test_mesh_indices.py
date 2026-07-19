"""Tests for Spiideo strip → triangle-list conversion."""
from __future__ import annotations

import numpy as np
import pytest

from mesh_indices import (
    ensure_triangle_list,
    looks_like_triangle_strip,
    strip_to_triangle_list,
)


def test_strip_expands_with_alternating_winding():
    # strip: 0-1-2-3 → tris (0,1,2) and (2,1,3)  [odd = BAC of 1,2,3]
    I = np.array([0, 1, 2, 3], np.uint32)
    out = strip_to_triangle_list(I)
    assert out.tolist() == [0, 1, 2, 2, 1, 3]


def test_strip_skips_degenerate_restart():
    # classic Spiideo restart: [a,a,b,...]
    I = np.array([5, 5, 0, 6, 1], np.uint32)
    out = strip_to_triangle_list(I)
    # i=0: 5,5,0 degenerate skip
    # i=1 (odd): 5,0,6 → BAC (0,5,6)
    # i=2 (even): 0,6,1 → ABC (0,6,1)
    assert out.tolist() == [0, 5, 6, 0, 6, 1]


def test_looks_like_strip_on_mod3_and_restart():
    assert looks_like_triangle_strip(np.array([0, 1, 2, 3, 4], np.uint32))  # %3 != 0
    assert looks_like_triangle_strip(np.array([9, 9, 0, 10, 1, 11], np.uint32))  # restart


def test_list_mesh_not_detected_as_strip():
    # our-style: consecutive tris share an edge, no duplicates, %3==0
    I = np.array([8, 158, 9, 9, 158, 159, 9, 159, 10, 10, 159, 160], np.uint32)
    assert not looks_like_triangle_strip(I, n_vertices=200)


def test_ensure_passthrough_list():
    I = np.array([0, 1, 2, 2, 1, 3], np.uint32)
    out, converted = ensure_triangle_list(I, force_strip=False)
    assert not converted
    assert out.tolist() == I.tolist()


def test_ensure_converts_strip():
    I = np.array([0, 1, 2, 3], np.uint32)
    out, converted = ensure_triangle_list(I, force_strip=True)
    assert converted
    assert out.tolist() == [0, 1, 2, 2, 1, 3]


def test_real_spiideo_fp_strip_file():
    from pathlib import Path

    p = Path(__file__).resolve().parents[3] / "veo-automations/captured-play-projection-recon/spiideo-mesh-fp/indices.bin"
    if not p.exists():
        # workspace layout: PLAYBACK Workspace/veo-automations/...
        p = Path(__file__).resolve().parents[4] / "veo-automations/captured-play-projection-recon/spiideo-mesh-fp/indices.bin"
    if not p.exists():
        pytest.skip("spiideo-mesh-fp not present")
    I = np.frombuffer(p.read_bytes(), np.uint32)
    assert looks_like_triangle_strip(I, n_vertices=64798)
    out, converted = ensure_triangle_list(I, n_vertices=64798)
    assert converted
    assert out.size % 3 == 0
    assert out.size // 3 == 128520  # measured in recon
    assert out.max() < 64798

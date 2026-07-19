"""Triangle-strip → triangle-list conversion for Spiideo VirtualPanorama meshes.

Spiideo's projectionParameters indices.bin is a triangle STRIP (often with
degenerate restarts like [a,a,b,...]). Our player and mesh_dewarp expect a
triangle LIST (groups of 3). Interpreting a strip as a list yields ~33%
speckled coverage — the FP pilot failure mode.
"""
from __future__ import annotations

import numpy as np


def strip_to_triangle_list(indices: np.ndarray) -> np.ndarray:
    """Expand a triangle strip (uint32) to a flat triangle-list index array.

    Skips degenerate consecutive pairs (strip restarts). Alternating winding
    matches GL triangle-strip convention (even: ABC, odd: BAC).
    """
    I = np.asarray(indices, dtype=np.uint32).reshape(-1)
    if I.size < 3:
        return np.zeros(0, dtype=np.uint32)
    tris: list[int] = []
    for i in range(I.size - 2):
        a, b, c = int(I[i]), int(I[i + 1]), int(I[i + 2])
        if a == b or b == c or a == c:
            continue
        if i % 2 == 0:
            tris.extend((a, b, c))
        else:
            tris.extend((b, a, c))
    return np.asarray(tris, dtype=np.uint32)


def looks_like_triangle_strip(indices: np.ndarray, n_vertices: int | None = None) -> bool:
    """Heuristic for Spiideo strip vs our triangle-list meshes.

    Reliable signals (in order):
      1. ni % 3 != 0 — Spiideo strips often end mid-primitive; lists never do.
      2. Leading restart [a,a,...] — classic strip restart; lists don't start that way.
      3. Near-zero shared-edge rate when read as a list — strip-as-list has ~0
         consecutive shared edges; our generate_mesh lists share heavily.

    Note: consecutive duplicate indices ALSO appear in lists at shared-vertex
    seams (…,v, v,…) — do NOT use "any duplicate pair" alone.
    """
    I = np.asarray(indices, dtype=np.uint32).reshape(-1)
    if I.size < 3:
        return False
    if I.size % 3 != 0:
        return True
    if I[0] == I[1]:
        return True
    t = I.reshape(-1, 3)
    if n_vertices is not None and n_vertices > 0:
        if not np.all((t >= 0) & (t < n_vertices)):
            return False
    n = min(500, len(t) - 1)
    if n <= 0:
        return False
    share = 0
    for i in range(n):
        if len(set(t[i].tolist()) & set(t[i + 1].tolist())) >= 2:
            share += 1
    return (share / n) < 0.05

def ensure_triangle_list(
    indices: np.ndarray, n_vertices: int | None = None, force_strip: bool | None = None
) -> tuple[np.ndarray, bool]:
    """Return (triangle_list_indices, converted_from_strip)."""
    I = np.asarray(indices, dtype=np.uint32).reshape(-1)
    is_strip = looks_like_triangle_strip(I, n_vertices) if force_strip is None else bool(force_strip)
    if not is_strip:
        return I, False
    return strip_to_triangle_list(I), True

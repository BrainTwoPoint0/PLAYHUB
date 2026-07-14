"""Detection-stream sampling + parsing for the H solve.

Detection results carry ABSOLUTE per-result timestamps (unlike tracklet
timeOffsets) — use them directly, ignore item numbering (the 2026-07-11
detections-item-475s-vs-900s lesson). Import-safe: no env reads.
"""

from __future__ import annotations

import json

import numpy as np

import spiideo


def _item_first_ts(raw: bytes) -> int | None:
    try:
        data = json.loads(raw)
        for cr in data.get('camera_results', []):
            for r in cr.get('results', []):
                return int(r['timestamp'])
    except (ValueError, KeyError, TypeError):
        pass
    return None


def sample_detection_items(game_id: str, stream_id: str, target: int,
                           window_us: tuple[int, int] | None = None) -> list:
    """Fetch `target` items spread across the stream, restricted to a time
    window when given. The tracklets stream can be SHORTER than the detection
    stream (pilot game: tracker stopped at 35 of 56 min) — sampling outside
    the tracklet window wastes the whole budget on unpairable frames. Item
    index maps ~linearly to time, anchored by probing the ends."""
    def fetch(idx: int) -> bytes | None:
        return spiideo._get(
            f'{spiideo.CF}/{game_id}/{stream_id}/item-{idx:08d}')

    first = fetch(0)
    if first is None:
        return []
    lo, hi = 0, 1
    while hi < spiideo.MAX_ITEMS and fetch(hi) is not None:
        lo, hi = hi, hi * 2
    while lo + 1 < hi:
        mid = (lo + hi) // 2
        if fetch(mid) is not None:
            lo = mid
        else:
            hi = mid
    count = lo + 1

    lo_idx, hi_idx = 0, count - 1
    if window_us and count > 2:
        last = fetch(count - 1)
        ts0 = _item_first_ts(first)
        ts1 = _item_first_ts(last) if last else None
        if ts0 is not None and ts1 is not None and ts1 > ts0:
            per_idx = (ts1 - ts0) / (count - 1)
            lo_idx = max(0, int((window_us[0] - ts0) / per_idx) - 1)
            hi_idx = min(count - 1, int((window_us[1] - ts0) / per_idx) + 1)
            if hi_idx <= lo_idx:
                lo_idx, hi_idx = 0, count - 1

    idxs = sorted(set(
        int(round(i)) for i in
        np.linspace(lo_idx, hi_idx, min(target, hi_idx - lo_idx + 1))))
    items = []
    for idx in idxs:
        raw = fetch(idx)
        if raw is not None:
            items.append((idx, raw))
    return items


def parse_detection_items(items: list[tuple[int, bytes]], uv_to_rayn,
                          frames: dict | None = None) -> dict:
    """Detection items -> {abs_ts_us: (feet uv (N,2), feet rayn (N,2))}
    for label-1 (person) boxes; frames with <4 feet are useless for the
    Hungarian assignment and dropped.

    NOTE: the index probe assumes contiguous item indices — a mid-stream
    gap makes the count converge early and shrinks the sampling window
    (accepted: the window mapping degrades gracefully and the eval gate
    catches a starved solve).

    Pass the same `frames` dict across calls to MERGE multi-camera streams:
    timestamp collisions concatenate (2-cam scenes share a frame grid — a
    plain dict.update would last-writer-win one whole camera away)."""
    if frames is None:
        frames = {}
    for _, raw in items:
        try:
            data = json.loads(raw)
        except ValueError:
            continue
        for cr in data.get('camera_results', []):
            for r in cr.get('results', []):
                feet = [[b['bounding_box']['x']
                         + b['bounding_box']['width'] / 2,
                         b['bounding_box']['y']
                         + b['bounding_box']['height']]
                        for b in r.get('detections', [])
                        if b.get('label') == 1]
                if len(feet) >= 4:
                    fv = np.array(feet, np.float64)
                    ts = int(r['timestamp'])
                    if ts in frames:
                        prev_uv, prev_rn = frames[ts]
                        frames[ts] = (
                            np.vstack([prev_uv, fv]),
                            np.vstack([prev_rn, uv_to_rayn(fv)]),
                        )
                    else:
                        frames[ts] = (fv, uv_to_rayn(fv))
    return frames

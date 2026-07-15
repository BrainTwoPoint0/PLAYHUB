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


def fetch_window_items(game_id: str, stream: dict,
                       window_us: tuple[int, int],
                       fetch=None) -> list:
    """Fetch every detection item overlapping [t0, t1] (absolute µs) — a
    DENSE CONTIGUOUS window, the shape the reference solve was validated on.
    Item index -> time comes from stream metadata (span / numItems), then the
    first fetched item's own absolute timestamps correct the estimate (the
    2026-07-11 detections-item-index lesson: content timestamps are truth,
    numbering is only a map)."""
    if fetch is None:
        def fetch(idx: int) -> bytes | None:
            return spiideo._get(
                f'{spiideo.CF}/{game_id}/{stream["id"]}/item-{idx:08d}')

    start = stream.get('startTime')
    stop = stream.get('stopTime')
    n = stream.get('numItems')
    if start is None or stop is None or not n:
        return []
    cad = max((int(stop) - int(start)) / max(int(n), 1), 1e5)

    def idx_for(ts: int) -> int:
        return min(max(int((ts - int(start)) / cad), 0), int(n) - 1)

    lo_idx = idx_for(window_us[0])
    probe = fetch(lo_idx)
    if probe is not None:
        ts0 = _item_first_ts(probe)
        if ts0 is not None:
            # walk the residual error of the linear map (usually 0-1 items)
            shift = int(round((ts0 - window_us[0]) / cad))
            if shift:
                lo_idx = min(max(lo_idx - shift, 0), int(n) - 1)
    hi_idx = min(lo_idx + int((window_us[1] - window_us[0]) / cad) + 2,
                 int(n) - 1)

    items = []
    for idx in range(max(lo_idx - 1, 0), hi_idx + 1):
        raw = fetch(idx)
        if raw is not None:
            items.append((idx, raw))
    return items


def parse_detection_items(items: list[tuple[int, bytes]], uv_to_rayn,
                          frames: dict | None = None,
                          window_us: tuple[int, int] | None = None) -> dict:
    """Detection items -> {abs_ts_us: (feet uv (N,2), feet rayn (N,2))}
    for label-1 (person) boxes; frames with <4 feet are useless for the
    Hungarian assignment and dropped.

    `window_us` clamps results to the requested window: fetched items pad
    past the window edges, and without the clamp solve-window frames leak
    into the held-out eval windows at small tracklet spans.

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
        if not isinstance(data, dict):
            continue
        for cr in data.get('camera_results', []):
            for r in cr.get('results', []):
                if window_us is not None:
                    try:
                        ts_r = int(r['timestamp'])
                    except (KeyError, TypeError, ValueError):
                        continue
                    if not window_us[0] <= ts_r <= window_us[1]:
                        continue
                feet = [[b['bounding_box']['x']
                         + b['bounding_box']['width'] / 2,
                         b['bounding_box']['y']
                         + b['bounding_box']['height']]
                        for b in r.get('detections', [])
                        if b.get('label') == 1]
                if len(feet) >= 4:
                    fv = np.array(feet, np.float64)
                    rn = uv_to_rayn(fv)
                    # NaN = outside mesh coverage (uv_to_rayn's query cap)
                    ok = ~np.isnan(rn).any(axis=1)
                    if ok.sum() < 4:
                        continue
                    fv, rn = fv[ok], rn[ok]
                    ts = int(r['timestamp'])
                    if ts in frames:
                        prev_uv, prev_rn = frames[ts]
                        frames[ts] = (
                            np.vstack([prev_uv, fv]),
                            np.vstack([prev_rn, rn]),
                        )
                    else:
                        frames[ts] = (fv, rn)
    return frames

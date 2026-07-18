"""Detection-stream sampling + parsing for the H solve.

Detection results carry ABSOLUTE per-result timestamps (unlike tracklet
timeOffsets) — use them directly, ignore item numbering (the 2026-07-11
detections-item-475s-vs-900s lesson). Import-safe: no env reads.

Multi-camera scenes (2026-07-17, the HCT time-base-gate incident): each
detection stream carries uv normalized in its OWN lens frame, while the scene
mesh (and the raw VP it describes) is the k lens views STACKED as horizontal
strips. Feeding per-lens uv into the stacked mesh routes most detections
through the wrong lens's geometry — rayn becomes junk, the det speed profile
decorrelates from the tracklets, and the time-base gate fires with a spurious
lag even though occupancy proves the timeline aligned at 0. The fix is a
per-stream `uv_transform` mapping lens uv into the VP frame; the camera->strip
assignment is not published anywhere, so `strip_candidates` enumerates the
possibilities and the caller arbitrates with the lag-gate correlation
(identity stays a candidate, so a venue whose det uv are already VP-frame —
every single-camera scene — is unaffected).
"""

from __future__ import annotations

import json

import numpy as np

import spiideo

# Fence/spectator rows sit at the top of each LENS view (mirrors
# solve_h.FENCE_V, which masks the same rows in VP-frame v for single-camera
# scenes). Applied pre-transform when a uv_transform is set: the bottom
# strip's fence rows land at VP v ~0.5+ and would sail past the VP-frame mask.
LENS_FENCE_V = 0.18


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


def _strip_transform(strip: int, k: int):
    def tf(pts: np.ndarray, strip=strip, k=k) -> np.ndarray:
        out = pts.copy()
        out[:, 1] = (strip + out[:, 1]) / k
        return out
    return tf


def strip_candidates(det_streams: list[dict]) -> list[tuple[str, dict | None]]:
    """Candidate det-uv layouts as (label, {stream_id: uv_transform} | None).

    None = identity (det uv already in the VP frame — true for every
    single-camera scene, so those get exactly one candidate and behave
    byte-identically to before). For k >= 2 streams the raw VP stacks the k
    lens views as equal horizontal strips top-to-bottom; the camera->strip
    assignment is unpublished, so every permutation is offered. The caller
    arbitrates with the lag-gate correlation — a spatially wrong layout
    destroys the det speed profile, so the true layout wins on r."""
    k = len(det_streams)
    if k < 2 or k > 3:  # k>3: factorial sweep unjustified — identity + gate
        return [('identity', None)]
    from itertools import permutations
    ids = [s['id'] for s in det_streams]
    out: list[tuple[str, dict | None]] = [('identity', None)]
    for perm in permutations(range(k)):
        label = 'strips:' + ','.join(
            f'{ids[i][:8]}->{perm[i]}' for i in range(k))
        out.append((label, {ids[i]: _strip_transform(perm[i], k)
                            for i in range(k)}))
    return out


def choose_layout(candidates: list[tuple[str, dict | None]],
                  build_frames, score) -> tuple:
    """Arbitrate det-uv layout candidates (pure — fully unit-testable).

    `build_frames(transforms) -> {window: frames}`; `score(pooled_frames) ->
    (lag_s, r)` — the caller passes a lag scan CONSTRAINED to the time-base
    gate's window (|lag| <= MAX_LAG_S): an unconstrained scan lets a wrong
    layout shop ~480 lag bins for a noise peak (~0.2-0.25) while the true
    layout reports its lag-0 r, biasing the comparison (2026-07-17 review).

    Selection: max r; NaN never wins; an EMPTY parse scores NaN, not the
    real 0.0 lag_peak_s returns for an empty dict (a candidate that parsed
    zero frames must not outrank a no-overlap NaN and hijack the error
    message). Ties keep the earlier candidate — identity is ordered first,
    so ties break toward the pre-fix behavior.

    Returns (label, transforms, det_windows, diag)."""
    best = None
    diag: dict = {}
    for label, transforms in candidates:
        dw = build_frames(transforms)
        pooled: dict = {}
        for frames in dw.values():
            pooled.update(frames)
        if pooled:
            lag, r = score(pooled)
        else:
            lag, r = 0.0, float('nan')
        diag[label] = {'lag_s': None if np.isnan(r) else lag,
                       'lag_r': None if np.isnan(r) else round(float(r), 3)}
        if best is None or (not np.isnan(r)
                            and (np.isnan(best[3]) or r > best[3])):
            best = (label, transforms, dw, r)
    label, transforms, dw, _ = best
    return label, transforms, dw, diag


def parse_detection_items(items: list[tuple[int, bytes]], uv_to_rayn,
                          frames: dict | None = None,
                          window_us: tuple[int, int] | None = None,
                          uv_transform=None) -> dict:
    """Detection items -> {abs_ts_us: (feet uv (N,2), feet rayn (N,2))}
    for label-1 (person) boxes; frames with <4 feet are useless for the
    Hungarian assignment and dropped.

    `window_us` clamps results to the requested window: fetched items pad
    past the window edges, and without the clamp solve-window frames leak
    into the held-out eval windows at small tracklet spans.

    `uv_transform` (multi-camera scenes): maps this stream's per-lens uv
    into the VP/mesh frame. Applied to BOTH the rayn query and the stored
    uv, so downstream consumers (fence mask, validation-PNG greens) see
    VP-frame coordinates; the lens-local fence rows are dropped BEFORE the
    transform (see LENS_FENCE_V).

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
                    if uv_transform is not None:
                        fv = fv[fv[:, 1] > LENS_FENCE_V]
                        if len(fv) < 4:
                            continue
                        fv = uv_transform(fv)
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

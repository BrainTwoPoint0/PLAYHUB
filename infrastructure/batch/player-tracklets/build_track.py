"""Parse tracklet items into per-object series, filter to on-pitch objects,
stitch fragments conservatively, and convert to the player's pan/tilt space.

Identity caveat (research, 2026-07-11): objectUUID continuity across the 10s
item boundary is unverified and fragments run up to ~15s, so stitching is
deliberately conservative — a wrong bridge makes the spotlight jump to a
stranger, which is worse than a shorter followable segment (the client
re-associates on fragment end anyway).
"""

from __future__ import annotations

import json

import numpy as np
import cv2

from mesh_rays import rayn_pan_tilt_deg

SAMPLE_FPS = 5
# Objects with fewer samples than this (~2s) are noise/transients.
MIN_SAMPLES = 10
# Stitch gates: bridge two fragments only when the gap and jump are small AND
# no second candidate is anywhere near (ambiguity kills the bridge).
STITCH_MAX_GAP_S = 1.5
STITCH_MAX_DIST_M = 2.5
STITCH_AMBIGUITY_RATIO = 1.5
# Artifact size budget — beyond this, halve the sample rate (client lerps).
MAX_TOTAL_POINTS = 700_000


def parse_items(items: list[tuple[int, bytes]], start_time_us: int) -> dict:
    """(index, raw json bytes) -> {uuid: [(abs_ts_us, x, y), ...] sorted,
    deduped on abs_ts (adjacent items overlap)."""
    objects: dict[str, dict[int, tuple[float, float]]] = {}
    for idx, raw in items:
        base = start_time_us + idx * 10 * 1_000_000
        data = json.loads(raw)
        for oid, pts in data.items():
            if not isinstance(pts, list):
                continue
            dst = objects.setdefault(oid, {})
            for p in pts:
                try:
                    ts = base + int(round(p['timeOffset']))
                    dst[ts] = (float(p['x']), float(p['y']))
                except (KeyError, TypeError, ValueError):
                    continue
    out = {}
    for oid, d in objects.items():
        if len(d) < MIN_SAMPLES:
            continue
        ts = np.array(sorted(d), np.int64)
        xy = np.array([d[t] for t in ts], np.float64)
        out[oid] = (ts, xy)
    return out


def filter_on_pitch(objects: dict, lo, hi) -> dict:
    """Keep objects whose MEDIAN position is inside the pitch rect —
    spectators/staff sit at fixed off-pitch spots for the whole match."""
    lo = np.asarray(lo)
    hi = np.asarray(hi)
    out = {}
    for oid, (ts, xy) in objects.items():
        med = np.median(xy, axis=0)
        if np.all(med > lo) and np.all(med < hi):
            out[oid] = (ts, xy)
    return out


def stitch(objects: dict) -> list[tuple[np.ndarray, np.ndarray]]:
    """Greedy conservative fragment stitching. Returns a list of
    (ts, xy) series (identity = one stitched chain)."""
    frags = sorted(objects.values(), key=lambda f: int(f[0][0]))
    used = [False] * len(frags)
    chains: list[list[int]] = []
    for i in range(len(frags)):
        if used[i]:
            continue
        used[i] = True
        chain = [i]
        while True:
            ts_end = int(frags[chain[-1]][0][-1])
            pos_end = frags[chain[-1]][1][-1]
            cands = []
            for j in range(len(frags)):
                if used[j]:
                    continue
                gap = (int(frags[j][0][0]) - ts_end) / 1e6
                if not (0.0 < gap <= STITCH_MAX_GAP_S):
                    continue
                dist = float(np.linalg.norm(frags[j][1][0] - pos_end))
                if dist <= STITCH_MAX_DIST_M:
                    cands.append((dist, j))
            if not cands:
                break
            cands.sort()
            if (len(cands) > 1
                    and cands[1][0] < cands[0][0] * STITCH_AMBIGUITY_RATIO):
                break  # ambiguous — do not bridge
            j = cands[0][1]
            used[j] = True
            chain.append(j)
        chains.append(chain)

    out = []
    for chain in chains:
        ts = np.concatenate([frags[i][0] for i in chain])
        xy = np.concatenate([frags[i][1] for i in chain])
        order = np.argsort(ts)
        ts, xy = ts[order], xy[order]
        keep = np.concatenate([[True], np.diff(ts) > 0])
        out.append((ts[keep], xy[keep]))
    return out


def build_payload(chains: list, H: np.ndarray, start_time_us: int,
                  diag: dict) -> dict:
    """Chains + homography -> the public tracklets.json payload.

    t is seconds on the produced-video clock (assumes the produced video
    starts at the stream start — the aim-track pipeline's validated base);
    t0OffsetSec lets a future per-game correction shift it client-side."""
    chains = sorted(chains, key=lambda c: -len(c[0]))
    total = sum(len(c[0]) for c in chains)
    step = 2 if total > MAX_TOTAL_POINTS else 1

    objects = []
    for i, (ts, xy) in enumerate(chains):
        ts, xy = ts[::step], xy[::step]
        if len(ts) < MIN_SAMPLES:
            continue
        # Strictly-ascending must survive the 2-decimal rounding: a stitch
        # bridge or item-overlap pair can be <10ms apart, which rounds to a
        # DUPLICATE t — and the client rejects the whole artifact on any
        # non-ascending t (null-degrade, no signal, row already 'ready').
        t_round = np.round((ts - start_time_us) / 1e6, 2)
        keep = np.concatenate([[True], np.diff(t_round) > 0])
        ts, xy, t_round = ts[keep], xy[keep], t_round[keep]
        if len(ts) < MIN_SAMPLES:
            continue
        rn = cv2.perspectiveTransform(
            xy[None].astype(np.float32), H.astype(np.float64))[0]
        pan, tilt = rayn_pan_tilt_deg(rn.astype(np.float64))
        objects.append({
            'id': f'o{i}',
            't': [float(v) for v in t_round],
            'pan': [round(float(v), 2) for v in pan],
            'tilt': [round(float(v), 2) for v in tilt],
        })

    return {
        'version': 1,
        'sampleFps': SAMPLE_FPS / step,
        't0OffsetSec': 0.0,
        'objects': objects,
        'meta': {
            'hMedianRes': round(diag['median_res'], 5),
            'matchedFrames': diag['matched_frames'],
            'nObjects': len(objects),
            'downsampled': step > 1,
        },
    }

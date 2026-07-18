"""Play-anchored crop harvest — "ball → zoom → ring" (B2 design, measured).

Uniform wide-frame sampling harvests the near-camera bench/staff strip (two
galleries rejected during B1); the play-anchored design instead:

  1. PLAY position per 2s bin — median of chains moving 1-10 m/s (pure
     tracklet math; aim track / ball detection can replace this later).
  2. DENSE harvest — sample every ``step_s`` across the in-match,
     video-covered span; crop the NATIVE panorama around the projected play
     (virtual zoom, full source pixels); run the detector inside that window
     only (~20-25x fewer detector calls than full-frame tiling).
  3. Associate boxes to chains (Hungarian, same conventions as B1), keep
     solo crops with the chain's metric DISTANCE TO PLAY at that moment —
     the 25m gate that deletes the staff population is applied downstream.

Everything except the detector call and the video read is pure and unit
tested; the detector is injected as a callable so tests never need torch.
"""
from __future__ import annotations

from collections import defaultdict

import numpy as np

# Frame / crop conventions (probe conventions — the reader was validated on
# crops produced exactly this way; do not change without re-measuring).
SEAM_FRACTION = 0.5      # stacked 2-lens panorama: seam at H/2
MARGIN = 0.18            # crop pad, fraction of box height
ASSOC_GATE_PX = 80.0
MIN_BOX_H_PX = 64.0
ASPECT_LO, ASPECT_HI = 0.15, 1.2
SOLO_MAX_OVERLAP = 0.15

# Play-centroid parameters (B2, measured on HCT).
PLAY_BIN_S = 2.0
PLAY_SPEED_LO, PLAY_SPEED_HI = 1.0, 10.0
PLAY_MIN_MOVERS = 3
NEAR_PLAY_M = 25.0
MIN_NEAR_PLAY = 3

# Harvest window geometry.
WIN_MARGIN_PX = 140
WIN_MIN = 640
WIN_MAX_W, WIN_MAX_H = 1920, 1080

# In-match derivation (replaces B2's hardcoded IN_MATCH_LO_S=2000, an HCT
# constant). A bin is "active" when enough bodies move at play speeds; the
# in-match region is the smoothed-activity span — warmup has sparse,
# uncoordinated movement, a real match has 10-20 concurrent movers.
ACTIVITY_SMOOTH_S = 60.0
ACTIVITY_FRACTION = 0.5   # of the p90 smoothed mover count
MIN_SPAN_S = 300.0
MAX_GAP_S = 120.0


def play_centroids(chains: list, start_us: int) -> dict:
    """{bin_idx: (x, y)} — median metric position of moving chains per bin."""
    acc = defaultdict(list)
    for ts, xy in chains:
        t = np.asarray(ts, float) / 1e6
        dt = np.diff(t)
        sp = np.linalg.norm(np.diff(xy, axis=0), axis=1) / np.maximum(dt, 1e-9)
        mv = (sp > PLAY_SPEED_LO) & (sp < PLAY_SPEED_HI)
        tb = ((t[1:][mv] - start_us / 1e6) / PLAY_BIN_S).astype(int)
        for b, p in zip(tb, xy[1:][mv]):
            acc[b].append(p)
    return {b: np.median(np.stack(v), axis=0)
            for b, v in acc.items() if len(v) >= PLAY_MIN_MOVERS}


def mover_counts(chains: list, start_us: int) -> dict:
    """{bin_idx: n movers} — same movers as play_centroids, no minimum."""
    acc: dict = defaultdict(int)
    for ts, xy in chains:
        t = np.asarray(ts, float) / 1e6
        dt = np.diff(t)
        sp = np.linalg.norm(np.diff(xy, axis=0), axis=1) / np.maximum(dt, 1e-9)
        mv = (sp > PLAY_SPEED_LO) & (sp < PLAY_SPEED_HI)
        for b in ((t[1:][mv] - start_us / 1e6) / PLAY_BIN_S).astype(int):
            acc[b] += 1
    return dict(acc)


def in_match_spans(counts: dict, bin_s: float = PLAY_BIN_S) -> list:
    """[(t_lo_s, t_hi_s)] relative to start — the smoothed-activity spans.

    Active bin = smoothed mover count >= ACTIVITY_FRACTION * p90(smoothed).
    Gaps <= MAX_GAP_S are closed (halftime lulls shorter than that merge);
    spans < MIN_SPAN_S are dropped (a warmup drill is not a match).
    Degrades to [] on empty/flat input — the caller treats that as
    "cannot establish an in-match region" and refuses, never guesses.
    """
    if not counts:
        return []
    hi = max(counts)
    series = np.zeros(hi + 1, float)
    for b, n in counts.items():
        if b >= 0:
            series[b] = n
    w = max(1, int(round(ACTIVITY_SMOOTH_S / bin_s)))
    kernel = np.ones(w) / w
    smooth = np.convolve(series, kernel, mode='same')
    p90 = float(np.percentile(smooth, 90))
    if p90 <= 0:
        return []
    # Absolute floor as well as the relative one: on a mostly-idle capture
    # p90 sits in the idle mass and a purely relative threshold would admit
    # the warmup it exists to exclude (CV review).
    active = smooth >= max(ACTIVITY_FRACTION * p90, float(PLAY_MIN_MOVERS))
    spans = []
    i = 0
    while i < len(active):
        if not active[i]:
            i += 1
            continue
        j = i
        while j + 1 < len(active) and active[j + 1]:
            j += 1
        spans.append([i, j])
        i = j + 1
    # close small gaps
    merged: list = []
    max_gap_bins = int(round(MAX_GAP_S / bin_s))
    for s in spans:
        if merged and s[0] - merged[-1][1] <= max_gap_bins:
            merged[-1][1] = s[1]
        else:
            merged.append(s)
    out = [(lo * bin_s, (hi_ + 1) * bin_s) for lo, hi_ in merged
           if (hi_ + 1 - lo) * bin_s >= MIN_SPAN_S]
    return out


def in_spans(t_s: float, spans: list) -> bool:
    return any(lo <= t_s <= hi for lo, hi in spans)


def window_bounds(pxs_near: np.ndarray, frame_w: int, frame_h: int) -> tuple:
    """(x0, y0, x1, y1) — bbox of near-play projections + margin, sized into
    [WIN_MIN, WIN_MAX_*] and clamped to the frame. Pure (unit tested)."""
    x0 = max(0, int(pxs_near[:, 0].min() - WIN_MARGIN_PX))
    x1 = min(frame_w, int(pxs_near[:, 0].max() + WIN_MARGIN_PX))
    y0 = max(0, int(pxs_near[:, 1].min() - 2.2 * WIN_MARGIN_PX))
    y1 = min(frame_h, int(pxs_near[:, 1].max() + WIN_MARGIN_PX))
    if x1 - x0 < WIN_MIN:
        c = (x0 + x1) // 2
        x0, x1 = max(0, c - WIN_MIN // 2), min(frame_w, c + WIN_MIN // 2)
    if y1 - y0 < WIN_MIN:
        c = (y0 + y1) // 2
        y0, y1 = max(0, c - WIN_MIN // 2), min(frame_h, c + WIN_MIN // 2)
    if x1 - x0 > WIN_MAX_W:
        c = int(np.median(pxs_near[:, 0]))
        x0 = max(0, c - WIN_MAX_W // 2)
        x1 = min(frame_w, x0 + WIN_MAX_W)
    if y1 - y0 > WIN_MAX_H:
        c = int(np.median(pxs_near[:, 1]))
        y0 = max(0, c - WIN_MAX_H // 2)
        y1 = min(frame_h, y0 + WIN_MAX_H)
    return x0, y0, x1, y1


def filter_boxes(boxes: np.ndarray, seam_y: float) -> list:
    """Person boxes -> plausible standing players; drops tiny boxes, wrong
    aspect, and seam-straddlers (a box crossing the lens seam is two half
    bodies)."""
    out = []
    for b in np.asarray(boxes).reshape(-1, 4):
        bh = b[3] - b[1]
        bw = b[2] - b[0]
        if bh < MIN_BOX_H_PX or bh <= 0:
            continue
        if not (ASPECT_LO < bw / bh < ASPECT_HI):
            continue
        if b[1] < seam_y <= b[3]:
            continue
        out.append([float(v) for v in b])
    return out


def solo_flag(idx: int, boxes: list, crop_xyxy: tuple) -> bool:
    """True iff no OTHER box overlaps more than SOLO_MAX_OVERLAP of the padded
    crop area (neighbour-number poison gate)."""
    cx0, cy0, cx1, cy1 = crop_xyxy
    area = (cx1 - cx0) * (cy1 - cy0)
    if area <= 0:
        return False
    for j, o in enumerate(boxes):
        if j == idx:
            continue
        ix = max(0, min(cx1, o[2]) - max(cx0, o[0]))
        iy = max(0, min(cy1, o[3]) - max(cy0, o[1]))
        if ix * iy / area > SOLO_MAX_OVERLAP:
            return False
    return True


def crop_box(box: list, frame_w: int, frame_h: int) -> tuple:
    """Padded crop bounds (probe convention: MARGIN * box height)."""
    x0, y0, x1, y1 = box
    pad = MARGIN * (y1 - y0)
    return (max(0, int(x0 - pad)), max(0, int(y0 - pad)),
            min(frame_w, int(x1 + pad)), min(frame_h, int(y1 + pad)))


def project_chains_at(chains: list, Hm: np.ndarray, rayn_to_uv,
                      t_us: float, frame_w: int, frame_h: int,
                      interp_max_bracket_us: float) -> list:
    """[(chain_idx, px, py, x_m, y_m)] for chains alive (and interpolable)
    at t_us — metric position + raw-frame pixel via H -> rayn -> mesh uv."""
    import cv2
    met, ids = [], []
    for ci, (ts, xy) in enumerate(chains):
        if not (ts[0] <= t_us <= ts[-1]):
            continue
        j = int(np.searchsorted(ts, t_us))
        if 0 < j < len(ts) and t_us != ts[j - 1] \
                and ts[j] - ts[j - 1] > interp_max_bracket_us:
            continue
        met.append([np.interp(t_us, ts, xy[:, 0]),
                    np.interp(t_us, ts, xy[:, 1])])
        ids.append(ci)
    if not met:
        return []
    met = np.asarray(met)
    rn = cv2.perspectiveTransform(
        met[None].astype(np.float64), Hm.astype(np.float64))[0]
    uv = rayn_to_uv(rn)
    # a non-finite uv (outside mesh coverage) would enter the window/
    # association math as garbage and could steal a box — drop it
    return [(ci, float(u * frame_w), float(v * frame_h),
             float(m[0]), float(m[1]))
            for ci, (u, v), m in zip(ids, uv, met)
            if np.isfinite(u) and np.isfinite(v)]


def harvest_frame(img: np.ndarray, t_vp: float, proj: list, cent: np.ndarray,
                  detect, frame_w: int, frame_h: int) -> list:
    """One harvest step on a decoded frame. `detect(window_bgr)` returns
    Nx4 xyxy person boxes in WINDOW coordinates. Returns crop records:
    {chain, t_vp, h_px, solo, play_dist, crop(BGR ndarray)}."""
    from scipy.optimize import linear_sum_assignment

    if len(proj) < 4:
        return []
    ids = [p[0] for p in proj]
    pxs = np.array([[p[1], p[2]] for p in proj])
    met = np.array([[p[3], p[4]] for p in proj])
    d_play = np.linalg.norm(met - np.asarray(cent)[None], axis=1)
    near = d_play <= NEAR_PLAY_M
    if near.sum() < MIN_NEAR_PLAY:
        return []
    x0, y0, x1, y1 = window_bounds(pxs[near], frame_w, frame_h)
    win = img[y0:y1, x0:x1]
    if win.size == 0:
        return []
    raw = detect(win)
    if raw is None or len(raw) == 0:
        return []
    boxes = filter_boxes(
        np.asarray(raw) + np.array([x0, y0, x0, y0], float),
        seam_y=frame_h * SEAM_FRACTION)
    if not boxes:
        return []
    feet = np.array([[(b[0] + b[2]) / 2, b[3]] for b in boxes])
    C = np.linalg.norm(feet[:, None] - pxs[None], axis=2)
    ri, ci_ = linear_sum_assignment(np.minimum(C, ASSOC_GATE_PX))
    out = []
    for bi, pi_ in zip(ri, ci_):
        if C[bi, pi_] >= ASSOC_GATE_PX:
            continue
        cb = crop_box(boxes[bi], frame_w, frame_h)
        # .copy() is load-bearing: a slice VIEW retains the whole ~50MB
        # decoded frame via .base — accumulated across the pending/debug
        # buffers that's a multi-GB leak ending in a SIGKILL OOM that skips
        # the status write (senior review, 2026-07-18).
        crop = img[cb[1]:cb[3], cb[0]:cb[2]].copy()
        if crop.size == 0:
            continue
        out.append({
            'chain': int(ids[pi_]),
            't_vp': float(t_vp),
            'h_px': round(float(boxes[bi][3] - boxes[bi][1]), 1),
            'solo': solo_flag(bi, boxes, cb),
            'play_dist': round(float(d_play[pi_]), 1),
            'x_m': float(met[pi_][0]),
            'y_m': float(met[pi_][1]),
            'crop': crop,
        })
    return out

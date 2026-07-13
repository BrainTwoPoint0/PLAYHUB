#!/usr/bin/env python3
"""Corridor-snap plumb-line annotation — the venue-portable middle ground
between full-auto line detection (fails on indoor arenas: greenish-lit walls,
L-corner merges, curved-centre-line rejection) and hand-tracing every point.

You supply per-line GUIDE POLYLINES (2+ rough points along each straight
world line, read off a gridded frame crop); this walks each polyline in small
arc-length steps and snaps perpendicular to the local white-ridge maximum
(top-hat response), sub-pixel refined. Occlusions (players/chairs on the
line) are skipped automatically — weak-peak steps contribute no point.

Input JSON:  {"lines": [{"name": "center", "guide": [[x,y],[x,y],...]}, ...]}
             (full-res pixels)
Output JSON: {"lines": [{"name":..., "pts": [[x,y],...]}, ...]}  (full-res)
             consumed by calibrate.py via MANUAL_LINES=<path>.

Usage:
  SRC=<frame.jpg> GUIDES=<guides.json> OUT=<lines.json> python3 snap_lines.py
"""
import json
import os
import sys

import cv2
import numpy as np

SRC = os.environ['SRC']
GUIDES = os.environ['GUIDES']
OUT = os.environ['OUT']
STEP = float(os.environ.get('STEP', 12))       # px between samples along the line
HALF = int(os.environ.get('HALF', 25))         # perpendicular search half-width
MIN_PEAK = float(os.environ.get('MIN_PEAK', 8))  # top-hat response floor (occlusion skip)
MIN_PTS = int(os.environ.get('MIN_PTS', 8))

img = cv2.imread(SRC)
if img is None:
    sys.exit(f'cannot read {SRC}')
gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
# bright ridges (white paint / posts) via top-hat; dark ridges (steel columns,
# panel seams against a white wall) via black-hat — per-line "ridge": "dark".
# Dark kernel is wider: a ~30px column only closes (single ridge, not twin
# edges) under a structuring element wider than the bar.
kb = int(os.environ.get('KERN_BRIGHT', 15))
kd = int(os.environ.get('KERN_DARK', 31))
ridge = {'bright': cv2.morphologyEx(gray, cv2.MORPH_TOPHAT,
                                    cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kb, kb))).astype(np.float32),
         'dark': cv2.morphologyEx(gray, cv2.MORPH_BLACKHAT,
                                  cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kd, kd))).astype(np.float32)}
H, W = gray.shape

guides = json.load(open(GUIDES))['lines']
out_lines, viz = [], img.copy()
for g in guides:
    top = ridge[g.get('ridge', 'bright')]
    half = int(g.get('half', HALF))  # per-line corridor override (§0k ridge trap)
    poly = np.array(g['guide'], dtype=np.float64)
    pts = []
    for i in range(len(poly) - 1):
        a, b = poly[i], poly[i + 1]
        seg = b - a
        seglen = float(np.hypot(*seg))
        if seglen < 1:
            continue
        d = seg / seglen
        perp = np.array([-d[1], d[0]])
        for t in np.arange(0, seglen, STEP):
            c = a + d * t
            # perpendicular top-hat profile around the guide
            offs = np.arange(-half, half + 1, dtype=np.float64)
            xs = np.clip(np.round(c[0] + perp[0] * offs).astype(int), 0, W - 1)
            ys = np.clip(np.round(c[1] + perp[1] * offs).astype(int), 0, H - 1)
            prof = top[ys, xs]
            j = int(np.argmax(prof))
            if prof[j] < MIN_PEAK or j == 0 or j == len(prof) - 1:
                continue  # occluded / no ridge here — skip, don't fabricate
            # sub-pixel parabola on the peak
            y0, y1, y2 = prof[j - 1], prof[j], prof[j + 1]
            denom = (y0 - 2 * y1 + y2)
            frac = 0.5 * (y0 - y2) / denom if abs(denom) > 1e-9 else 0.0
            off = offs[j] + float(np.clip(frac, -1, 1))
            p = c + perp * off
            pts.append([float(p[0]), float(p[1])])
    # outlier rejection: the image of a straight world line is a SMOOTH curve,
    # so fit quadratics x(t),y(t) over arc-length and iteratively drop >3-sigma
    # deviants (snaps that latched onto players/chairs/goal frames)
    if len(pts) >= MIN_PTS:
        P = np.array(pts)
        for _ in range(3):
            t = np.r_[0, np.cumsum(np.hypot(*np.diff(P, axis=0).T))]
            if t[-1] < 1:
                break
            t = t / t[-1]
            rx = P[:, 0] - np.polyval(np.polyfit(t, P[:, 0], 2), t)
            ry = P[:, 1] - np.polyval(np.polyfit(t, P[:, 1], 2), t)
            r = np.hypot(rx, ry)
            keep = r < max(4.0, 3 * np.std(r))
            if keep.all() or keep.sum() < MIN_PTS:
                break
            P = P[keep]
        pts = P.tolist()
    if len(pts) >= MIN_PTS:
        out_lines.append({'name': g['name'], 'pts': pts})
        for (x, y) in np.array(pts).astype(int):
            cv2.circle(viz, (int(x), int(y)), 4, (0, 0, 255), -1)
    else:
        print(f"  DROPPED {g['name']}: only {len(pts)} snapped points", file=sys.stderr)

json.dump({'lines': out_lines}, open(OUT, 'w'))
vp = os.path.splitext(OUT)[0] + '-viz.png'
cv2.imwrite(vp, viz)
print(f"{len(out_lines)} lines snapped -> {OUT} ; viz -> {vp}")
for ln in out_lines:
    print(f"  {ln['name']}: {len(ln['pts'])} pts")

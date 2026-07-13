"""Establish the image<->pitch homography for the Nazwa scene (static camera → one
H for the whole match). Canonical small-sided pitch in metres; landmark image
coords hand-anchored from the detection frame and refined against the projected
overlay. Saves H (+ inverse) and an overlay to eyeball the fit.

  python3 pitch_homography.py            # fit + overlay from PTS below
"""
from __future__ import annotations

import json
import numpy as np
import cv2

REF = "/tmp/follow-pair/calib_ref.png"
OUT_OVERLAY = "/tmp/follow-pair/pitch_overlay.png"
OUT_H = "/tmp/follow-pair/pitch_H.json"

# Kuwait fisheye model (kuwait-fit.json). Pitch lines are straight in RECTILINEAR
# (undistorted) space, not in the raw fisheye — so we fit H in undistorted-normalized
# space and re-distort to draw.
F, CX, CY, K1 = 1158.15, 1820.72, 810.19, -0.005580739537927541
K = np.array([[F, 0, CX], [0, F, CY], [0, 0, 1]], np.float64)
D = np.array([K1, 0, 0, 0], np.float64)


def undistort(px):
    p = np.array(px, np.float64).reshape(-1, 1, 2)
    return cv2.fisheye.undistortPoints(p, K, D).reshape(-1, 2)  # → normalized rays


def distort(norm):
    p = np.array(norm, np.float64).reshape(-1, 1, 2)
    return cv2.fisheye.distortPoints(p, K, D).reshape(-1, 2)     # normalized → fisheye px

# Canonical pitch (metres). x = goal-to-goal (length), y = touchline-to-touchline.
L, Wm = 40.0, 25.0
GOAL_HW = 2.5          # half goal width
BOX_D, BOX_HW = 10.0, 9.0  # penalty box depth / half-width

# Landmark correspondences: (pitch_xy) -> (image_xy, full-res 3840x2160).
# Anchored from /tmp/follow-pair/calib_detect.png (viz 1280x720 → ×3). Refine these
# against the overlay until the projected model lines sit on the painted lines.
PTS = [
    ((0, 0),        (1365, 504)),   # far-left corner  (left goalline ∩ far touchline)
    ((L, 0),        (2634, 450)),   # far-right corner
    ((L, Wm),       (3390, 1665)),  # near-right corner
    ((0, Wm),       (495, 1725)),   # near-left corner
    ((0, Wm / 2),   (795, 900)),    # left goal centre
    ((L, Wm / 2),   (3150, 966)),   # right goal centre
    ((L / 2, 0),    (1935, 534)),   # halfway ∩ far touchline
    ((L / 2, Wm),   (1965, 1950)),  # halfway ∩ near touchline
]


def fit():
    src = np.array([p for p, _ in PTS], np.float64)            # pitch (m)
    dst = undistort([q for _, q in PTS])                        # undistorted-normalized
    H, _ = cv2.findHomography(src, dst, cv2.RANSAC, 0.01)       # pitch → normalized
    return H


def pitch_to_px(H, pts):
    """pitch(m) → H → normalized → re-distort → fisheye pixel."""
    p = np.array(pts, np.float64).reshape(-1, 1, 2)
    norm = cv2.perspectiveTransform(p, H).reshape(-1, 2)
    return distort(norm)


def draw_line(img, H, a, b, color, n=60, t=3):
    xs = np.linspace(a[0], b[0], n); ys = np.linspace(a[1], b[1], n)
    q = pitch_to_px(H, np.c_[xs, ys]).astype(int)
    for i in range(len(q) - 1):
        cv2.line(img, tuple(q[i]), tuple(q[i + 1]), color, t)


def main():
    H = fit()
    img = cv2.imread(REF)
    # boundary
    for a, b in [((0, 0), (L, 0)), ((L, 0), (L, Wm)), ((L, Wm), (0, Wm)), ((0, Wm), (0, 0))]:
        draw_line(img, H, a, b, (0, 0, 255))
    draw_line(img, H, (L / 2, 0), (L / 2, Wm), (0, 255, 255))          # halfway
    # penalty boxes
    for gx, sgn in ((0, 1), (L, -1)):
        draw_line(img, H, (gx, Wm / 2 - BOX_HW), (gx + sgn * BOX_D, Wm / 2 - BOX_HW), (255, 180, 0))
        draw_line(img, H, (gx, Wm / 2 + BOX_HW), (gx + sgn * BOX_D, Wm / 2 + BOX_HW), (255, 180, 0))
        draw_line(img, H, (gx + sgn * BOX_D, Wm / 2 - BOX_HW), (gx + sgn * BOX_D, Wm / 2 + BOX_HW), (255, 180, 0))
    # goals
    for gx in (0, L):
        draw_line(img, H, (gx, Wm / 2 - GOAL_HW), (gx, Wm / 2 + GOAL_HW), (0, 255, 0), t=6)
    # landmark markers
    for _, q in PTS:
        cv2.circle(img, tuple(map(int, q)), 12, (255, 0, 255), -1)
    cv2.imwrite(OUT_OVERLAY, cv2.resize(img, (1280, 720)))
    json.dump({"H": H.tolist(), "Hinv": np.linalg.inv(H).tolist(), "L": L, "W": Wm}, open(OUT_H, "w"))
    print(f"H fit; overlay → {OUT_OVERLAY}, H → {OUT_H}")


if __name__ == "__main__":
    main()

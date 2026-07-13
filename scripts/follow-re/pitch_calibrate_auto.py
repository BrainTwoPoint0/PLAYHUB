"""Auto-refine the image<->pitch homography by snapping the projected pitch MODEL
onto the DETECTED white lines (distance-transform cost, least-squares). Turns the
rough hand-anchored H into an accurate fit without pixel-perfect manual clicking.

Method: detect white-line pixels inside the pitch → distance transform → optimise
H (pitch→undistorted-normalized) so canonical pitch-line samples, projected through
H + fisheye distortion, land on the detected lines.

  python3 pitch_calibrate_auto.py   # reads pitch_H.json (init) → writes refined H + overlay
"""
from __future__ import annotations

import json
import numpy as np
import cv2
from scipy.optimize import least_squares

REF = "/tmp/follow-pair/calib_ref.png"
POLY = np.array(json.load(open("/tmp/follow-pair/pitch_poly.json"))["poly_px"], np.int32)
Hj = json.load(open("/tmp/follow-pair/pitch_H.json"))
H0 = np.array(Hj["H"]); Lp, Wp = Hj["L"], Hj["W"]

F, CX, CY, K1 = 1158.15, 1820.72, 810.19, -0.005580739537927541
K = np.array([[F, 0, CX], [0, F, CY], [0, 0, 1]], np.float64)
D = np.array([K1, 0, 0, 0], np.float64)

BOX_D, BOX_HW, GOAL_HW = 10.0, 9.0, 2.5


def canonical_samples(n=40):
    """Dense points along the canonical pitch lines (metres)."""
    segs = [((0, 0), (Lp, 0)), ((Lp, 0), (Lp, Wp)), ((Lp, Wp), (0, Wp)), ((0, Wp), (0, 0)),
            ((Lp / 2, 0), (Lp / 2, Wp))]
    for gx, s in ((0, 1), (Lp, -1)):
        segs += [((gx, Wp / 2 - BOX_HW), (gx + s * BOX_D, Wp / 2 - BOX_HW)),
                 ((gx, Wp / 2 + BOX_HW), (gx + s * BOX_D, Wp / 2 + BOX_HW)),
                 ((gx + s * BOX_D, Wp / 2 - BOX_HW), (gx + s * BOX_D, Wp / 2 + BOX_HW))]
    pts = []
    for a, b in segs:
        t = np.linspace(0, 1, n)
        pts += list(zip(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    return np.array(pts, np.float64)


def project(Hp, pts):
    """pitch(m) → H → normalized → distort → fisheye px."""
    norm = cv2.perspectiveTransform(pts.reshape(-1, 1, 2), Hp).reshape(-1, 2)
    return cv2.fisheye.distortPoints(norm.reshape(-1, 1, 2), K, D).reshape(-1, 2)


def main():
    img = cv2.imread(REF); Hi, Wi = img.shape[:2]
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    white = cv2.inRange(hsv, (0, 0, 165), (180, 70, 255))
    mask = np.zeros((Hi, Wi), np.uint8)
    cv2.fillPoly(mask, [POLY], 255)
    mask = cv2.erode(mask, np.ones((25, 25), np.uint8))     # keep off the fence/boundary
    lines = cv2.bitwise_and(white, mask)
    lines = cv2.morphologyEx(lines, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    dt = cv2.distanceTransform(255 - lines, cv2.DIST_L2, 5)
    dt = np.clip(dt, 0, 60)

    samp = canonical_samples()

    def resid(x):
        Hp = np.append(x, 1.0).reshape(3, 3)
        px = project(Hp, samp)
        xi = np.clip(px[:, 0].astype(int), 0, Wi - 1); yi = np.clip(px[:, 1].astype(int), 0, Hi - 1)
        oob = (px[:, 0] < 0) | (px[:, 0] >= Wi) | (px[:, 1] < 0) | (px[:, 1] >= Hi)
        r = dt[yi, xi].astype(np.float64); r[oob] = 60.0
        return r

    x0 = (H0 / H0[2, 2]).flatten()[:8]
    sol = least_squares(resid, x0, method="lm", max_nfev=4000)
    Href = np.append(sol.x, 1.0).reshape(3, 3)
    r0, r1 = np.sqrt((resid(x0) ** 2).mean()), np.sqrt((sol.fun ** 2).mean())
    print(f"line-fit RMS distance: {r0:.1f}px → {r1:.1f}px  ({len(samp)} samples, {int((lines>0).sum())} line px)")

    # overlay refined model
    viz = img.copy(); viz[lines > 0] = (0, 255, 255)
    for a, b in [((0, 0), (Lp, 0)), ((Lp, 0), (Lp, Wp)), ((Lp, Wp), (0, Wp)), ((0, Wp), (0, 0)), ((Lp / 2, 0), (Lp / 2, Wp))]:
        t = np.linspace(0, 1, 60); seg = np.c_[a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
        q = project(Href, seg).astype(int)
        for i in range(len(q) - 1):
            cv2.line(viz, tuple(q[i]), tuple(q[i + 1]), (0, 0, 255), 3)
    cv2.imwrite("/tmp/follow-pair/pitch_refined_overlay.png", cv2.resize(viz, (1400, 788)))
    json.dump({"H": Href.tolist(), "Hinv": np.linalg.inv(Href).tolist(), "L": Lp, "W": Wp,
               "line_fit_rms_px": float(r1)}, open("/tmp/follow-pair/pitch_H.json", "w"))
    print("refined H saved → pitch_H.json; overlay → pitch_refined_overlay.png")


if __name__ == "__main__":
    main()

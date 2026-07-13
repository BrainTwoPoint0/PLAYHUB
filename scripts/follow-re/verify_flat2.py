"""Decouple GEOMETRY from FRAMING. Two virtual cameras at the SAME optical centre (ours
and Spiideo's are both crops of the same panorama centre) relate by a HOMOGRAPHY over the
WHOLE image iff both are ideal flat pinhole views. So:
  - align OUR dewarp → Spiideo by full homography (absorbs ALL framing/aspect/perspective)
  - if edges then coincide + residual stays low to the rim ⇒ our dewarp IS a correct flat
    pinhole; any earlier divergence was just wrong framing.
  - if residual GROWS at the rim even under the best homography ⇒ real lens bow remains.
Shows similarity-aligned vs homography-aligned edge overlays side by side + radial residual.

  python3 verify_flat2.py <raw.mp4> <play.mp4> <framing.json> --times 41,94,101
"""
from __future__ import annotations

import json
import sys
import numpy as np
import cv2

import mesh_dewarp as MD

PW, PH = 960, 540
F, CX, W_PANO = 1158.15, 1820.72, 3840.0
projs, _ = MD.load_mesh("/tmp/follow-pair/mesh")


def render(rawf, pan, tilt, fov):
    u, v = MD.bake_uv_map(projs, np.radians(pan), np.radians(tilt), fov, PW, PH)
    th, tw = rawf.shape[:2]; m1 = (u * tw).astype("f4"); m2 = (v * th).astype("f4"); m1[u < 0] = -1; m2[u < 0] = -1
    return cv2.remap(rawf, m1, m2, cv2.INTER_LINEAR)


def radial(src, dst, err):
    rad = np.linalg.norm(src - [PW / 2, PH / 2], axis=1) / (np.hypot(PW, PH) / 2)
    out = []
    for lo, hi in [(0, .4), (.4, .7), (.7, 1.1)]:
        m = (rad >= lo) & (rad < hi)
        out.append(round(float(np.median(err[m])), 2) if m.any() else None)
    return out


def overlay(aligned, pl):
    eo = cv2.Canny(cv2.cvtColor(aligned, cv2.COLOR_BGR2GRAY), 60, 160)
    ep = cv2.Canny(cv2.cvtColor(pl, cv2.COLOR_BGR2GRAY), 60, 160)
    ov = np.zeros((PH, PW, 3), np.uint8); ov[..., 2] = eo; ov[..., 1] = ep
    return ov


def main():
    raw, play, framingf = sys.argv[1:4]
    times = sys.argv[sys.argv.index("--times") + 1] if "--times" in sys.argv else "41,94,101"
    fr = json.load(open(framingf)); rows = fr["rows"]
    want = [float(x) for x in times.split(",")]
    rows = [min(rows, key=lambda r: abs(r["t"] - w)) for w in want]

    sift = cv2.SIFT_create(5000); bf = cv2.BFMatcher()
    capr = cv2.VideoCapture(raw); capp = cv2.VideoCapture(play)
    def lab(im, tx):
        im = im.copy(); cv2.rectangle(im, (0, 0), (PW, 24), (0, 0, 0), -1); cv2.putText(im, tx, (7, 17), cv2.FONT_HERSHEY_SIMPLEX, 0.46, (0, 255, 255), 1); return im
    panels = []
    for r in rows:
        t = r["t"]
        capr.set(cv2.CAP_PROP_POS_MSEC, t * 1000); _, rawf = capr.read()
        capp.set(cv2.CAP_PROP_POS_MSEC, t * 1000); _, playf = capp.read()
        pl = cv2.resize(playf, (PW, PH))
        our = render(rawf, r["pan"], r["tilt"], r["fov"])
        k1, d1 = sift.detectAndCompute(cv2.cvtColor(our, cv2.COLOR_BGR2GRAY), None)
        k2, d2 = sift.detectAndCompute(cv2.cvtColor(pl, cv2.COLOR_BGR2GRAY), None)
        good = [a for a, b in bf.knnMatch(d1, d2, k=2) if a.distance < 0.8 * b.distance]
        src = np.float32([k1[x.queryIdx].pt for x in good]).reshape(-1, 1, 2)
        dst = np.float32([k2[x.trainIdx].pt for x in good]).reshape(-1, 1, 2)
        # similarity
        Ms, inS = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=4.0)
        alS = cv2.warpAffine(our, Ms, (PW, PH))
        sS = src.reshape(-1, 2)[inS.ravel() > 0]; dS = dst.reshape(-1, 2)[inS.ravel() > 0]
        eS = np.linalg.norm((Ms[:, :2] @ sS.T).T + Ms[:, 2] - dS, axis=1)
        # homography
        Hh, inH = cv2.findHomography(src, dst, cv2.RANSAC, 4.0)
        alH = cv2.warpPerspective(our, Hh, (PW, PH))
        sH = src.reshape(-1, 2)[inH.ravel() > 0]; dH = dst.reshape(-1, 2)[inH.ravel() > 0]
        pH = cv2.perspectiveTransform(sH.reshape(-1, 1, 2), Hh).reshape(-1, 2)
        eH = np.linalg.norm(pH - dH, axis=1)
        print(f"t={t:5.1f}s  n={len(good)}  SIM residual by radius {radial(sS, dS, eS)}   HOMOG residual by radius {radial(sH, dH, eH)}")
        panels.append(np.hstack([lab(overlay(alS, pl), f"t={t:.0f}s SIMILARITY-aligned (rot+scale only)"),
                                 lab(overlay(alH, pl), "HOMOGRAPHY-aligned (absorbs framing)")]))
    capr.release(); capp.release()
    cv2.imwrite("/tmp/imitation/verify_flat2.png", np.vstack(panels))
    print("wrote /tmp/imitation/verify_flat2.png  (yellow=lines coincide)")


if __name__ == "__main__":
    main()

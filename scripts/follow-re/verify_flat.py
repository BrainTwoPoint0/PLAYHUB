"""Rigorous, DIRECT flatness verification (no reliance on a single residual number).
For chosen frames with well-determined framing:
  1. render OUR mesh dewarp at Spiideo's recovered (pan,tilt,fov)
  2. align OUR→Spiideo with a SIMILARITY ONLY (rot+uniform-scale+translation, 4 dof) —
     this CANNOT correct an aspect stretch or a lens bow, only rigid pose+scale.
  3. overlay Canny edges: OUR=red, Spiideo=green, coincidence=yellow.
  4. measure reprojection residual vs RADIUS (center→edge). Flat ⇒ residual stays low
     to the edges; a bow ⇒ residual grows toward the edges even after best similarity.
Writes a per-frame panel so a human can see line-by-line whether they match.

  python3 verify_flat.py <raw.mp4> <play.mp4> <framing.json> [--times 41,94,101]
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


def main():
    raw, play, framingf = sys.argv[1:4]
    times = sys.argv[sys.argv.index("--times") + 1] if "--times" in sys.argv else None
    fr = json.load(open(framingf)); rows = fr["rows"]
    if times:
        want = [float(x) for x in times.split(",")]
        rows = [min(rows, key=lambda r: abs(r["t"] - w)) for w in want]
    else:
        rows = sorted(rows, key=lambda r: -r["inliers"])[:3]

    sift = cv2.SIFT_create(4000); bf = cv2.BFMatcher()
    capr = cv2.VideoCapture(raw); capp = cv2.VideoCapture(play)
    panels = []
    for r in rows:
        t = r["t"]
        capr.set(cv2.CAP_PROP_POS_MSEC, t * 1000); _, rawf = capr.read()
        capp.set(cv2.CAP_PROP_POS_MSEC, t * 1000); _, playf = capp.read()
        pl = cv2.resize(playf, (PW, PH))
        our = render(rawf, r["pan"], r["tilt"], r["fov"])
        # SIFT match, SIMILARITY only
        k1, d1 = sift.detectAndCompute(cv2.cvtColor(our, cv2.COLOR_BGR2GRAY), None)
        k2, d2 = sift.detectAndCompute(cv2.cvtColor(pl, cv2.COLOR_BGR2GRAY), None)
        good = [a for a, b in bf.knnMatch(d1, d2, k=2) if a.distance < 0.75 * b.distance]
        src = np.float32([k1[x.queryIdx].pt for x in good]).reshape(-1, 1, 2)
        dst = np.float32([k2[x.trainIdx].pt for x in good]).reshape(-1, 1, 2)
        M, inl = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=4.0)
        aligned = cv2.warpAffine(our, M, (PW, PH))
        # residual vs radius (similarity)
        s = src.reshape(-1, 2)[inl.ravel() > 0]; d = dst.reshape(-1, 2)[inl.ravel() > 0]
        proj = (M[:, :2] @ s.T).T + M[:, 2]; err = np.linalg.norm(proj - d, axis=1)
        rad = np.linalg.norm(s - [PW / 2, PH / 2], axis=1) / (np.hypot(PW, PH) / 2)
        bins = [(0, .4), (.4, .7), (.7, 1.1)]
        rprof = [(f"{lo:.1f}-{hi:.1f}", round(float(np.median(err[(rad >= lo) & (rad < hi)])), 2) if ((rad >= lo) & (rad < hi)).any() else None) for lo, hi in bins]
        print(f"t={t:.1f}s inl={int(inl.sum())}  similarity residual by radius {rprof}")
        # edge overlay
        eo = cv2.Canny(cv2.cvtColor(aligned, cv2.COLOR_BGR2GRAY), 60, 160)
        ep = cv2.Canny(cv2.cvtColor(pl, cv2.COLOR_BGR2GRAY), 60, 160)
        ov = np.zeros((PH, PW, 3), np.uint8); ov[..., 2] = eo; ov[..., 1] = ep  # ours=red, spiideo=green, coincide=yellow
        def lab(im, tx):
            im = im.copy(); cv2.rectangle(im, (0, 0), (PW, 24), (0, 0, 0), -1); cv2.putText(im, tx, (7, 17), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1); return im
        panels.append(np.hstack([lab(aligned, f"OURS aligned t={t:.0f}s"), lab(pl, "Spiideo"), lab(ov, "edges: red=ours green=Spiideo yellow=match")]))
    capr.release(); capp.release()
    cv2.imwrite("/tmp/imitation/verify_flat.png", np.vstack(panels))
    print("wrote /tmp/imitation/verify_flat.png")


if __name__ == "__main__":
    main()

"""Close the 'is our output identical to Spiideo' step: match Spiideo's colour grade, then
show the difference BEFORE vs AFTER. Fit a per-channel tone curve (quadratic) mapping our
dewarp → Spiideo on STATIC pixels only (moving players masked out so they don't bias the
fit), apply it, and recompute |difference|. If the colour-grade component is what filled
the diff, the static structure should collapse toward black after matching.

  python3 color_match_proof.py <raw.mp4> <play.mp4> --times 41,94
"""
from __future__ import annotations

import sys
import numpy as np
import cv2
from scipy.optimize import minimize

import mesh_dewarp as MD

PW, PH = 960, 540
F, CX, W_ = 1158.15, 1820.72, 3840.0
projs, _ = MD.load_mesh("/tmp/follow-pair/mesh")
sift = cv2.SIFT_create(5000); bf = cv2.BFMatcher()


def render(rawf, pan, tilt, fov):
    u, v = MD.bake_uv_map(projs, np.radians(pan), np.radians(tilt), fov, PW, PH)
    th, tw = rawf.shape[:2]; m1 = (u * tw).astype("f4"); m2 = (v * th).astype("f4"); m1[u < 0] = -1; m2[u < 0] = -1
    return cv2.remap(rawf, m1, m2, cv2.INTER_LINEAR)


def homog(our, pl):
    k1, d1 = sift.detectAndCompute(cv2.cvtColor(our, cv2.COLOR_BGR2GRAY), None)
    k2, d2 = sift.detectAndCompute(cv2.cvtColor(pl, cv2.COLOR_BGR2GRAY), None)
    if d1 is None or d2 is None: return None
    good = [a for a, b in bf.knnMatch(d1, d2, k=2) if a.distance < 0.8 * b.distance]
    if len(good) < 25: return None
    src = np.float32([k1[x.queryIdx].pt for x in good]).reshape(-1, 1, 2)
    dst = np.float32([k2[x.trainIdx].pt for x in good]).reshape(-1, 1, 2)
    H, inl = cv2.findHomography(src, dst, cv2.RANSAC, 3.0)
    if H is None: return None
    return cv2.warpPerspective(our, H, (PW, PH))


def fit_curve(aligned, pl, static):
    """Per-channel quadratic tone curve our→Spiideo, fit on static pixels."""
    out = np.zeros_like(aligned)
    coeffs = []
    for c in range(3):
        x = aligned[:, :, c][static].astype(np.float64); y = pl[:, :, c][static].astype(np.float64)
        A = np.stack([x ** 2, x, np.ones_like(x)], 1)
        k, *_ = np.linalg.lstsq(A, y, rcond=None)
        coeffs.append(k)
        xf = aligned[:, :, c].astype(np.float64)
        out[:, :, c] = np.clip(k[0] * xf ** 2 + k[1] * xf + k[2], 0, 255)
    return out.astype(np.uint8), coeffs


def main():
    raw, play = sys.argv[1:3]
    times = [float(x) for x in (sys.argv[sys.argv.index("--times") + 1] if "--times" in sys.argv else "41,94").split(",")]
    capr = cv2.VideoCapture(raw); capp = cv2.VideoCapture(play)
    def lab(im, tx):
        im = im.copy(); cv2.rectangle(im, (0, 0), (PW, 28), (0, 0, 0), -1); cv2.putText(im, tx, (8, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.52, (0, 255, 255), 2); return im
    rows = []
    for tv in times:
        capr.set(cv2.CAP_PROP_POS_MSEC, tv * 1000); _, rawf = capr.read()
        capp.set(cv2.CAP_PROP_POS_MSEC, tv * 1000); _, pf = capp.read()
        pl = cv2.resize(pf, (PW, PH))
        def resid(x):
            a = homog(render(rawf, *x), pl)
            if a is None: return 1e9
            m = cv2.cvtColor(a, cv2.COLOR_BGR2GRAY) > 0
            return float(cv2.absdiff(a, pl)[m].mean()) if m.mean() > 0.5 else 1e9
        k1r, d1r = sift.detectAndCompute(cv2.cvtColor(cv2.resize(rawf, (1920, 1080)), cv2.COLOR_BGR2GRAY), None)
        k2, d2 = sift.detectAndCompute(cv2.cvtColor(pl, cv2.COLOR_BGR2GRAY), None)
        g = [a for a, b in bf.knnMatch(d2, d1r, k=2) if a.distance < 0.75 * b.distance]
        Hm, _ = cv2.findHomography(np.float32([[k2[x.queryIdx].pt] for x in g]), np.float32([[k1r[x.trainIdx].pt] for x in g]), cv2.RANSAC, 5.0)
        c0 = cv2.perspectiveTransform(np.float32([[[PW / 2, PH / 2]]]), Hm)[0, 0]
        pan0 = np.degrees(-1.0 * (c0[0] / 1920 * W_ - CX) / F)
        res = minimize(resid, [pan0, -20, 32], method="Nelder-Mead", options=dict(xatol=0.05, fatol=0.02, maxiter=120))
        aligned = homog(render(rawf, *res.x), pl)
        valid = cv2.cvtColor(aligned, cv2.COLOR_BGR2GRAY) > 0
        # static = valid AND low raw diff (exclude players/moving)
        rawdiff = cv2.GaussianBlur(cv2.absdiff(aligned, pl).max(2).astype(np.float32), (0, 0), 3)
        static = valid & (rawdiff < np.percentile(rawdiff[valid], 70))
        matched, _ = fit_curve(aligned, pl, static)
        before = cv2.absdiff(aligned, pl); after = cv2.absdiff(matched, pl)
        mb = before[valid].mean(); ma = after[valid].mean()
        print(f"t={tv:.0f}s  mean|diff| BEFORE {mb:.1f}/255  → AFTER colour-match {ma:.1f}/255")
        d_b = np.clip(before.astype(int) * 3, 0, 255).astype(np.uint8)
        d_a = np.clip(after.astype(int) * 3, 0, 255).astype(np.uint8)
        rows.append(np.hstack([lab(matched, f"OURS colour-matched t={tv:.0f}s"), lab(pl, "SPIIDEO"),
                               lab(d_b, f"diff BEFORE x3 (mean {mb:.1f})"), lab(d_a, f"diff AFTER x3 (mean {ma:.1f})")]))
    capr.release(); capp.release()
    cv2.imwrite("/tmp/imitation/color_match_proof.png", np.vstack(rows))
    print("wrote /tmp/imitation/color_match_proof.png")


if __name__ == "__main__":
    main()

"""Prove OUR flat output == Spiideo's, unambiguously. The only thing that differed before
was a time offset between the raw VP and the Play render (players at different moments).
So: (1) match framing to Spiideo, (2) SEARCH the play time-offset that also aligns the
players, (3) show a CHECKERBOARD (identical ⇒ pitch lines + players flow seamlessly across
every tile edge) and the |difference| (identical ⇒ near-black everywhere).

  python3 identical_proof.py <raw.mp4> <play.mp4> --times 41,94
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


def align(our, pl):
    """Align ours→Spiideo by a full HOMOGRAPHY (the exact relation between two co-centred
    pinhole views). Fills the frame; a non-pinhole distortion difference would leave a
    residual a homography cannot absorb, so near-zero diff ⇒ identical geometry."""
    k1, d1 = sift.detectAndCompute(cv2.cvtColor(our, cv2.COLOR_BGR2GRAY), None)
    k2, d2 = sift.detectAndCompute(cv2.cvtColor(pl, cv2.COLOR_BGR2GRAY), None)
    if d1 is None or d2 is None: return None
    good = [a for a, b in bf.knnMatch(d1, d2, k=2) if a.distance < 0.8 * b.distance]
    if len(good) < 25: return None
    src = np.float32([k1[x.queryIdx].pt for x in good]).reshape(-1, 1, 2)
    dst = np.float32([k2[x.trainIdx].pt for x in good]).reshape(-1, 1, 2)
    H, inl = cv2.findHomography(src, dst, cv2.RANSAC, 3.0)
    if H is None or inl.sum() < 15: return None
    aligned = cv2.warpPerspective(our, H, (PW, PH))
    mask = (cv2.cvtColor(aligned, cv2.COLOR_BGR2GRAY) > 0)
    if mask.mean() < 0.5: return None
    d = cv2.absdiff(aligned, pl)
    return aligned, float(d[mask].mean()), H


def checker(a, b, sz=60):
    out = a.copy()
    for y in range(0, PH, sz):
        for x in range(0, PW, sz):
            if ((x // sz) + (y // sz)) % 2 == 0:
                out[y:y+sz, x:x+sz] = b[y:y+sz, x:x+sz]
    return out


def main():
    raw, play = sys.argv[1:3]
    times = [float(x) for x in (sys.argv[sys.argv.index("--times") + 1] if "--times" in sys.argv else "41,94").split(",")]
    capr = cv2.VideoCapture(raw); capp = cv2.VideoCapture(play)
    fps = capp.get(cv2.CAP_PROP_FPS) or 25.0
    def lab(im, tx):
        im = im.copy(); cv2.rectangle(im, (0, 0), (PW, 26), (0, 0, 0), -1); cv2.putText(im, tx, (7, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.48, (0, 255, 255), 1); return im
    rows = []
    for tv in times:
        capr.set(cv2.CAP_PROP_POS_MSEC, tv * 1000); _, rawf = capr.read()
        # framing: optimize to play[tv]
        capp.set(cv2.CAP_PROP_POS_MSEC, tv * 1000); _, pf0 = capp.read()
        pl0 = cv2.resize(pf0, (PW, PH))
        def resid(x):
            r = align(render(rawf, *x), pl0); return r[1] if r else 1e9
        k1r, d1r = sift.detectAndCompute(cv2.cvtColor(cv2.resize(rawf, (1920, 1080)), cv2.COLOR_BGR2GRAY), None)
        k2, d2 = sift.detectAndCompute(cv2.cvtColor(pl0, cv2.COLOR_BGR2GRAY), None)
        g = [a for a, b in bf.knnMatch(d2, d1r, k=2) if a.distance < 0.75 * b.distance]
        Hm, _ = cv2.findHomography(np.float32([[k2[x.queryIdx].pt] for x in g]), np.float32([[k1r[x.trainIdx].pt] for x in g]), cv2.RANSAC, 5.0)
        c = cv2.perspectiveTransform(np.float32([[[PW / 2, PH / 2]]]), Hm)[0, 0]
        pan0 = np.degrees(-1.0 * (c[0] / 1920 * W_ - CX) / F)
        res = minimize(resid, [pan0, -20, 32], method="Nelder-Mead", options=dict(xatol=0.05, fatol=0.02, maxiter=140))
        our = render(rawf, *res.x)
        # search play time-offset that also aligns players
        best = (1e9, None, None, 0)
        for df in range(-50, 51, 2):
            capp.set(cv2.CAP_PROP_POS_MSEC, (tv + df / fps) * 1000); ok, pf = capp.read()
            if not ok: continue
            r = align(our, cv2.resize(pf, (PW, PH)))
            if r and r[1] < best[0]:
                best = (r[1], r[0], cv2.resize(pf, (PW, PH)), df)
        mad, aligned, plb, df = best
        d3 = np.clip(cv2.absdiff(aligned, plb).astype(int) * 3, 0, 255).astype(np.uint8)
        print(f"t={tv:.0f}s  best play offset {df/fps*1000:+.0f}ms  mean|diff|={mad:.1f}/255")
        rows.append(np.hstack([lab(checker(aligned, plb), f"CHECKERBOARD ours/Spiideo t={tv:.0f}s (seamless=identical)"),
                               lab(d3, f"|difference| x3  mean {mad:.1f}/255  (black=identical)")]))
    capr.release(); capp.release()
    cv2.imwrite("/tmp/imitation/identical_proof.png", np.vstack(rows))
    print("wrote /tmp/imitation/identical_proof.png")


if __name__ == "__main__":
    main()

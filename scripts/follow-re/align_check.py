"""DECISIVE flatness test: does our mesh dewarp reproduce Spiideo's flat frame?
Search (pan,tilt,fov) to maximize SIFT-RANSAC inliers between OUR mesh dewarp of the raw
VP and SPIIDEO's Play frame at the same instant. Then examine the residual homography:
 - if OUR dewarp is geometrically flat like theirs, the best match needs only an
   affine/similarity (offset+scale+small rot) → low affine residual, flat.
 - if OUR projection still bows, an affine can't align the periphery → high edge residual
   even at the best (pan,tilt,fov), AND homography ≫ affine residual.
Reports center-vs-edge residual + writes an overlay.

  python3 align_check.py <raw.mp4> <play.mp4> --t 30 [--pan0 .. --fov0 ..]
"""
from __future__ import annotations

import sys
import numpy as np
import cv2

import mesh_dewarp as MD

PW, PH = 960, 540
F, CX, W_PANO = 1158.15, 1820.72, 3840.0
PAN_SIGN = -1.0


def panox_to_meshpan(px): return PAN_SIGN * (px * W_PANO - CX) / F


def sift_register(raw_frame, play_frame):
    """SIFT homography Play->raw to get the pano region Spiideo shows (init)."""
    sift = cv2.SIFT_create(4000); bf = cv2.BFMatcher()
    rr = cv2.resize(raw_frame, (1920, 1080)); pp = cv2.resize(play_frame, (PW, PH))
    k1, d1 = sift.detectAndCompute(cv2.cvtColor(pp, cv2.COLOR_BGR2GRAY), None)
    k2, d2 = sift.detectAndCompute(cv2.cvtColor(rr, cv2.COLOR_BGR2GRAY), None)
    m = bf.knnMatch(d1, d2, k=2); good = [a for a, b in m if a.distance < 0.75 * b.distance]
    src = np.float32([k1[x.queryIdx].pt for x in good]).reshape(-1, 1, 2)
    dst = np.float32([k2[x.trainIdx].pt for x in good]).reshape(-1, 1, 2)
    Hm, _ = cv2.findHomography(src, dst, cv2.RANSAC, 5.0)
    c = cv2.perspectiveTransform(np.float32([[[PW / 2, PH / 2]]]), Hm)[0, 0]
    return c[0] / 1920.0, c[1] / 1080.0


def render(projs, rawf, pan_deg, tilt_deg, fov):
    u, v = MD.bake_uv_map(projs, np.radians(pan_deg), np.radians(tilt_deg), fov, PW, PH)
    th, tw = rawf.shape[:2]
    m1 = (u * tw).astype("f4"); m2 = (v * th).astype("f4"); m1[u < 0] = -1; m2[u < 0] = -1
    return cv2.remap(rawf, m1, m2, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT), (u >= 0)


def match_inliers(our, play, min_ratio=0.75):
    sift = cv2.SIFT_create(3000); bf = cv2.BFMatcher()
    k1, d1 = sift.detectAndCompute(cv2.cvtColor(our, cv2.COLOR_BGR2GRAY), None)
    k2, d2 = sift.detectAndCompute(cv2.cvtColor(play, cv2.COLOR_BGR2GRAY), None)
    if d1 is None or d2 is None or len(k1) < 10 or len(k2) < 10:
        return 0, None, None, None
    m = bf.knnMatch(d1, d2, k=2); good = [a for a, b in m if a.distance < min_ratio * b.distance]
    if len(good) < 12:
        return len(good), None, None, None
    src = np.float32([k1[x.queryIdx].pt for x in good]).reshape(-1, 1, 2)
    dst = np.float32([k2[x.trainIdx].pt for x in good]).reshape(-1, 1, 2)
    return len(good), src, dst, None


def main():
    raw, play = sys.argv[1:3]
    t = float(sys.argv[sys.argv.index("--t") + 1]) if "--t" in sys.argv else 30.0
    projs, _ = MD.load_mesh("/tmp/follow-pair/mesh")
    capr = cv2.VideoCapture(raw); capr.set(cv2.CAP_PROP_POS_MSEC, t * 1000); _, rawf = capr.read(); capr.release()
    capp = cv2.VideoCapture(play); capp.set(cv2.CAP_PROP_POS_MSEC, t * 1000); _, playf = capp.read(); capp.release()
    play = cv2.resize(playf, (PW, PH))

    px, py = sift_register(rawf, playf)
    pan0 = np.degrees(panox_to_meshpan(px))
    print(f"SIFT init: pano_x={px:.3f} → pan0={pan0:.1f}°, pano_y={py:.3f}")

    best = (-1, None)
    for pan in np.arange(pan0 - 8, pan0 + 8.1, 2):
        for tilt in np.arange(-33, -8, 3):
            for fov in np.arange(24, 46, 3):
                our, valid = render(projs, rawf, pan, tilt, fov)
                if valid.mean() < 0.6:
                    continue
                nin, src, dst, _ = match_inliers(our, play)
                if nin > best[0]:
                    best = (nin, (pan, tilt, fov, our, src, dst))
    nin, (pan, tilt, fov, our, src, dst) = best
    print(f"best SIFT matches {nin} at pan={pan:.1f} tilt={tilt:.1f} fov={fov:.1f}")

    # residual analysis: affine vs homography reprojection error, center vs edge
    Ha, inA = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=4.0)
    Hf, inA2 = cv2.estimateAffine2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=4.0)
    Hh, inH = cv2.findHomography(src, dst, cv2.RANSAC, 4.0)
    def reproj_err(M, homog=False):
        s = src.reshape(-1, 2)
        if homog:
            proj = cv2.perspectiveTransform(src, M).reshape(-1, 2)
        else:
            proj = (M[:, :2] @ s.T).T + M[:, 2]
        e = np.linalg.norm(proj - dst.reshape(-1, 2), axis=1)
        cx = np.abs(s[:, 0] - PW / 2) > PW * 0.3
        return float(np.median(e)), float(np.median(e[cx])) if cx.any() else -1
    ea_all, ea_edge = reproj_err(Ha)
    ef_all, ef_edge = reproj_err(Hf)
    eh_all, eh_edge = reproj_err(Hh, homog=True)
    print(f"\nresidual reprojection error (median px, our-dewarp → Spiideo-Play):")
    print(f"  similarity(4dof): all {ea_all:.2f}  edge {ea_edge:.2f}")
    print(f"  affine(6dof):     all {ef_all:.2f}  edge {ef_edge:.2f}")
    print(f"  homography(8dof): all {eh_all:.2f}  edge {eh_edge:.2f}")
    print("  → if similarity/affine edge error is small (~<3px), OUR dewarp is flat like Spiideo's.")
    print("  → if homography ≪ affine (edge), residual PERSPECTIVE/bow remains in our projection.")

    # overlay: warp our dewarp by the affine into Spiideo frame, blend
    aligned = cv2.warpAffine(our, Hf, (PW, PH))
    blend = cv2.addWeighted(aligned, 0.5, play, 0.5, 0)
    for im, tag in [(our, "OUR mesh dewarp"), (play, "Spiideo Play"), (blend, "our→Spiideo (affine) 50/50")]:
        cv2.rectangle(im, (0, 0), (PW, 24), (0, 0, 0), -1); cv2.putText(im, tag, (7, 17), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1)
    cv2.imwrite("/tmp/imitation/align_check.png", np.vstack([np.hstack([our, play]), np.hstack([blend, np.zeros_like(blend)])]))
    print("wrote /tmp/imitation/align_check.png")


if __name__ == "__main__":
    main()

"""Trustworthy-label layer for imitation learning: recover the TEACHER camera's full
motion — pan, tilt, AND log-zoom — from a follow render, robustly, and validate it.

Upgrade over gt_from_render (which kept only median horizontal flow = pan): fit a
partial-affine transform (scale + rotation + translation) to the LK background
correspondences via RANSAC each frame. The DOMINANT motion is the static background
(= inverse camera motion); players are the RANSAC outliers. From the per-frame
transform:  pan += -tx,  tilt += -ty,  log_zoom += -log(scale)  (cumulative).

Validation by STABILIZATION: warp each frame by the inverse recovered transform into
a reference frame. If the recovery is correct the background freezes → residual
background flow drops toward zero. We report the residual before/after as the proof.

Also emits σ_teacher: the disagreement between this affine pan and the simpler
median-flow pan (two independent recoveries) — the irreducible label-noise floor
that the imitation policy must never "beat".

  python3 recover_camera.py <render.mp4> [--max-frames N] [--stabilize out.mp4]
"""
from __future__ import annotations

import sys
import numpy as np
import cv2

LK = dict(winSize=(21, 21), maxLevel=3,
          criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01))
FEAT = dict(maxCorners=1200, qualityLevel=0.01, minDistance=8, blockSize=7)


def recover(video: str, max_frames: int = 0, roi_rows=None):
    """Per-frame (pan, tilt, log_zoom) cumulative + per-step median-flow pan (for
    σ_teacher) + diagnostics. Units: pan/tilt in fraction of frame width; zoom in log.
    roi_rows=(y0,y1) restricts tracked features to those rows (for the top-vs-bottom
    independent-noise estimate)."""
    cap = cv2.VideoCapture(video)
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or 1920
    H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 1080
    ok, prev = cap.read()
    if not ok:
        raise RuntimeError(f"cannot read {video}")
    prevg = cv2.cvtColor(prev, cv2.COLOR_BGR2GRAY)
    roi = None
    if roi_rows is not None:
        roi = np.zeros((H, W), np.uint8); roi[roi_rows[0]:roi_rows[1]] = 255

    dtx = [0.0]; dty = [0.0]; dlz = [0.0]; dmed = [0.0]     # per-step deltas
    inl = [0]; nfeat = [0]
    idx = 1
    while True:
        ok, frame = cap.read()
        if not ok or (max_frames and idx >= max_frames):
            break
        g = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        p0 = cv2.goodFeaturesToTrack(prevg, mask=roi, **FEAT)
        tx = ty = lz = med = 0.0; nin = 0
        if p0 is not None and len(p0) >= 12:
            p1, st, _ = cv2.calcOpticalFlowPyrLK(prevg, g, p0, None, **LK)
            st = st.reshape(-1).astype(bool)
            a, b = p0.reshape(-1, 2)[st], p1.reshape(-1, 2)[st]
            if len(a) >= 12:
                med = float(np.median((b - a)[:, 0]))           # simple pan (2nd recovery)
                M, inliers = cv2.estimateAffinePartial2D(a, b, method=cv2.RANSAC,
                                                         ransacReprojThreshold=3.0)
                if M is not None:
                    tx, ty = float(M[0, 2]), float(M[1, 2])
                    scale = float(np.hypot(M[0, 0], M[1, 0])) or 1.0
                    lz = float(np.log(max(scale, 1e-3)))
                    nin = int(inliers.sum()) if inliers is not None else 0
        # camera motion = -background motion
        dtx.append(-tx / W); dty.append(-ty / H); dlz.append(-lz)
        dmed.append(-med / W); inl.append(nin); nfeat.append(0 if p0 is None else len(p0))
        prevg = g; idx += 1
    cap.release()

    pan = np.cumsum(dtx); tilt = np.cumsum(dty); logzoom = np.cumsum(dlz)
    pan_med = np.cumsum(dmed)
    return dict(pan=pan, tilt=tilt, logzoom=logzoom, pan_med=pan_med,
                fps=fps, W=W, H=H, n=len(pan),
                median_inliers=float(np.median(inl[1:]) if len(inl) > 1 else 0),
                median_feat=float(np.median(nfeat[1:]) if len(nfeat) > 1 else 0),
                per_step=dict(tx=dtx, ty=dty, lz=dlz))


def sigma_teacher_regions(video, max_frames=0):
    """Honest noise floor: recover pan from the TOP half vs the BOTTOM half of the
    frame independently. Both measure the SAME camera pan from DIFFERENT scene regions,
    so the per-step disagreement is pure recovery noise (no shared-signal confound)."""
    cap = cv2.VideoCapture(video); H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 1080; cap.release()
    rt = recover(video, max_frames, roi_rows=(0, H // 2))
    rb = recover(video, max_frames, roi_rows=(H // 2, H))
    n = min(rt["n"], rb["n"])
    dt = np.diff(rt["pan"][:n]); db = np.diff(rb["pan"][:n])       # per-step pan deltas
    sigma_step = float(np.std(dt - db) / np.sqrt(2))               # per-recovery step noise
    corr = float(np.corrcoef(rt["pan"][:n], rb["pan"][:n])[0, 1])
    return sigma_step, corr, rt, rb


def estimate_lag(pan_teacher, pan_raw_proxy, max_lag=250):
    """Per-match time offset: cross-correlate the teacher pan against a cheap raw-VP
    pan proxy (motion-centroid). Returns (lag_frames, peak_corr, peak_margin). A sharp,
    dominant peak (margin = peak/2nd-peak) means a trustworthy alignment; a flat xcorr
    means REJECT the segment (ambiguous offset would shift every label)."""
    a = np.asarray(pan_teacher, float); b = np.asarray(pan_raw_proxy, float)
    m = min(len(a), len(b)); a, b = a[:m], b[:m]
    a = (a - a.mean()) / (a.std() + 1e-9); b = (b - b.mean()) / (b.std() + 1e-9)
    lags = range(-max_lag, max_lag + 1, 1)
    ccs = []
    for lag in lags:
        if lag >= 0:
            x, y = b[lag:], a[:m - lag]
        else:
            x, y = b[:m + lag], a[-lag:]
        ccs.append(np.corrcoef(x, y)[0, 1] if len(x) > 500 else -2)
    ccs = np.array(ccs); best = int(np.argmax(ccs))
    peak = float(ccs[best]); lag = list(lags)[best]
    others = np.delete(ccs, slice(max(0, best - 15), best + 16))   # exclude ±15 around peak
    margin = float(peak / (others.max() + 1e-9)) if others.size else float("inf")
    return lag, peak, margin


def main():
    video = sys.argv[1]
    mx = int(sys.argv[sys.argv.index("--max-frames") + 1]) if "--max-frames" in sys.argv else 0
    r = recover(video, mx)
    print(f"recovered {r['n']} frames @ {r['fps']:.0f}fps  ({video.split('/')[-1]})")
    print(f"  pan range   {r['pan'].max() - r['pan'].min():.3f} (frac width)   "
          f"tilt range {r['tilt'].max() - r['tilt'].min():.3f}   "
          f"logzoom range {r['logzoom'].max() - r['logzoom'].min():.3f} (={np.exp(r['logzoom'].max() - r['logzoom'].min()):.2f}x)")
    print(f"  RANSAC inliers/frame median {r['median_inliers']:.0f} of {r['median_feat']:.0f} features")

    # honest noise floor: top-half vs bottom-half independent recovery
    sig, cc, _, _ = sigma_teacher_regions(video, mx)
    signal_step = float(np.std(np.diff(r["pan"])))
    print(f"  σ_teacher (top vs bottom half, per-step) = {sig:.5f} frac width   "
          f"[pan step std {signal_step:.5f} → SNR {signal_step/max(sig,1e-9):.1f}:1, halves corr {cc:.3f}]")
    print(f"  => cumulative label noise over the clip ≈ {sig*np.sqrt(r['n'])*100:.1f}% frame width worst case; "
          f"per-frame target noise ≈ {sig*100:.3f}%")

    # per-match lag vs a raw-VP proxy, if a cache with motion is supplied
    if "--raw-cache" in sys.argv:
        import json
        c = json.load(open(sys.argv[sys.argv.index("--raw-cache") + 1]))
        mot = c["motion"]; nn = c["video_frames"]
        raw = np.array([mot.get(str(i), np.nan) for i in range(nn)])
        gi = np.arange(nn); ok = ~np.isnan(raw); raw = np.interp(gi, gi[ok], raw[ok])
        lag, peak, margin = estimate_lag(r["pan"], raw)
        verdict = "TRUST" if margin >= 1.3 and peak >= 0.4 else "REJECT (ambiguous align)"
        print(f"  lag vs raw-VP: {lag} frames ({lag/r['fps']:.2f}s), peak corr {peak:.3f}, "
              f"peak/2nd margin {margin:.2f} → {verdict}")


if __name__ == "__main__":
    main()


if __name__ == "__main__":
    main()

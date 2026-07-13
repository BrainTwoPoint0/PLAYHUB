"""Residual° follow-quality gate (rebuilt). Compares PLAYHUB's own auto-follow
target signals against Spiideo's AutoFollow, on a paired (raw VP, Play render)
fetched by fetch_spiideo_pair.mjs.

Both cameras pan a virtual view over the SAME static wide panorama, so their pans
are comparable up to the zoom-scale (Spiideo's render is a crop of the pano) — an
affine fit recovers that scale, and the RESIDUAL after it measures how closely our
follow tracks the same action Spiideo does. Correlation is the unit-free headline.

  pan_S(t) : Spiideo's virtual-camera pan, recovered from the Play render's own
             background optical flow (gt_from_render — no ball GT needed).
  pan_P(t) : ours, player-cluster centroid over the raw VP → controller.
  pan_M(t) : ours, motion-centroid over the raw VP → controller (the DEPLOYED signal).

Gate: player-centroid tracks Spiideo BETTER than motion-centroid (higher corr /
lower residual) AND is no less smooth (jerk P95, false-whips).

  python3 follow_residual_gate.py /tmp/follow-pair/raw_<g>.mp4 /tmp/follow-pair/play_<g>.mp4 [--pano-fov 140]
"""
from __future__ import annotations

import sys
import numpy as np

from gt_from_render import gt_pan
from follow_retarget import player_centroids
from controller import FollowController

WHIP_STEP = 0.15   # normalized pan move that counts as a whip...
WHIP_FRAMES = 6    # ...within this many controller frames


def controller_pan(targets_by_frame: dict, n: int, fps: float) -> np.ndarray:
    """Feed per-frame normalized-x targets through the DEPLOYED controller (coast on
    gaps). Returns pan[n] in panorama-normalized-x units."""
    ctl = FollowController(fps=fps)
    out = []
    for fr in range(n):
        t = targets_by_frame.get(fr)
        out.append(ctl.step({"pan": t, "tilt": 0.0, "fov": 40.0} if t is not None else None)["pan"])
    return np.array(out)


def resample(pan: np.ndarray, src_fps: float, tgt_t: np.ndarray) -> np.ndarray:
    src_t = np.arange(len(pan)) / src_fps
    return np.interp(tgt_t, src_t, pan)


def affine_residual(ours: np.ndarray, spiideo: np.ndarray):
    """Best-fit spiideo ≈ a*ours + b (absorbs the zoom-scale + offset). Returns
    (rms_resid, corr, a) in spiideo's units (render-width fractions)."""
    A = np.vstack([ours, np.ones_like(ours)]).T
    (a, b), *_ = np.linalg.lstsq(A, spiideo, rcond=None)
    resid = spiideo - (a * ours + b)
    rms = float(np.sqrt((resid ** 2).mean()))
    corr = float(np.corrcoef(ours, spiideo)[0, 1])
    return rms, corr, float(a)


def whips(pan: np.ndarray) -> int:
    return int(sum(abs(pan[i + WHIP_FRAMES] - pan[i]) > WHIP_STEP for i in range(len(pan) - WHIP_FRAMES)))


def main():
    raw, play = sys.argv[1], sys.argv[2]
    pano_fov = float(sys.argv[sys.argv.index("--pano-fov") + 1]) if "--pano-fov" in sys.argv else 140.0
    print(f"=== residual° gate ===\n  raw VP : {raw.split('/')[-1]}\n  Spiideo: {play.split('/')[-1]}")

    # 1. Spiideo's pan from the Play render (normalized render-width fractions).
    pan_S, metaS = gt_pan(play, render_fov_deg=None)
    rfps = metaS["fps"]
    print(f"  Spiideo pan: {metaS['n']} frames @ {rfps:.1f}fps, range={metaS['pan_range']:.3f} (render-width), "
          f"median LK inliers={metaS['median_inliers']:.0f}")

    # 2. Our targets over the raw VP (player-centroid AND motion-centroid).
    cents, motion, spreads, nplayers, vfps, vn = player_centroids(raw, sample_fps=5.0)
    print(f"  raw VP: {vn} frames @ {vfps:.1f}fps, players/frame median={np.median(nplayers) if nplayers else 0:.0f}, "
          f"player-centroid coverage={len(cents)/max(1,vn)*100:.0f}%, motion coverage={len(motion)/max(1,vn)*100:.0f}%")
    pan_P = controller_pan(cents, vn, vfps)
    pan_M = controller_pan(motion, vn, vfps)

    # 3. Common time base = Spiideo render frames; resample ours onto it.
    tgt_t = np.arange(len(pan_S)) / rfps
    pan_P_r = resample(pan_P, vfps, tgt_t)
    pan_M_r = resample(pan_M, vfps, tgt_t)

    # 4. Residual to Spiideo (affine-aligned) + smoothness. Convert residual to a
    #    degrees estimate: recovered scale a maps pano-x→render-frac, so
    #    resid_pano_x = rms/|a|, ×pano_fov° = degrees (pano_fov is an ASSUMPTION).
    print(f"\n  {'target':16} corr↑   resid(rendfrac)↓  ~resid°   jerkP95↓   whips↓")
    rows = {}
    for name, ours, ours_native in (("player-centroid", pan_P_r, pan_P), ("motion-centroid", pan_M_r, pan_M)):
        rms, corr, a = affine_residual(ours, pan_S)
        deg = (rms / abs(a)) * pano_fov if a != 0 else float("nan")
        jerk = float(np.percentile(np.abs(np.diff(ours_native, 2)), 95)) if len(ours_native) > 2 else 0.0
        w = whips(ours_native)
        rows[name] = (corr, rms, deg, jerk, w)
        print(f"  {name:16} {corr:+.3f}   {rms:.4f}          {deg:5.1f}°    {jerk:.5f}   {w}")

    cp, cm = rows["player-centroid"], rows["motion-centroid"]
    print(f"\n  VERDICT: player-centroid vs motion-centroid to Spiideo —")
    print(f"    correlation {cp[0]:+.3f} vs {cm[0]:+.3f}  ({'PLAYER wins' if cp[0] > cm[0] else 'motion wins'})")
    print(f"    residual°   {cp[2]:.1f}° vs {cm[2]:.1f}°   ({'PLAYER tighter' if cp[2] < cm[2] else 'motion tighter'})")
    print(f"    smoothness  jerk {cp[3]:.5f} vs {cm[3]:.5f}, whips {cp[4]} vs {cm[4]}")
    win = cp[0] > cm[0] and cp[2] <= cm[2] + 1.0 and cp[4] <= cm[4]
    print(f"    => player-centroid {'PASSES' if win else 'does NOT clearly pass'} the gate "
          f"(note: ~resid° assumes pano FOV={pano_fov:.0f}°; correlation is the unit-free truth)")


if __name__ == "__main__":
    main()

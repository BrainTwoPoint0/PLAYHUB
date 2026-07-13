"""Reverse-engineer Spiideo's colour grade from paired frames (our raw dewarp vs their Play
output at the SAME aim) and reproduce it as a per-channel LUT.

Method = histogram specification (alignment-free): for each BGR channel, map our value -> the
Spiideo value at the same CDF percentile. Both frames show the same pitch at the same aim, so
the channel distributions are directly comparable — this recovers Spiideo's tone + white balance
+ contrast without needing pixel-perfect correspondence (which translation-align can't give when
players move). A light smoothing keeps the LUT monotonic and free of banding.

  learn_luts(O, T)   O,T = Nx3 BGR paired-pixel samples -> (lut_b, lut_g, lut_r) uint8[256]
  apply_luts(img, luts)                                  -> graded BGR image
  save_luts / load_luts                                  -> /tmp/imitation/spiideo_grade_lut.npy

Default (no LUT) is a no-op — nothing in the pipeline changes unless a grade is explicitly applied.
"""
from __future__ import annotations
import numpy as np, cv2

LUT_PATH = "/tmp/imitation/spiideo_grade_lut.npy"


def _chan_lut(src_vals, ref_vals, smooth=5):
    """histogram-specification LUT mapping src channel -> ref channel by matching CDFs."""
    sh, _ = np.histogram(src_vals, 256, [0, 256])
    rh, _ = np.histogram(ref_vals, 256, [0, 256])
    sc = np.cumsum(sh).astype(np.float64); sc /= max(sc[-1], 1)
    rc = np.cumsum(rh).astype(np.float64); rc /= max(rc[-1], 1)
    lut = np.interp(sc, rc, np.arange(256))          # for each src level, the ref level at equal CDF
    if smooth > 1:                                    # box-smooth then enforce monotonic
        k = np.ones(smooth) / smooth
        lut = np.convolve(lut, k, mode="same")
        lut = np.maximum.accumulate(lut)
    return np.clip(lut, 0, 255).astype(np.uint8)


def learn_luts(O, T, smooth=5):
    """O, T: Nx3 uint8 BGR co-sampled pixels. Returns per-channel LUTs (B, G, R)."""
    O = np.asarray(O).reshape(-1, 3); T = np.asarray(T).reshape(-1, 3)
    return tuple(_chan_lut(O[:, c], T[:, c], smooth) for c in range(3))


def apply_luts(img, luts):
    if luts is None:
        return img
    out = img.copy()
    for c in range(3):
        out[:, :, c] = luts[c][img[:, :, c]]   # numpy gather — robust to array layout
    return out


def save_luts(luts, path=LUT_PATH):
    np.save(path, np.stack(luts))


def load_luts(path=LUT_PATH):
    try:
        a = np.load(path)
        return tuple(a[c] for c in range(3))
    except Exception:
        return None


def describe(luts):
    """one-line human summary of what the grade does at black / mid / white per channel."""
    for c, nm in zip(range(3), "B G R".split()):
        l = luts[c]
        print(f"  {nm}: black 0->{l[0]:3d}   mid 128->{l[128]:3d}   white 255->{l[255]:3d}")

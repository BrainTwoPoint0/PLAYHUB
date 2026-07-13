"""Bounded cosmetic anti-bow — straighten the residual line curvature left by the mesh FIT.

The mesh dewarp is a fit, so a straight world line still bows ~0.6-1.1% in the flat render
(measured; see AIM_RESUME §0e). This applies a single-parameter radial correction to the
(u,v) SAMPLE MAP (not the image), so the existing final remap stays the only image
interpolation — no double-resample quality loss. Default k1=0 is a no-op (Layer-0 untouched).

  warp_uv(u, v, k1)  ->  (u2, v2)   apply BEFORE scaling u,v into raw-pixel coords
  calibrate(render_fn, frames)      -> k1 that minimises measured straight-line bow (clamped)

Sign: k1<0 = barrel correction (pulls a center 'hill' down flat); k1>0 = pincushion.
Magnitude is clamped to |k1|<=K1_MAX so it can never introduce visible edge stretch.
"""
from __future__ import annotations
import numpy as np, cv2

K1_MAX = 0.06  # hard cosmetic bound — beyond this, straight lines start visibly over-bending


def warp_uv(u, v, k1, k2=0.0):
    """Radially resample the (u,v) coordinate maps to straighten residual bow.
    u,v are HxW normalized source coords with -1 sentinel where no mesh. Returns warped maps
    with the sentinel preserved (any pixel that samples a sentinel neighbour is set back to -1)."""
    if k1 == 0.0 and k2 == 0.0:
        return u, v
    H, W = u.shape
    sy = H / W  # isotropic scale for the shorter (vertical) axis
    gx, gy = np.meshgrid(np.arange(W, dtype=np.float32), np.arange(H, dtype=np.float32))
    ax = 2.0 * gx / (W - 1) - 1.0                 # [-1, 1]
    ay = (2.0 * gy / (H - 1) - 1.0) * sy          # isotropic vertical
    r2 = ax * ax + ay * ay
    f = 1.0 + k1 * r2 + k2 * r2 * r2
    sx = ((ax * f) + 1.0) * 0.5 * (W - 1)
    syy = ((ay * f) / sy + 1.0) * 0.5 * (H - 1)
    valid = (u >= 0).astype(np.float32)
    u2 = cv2.remap(u, sx.astype(np.float32), syy.astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    v2 = cv2.remap(v, sx.astype(np.float32), syy.astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    vm = cv2.remap(valid, sx.astype(np.float32), syy.astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
    bad = vm < 0.999                              # sampled across a mesh edge -> mark invalid
    u2[bad] = -1.0; v2[bad] = -1.0
    return u2, v2


def _rail_bow_pct(img):
    """max signed perp deviation (% of span) of the topmost strong horizontal edge (a straight
    world line: fence rail / pitch far edge). Negative = arch-up (hill). None if not found."""
    H, W = img.shape[:2]
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    mag = np.abs(cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3))
    xs, ys = [], []
    lo, hi = int(0.05 * H), int(0.45 * H)
    for x in range(int(0.08 * W), int(0.92 * W), 2):
        y = int(np.argmax(mag[lo:hi, x])) + lo
        if mag[y, x] > 60:
            xs.append(x); ys.append(y)
    xs = np.array(xs, float); ys = np.array(ys, float)
    if len(xs) < 100:
        return None
    A = np.polyfit(xs, ys, 1); k = np.abs(ys - np.polyval(A, xs)) < 10
    xs, ys = xs[k], ys[k]
    if len(xs) < 100:
        return None
    o = np.argsort(xs); xs, ys = xs[o], ys[o]
    p1 = np.array([xs[0], ys[0]]); p2 = np.array([xs[-1], ys[-1]])
    d = (p2 - p1) / np.linalg.norm(p2 - p1); nrm = np.array([-d[1], d[0]])
    dev = (np.column_stack([xs, ys]) - p1) @ nrm
    span = xs.max() - xs.min()
    return float(dev[np.argmax(np.abs(dev))] / span * 100)


def calibrate(render_k1, sweep=None, verbose=True):
    """render_k1(k1) -> list of frames (BGR) at that correction. Pick the k1 in `sweep`
    that minimises mean |rail bow| across the frames. Clamped to [-K1_MAX, K1_MAX]."""
    if sweep is None:
        sweep = np.round(np.arange(-K1_MAX, K1_MAX + 1e-9, 0.01), 3)
    best_k, best_c = 0.0, None
    for k1 in sweep:
        bows = [b for b in (_rail_bow_pct(im) for im in render_k1(float(k1))) if b is not None]
        if not bows:
            continue
        c = float(np.mean(np.abs(bows)))
        if verbose:
            print(f"  k1={k1:+.3f}  mean|bow|={c:.3f}%  (n={len(bows)})")
        if best_c is None or c < best_c:
            best_k, best_c = float(k1), c
    return float(np.clip(best_k, -K1_MAX, K1_MAX)), best_c

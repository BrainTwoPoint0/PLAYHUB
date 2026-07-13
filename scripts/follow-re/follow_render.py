"""LAYER-1: OUR autofollow through OUR picture pipeline, vs Spiideo.

Aim = ball_follow (antiteleport + gap-YOLO-fusion) — NOT reg. Picture = render_smooth's pipeline
(fov x1.40, coverage-clamp, edge-safe savgol, reverse-engineered Spiideo grade). This is the real
test: same lovely picture, but pointed by US instead of Spiideo.

  python3 follow_render.py            -> /tmp/imitation/follow_render.mp4 + follow_still.png
Env: FOVMUL (1.40), GRADE (1=on). Follow config pinned to the proven best (gap-fusion, antiteleport).
"""
import os
os.environ.setdefault("MODE", "antiteleport")
os.environ.setdefault("FUSE_YOLO", "gap")
os.environ.setdefault("YOLO_CONF", "0.35")
import numpy as np, cv2
from scipy.signal import savgol_filter
import mesh_dewarp as MD
import color_match as CM
import ball_follow as BF

W, H = 960, 540
FOVMUL = float(os.environ.get("FOVMUL", "1.40"))
FOVBASE = 28.0                                  # base deg; *FOVMUL = the x1.40 zoom (follow has no reg footw)
GRADE = CM.load_luts() if os.environ.get("GRADE", "1") != "0" else None
projs = BF.projs
T0, T1 = 31.0, 56.0

def sg(a, w=15, p=2):
    w = min(w, len(a) - (1 - len(a) % 2)); w = max(5, w if w % 2 else w - 1)
    return savgol_filter(a, w, p, mode="nearest")

def cov(pan, tilt, fov):
    u, _ = MD.bake_uv_map(projs, np.radians(pan), np.radians(tilt), fov, W, H); return float(np.mean(u >= 0))

def clamp_view(pan, tilt, fov, floor=14):
    """Spiideo-style clampView, void-location aware. Each step: if the uncovered pixels sit mostly
    at the BOTTOM (the sub-camera blind spot), raise tilt toward the horizon to lift the frame off
    it; otherwise (side/top edge) shrink fov. Never points at the sky for a side-edge void.
    Returns (tilt, fov)."""
    t, f = tilt, fov
    for _ in range(60):
        u, _ = MD.bake_uv_map(projs, np.radians(pan), np.radians(t), f, W, H)
        off = u < 0
        if off.mean() <= 0.001 or f <= floor:
            break
        bottom = off[H // 2:].mean(); top = off[:H // 2].mean()
        if bottom > top * 1.5 and t < 0:           # bottom-dominant = sub-camera void -> tilt up
            t = min(t + 0.8, 0.0)
        else:                                      # side/top edge -> zoom in
            f *= 0.98
    return t, f

def render(rawf, pan, tilt, fov):
    u, v = MD.bake_uv_map(projs, np.radians(pan), np.radians(tilt), fov, W, H); th, tw = rawf.shape[:2]
    m1 = (u * tw).astype("f4"); m2 = (v * th).astype("f4"); m1[u < 0] = -1; m2[u < 0] = -1
    out = cv2.remap(rawf, m1, m2, cv2.INTER_LINEAR)
    return CM.apply_luts(out, GRADE) if GRADE is not None else out

# ---- OUR follow aim (ball_follow, antiteleport + gap fusion) ----
frames = BF.load_frames()
ts, xy = BF.track_antiteleport(frames)
bx, by = BF.fill_smooth(ts, xy)
tsec = (ts - BF.RAWABS0) / 1e6
pan_t = sg(np.array([BF.ray_to_pantilt_uv(bx[i], by[i])[0] for i in range(len(bx))]))
tilt_t = sg(np.array([BF.ray_to_pantilt_uv(bx[i], by[i])[1] for i in range(len(bx))]))

capr = cv2.VideoCapture(BF.RAW); capp = cv2.VideoCapture(BF.PLAY); fps = capp.get(5) or 25
# precompute coverage-clamped, smoothed fov along the window
grid = np.arange(T0, T1, 1.0 / fps)
# aim (pan_t/tilt_t) is already savgol-smoothed; apply clampView as the FINAL per-frame safety so
# no later smoothing can push the view back into a void (bottom OR top).
pans = np.interp(grid, tsec, pan_t); tilts_s = np.interp(grid, tsec, tilt_t)
tilts = np.empty_like(tilts_s); fovc = np.empty_like(tilts_s)
for k in range(len(grid)):
    tilts[k], fovc[k] = clamp_view(pans[k], tilts_s[k], FOVBASE * FOVMUL)
# tilt from clamp is unchanged at this fov (no bottom void) so already smooth; smooth the fov so the
# side-edge coverage clamp doesn't pulse the zoom, but never let it exceed the clamp (stays covered).
fovs = np.minimum(sg(fovc, 11, 2), fovc)

vw = cv2.VideoWriter("/tmp/imitation/follow_render.mp4", cv2.VideoWriter_fourcc(*"mp4v"), fps, (W * 2, H))
def lab(im, t, c):
    cv2.rectangle(im, (0, 0), (W, 26), (0, 0, 0), -1); cv2.putText(im, t, (10, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.5, c, 1); return im
n = 0
for fi in range(int(T0 * fps), int(T1 * fps)):
    capr.set(1, fi); okr, rf = capr.read(); capp.set(1, fi); okp, pf = capp.read()
    if not okr: break
    ct = fi / fps
    pn = np.interp(ct, grid, pans); tl = np.interp(ct, grid, tilts); fv = np.interp(ct, grid, fovs)
    a = lab(render(rf, pn, tl, fv), "PLAYHUB (OUR autofollow, x1.40, graded)", (120, 255, 120))
    b = lab(cv2.resize(pf, (W, H)) if okp else np.zeros((H, W, 3), np.uint8), "SPIIDEO AutoFollow", (210, 210, 210))
    vw.write(np.hstack([a, b])); n += 1
    if fi == int(47 * fps): cv2.imwrite("/tmp/imitation/follow_still.png", np.hstack([a, b]))
capr.release(); capp.release(); vw.release()
print(f"wrote /tmp/imitation/follow_render.mp4 ({n} frames) + follow_still.png")

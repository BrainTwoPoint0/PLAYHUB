"""View-side projection A/B — flatten the "rounded feel" (AIM_RESUME §0h next-session ask).

The mesh/dewarp is UNTOUCHED (coverage solved + deployed). The lever is the RENDERING
projection: our render (and Spiideo's own shader, and the production three.js player)
is pure PINHOLE — a rectilinear wide view of a ground plane perceptually bows the far
touchline. Candidates form one family in the Panini squeeze parameter d:

    pinhole (d=0)  →  Panini d=0.5  →  Panini d=1 (classic)  →  cylindrical (d→∞)

Method: bake the existing pinhole UV map ONCE per view (mesh_dewarp, 4-proj mesh as-is),
then COMPOSE analytically with the candidate projection's pixel→ray map and do a SINGLE
final cv2.remap of the raw frame (no double resample — same rule as anti_bow).

Matched framing: all candidates share the same aim (pan/tilt), the same HORIZONTAL
angular extent (hfov from the pinhole vfov at 16:9), and the same centre scale (all
these projections have unit d(coord)/d(angle) at the axis) — so content at frame edges
is identical; only the geometry between differs.

Self-check: the composed pinhole panel must reproduce MD.dewarp pixel-identically.

Outputs (all under /tmp/imitation/proj_ab/):
  grid_<view>.png     2x2 labeled judge grid per view
  <view>_<proj>.png   full-res individual panels
  flicker_t47.mp4     pinhole <-> Panini d=1 A/B flicker at the flagged frame
  motion_ab.mp4       side-by-side follow render t=31..56, pinhole | Panini d=1

Usage:  python3 projection_ab.py [stills|flicker|motion|all]
"""
import os, sys, json, glob
import numpy as np, cv2
from scipy.spatial import cKDTree
from scipy.signal import savgol_filter
import mesh_dewarp as MD

G8 = "b923d40f"; WOFF = 900
RAW = glob.glob(f"/tmp/follow-pair/raw_{G8}*_s{WOFF}.mp4")[0]
OUT = "/tmp/imitation/proj_ab"; os.makedirs(OUT, exist_ok=True)
ASP = 16 / 9
projs, _ = MD.load_mesh(os.environ.get("MESH", "/tmp/follow-pair/mesh-fixed"))

# ---- reg-driven framing (same conventions as render_smooth.py) ----
reg = json.load(open(f"/tmp/imitation/reg_{G8}.json"))
rt = np.array(reg["t"]); rpx = np.array(reg["pano_x"]); rpy = np.array(reg["pano_y"]); fw = np.array(reg["footw"])
UV = np.vstack([p["uv"] for p in projs]); WORLD = np.vstack([p["world"] for p in projs])
RAYN = WORLD[:, :2] / WORLD[:, 2:3]; uvt = cKDTree(UV)

def u2pt(u, v):
    rn = RAYN[uvt.query([[u, v]])[1][0]]; x, y = float(rn[0]), float(rn[1])
    n = np.sqrt(x * x + y * y + 1)
    return np.degrees(np.arctan2(-x, 1)), np.degrees(-np.arcsin(y / n))

def sg(a, w=15, p=2):
    w = min(w, len(a) - (1 - len(a) % 2)); w = max(5, w if w % 2 else w - 1)
    return savgol_filter(a, w, p, mode="nearest")

FOVMUL = 1.40
TRAJ_PAN = sg(np.array([u2pt(rpx[i], rpy[i])[0] for i in range(len(rt))]))
TRAJ_TILT = sg(np.array([u2pt(rpx[i], rpy[i])[1] for i in range(len(rt))]))
TRAJ_FOV = sg(np.clip(fw * 95, 20, 46)) * FOVMUL

def framing_at(t):
    return (float(np.interp(t, rt, TRAJ_PAN)), float(np.interp(t, rt, TRAJ_TILT)),
            float(np.interp(t, rt, TRAJ_FOV)))

# ---- projection family: image coord <-> camera ray ----
# Horizontal: theta = azimuth from optical axis. Panini x = (d+1)sin(th)/(d+cos(th));
# d=0 -> tan(th) = pinhole. Vertical: y = S*tan(phi), S = (d+1)/(d+cos(th)); pinhole
# y = tan(phi)/cos(th) = same formula at d=0. Cylindrical: x = theta, y = tan(phi).
# All have unit derivative at the axis -> same centre scale for free.

def half_extent(proj, d, half_deg):
    hh = np.radians(half_deg)
    if proj == "pinhole": return np.tan(hh)
    if proj == "cyl": return hh
    if proj == "blend": return (1 - d) * np.tan(hh) + d * hh
    return (d + 1) * np.sin(hh) / (d + np.cos(hh))          # panini

def rays_for(proj, d, hfov_deg, W, H):
    """Per-output-pixel camera-frame ray (dx, dy, dz), y up, matched centre scale."""
    xmax = half_extent(proj, d, hfov_deg / 2); ymax = xmax * H / W
    x = (np.arange(W) + 0.5) / W * 2 - 1
    y = 1 - (np.arange(H) + 0.5) / H * 2                     # row 0 = top = +y
    X, Y = np.meshgrid(x * xmax, y * ymax)
    if proj == "pinhole":
        th = np.arctan(X); S = 1 / np.cos(th)                # y = tan(phi)/cos(th)
    elif proj == "cyl":
        th = X; S = np.ones_like(X)                          # y = tan(phi)
    elif proj == "blend":                                    # pinhole<->cyl, b = d in [0,1]
        b = d
        th = np.arctan(X)                                    # Newton on (1-b)tan(th)+b*th = x
        for _ in range(8):
            th -= ((1 - b) * np.tan(th) + b * th - X) / ((1 - b) / np.cos(th) ** 2 + b)
        S = (1 - b) / np.cos(th) + b
    else:                                                    # panini, squeeze d
        k = X / (d + 1)
        th = np.arctan(k) + np.arcsin(np.clip(k * d / np.sqrt(1 + k * k), -1, 1))
        S = (d + 1) / (d + np.cos(th))
    tanphi = Y / S
    return np.sin(th), tanphi, np.cos(th)                    # (dx, dy, dz); |dx,dz| = 1

def bake_for_rays(pan_deg, tilt_deg, dx, dy, dz, scale=2.4):
    """Pinhole UV bake sized to cover the given rays; returns (u, v, px2col, py2row)."""
    px = dx / dz; py = dy / dz
    xb = float(np.abs(px).max()) * 1.02; yb = float(np.abs(py).max()) * 1.02
    fov_b = np.degrees(2 * np.arctan(yb)); asp_b = xb / yb
    Hb = int(dy.shape[0] * scale); Wb = int(Hb * asp_b)
    u, v = MD.bake_uv_map(projs, np.radians(pan_deg), np.radians(tilt_deg), fov_b, Wb, Hb, aspect=asp_b)
    bad = u < 0
    u = u.astype("f4"); v = v.astype("f4"); u[bad] = np.nan; v[bad] = np.nan  # NaN poisons blends -> clean mask
    col = ((px / xb + 1) / 2 * Wb - 0.5).astype("f4")
    row = ((1 - py / yb) / 2 * Hb - 0.5).astype("f4")
    return u, v, col, row

def render_proj(rawf, pan_deg, tilt_deg, vfov_deg, proj, d=0.0, W=1280, H=720):
    """Single-resample render of `rawf` through the mesh under the given view projection."""
    hfov = np.degrees(2 * np.arctan(ASP * np.tan(np.radians(vfov_deg) / 2)))
    dx, dy, dz = rays_for(proj, d, hfov, W, H)
    u, v, col, row = bake_for_rays(pan_deg, tilt_deg, dx, dy, dz)
    uu = cv2.remap(u, col, row, cv2.INTER_LINEAR, borderValue=np.nan)
    vv = cv2.remap(v, col, row, cv2.INTER_LINEAR, borderValue=np.nan)
    th_, tw_ = rawf.shape[:2]
    bad = ~np.isfinite(uu)
    m1 = (uu * tw_).astype("f4"); m2 = (vv * th_).astype("f4"); m1[bad] = -1; m2[bad] = -1
    return cv2.remap(rawf, m1, m2, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)

CANDS = [("pinhole (current)", "pinhole", 0.0), ("panini d=0.5", "panini", 0.5),
         ("panini d=1.0", "panini", 1.0), ("cylindrical", "cyl", 0.0)]

def grab(t):
    cap = cv2.VideoCapture(RAW); fps = cap.get(5) or 25
    cap.set(1, int(t * fps)); ok, f = cap.read(); cap.release()
    assert ok, f"no frame at t={t}"
    return f

def label(im, txt):
    im = im.copy(); cv2.rectangle(im, (0, 0), (im.shape[1], 34), (0, 0, 0), -1)
    cv2.putText(im, txt, (12, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 255), 2)
    return im

def self_check():
    """Composed pinhole must equal the direct MD.dewarp render."""
    f = grab(47); pan, tilt, fov = framing_at(47)
    a = render_proj(f, pan, tilt, fov, "pinhole", W=960, H=540)
    b = MD.dewarp(f, projs, np.radians(pan), np.radians(tilt), fov, 960, 540)
    d = np.abs(a.astype(np.int16) - b.astype(np.int16)).mean()
    print(f"self-check composed-pinhole vs direct dewarp: mean|diff| = {d:.3f} (want < 1.0)")
    assert d < 1.0, "composition does not reproduce the pinhole render — sign/scale bug"

def stills():
    views = [("follow_t47", *framing_at(47)),
             ("follow_t80", *framing_at(80)),
             ("explore_center_fov46", 0.0, float(np.median(TRAJ_TILT)), 46.0),
             ("explore_leftgoal_fov46", float(TRAJ_PAN.min()), float(np.median(TRAJ_TILT)), 46.0),
             ("explore_wide_fov60", 0.0, float(np.median(TRAJ_TILT)), 60.0)]
    for name, pan, tilt, fov in views:
        t = 47 if "t80" not in name else 80
        f = grab(t)
        panels = []
        for lab, proj, d in CANDS:
            im = render_proj(f, pan, tilt, fov, proj, d)
            cv2.imwrite(f"{OUT}/{name}_{lab.split()[0]}{('_' + str(d)) if proj == 'panini' else ''}.png", im)
            panels.append(label(im, f"{lab}   [{name}  pan {pan:+.1f}  fov {fov:.0f}]"))
        grid = np.vstack([np.hstack(panels[:2]), np.hstack(panels[2:])])
        cv2.imwrite(f"{OUT}/grid_{name}.png", grid)
        print(f"grid_{name}.png  (pan {pan:+.1f} tilt {tilt:+.1f} vfov {fov:.1f})")

def flicker(d=1.0):
    f = grab(47); pan, tilt, fov = framing_at(47)
    a = label(render_proj(f, pan, tilt, fov, "pinhole"), "pinhole (current)")
    b = label(render_proj(f, pan, tilt, fov, "panini", d), f"panini d={d}")
    vw = cv2.VideoWriter(f"{OUT}/flicker_t47_d{d}.mp4", cv2.VideoWriter_fourcc(*"mp4v"), 25, (1280, 720))
    for _ in range(8):
        for im in (a, b):
            for _ in range(15): vw.write(im)
    vw.release(); print(f"flicker_t47_d{d}.mp4")

def motion(d=1.0):
    W, H = 960, 540
    cap = cv2.VideoCapture(RAW); fps = cap.get(5) or 25
    vw = cv2.VideoWriter(f"{OUT}/motion_ab_d{d}.mp4", cv2.VideoWriter_fourcc(*"mp4v"), fps, (W * 2, H))
    n = 0
    for fi in range(int(31 * fps), int(56 * fps)):
        cap.set(1, fi); ok, f = cap.read()
        if not ok: break
        pan, tilt, fov = framing_at(fi / fps)
        a = label(render_proj(f, pan, tilt, fov, "pinhole", W=W, H=H), "pinhole (current)")
        b = label(render_proj(f, pan, tilt, fov, "panini", d, W=W, H=H), f"panini d={d}")
        vw.write(np.hstack([a, b])); n += 1
    cap.release(); vw.release(); print(f"motion_ab_d{d}.mp4 ({n} frames)")

def explore_flicker():
    """Pinhole <-> cylindrical at the two explore views (the gate instrument for the
    explore-fov verdict: 'cylindrical looks better' on grid_explore_leftgoal_fov46)."""
    f = grab(47); tilt = float(np.median(TRAJ_TILT))
    for name, pan in (("leftgoal", float(TRAJ_PAN.min())), ("center", 0.0)):
        a = label(render_proj(f, pan, tilt, 46.0, "pinhole"), "pinhole (current)")
        b = label(render_proj(f, pan, tilt, 46.0, "cyl"), "cylindrical")
        vw = cv2.VideoWriter(f"{OUT}/flicker_explore_{name}_cyl.mp4", cv2.VideoWriter_fourcc(*"mp4v"), 25, (1280, 720))
        for _ in range(8):
            for im in (a, b):
                for _ in range(15): vw.write(im)
        vw.release(); print(f"flicker_explore_{name}_cyl.mp4")

def pan_sweep():
    """Simulated explore drag: goal-to-goal pan at fov 46, pinhole | cylindrical."""
    W, H = 960, 540
    f = grab(47); tilt = float(np.median(TRAJ_TILT))
    p0, p1 = float(TRAJ_PAN.min()), float(TRAJ_PAN.max())
    vw = cv2.VideoWriter(f"{OUT}/pan_sweep_cyl.mp4", cv2.VideoWriter_fourcc(*"mp4v"), 25, (W * 2, H))
    for s in np.concatenate([np.linspace(0, 1, 250), np.linspace(1, 0, 250)]):
        pan = p0 + (p1 - p0) * float(s)
        a = label(render_proj(f, pan, tilt, 46.0, "pinhole", W=W, H=H), "pinhole (current)")
        b = label(render_proj(f, pan, tilt, 46.0, "cyl", W=W, H=H), "cylindrical")
        vw.write(np.hstack([a, b]))
    vw.release(); print("pan_sweep_cyl.mp4")

B_LO, B_HI = 38.0, 52.0    # d(fov) ramp: pure pinhole below B_LO vfov, pure cylindrical above B_HI

def blend_b(vfov):
    t = np.clip((vfov - B_LO) / (B_HI - B_LO), 0, 1)
    return float(t * t * (3 - 2 * t))                        # smoothstep

def zoom_sweep():
    """The PROPOSED behaviour: fov-adaptive projection (pinhole zoomed in -> cylindrical
    zoomed out, smooth d(fov) ramp) vs pure pinhole, zooming at the left goal."""
    W, H = 960, 540
    f = grab(47); tilt = float(np.median(TRAJ_TILT)); pan = float(TRAJ_PAN.min())
    vw = cv2.VideoWriter(f"{OUT}/zoom_sweep_adaptive.mp4", cv2.VideoWriter_fourcc(*"mp4v"), 25, (W * 2, H))
    for s in np.concatenate([np.linspace(0, 1, 250), np.linspace(1, 0, 250)]):
        fov = 25 + (60 - 25) * float(s); b = blend_b(fov)
        a = label(render_proj(f, pan, tilt, fov, "pinhole", W=W, H=H), f"pinhole (current)  fov {fov:.0f}")
        c = label(render_proj(f, pan, tilt, fov, "blend", b, W=W, H=H), f"fov-adaptive  fov {fov:.0f}  b={b:.2f}")
        vw.write(np.hstack([a, c]))
    vw.release(); print("zoom_sweep_adaptive.mp4")

if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "all"
    d = float(sys.argv[2]) if len(sys.argv) > 2 else 1.0
    self_check()
    if mode in ("stills", "all"): stills()
    if mode in ("flicker", "all"): flicker(d)
    if mode in ("motion", "all"): motion(d)
    if mode == "explore": explore_flicker(); pan_sweep()
    if mode == "zoom": zoom_sweep()

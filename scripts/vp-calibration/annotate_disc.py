#!/usr/bin/env python3
"""One-time fisheye disc annotation → principal point (CX,CY).

The camera is FIXED, so its optical axis only needs to be found once, ever. Auto
disc-detection (RANSAC in calibrate.py) fails on dark/night frames where the black
fisheye exterior merges with dark scene — this manual path is the robust fallback.

Click 6-8+ points around the visible image-circle RIM (the boundary between the
lit scene and the black exterior). A Taubin circle fit (low radius-bias on partial
arcs) gives the centre = principal point. Writes kuwait-disc.json {cx,cy,R} in
FULL-RES pixels; calibrate.py picks it up automatically and re-solves the lens
with the correct, off-centre principal point (which is what fixes the ASYMMETRIC
touchline bow — radial distortion about a wrong centre cannot).

Controls:  left-click = add rim point · right-click / u = undo last · r = reset
           w or enter = write & quit · q or esc = cancel (no write)
Use the matplotlib toolbar magnifier to zoom in for precise rim clicks (clicks are
ignored while a toolbar tool is active, so zoom freely).

Env: SRC (frame), OUT (json path), SELFTEST=1 (headless fit self-check, no GUI).
"""
import os, json, numpy as np, cv2

SITE = os.environ.get('SITE', 'kuwait')
SRC = os.environ.get('SRC', f'PLAYHUB/scripts/vp-calibration/{SITE}-fisheye.jpg')
OUT = os.environ.get('OUT', f'PLAYHUB/scripts/vp-calibration/{SITE}-disc.json')


def fit_circle_taubin(pts):
    """Taubin algebraic circle fit (Chernov). Returns (cx, cy, R, rms). Far less
    radius-biased than Kåsa when the points cover only a partial arc — which is
    the norm here (the rim is usually visible on one or two sides only)."""
    p = np.asarray(pts, float)
    if len(p) < 3:
        return None
    c = p.mean(0); u, v = p[:, 0] - c[0], p[:, 1] - c[1]
    z = u * u + v * v
    Muu, Mvv, Muv = (u * u).mean(), (v * v).mean(), (u * v).mean()
    Muz, Mvz, Mzz = (u * z).mean(), (v * z).mean(), (z * z).mean()
    Mz = Muu + Mvv
    Cov = Muu * Mvv - Muv * Muv
    A3 = 4 * Mz
    A2 = -3 * Mz * Mz - Mzz
    A1 = Mzz * Mz + 4 * Cov * Mz - Muz * Muz - Mvz * Mvz - Mz ** 3
    A0 = Muz * Muz * Mvv + Mvz * Mvz * Muu - Mzz * Cov - 2 * Muz * Mvz * Muv + Mz * Mz * Cov
    A22, A33 = A2 + A2, A3 + A3 + A3
    x, y = 0.0, 1e20
    for _ in range(50):
        yold = y; y = A0 + x * (A1 + x * (A2 + x * A3))
        if abs(y) > abs(yold):
            break
        Dy = A1 + x * (A22 + x * A33)
        if Dy == 0:
            break
        xold = x; x = xold - y / Dy
        if x < 0 or not np.isfinite(x):
            x = 0.0; break
        if abs((x - xold) / (x + 1e-12)) < 1e-12:
            break
    det = x * x - x * Mz + Cov
    if abs(det) < 1e-12:
        return None
    uc = (Muz * (Mvv - x) - Mvz * Muv) / det / 2
    vc = (Mvz * (Muu - x) - Muz * Muv) / det / 2
    cx, cy = uc + c[0], vc + c[1]
    R = np.sqrt(max(uc * uc + vc * vc + Mz + 2 * x, 1e-9))
    rms = float(np.sqrt(np.mean((np.hypot(p[:, 0] - cx, p[:, 1] - cy) - R) ** 2)))
    return float(cx), float(cy), float(R), rms


def _selftest():
    # synthetic partial arc (top-left ~120°), fit must recover the true centre
    rng = np.random.default_rng(0)
    tx, ty, tR = 1750.0, 900.0, 2000.0
    ang = np.radians(np.linspace(150, 270, 40))
    pts = np.stack([tx + tR * np.cos(ang), ty + tR * np.sin(ang)], 1)
    pts += rng.normal(0, 1.5, pts.shape)
    cx, cy, R, rms = fit_circle_taubin(pts)
    err = np.hypot(cx - tx, cy - ty)
    print(f'SELFTEST partial-arc: centre=({cx:.1f},{cy:.1f}) R={R:.0f} rms={rms:.2f} '
          f'centre-err={err:.1f}px')
    assert err < 15 and abs(R - tR) < 40, 'Taubin fit off on synthetic arc'
    print('SELFTEST ok')


def main():
    if os.environ.get('SELFTEST'):
        _selftest(); return
    import matplotlib
    import matplotlib.pyplot as plt

    bgr = cv2.imread(SRC)
    if bgr is None:
        raise SystemExit(f'could not read {SRC}')
    Hf, Wf = bgr.shape[:2]
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)

    fig, ax = plt.subplots(figsize=(13, 8))
    ax.imshow(rgb); ax.set_axis_off()
    ax.set_title('Click 6-8+ points around the fisheye RIM · right-click/u=undo · '
                 'r=reset · w/enter=save · q=cancel', fontsize=10)
    pts = []
    dot_artist = ax.plot([], [], 'o', ms=7, mfc='none', mec='#00e5ff', mew=2)[0]
    ctr_artist = ax.plot([], [], '+', ms=16, mec='#ff3b3b', mew=2)[0]
    circ = matplotlib.patches.Circle((0, 0), 0, fill=False, ec='#ffb000', lw=1.4, visible=False)
    ax.add_patch(circ)
    txt = ax.text(0.01, 0.99, '', transform=ax.transAxes, va='top', ha='left',
                  fontsize=10, color='#ffb000', family='monospace',
                  bbox=dict(boxstyle='round', fc='black', alpha=0.6))
    state = {'saved': False}

    def redraw():
        if pts:
            a = np.array(pts); dot_artist.set_data(a[:, 0], a[:, 1])
        else:
            dot_artist.set_data([], [])
        fit = fit_circle_taubin(pts) if len(pts) >= 3 else None
        if fit:
            cx, cy, R, rms = fit
            circ.center = (cx, cy); circ.radius = R; circ.set_visible(True)
            ctr_artist.set_data([cx], [cy])
            txt.set_text(f'{len(pts)} pts  centre=({cx:.0f},{cy:.0f})  R={R:.0f}\n'
                         f'offset from frame-centre ({cx-Wf/2:+.0f},{cy-Hf/2:+.0f})  '
                         f'rms={rms:.1f}px')
        else:
            circ.set_visible(False); ctr_artist.set_data([], [])
            txt.set_text(f'{len(pts)} pts  (need 3+ for a fit)')
        fig.canvas.draw_idle()

    def on_click(ev):
        if ev.inaxes != ax or fig.canvas.toolbar.mode:  # ignore while zoom/pan active
            return
        if ev.button == 1:
            pts.append((ev.xdata, ev.ydata))
        elif ev.button == 3 and pts:
            pts.pop()
        redraw()

    def save():
        fit = fit_circle_taubin(pts)
        if not fit:
            txt.set_text('need 3+ points to save'); fig.canvas.draw_idle(); return
        cx, cy, R, rms = fit
        json.dump({'cx': cx, 'cy': cy, 'R': R, 'rms': rms, 'n_points': len(pts),
                   'source': 'manual', 'src_w': Wf, 'src_h': Hf},
                  open(OUT, 'w'), indent=2)
        state['saved'] = True
        print(f'wrote {OUT}: centre=({cx:.1f},{cy:.1f}) R={R:.0f} rms={rms:.2f}px '
              f'offset=({cx-Wf/2:+.1f},{cy-Hf/2:+.1f})  ({len(pts)} points)')
        print('next: re-run calibrate.py (it auto-uses this disc) → generate_mesh.py')
        plt.close(fig)

    def on_key(ev):
        if ev.key in ('w', 'enter'):
            save()
        elif ev.key == 'u' and pts:
            pts.pop(); redraw()
        elif ev.key == 'r':
            pts.clear(); redraw()
        elif ev.key in ('q', 'escape'):
            plt.close(fig)

    fig.canvas.mpl_connect('button_press_event', on_click)
    fig.canvas.mpl_connect('key_press_event', on_key)
    redraw()
    plt.show()
    if not state['saved']:
        print('cancelled — no disc file written')


if __name__ == '__main__':
    main()

"""Derive Spiideo's exact framing (pan,tilt,fov) DIRECTLY from the reliable SIFT
registration (reg: crop-centre pano_x,pano_y + crop-width footw in raw coords, matched on
static background, 100% coverage) by GEOMETRIC INVERSION of the mesh — NOT by re-matching
(which rewarded a wide view that merely contains Spiideo's crop). For each frame:
  pan  : exact from pano_x  (mesh_pan = -(px*W-CX)/F)
  tilt : bisect so the view-centre samples raw row pano_y
  fov  : bisect so the view's horizontal footprint in raw = footw
Then VALIDATE: render our dewarp at that framing next to Spiideo — must show the SAME
region/zoom. Writes a validation montage FIRST; only render the full clip if it matches.

  python3 framing_from_reg.py <raw.mp4> <play.mp4> <reg.json> <out.mp4> [--validate-only]
"""
from __future__ import annotations

import json
import sys
import numpy as np
import cv2

import mesh_dewarp as MD

F, CX, W_PANO = 1158.15, 1820.72, 3840.0
projs, _ = MD.load_mesh("/tmp/follow-pair/mesh")


def center_and_footprint(pan, tilt, fov):
    """Where the view centre samples in the raw (normalized u,v) and the horizontal
    footprint width (normalized) — via a tiny bake."""
    u, v = MD.bake_uv_map(projs, np.radians(pan), np.radians(tilt), fov, 160, 90)
    cu, cv = u[45, 80], v[45, 80]
    row = u[45]; valid = row >= 0
    fw = (row[valid].max() - row[valid].min()) if valid.any() else 0.0
    return float(cu), float(cv), float(fw)


def invert(pano_x, pano_y, footw, pan0=0.0, tilt0=-20.0, fov0=30.0):
    """Solve (pan,tilt,fov) so the view centre samples raw (pano_x,pano_y) with horizontal
    footprint footw. Coordinate descent; each DOF is monotonic + near-decoupled (probed):
      center_u ↓ in pan, center_v ↓ in tilt, footprint ↑ in fov."""
    pan, tilt, fov = pan0, tilt0, fov0
    for _ in range(6):
        lo, hi = -75.0, 75.0                          # pan for center_u = pano_x
        for _ in range(18):
            mid = (lo + hi) / 2; cu, _, _ = center_and_footprint(mid, tilt, fov)
            if cu < pano_x: hi = mid
            else: lo = mid
        pan = (lo + hi) / 2
        lo, hi = -38.0, -6.0                           # tilt for center_v = pano_y
        for _ in range(18):
            mid = (lo + hi) / 2; _, cv, _ = center_and_footprint(pan, mid, fov)
            if cv < pano_y: hi = mid
            else: lo = mid
        tilt = (lo + hi) / 2
        lo, hi = 12.0, 50.0                            # fov for footprint = footw
        for _ in range(18):
            mid = (lo + hi) / 2; _, _, fw = center_and_footprint(pan, tilt, mid)
            if fw < footw: lo = mid
            else: hi = mid
        fov = (lo + hi) / 2
    return float(pan), float(np.clip(tilt, -38, -6)), float(np.clip(fov, 14, 46))


def main():
    raw, play, regf, out = sys.argv[1:5]
    validate_only = "--validate-only" in sys.argv
    reg = json.load(open(regf))
    t = np.array(reg["t"]); px = np.array(reg["pano_x"]); py = np.array(reg["pano_y"]); fw = np.array(reg["footw"])
    capr = cv2.VideoCapture(raw); capp = cv2.VideoCapture(play)
    def lab(im, tx, c):
        cv2.rectangle(im, (0, 0), (640, 24), (0, 0, 0), -1); cv2.putText(im, tx, (7, 17), cv2.FONT_HERSHEY_SIMPLEX, 0.5, c, 1); return im

    if validate_only:
        rows = []
        pn, ti, fo = 0.0, -20.0, 30.0
        for tv in [t.max() * 0.2, t.max() * 0.45, 77.0, t.max() * 0.85]:
            i = int(np.argmin(np.abs(t - tv)))
            pn, ti, fo = invert(px[i], py[i], fw[i], 0.0, -20.0, 30.0)
            capr.set(cv2.CAP_PROP_POS_MSEC, t[i] * 1000); _, rf = capr.read()
            capp.set(cv2.CAP_PROP_POS_MSEC, t[i] * 1000); _, pf = capp.read()
            our = MD.dewarp(rf, projs, np.radians(pn), np.radians(ti), fo, 640, 360)
            a = lab(our, f"OURS t={t[i]:.0f}s pan{pn:.0f} tilt{ti:.0f} fov{fo:.0f}", (120, 255, 120))
            b = lab(cv2.resize(pf, (640, 360)), "Spiideo AutoFollow", (210, 210, 210))
            rows.append(np.hstack([a, b]))
        cv2.imwrite("/tmp/imitation/framing_from_reg_validate.png", np.vstack(rows))
        print("wrote /tmp/imitation/framing_from_reg_validate.png (VALIDATE-ONLY)")
        capr.release(); capp.release(); return

    # invert every sample (warm-started)
    pan = np.zeros_like(px); tilt = np.zeros_like(px); fov = np.zeros_like(px)
    pn, ti, fo = 0.0, -20.0, 30.0
    for i in range(len(px)):
        pn, ti, fo = invert(px[i], py[i], fw[i], pn, ti, fo)
        pan[i] = pn; tilt[i] = ti; fov[i] = fo
    k = 5; sm = lambda a: np.convolve(a, np.ones(k) / k, "same")
    tilt = sm(tilt); fov = sm(fov)
    json.dump(dict(t=list(t), pan=list(map(float, pan)), tilt=list(map(float, tilt)), fov=list(map(float, fov))),
              open(out.replace(".mp4", "_framing.json"), "w"))
    print(f"inverted {len(px)} frames  pan {pan.min():.0f}..{pan.max():.0f}  tilt {tilt.min():.0f}..{tilt.max():.0f}  fov {fov.min():.0f}..{fov.max():.0f}")

    # full render
    fps = capp.get(cv2.CAP_PROP_FPS) or 25.0
    n = int(capr.get(cv2.CAP_PROP_FRAME_COUNT)) or int(t.max() * fps)
    capr.set(cv2.CAP_PROP_POS_FRAMES, 0); capp.set(cv2.CAP_PROP_POS_FRAMES, 0)
    vw = cv2.VideoWriter(out, cv2.VideoWriter_fourcc(*"mp4v"), fps, (1280, 360))
    i = 0
    while True:
        okr, rf = capr.read(); okp, pf = capp.read()
        if not okr or i >= n:
            break
        ct = i / fps
        pn = np.interp(ct, t, pan); tl = np.interp(ct, t, tilt); fv = np.interp(ct, t, fov)
        a = lab(MD.dewarp(rf, projs, np.radians(pn), np.radians(tl), fv, 640, 360), "PLAYHUB flat follow", (120, 255, 120))
        b = lab(cv2.resize(pf, (640, 360)) if okp else np.zeros((360, 640, 3), np.uint8), "Spiideo AutoFollow", (210, 210, 210))
        vw.write(np.hstack([a, b])); i += 1
    capr.release(); capp.release(); vw.release()
    print(f"wrote {out} ({i} frames)")


if __name__ == "__main__":
    main()

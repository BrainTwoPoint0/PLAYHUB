#!/usr/bin/env python3
"""Layer 2 — de-warp a single raw fisheye frame to a rectilinear view.
Params via env so we can iterate fast:
  F      fisheye focal px (equidistant scale; edge θ=90° ⇒ f≈2R/π)
  CX,CY  fisheye centre px
  K1..K4 cv2.fisheye distortion (r_d = θ(1+k1θ²+k2θ⁴+k3θ⁶+k4θ⁸))
  TILT   output camera pitch-down degrees (camera looks down at the pitch)
  YAW,ROLL output camera yaw/roll degrees
  OUTF   output focal px (zoom; smaller = wider FOV)
  OW,OH  output size
"""
import os, cv2, numpy as np

env = lambda k, d: float(os.environ.get(k, d))
SITE = os.environ.get('SITE', 'kuwait')
SRC = os.environ.get('SRC', f'PLAYHUB/scripts/vp-calibration/{SITE}-fisheye.jpg')
OUT = os.environ.get('OUT', f'/tmp/{SITE}-dewarped.png')

img = cv2.imread(SRC)
H, W = img.shape[:2]
f = env('F', 1200); cx = env('CX', W/2); cy = env('CY', H/2)
K = np.array([[f, 0, cx], [0, f, cy], [0, 0, 1]], np.float64)
D = np.array([env('K1', 0), env('K2', 0), env('K3', 0), env('K4', 0)], np.float64)

OW = int(env('OW', 1600)); OH = int(env('OH', 900))
outf = env('OUTF', 850)
Knew = np.array([[outf, 0, OW/2], [0, outf, OH/2], [0, 0, 1]], np.float64)

rx = np.radians(env('TILT', 32)); ry = np.radians(env('YAW', 0)); rz = np.radians(env('ROLL', 0))
Rx = cv2.Rodrigues(np.array([rx, 0, 0]))[0]
Ry = cv2.Rodrigues(np.array([0, ry, 0]))[0]
Rz = cv2.Rodrigues(np.array([0, 0, rz]))[0]
R = Rz @ Ry @ Rx

map1, map2 = cv2.fisheye.initUndistortRectifyMap(K, D, R, Knew, (OW, OH), cv2.CV_16SC2)
out = cv2.remap(img, map1, map2, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
cv2.imwrite(OUT, out)
print(f'de-warped → {OUT}  (f={f} cx={cx:.0f} cy={cy:.0f} D={D.tolist()} tilt={np.degrees(rx):.0f} outf={outf} {OW}x{OH})')

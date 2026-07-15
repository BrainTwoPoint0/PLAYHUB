"""Physical model: is the pitch crowned?

If a player stands at ground height h(P) above the plane H fitted, and the
camera is at (N, Hc) above that plane, the detection ray crosses the fitted
plane at  P + (h/(Hc-h))(P-N).  Spiideo's tracker reports P (its own ground
model), so:

    d(P) = M - m_true = -(h/(Hc-h)) * (P - N)          [radial from N]

=> kappa(P) := -(d . u) / |P-N|  ~=  h(P)/Hc      with u = (P-N)/|P-N|

So the residuals let us SOLVE for the pitch's height field (up to the camera
height Hc). If kappa comes out a smooth dome, the pitch is crowned and the
fix is a 6-parameter physical correction, not a generic polynomial.
"""
import json, os, sys, glob
sys.path.insert(0, '/Users/karimfawaz/Dev Projects/PLAYBACK Workspace/PLAYHUB/infrastructure/batch/player-tracklets')
import numpy as np
import cv2
from scipy.optimize import minimize

OUT = os.path.dirname(os.path.abspath(__file__))
z = np.load(f'{OUT}/residuals.npz')
M, d_metric, LO, HI, H = z['M'], z['d_metric'], z['LO'], z['HI'], z['H']
Hinv = np.linalg.inv(H)
print(f'{len(M)} correspondences')

# ---- robust per-cell median field (suppresses per-point noise) ---------------
BIN = 4.0
gx = np.floor((M[:, 0] - LO[0]) / BIN).astype(int)
gy = np.floor((M[:, 1] - LO[1]) / BIN).astype(int)
cells = {}
for i in range(len(M)):
    cells.setdefault((gx[i], gy[i]), []).append(i)
C_pos, C_d, C_n = [], [], []
for (cx_, cy_), idx in cells.items():
    if len(idx) < 25:
        continue
    C_pos.append(np.median(M[idx], axis=0))
    C_d.append(np.median(d_metric[idx], axis=0))
    C_n.append(len(idx))
C_pos = np.array(C_pos); C_d = np.array(C_d); C_n = np.array(C_n)
print(f'{len(C_pos)} cells with >=25 points')

# ---- fit the nadir N: residuals should be radial from it --------------------
w = np.sqrt(C_n)
def cost(n):
    v = C_pos - n
    r = np.linalg.norm(v, axis=1, keepdims=True)
    u = v / (r + 1e-9)
    # component of d perpendicular to the radial direction should vanish
    perp = C_d[:, 0] * u[:, 1] - C_d[:, 1] * u[:, 0]
    return float((w * perp ** 2).sum())
best = None
for x0 in ([-22, 0], [15, 0], [0, -31], [0, 29], [-3, -1], [-10, 1]):
    r = minimize(cost, x0, method='Nelder-Mead',
                 options={'maxiter': 4000, 'xatol': 1e-3, 'fatol': 1e-9})
    if best is None or r.fun < best.fun:
        best = r
N = best.x
v = C_pos - N
rad = np.linalg.norm(v, axis=1)
u = v / rad[:, None]
kappa = -(C_d * u).sum(axis=1) / rad          # ~= h/Hc
align = np.abs((C_d / (np.linalg.norm(C_d, axis=1, keepdims=True) + 1e-9)
                * u).sum(axis=1))
print(f'\nfitted nadir N = ({N[0]:.1f}, {N[1]:.1f}) m   '
      f'(pitch x[{LO[0]:.0f},{HI[0]:.0f}] y[{LO[1]:.0f},{HI[1]:.0f}])')
print(f'radial alignment |cos| (cell medians, weighted): '
      f'{np.average(align, weights=w):.3f}')

# ---- the implied height field ------------------------------------------------
print(f'\nkappa = h/Hc per cell  (x -> across, y -> along). '
      f'For a 10m camera, h[m] = 10*kappa:')
nx = int((HI[0] - LO[0]) / BIN) + 1
ny = int((HI[1] - LO[1]) / BIN) + 1
grid = np.full((ny, nx), np.nan)
for p, k in zip(C_pos, kappa):
    ix = int((p[0] - LO[0]) / BIN); iy = int((p[1] - LO[1]) / BIN)
    if 0 <= ix < nx and 0 <= iy < ny:
        grid[iy, ix] = k
print('        ' + ''.join(f'{LO[0] + (i + .5) * BIN:7.0f}' for i in range(nx)))
for j in range(ny):
    row = ''.join('      .' if np.isnan(grid[j, i]) else f'{grid[j, i]:7.3f}'
                  for i in range(nx))
    print(f'y={LO[1] + (j + .5) * BIN:6.1f} |{row}')
kv = kappa[np.isfinite(kappa)]
print(f'\nkappa range {kv.min():+.3f} .. {kv.max():+.3f}  '
      f'=> for Hc=10m, height spread {(kv.max() - kv.min()) * 10:.2f} m')

# ---- fit a quadratic crown: h/Hc = a + b.x + c.y + d.x^2 + e.xy + f.y^2 ------
def dsg(P):
    x = (P[:, 0] - (LO[0] + HI[0]) / 2) / 10.0
    y = (P[:, 1] - (LO[1] + HI[1]) / 2) / 10.0
    return np.column_stack([np.ones(len(P)), x, y, x * x, x * y, y * y])
A = dsg(C_pos) * w[:, None]
coef, *_ = np.linalg.lstsq(A, kappa * w, rcond=None)
pred = dsg(C_pos) @ coef
ss_res = float((w * (kappa - pred) ** 2).sum())
ss_tot = float((w * (kappa - np.average(kappa, weights=w)) ** 2).sum())
print(f'quadratic height fit R^2 = {1 - ss_res / ss_tot:.3f}  coef={np.round(coef, 4)}')

# curvature: is it a DOME? (negative-definite Hessian)
Hess = np.array([[2 * coef[3], coef[4]], [coef[4], 2 * coef[5]]])
ev = np.linalg.eigvalsh(Hess)
shape = ('DOME (crowned)' if (ev < 0).all() else
         'BOWL (dished)' if (ev > 0).all() else 'SADDLE')
print(f'  Hessian eigenvalues {np.round(ev, 4)} -> {shape}')

# ---- apply the physical correction & score held-out ---------------------------
np.save(f'{OUT}/height_coef.npy', coef)
np.save(f'{OUT}/height_nadir.npy', N)

def phys_delta(P, coef=coef, N=N):
    """metric correction: subtract the height-induced radial displacement."""
    v = P - N
    r = np.linalg.norm(v, axis=1, keepdims=True) + 1e-9
    k = (dsg(P) @ coef)[:, None]       # h/Hc
    return -(k / (1 - k)) * v          # == -(h/(Hc-h))(P-N)

e0 = np.linalg.norm(d_metric, axis=1)
e1 = np.linalg.norm(d_metric - phys_delta(M), axis=1)
cy = (LO[1] + HI[1]) / 2
far = np.abs(M[:, 1] - cy) > 18
print(f'\nIN-SAMPLE check (all pooled pairs):')
print(f'  baseline median {np.median(e0):.3f}m | ends {np.median(e0[far]):.3f}m')
print(f'  +height  median {np.median(e1):.3f}m | ends {np.median(e1[far]):.3f}m')

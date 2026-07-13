#!/usr/bin/env python3
"""Convention-free line-straightness arbiter: OUR fit vs SPIIDEO'S OWN mesh.

Settles "is this visible curve our calibration's fault?" without decoding
Spiideo's vertex conventions: collinearity through the origin is invariant
under any fixed invertible 3x3, so testing their (gnx, gny, 1) vectors for
coplanarity asks whether THEIR calibration renders the same pixels straight —
no textureToWorld/MOUNT decoding needed (the blocker in the §0k byte-level
cross-check does not apply to this instrument).

Readings (rms mrad, ours vs theirs):
  low  / low   → line is straight, both calibrations fine
  high / low   → OUR fit is wrong in that region (refit candidate)
  high / high  → the traced points are junk OR the world line is genuinely
                 curved — no calibration change can (or should) flatten it.

⚠️ RETRACTED FOR SYNTHETIC MESHES (2026-07-13, AIM_RESUME §0r): single-lens
Spiideo meshes (Nazwa/FP style) are PURE WINDOW GEOMETRY — positions are a
gnomonic of window-fraction angles and the texture coords are a REGULAR
lattice; they carry NO lens information (the lens lives in an upstream
raw→equirect stage). Against such a mesh the "theirs" column is meaningless
— the guard in main() refuses them. Meshes with REAL (irregular) texture UVs
— e.g. HCT's two-cam product mesh — remain valid comparison sources.

ASSUMPTION — same sensor/lens, same intrinsics epoch. The mesh must calibrate
the SAME physical camera that produced the traced frame. Camera POSITION and
re-mounts don't matter (a straight world line projects onto a plane of rays
from any viewpoint, so the verdict is viewpoint-independent), but pointing
this at a mesh from a different camera, a swapped lens, or a calibration from
before a lens change makes the pixel→ray map meaningless — residuals then
read spuriously high and every line looks "curved". Check the mesh's source
scene/camera id against the frame's before trusting a cross-epoch verdict.

Usage:
  python3 line_check_spiideo.py FIT.json LINES.json SPIIDEO_MESH_DIR [W H]

LINES.json = {"lines": [{"name":..., "pts": [[x,y],...]}]} (full-res pixels,
snap_lines.py output or any traced points). W H = raw frame size (default
3840 2160). SPIIDEO_MESH_DIR = a fetched real mesh (fetch_spiideo_mesh.mjs),
vertex layout [gnx, gny, u, v, alpha], no v-flip.
"""
import json
import sys

import numpy as np
from scipy.interpolate import griddata

sys.path.insert(0, __file__.rsplit('/', 1)[0])
from fisheye_model import kb_params, unproject  # noqa: E402


def plane_rms_mrad(vecs):
    v = vecs / np.linalg.norm(vecs, axis=1, keepdims=True)
    _, _, vt = np.linalg.svd(v, full_matrices=False)
    r = 1000 * (v @ vt[2])
    return float(np.sqrt((r ** 2).mean()))


def main():
    fit_p, lines_p, mesh_dir = sys.argv[1], sys.argv[2], sys.argv[3]
    W = int(sys.argv[4]) if len(sys.argv) > 4 else 3840
    H = int(sys.argv[5]) if len(sys.argv) > 5 else 2160

    fit = json.load(open(fit_p))
    F, cx, cy, ks = kb_params(fit)

    V = np.frombuffer(open(f'{mesh_dir}/vertices.bin', 'rb').read(), np.float32).reshape(-1, 5)
    I = np.frombuffer(open(f'{mesh_dir}/indices.bin', 'rb').read(), np.uint32)
    V = V[np.unique(I[:len(I) - len(I) % 3])]  # triangle-referenced only
    uv = V[:, 2:4].astype(np.float64)
    gn = V[:, :2].astype(np.float64)
    # synthetic-mesh guard: a regular texture-coord lattice = window geometry,
    # not a calibration — comparisons against it are void (see docstring)
    if (len(np.unique(uv[:, 0])) < 0.05 * len(uv)
            and len(np.unique(uv[:, 1])) < 0.05 * len(uv)):
        sys.exit('REFUSING: mesh texture coords form a regular lattice — this is a '
                 'SYNTHETIC window mesh with no lens information (AIM_RESUME §0r).')

    print(f"{'line':>18} {'ours(mrad)':>11} {'theirs(mrad)':>13}  verdict")
    for l in json.load(open(lines_p))['lines']:
        pts = np.array(l['pts'], float)
        rays, ok = unproject(pts, F, cx, cy, ks)
        ours = plane_rms_mrad(rays[ok]) if ok.sum() >= 5 else float('nan')
        q = np.column_stack([pts[:, 0] / W, pts[:, 1] / H])
        g = griddata(uv, gn, q, method='linear')
        okg = np.isfinite(g).all(1)
        theirs = (
            plane_rms_mrad(np.column_stack([g[okg, 0], g[okg, 1], np.ones(okg.sum())]))
            if okg.sum() >= 5 else float('nan')
        )
        if np.isnan(ours) or np.isnan(theirs):
            v = 'unmapped'
        elif theirs < 2.5 and ours < 2.5:
            v = 'straight, both fine'
        elif theirs < 2.5 <= ours:
            v = 'OUR FIT WRONG HERE (refit candidate)'
        elif ours < 2.5 <= theirs:
            v = 'their mesh worse here (rare)'
        else:
            v = 'junk points OR world line genuinely curved'
        print(f"{l['name']:>18} {ours:11.2f} {theirs:13.2f}  {v}")


if __name__ == '__main__':
    main()

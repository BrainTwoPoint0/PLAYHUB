#!/usr/bin/env python3
"""Per-projection colour match from the cross-camera OVERLAP band.

Multi-camera scenes (HCT: two co-located lenses) can differ visibly in
exposure/colour at the seam. Both projections image the SAME world rays in
the overlap band (rotation-only relative extrinsics), so sampling the raw
frame through each projection's UV map at identical output pixels yields
matched colour pairs — no alignment, no feature matching. The correction is
reduced to per-channel RGB GAINS on the non-base projections (the player
multiplies them in via the existing per-vertex colour path), normalised so
the BASE projection (the LAST one — the opaque layer in the player) stays
identity.

Robustness: median-of-ratios per channel over well-exposed pixels (median is
immune to the small near-field parallax step at the seam and to specular
outliers).

⚠️ GAINS ARE LINEAR-LIGHT, NOT sRGB. The player's video texture is
`THREE.SRGBColorSpace`, so the GPU decodes texels to linear BEFORE the vertex
colour multiplies (three r152+ colour management) and re-encodes on output —
a vertex gain g displays as ≈ g^(1/2.2) in sRGB terms. Pixels are therefore
decoded through the sRGB EOTF before the ratio (also the physically correct
domain: a constant exposure difference between lenses IS a linear gain), and
the proof render applies gains in linear then re-encodes.

Usage:
  python3 color_match_overlap.py MESH_DIR FRAME [FRAME2] [OUT_DIR]

  FRAME       stacked raw panorama frame (e.g. 3840x2160 for HCT), OR the
              TOP half (v 0..0.5) if FRAME2 (bottom half) is also given.
  OUT_DIR     default /tmp/color-match — writes tuning.json + proof renders.

Writes OUT_DIR/tuning.json:  {"colorGains": [[r,g,b], ...]}  (one per
projection, texture-RGB multipliers; base = [1,1,1]). Copy it next to the
scene's mesh files (ingest uploads it with scene.json/vertices/indices).
"""
import json
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "follow-re"))
import mesh_dewarp as MD  # noqa: E402


def srgb_to_linear(px8):
    """sRGB EOTF on 8-bit pixels → linear [0,1] float32."""
    c = px8.astype(np.float32) / 255.0
    return np.where(c > 0.04045, ((c + 0.055) / 1.055) ** 2.4, c / 12.92).astype(np.float32)


def linear_to_srgb(lin):
    """Inverse EOTF, linear [0,1] → 8-bit sRGB."""
    c = np.clip(lin, 0.0, 1.0)
    s = np.where(c > 0.0031308, 1.055 * c ** (1 / 2.4) - 0.055, 12.92 * c)
    return np.clip(s * 255.0 + 0.5, 0, 255).astype(np.uint8)


def referenced_extents(p):
    """Angular extents over TRIANGLE-REFERENCED vertices only — culled vertices
    stay in vertices.bin with garbage f0/f1/UV (2026-07-12 invariant)."""
    ref = np.unique(p["tris"])
    w = p["world"][ref]
    w = w / np.linalg.norm(w, axis=1, keepdims=True)
    pan = np.degrees(np.arctan2(w[:, 0], w[:, 2]))
    tilt = np.degrees(np.arcsin(np.clip(-w[:, 1], -1, 1)))
    uv = p["uv"][ref]
    return pan, tilt, uv


def load_frame(argv):
    f = cv2.imread(argv[2], cv2.IMREAD_COLOR)
    assert f is not None, f"cannot read {argv[2]}"
    if len(argv) > 3 and os.path.isfile(argv[3]) and not os.path.isdir(argv[3]):
        f2 = cv2.imread(argv[3], cv2.IMREAD_COLOR)
        assert f2 is not None, f"cannot read {argv[3]}"
        f = np.vstack([f, f2])
        out = argv[4] if len(argv) > 4 else "/tmp/color-match"
    else:
        out = argv[3] if len(argv) > 3 else "/tmp/color-match"
    return f, out


def overlap_views(projs):
    """Views centred on the cross-projection overlap: intersect per-projection
    pan ranges, span the common tilt range. Triangle-referenced vertices only."""
    rng = []
    for p in projs:
        pan, tilt, _ = referenced_extents(p)
        rng.append((pan.min(), pan.max(), tilt.min(), tilt.max()))
    lo = max(r[0] for r in rng)
    hi = min(r[1] for r in rng)
    assert hi > lo, "projections do not overlap in pan"
    tlo = max(r[2] for r in rng)
    thi = min(r[3] for r in rng)
    pan_c = np.radians((lo + hi) / 2)
    tilts = np.radians(np.linspace(tlo + 5, thi - 5, 3))
    return pan_c, tilts, (lo, hi)


def sample_pairs(frame, singles, pan, tilt, fov=40.0, W=1280, H=720):
    """Matched colour pairs (one row per output pixel valid in EVERY projection):
    returns list of float32 arrays, one per projection, Nx3 BGR.

    `singles` = one single-projection list per projection, allocated ONCE by the
    caller and kept alive: mesh_dewarp caches VAOs by id(list), and a fresh
    slice per call lets Python reuse a dead list's id — both bakes would then
    silently render the FIRST projection's cached geometry."""
    th, tw = frame.shape[:2]
    uvs = []
    for s in singles:
        u, v = MD.bake_uv_map(s, pan, tilt, fov, W, H)
        uvs.append((u, v))
    valid = np.ones(uvs[0][0].shape, bool)
    for u, v in uvs:
        valid &= (u >= 0) & (v >= 0)
    if valid.sum() == 0:
        return None
    out = []
    for u, v in uvs:
        m1 = (u * tw).astype("f4")
        m2 = (v * th).astype("f4")
        px = cv2.remap(frame, m1, m2, cv2.INTER_LINEAR)
        out.append(px[valid].astype(np.float32))
    return out


LUT_N = 256


def lut_from_pairs(base, other):
    """Per-channel tone LUT mapping other→base in LINEAR light — quantile
    (histogram-spec) matching, which the HCT data demands: the base/other
    ratio runs ~1.8 in shadows down to ~1.1 in highlights, so no gain (or
    affine) can flatten the seam. Returns (LUT_N, 3) float32, indexed by the
    sRGB-ENCODED input (idx = lin^(1/2.4)) so shadow resolution isn't wasted;
    values are linear output. Monotonic; endpoint GAIN held outside the
    observed range; output clipped to [0, 1]. Input pair arrays are BGR
    (OpenCV); the returned LUT is RGB-ordered (the shipped/tuning order)."""
    lut = np.zeros((LUT_N, 3), np.float32)
    idx_lin = (np.arange(LUT_N, dtype=np.float64) / (LUT_N - 1)) ** 2.4  # index → input linear
    qs = np.linspace(0.002, 0.998, 512)
    for c in range(3):
        m = (base[:, c] > 1e-4) & (other[:, c] > 1e-4)
        xo = np.quantile(other[m, c], qs)
        xb = np.quantile(base[m, c], qs)
        xb = np.maximum.accumulate(xb)  # monotonic
        g_lo = xb[0] / max(xo[0], 1e-6)
        g_hi = xb[-1] / max(xo[-1], 1e-6)
        out = np.where(
            idx_lin < xo[0], idx_lin * g_lo,
            np.where(idx_lin > xo[-1], idx_lin * g_hi, np.interp(idx_lin, xo, xb)),
        )
        lut[:, c] = np.clip(np.maximum.accumulate(out), 0.0, 1.0)
    return lut[:, ::-1].copy()  # BGR loop order → RGB storage order


def apply_lut_linear(lin_bgr, lut):
    """Apply a (LUT_N,3) RGB-ordered LUT to a linear BGR image (proof twin of
    the player's fragment patch)."""
    idx = np.clip(lin_bgr, 0.0, 1.0) ** (1 / 2.4)
    xi = idx * (LUT_N - 1)
    out = np.empty_like(lin_bgr)
    for c_bgr, c_rgb in ((0, 2), (1, 1), (2, 0)):
        out[..., c_bgr] = np.interp(xi[..., c_bgr].ravel(), np.arange(LUT_N), lut[:, c_rgb]).reshape(xi.shape[:-1]).astype(np.float32)
    return out


def gains_from_pairs(base, other):
    """Per-channel LINEAR gain g so g*other ≈ base — median of per-pixel ratios
    over well-exposed pixels in BOTH (bounds = 12..242 in 8-bit sRGB terms,
    converted to linear)."""
    lo = float(srgb_to_linear(np.array(12, np.uint8)))
    hi = float(srgb_to_linear(np.array(242, np.uint8)))
    g = np.ones(3)
    for c in range(3):
        m = (base[:, c] > lo) & (base[:, c] < hi) & (other[:, c] > lo) & (other[:, c] < hi)
        if m.sum() < 500:
            print(f"  WARN channel {c}: only {m.sum()} usable pairs — gain left at 1")
            continue
        g[c] = float(np.median(base[m, c] / other[m, c]))
    return g


def main():
    mesh_dir = sys.argv[1]
    frame, out_dir = load_frame(sys.argv)
    os.makedirs(out_dir, exist_ok=True)
    projs, sc = MD.load_mesh(mesh_dir)
    n = len(projs)
    # Only the 2-LENS case is supported: the overlap band is the intersection
    # of ALL projections' ranges, which is wrong for single-lens multi-
    # projection meshes (Nazwa/FP: 3 strips + floor bowl never triple-
    # intersect, and cross-strip "gains" would be meaningless anyway).
    assert n == 2, f"expected a 2-camera mesh, got {n} projections — do not point this at strip meshes"
    pan_c, tilts, band = overlap_views(projs)
    print(f"{n} projections; overlap pan band [{band[0]:.1f},{band[1]:.1f}]°")

    frame_lin = srgb_to_linear(frame)  # gains are LINEAR-light (see module doc)
    base_i = n - 1  # the player's opaque base layer stays identity
    singles = [projs[i : i + 1] for i in range(n)]  # keep alive (see sample_pairs)
    pair_acc = [[] for _ in range(n)]
    for t in tilts:
        pairs = sample_pairs(frame_lin, singles, pan_c, t)
        if pairs is None:
            continue
        for i in range(n):
            pair_acc[i].append(pairs[i])
    assert pair_acc[0], "no overlap pixels found"
    cols = [np.vstack(a) for a in pair_acc]
    print(f"matched pixels: {len(cols[0])}")

    # Default = per-channel tone LUT (histogram spec): the HCT overlap shows a
    # brightness-DEPENDENT ratio (~1.8 shadows → ~1.1 highlights) no gain can
    # flatten. NOLUT=1 falls back to gains-only (older player builds).
    use_lut = os.environ.get("NOLUT") != "1"
    gains = []
    luts = []
    for i in range(n):
        if i == base_i:
            gains.append([1.0, 1.0, 1.0])
            luts.append(None)
            continue
        g_bgr = gains_from_pairs(cols[base_i], cols[i])
        # linear-domain sanity: ±0.7 stop between co-sited lenses is already a lot
        if np.any(g_bgr > 1.6) or np.any(g_bgr < 0.62):
            print(f"  WARN proj{i}: large linear gains {g_bgr} — check the frame (day/night mix?)")
        g_rgb = [round(float(g_bgr[2]), 4), round(float(g_bgr[1]), 4), round(float(g_bgr[0]), 4)]
        print(f"proj{i} vs base proj{base_i}: LINEAR RGB gains {g_rgb}"
              + (" (reference only — LUT shipped)" if use_lut else ""))
        if use_lut:
            lut = lut_from_pairs(cols[base_i], cols[i])
            luts.append(lut)
            gains.append([1.0, 1.0, 1.0])  # LUT carries the whole correction
            mids = lut[[64, 128, 192]]
            print(f"  LUT mid-curve (linear out at sRGB idx 64/128/192): {mids.round(3).tolist()}")
        else:
            luts.append(None)
            gains.append(g_rgb)

    tuning = {"colorGains": gains}
    if any(l is not None for l in luts):
        tuning["colorLuts"] = [
            None if l is None else {"size": LUT_N, "encoding": "srgb-index", "rgb": [round(float(v), 5) for v in l.reshape(-1)]}
            for l in luts
        ]
    with open(os.path.join(out_dir, "tuning.json"), "w") as f:
        json.dump(tuning, f, indent=1)
    print(f"wrote {out_dir}/tuning.json")

    # proof renders: seam view through the full mesh, before/after applying the
    # gains IN LINEAR (exactly the player's pipeline: sRGB decode → gain →
    # re-encode) to each projection's texture window (disjoint v-windows per
    # projection ⇒ gaining the window == gaining the projection)
    vwins = []
    for p in projs:
        _, _, uv = referenced_extents(p)
        vwins.append((float(uv[:, 1].min()), float(uv[:, 1].max())))
    for a in range(len(vwins)):
        for b in range(a + 1, len(vwins)):
            lo_, hi_ = sorted([vwins[a], vwins[b]])
            assert lo_[1] <= hi_[0] + 1e-6, f"v-windows overlap: {vwins} — proof gain-by-row invalid"

    def apply_gains(fr):
        g = srgb_to_linear(fr)
        th = fr.shape[0]
        for i in range(len(projs)):
            corrected = luts[i] is not None or gains[i] != [1.0, 1.0, 1.0]
            if not corrected:
                continue
            v0, v1 = vwins[i]
            r0, r1 = int(v0 * th), int(np.ceil(v1 * th))
            if luts[i] is not None:
                g[r0:r1] = apply_lut_linear(g[r0:r1], luts[i])
            else:
                bgr = np.array([gains[i][2], gains[i][1], gains[i][0]], np.float32)
                g[r0:r1] *= bgr
        return linear_to_srgb(g)

    mid_t = float(tilts[len(tilts) // 2])
    for tag, fr in [("before", frame), ("after", apply_gains(frame))]:
        img = MD.dewarp(fr, projs, pan_c, mid_t, 46.0, W=1600, H=900)
        cv2.imwrite(os.path.join(out_dir, f"seam_{tag}.jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, 92])
    print(f"proofs: {out_dir}/seam_before.jpg / seam_after.jpg")


if __name__ == "__main__":
    main()

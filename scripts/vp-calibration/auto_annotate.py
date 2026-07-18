#!/usr/bin/env python3
"""Auto-annotation: replace the hand-made *-lines.json/*-guides.json with
detected pitch paint lines + plumb verticals from the median still.

Two families, two detectors (per prior-art review 2026-07-18 — classical
first, DeepLSD as the documented fallback if a venue class defeats these):

  pitch    — white paint on grass. Tophat + green gate + connected components
             + centreline sampling: the same detector calibrate.py has run
             since 07-05 (it found kuwait's 11 auto lines), extracted here
             standalone so every consumer shares one implementation. Curved
             fisheye lines come out as centreline-sampled polylines, which is
             exactly what the great-circle straightness solve wants (segment
             detectors fragment curves and lose the long-chord constraint).

  vertical — fence posts, masts, building edges: gradient segments (FLD),
             classified by GREAT-CIRCLE PLANE NORMALS through a seed
             equidistant model (disc-anchored CX/CY/F, or the existing fit).
             Every world-vertical's ray plane contains the up axis, so all
             their normals are ⊥ up: RANSAC the axis u maximizing
             length-weighted inliers |n·u| < tol, constrained to up-ish in
             the camera frame (u_y < −0.3 — a 20–60° down-tilted mount puts
             up at strongly negative camera y, which is what excludes the
             pitch length/width families, whose axes are near-horizontal).
             A straight-line pinhole VP vote was tried first and REJECTED:
             under k1..k4 distortion the segments' support lines do not pass
             through the true nadir image (validated against the kuwait fit —
             the vote converged on a spurious above-frame cluster).
             The winning axis doubles as the GRAVITY SEED for the mount
             solve. Collinear inlier segments with adjacent endpoints are
             chained into longer polylines (building edges fragment).

Output: {SITE}-auto-lines.json, snap_lines-compatible ({lines:[{name, pts}]},
full-res px, names prefixed pitch_/vert_) + /tmp/{SITE}-auto-annotate.png
overlay for eyes-on. calibrate.py consumes it via MANUAL_LINES=; the mount
solve reads the vert_ family.

Env: SITE, SRC (default {SITE}-fisheye.jpg), SCALE_W (working width, 1920),
     GREEN_SAT (grass gate, see calibrate.py), MINLEN/MINELONG (pitch comps,
     working px), VMINLEN (vertical segment min length, working px),
     VP_TOL (px distance from the VP for inliers), VP_MIN_INLIERS.
"""
import json
import os

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.environ.get('SITE', 'kuwait')
SRC = os.environ.get('SRC', os.path.join(HERE, f'{SITE}-fisheye.jpg'))
full = cv2.imread(SRC)
if full is None:
    raise SystemExit(f'could not read {SRC}')
Hf, Wf = full.shape[:2]
SCALE_W = int(os.environ.get('SCALE_W', 1920))
s = SCALE_W / Wf
img = cv2.resize(full, (SCALE_W, int(round(Hf * s))), interpolation=cv2.INTER_AREA)
H, W = img.shape[:2]
gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)


# ── pitch paint lines: mask → skeleton → branch split → smooth polylines ─────
# calibrate.py's whole-component detector fails on connected paint (halfway +
# centre circle + touchlines form ONE plus-shaped blob that flunks the
# elongation test — observed on kuwait: the main lines were missed while the
# lit netting rim got in). Skeletonize instead, cut at junctions, keep smooth
# bright branches.
def detect_pitch_lines():
    green_sat = int(os.environ.get('GREEN_SAT', 15))
    grass_raw = cv2.inRange(hsv, (30, green_sat, 15), (95, 255, 235))
    green = cv2.dilate(grass_raw, np.ones((25, 25), np.uint8))
    top = cv2.morphologyEx(gray, cv2.MORPH_TOPHAT,
                           cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))
    mask = ((top > 15) & (green > 0)).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE,
                            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))

    minlen = float(os.environ.get('MINLEN', 68))
    minelong = float(os.environ.get('MINELONG', 4))
    # NOTE (2026-07-18): do NOT add sub-minlen fragment recovery here. It was
    # built (admit pieces >= 0.4*minlen as merge candidates, enforce the full
    # bar post-merge) and REVERTED after measurement: it recovered zero box
    # lines (their mask evidence is fat blobs / one giant merged component,
    # not clean fragments) while extending near_touch by 15 visually-on-paint
    # points that flipped SOLVE=full into a CY+120px basin the refinement's
    # +-120px bounds could not escape (mirrored mount, coverage 44%, gates
    # FAIL). The value ceiling was also measured with the HAND box lines
    # appended: marks 0.63->0.61% of span, bow/wmed unchanged — the remaining
    # error is midline_s ground non-planarity, not line coverage. See
    # benchmarks/README.md.
    grass_bright = np.median(gray[grass_raw > 0]) if (grass_raw > 0).any() else 60
    dbg = {'elong': 0, 'skel': 0, 'short': 0, 'dark': 0, 'loop': 0}
    out = []

    def centreline_sample(p):
        """calibrate.py's centreline sampler for one elongated component."""
        c = p.mean(0)
        _, _, vt = np.linalg.svd(p - c, full_matrices=False)
        proj = (p - c) @ vt[0]
        perp = (p - c) @ vt[1]
        length = proj.max() - proj.min()
        nb = max(8, int(length / 6))
        edges = np.linspace(proj.min(), proj.max(), nb + 1)
        idx = np.clip(np.digitize(proj, edges) - 1, 0, nb - 1)
        centre = []
        for b in range(nb):
            m = idx == b
            if m.sum() >= 2:
                centre.append(c + np.median(proj[m]) * vt[0]
                              + np.median(perp[m]) * vt[1])
        return np.array(centre) if len(centre) >= 6 else None

    bright_margin = float(os.environ.get('BRIGHT_MARGIN', 18))

    def bright_enough(path):
        """Paint gate, LOCAL: the centreline must be brighter than the grass
        NEXT TO IT (a global grass median fails genuine box lines in dimly lit
        pitch regions — kuwait lost all four box lines to it), and at least
        one perpendicular side must actually be grass (kills the lit netting
        at the disc rim, which is bright but hangs over black exterior)."""
        ys = np.clip(path[:, 1].astype(int), 0, H - 1)
        xs = np.clip(path[:, 0].astype(int), 0, W - 1)
        bri = np.median(gray[ys, xs])
        # perpendicular offsets from the local tangent
        d = np.gradient(path, axis=0)
        nrm = np.linalg.norm(d, axis=1, keepdims=True)
        d = d / np.maximum(nrm, 1e-9)
        perp = np.column_stack([-d[:, 1], d[:, 0]])
        side_stats = []
        for sign in (+1, -1):
            q = path + sign * 12 * perp
            qx = np.clip(q[:, 0].astype(int), 0, W - 1)
            qy = np.clip(q[:, 1].astype(int), 0, H - 1)
            side_stats.append((float((grass_raw[qy, qx] > 0).mean()),
                               float(np.median(gray[qy, qx]))))
        grass_frac = max(s[0] for s in side_stats)
        local_grass = np.median([s[1] for s in side_stats])
        return grass_frac >= 0.5 and bri >= local_grass + bright_margin

    def walk_branch(pset, start):
        path = [start]
        seen = {start}
        while True:
            x, y = path[-1]
            nxt = [(x + dx, y + dy) for dx in (-1, 0, 1) for dy in (-1, 0, 1)
                   if (dx, dy) != (0, 0) and (x + dx, y + dy) in pset
                   and (x + dx, y + dy) not in seen]
            if not nxt:
                return path
            path.append(nxt[0])
            seen.add(nxt[0])

    def split_at_turns(path, max_turn=25, step=15):
        """Split an ordered path wherever successive ~step-px chords turn more
        than max_turn deg (junction stubs, netting corners); yield the smooth
        pieces. Genuine fisheye curvature over 15px is ~1-3 deg."""
        if len(path) < 2 * step:
            yield path
            return
        cut = [0]
        for i in range(step, len(path) - step, step):
            a = path[i] - path[i - step]
            b = path[i + step] - path[i]
            na, nbv = np.linalg.norm(a), np.linalg.norm(b)
            if na > 1e-9 and nbv > 1e-9:
                cosang = np.clip(a @ b / (na * nbv), -1, 1)
                if np.degrees(np.arccos(cosang)) > max_turn:
                    cut.append(i)
        cut.append(len(path))
        for a, b in zip(cut[:-1], cut[1:]):
            yield path[a:b]

    n, lab, st, _ = cv2.connectedComponentsWithStats(mask, 8)
    for i in range(1, n):
        if st[i, cv2.CC_STAT_AREA] < 60:
            continue
        ys, xs = np.where(lab == i)
        p = np.stack([xs, ys], 1).astype(np.float64)
        psub = p[:: len(p) // 20000 + 1] if len(p) > 20000 else p
        c = psub.mean(0)
        _, _, vt = np.linalg.svd(psub - c, full_matrices=False)
        proj = (psub - c) @ vt[0]
        perp = (psub - c) @ vt[1]
        length = proj.max() - proj.min()
        width = max(perp.max() - perp.min(), 1e-6)
        if length <= minlen:
            continue
        if length / width > minelong:
            # elongated: the proven whole-component centreline path
            cl = centreline_sample(psub)
            if cl is not None and bright_enough(cl):
                out.append(cl)
                dbg['elong'] += 1
            elif cl is not None:
                dbg['dark'] += 1
            continue
        # non-elongated big structure (merged paint: halfway + circle +
        # touchlines as one plus-blob): skeletonize THIS component, cut at
        # junctions (crossing number ≥ 3 — a plain neighbour count misreads
        # diagonal staircases and shatters every curve), keep smooth pieces
        comp = (lab == i).astype(np.uint8) * 255
        skel = cv2.ximgproc.thinning(comp)
        S = (skel > 0).astype(np.uint8)
        # prune spurs BEFORE junction-cutting: every few-px offshoot creates a
        # junction that dices the main line (observed: 247 short rejects, no
        # halfway line). 12 endpoint-erosion rounds ≈ spurs ≤12px vanish.
        for _ in range(12):
            # kernel MUST be float32 — a uint8 kernel makes filter2D compute
            # garbage neighbour counts (interior=1) and the skeleton vanishes
            nbc = cv2.filter2D(S, -1, np.ones((3, 3), np.float32),
                               borderType=cv2.BORDER_CONSTANT)
            S = (S & (nbc > 2)).astype(np.uint8)  # drop degree-1 endpoints
        P = np.pad(S, 1)
        ring = [P[1 + dy:P.shape[0] - 1 + dy, 1 + dx:P.shape[1] - 1 + dx]
                for (dy, dx) in [(-1, 0), (-1, 1), (0, 1), (1, 1),
                                 (1, 0), (1, -1), (0, -1), (-1, -1)]]
        cn = np.zeros_like(S, np.uint8)
        for k in range(8):
            cn += ((ring[k] == 0) & (ring[(k + 1) % 8] == 1)).astype(np.uint8)
        branch_img = (S & (cn <= 2)).astype(np.uint8)
        ncc2, lab2 = cv2.connectedComponents(branch_img, 8)
        for j in range(1, ncc2):
            bys, bxs = np.where(lab2 == j)
            if len(bxs) < minlen * 0.8:
                dbg['short'] += 1
                continue
            pset = {(int(x), int(y)) for x, y in zip(bxs, bys)}
            deg = {q: sum(((q[0] + dx, q[1] + dy) in pset)
                          for dx in (-1, 0, 1) for dy in (-1, 0, 1)
                          if (dx, dy) != (0, 0)) for q in pset}
            ends = [q for q, d in deg.items() if d == 1]
            if not ends:
                dbg['loop'] += 1
                continue
            path = np.array(walk_branch(pset, ends[0]), np.float64)
            for piece in split_at_turns(path):
                if len(piece) < minlen * 0.8:
                    dbg['short'] += 1
                    continue
                if not bright_enough(piece):
                    dbg['dark'] += 1
                    continue
                keep = piece[::6]
                if len(keep) >= 6:
                    out.append(keep)
                    dbg['skel'] += 1

    # merge branches that continue each other across a junction cut (the
    # halfway line splits where the centre circle crosses it): endpoints
    # adjacent + tangents aligned
    merged = True
    while merged:
        merged = False
        for a in range(len(out)):
            for b in range(a + 1, len(out)):
                pa, pb = out[a], out[b]
                best = None
                for ea, ta in ((pa[0], pa[0] - pa[min(4, len(pa) - 1)]),
                               (pa[-1], pa[-1] - pa[-min(5, len(pa))])):
                    for eb, tb in ((pb[0], pb[min(4, len(pb) - 1)] - pb[0]),
                                   (pb[-1], pb[-min(5, len(pb))] - pb[-1])):
                        gap = np.linalg.norm(ea - eb)
                        if gap > 30:
                            continue
                        ta_n = ta / max(np.linalg.norm(ta), 1e-9)
                        tb_n = tb / max(np.linalg.norm(tb), 1e-9)
                        if ta_n @ tb_n < 0.966:  # tangents within 15°
                            continue
                        best = (ea, eb)
                if best is not None:
                    # orient both so they run end-of-a → start-of-b
                    ea, eb = best
                    A = pa if np.allclose(pa[-1], ea) else pa[::-1]
                    B = pb if np.allclose(pb[0], eb) else pb[::-1]
                    out[a] = np.concatenate([A, B])
                    out.pop(b)
                    merged = True
                    break
            if merged:
                break
    print(f'  pitch: {dbg}')
    return [p for p in out if len(p) >= 6]


# ── seed model for ray geometry (equidistant; disc anchor or existing fit) ───
def seed_model():
    """(F, CX, CY, ks, theta_cap, src) at WORKING scale. Priority: existing
    {SITE}-fit.json (full KB — rim segments usable to theta 100°) →
    {SITE}-disc.json (equidistant only; rim normals are garbage there, cap
    theta at 65° — the auto-fit loop re-annotates with the fitted model on
    round 2, which is when the rim verticals join) → image centre fallback."""
    try:
        fit = json.load(open(os.path.join(HERE, f'{SITE}-fit.json')))
        if 'F' in fit:
            ks = [float(fit.get(f'K{i}', 0)) for i in (1, 2, 3, 4)]
            return (fit['F'] * s, fit['CX'] * s, fit['CY'] * s, ks,
                    np.radians(100), 'fit')
    except Exception:
        pass
    try:
        d = json.load(open(os.path.join(HERE, f'{SITE}-disc.json')))
        return (d['R'] * s * 2 / np.pi, d['cx'] * s, d['cy'] * s,
                [0, 0, 0, 0], np.radians(65), 'disc')
    except Exception:
        pass
    return 0.29 * W, W / 2, H / 2, [0, 0, 0, 0], np.radians(65), 'centre'


def _rays(px, F, cx, cy, ks):
    """Working-scale pixels (N,2) → (unit rays, theta). Full KB inversion via
    fisheye_model.unproject (bisection; valid past 90°)."""
    from fisheye_model import unproject
    d, ok = unproject(np.asarray(px, np.float64), F, cx, cy, ks)
    th = np.arccos(np.clip(d[:, 2], -1, 1))
    th[~ok] = np.pi  # force past any theta cap
    return d, th


# ── plumb verticals: FLD segments + up-axis RANSAC on plane normals ──────────
def detect_vertical_lines():
    vminlen = float(os.environ.get('VMINLEN', 26))
    # do_merge=False: FLD's merge is O(n^2) and the fence netting at these
    # venues yields thousands of segments (observed: minutes-long hang). Our
    # own VP-gated chaining below does the merging on the ~dozens that matter.
    fld = cv2.ximgproc.createFastLineDetector(
        length_threshold=int(vminlen), distance_threshold=1.41,
        canny_th1=60, canny_th2=160, canny_aperture_size=3, do_merge=False)
    segs = fld.detect(gray)
    if segs is None or len(segs) == 0:
        return [], None, []
    segs = segs.reshape(-1, 4).astype(np.float64)
    # cap the pool: keep the longest segments (the signal — posts, masts,
    # building edges — is long; netting noise is short)
    if len(segs) > 1200:
        L = np.hypot(segs[:, 2] - segs[:, 0], segs[:, 3] - segs[:, 1])
        segs = segs[np.argsort(-L)[:1200]]

    # candidate gate: broadly downward segments (a 20-60deg down-tilted mount
    # images world verticals within ~±60deg of image-vertical everywhere we
    # have ever seen; this only prunes the RANSAC pool, the axis vote decides)
    dx = segs[:, 2] - segs[:, 0]
    dy = segs[:, 3] - segs[:, 1]
    ang = np.abs(np.degrees(np.arctan2(dx, dy)))  # 0 = image-vertical
    ang = np.minimum(ang, 180 - ang)
    cand = segs[ang < 60]
    if len(cand) < 4:
        return [], None, []

    # OFF-GRASS gate — the discriminator that makes the axis vote identifiable.
    # For a down-tilted camera BOTH world-up and the away-running horizontal
    # ground direction land at strongly negative camera-y, and the ground
    # family (box lines, touchline segments running away from camera) is
    # longer and more numerous, so it wins the vote (observed: the first run
    # converged 88° off up, exactly on the pitch-width axis). True verticals —
    # posts, masts, building edges — stand OFF the grass.
    green_sat = int(os.environ.get('GREEN_SAT', 15))
    grass = cv2.dilate(cv2.inRange(hsv, (30, green_sat, 15), (95, 255, 235)),
                       np.ones((9, 9), np.uint8)) > 0
    keep = []
    for sg in cand:
        n = max(4, int(np.hypot(sg[2] - sg[0], sg[3] - sg[1]) / 6))
        t = np.linspace(0, 1, n)
        xs = np.clip((sg[0] + t * (sg[2] - sg[0])).astype(int), 0, W - 1)
        ys = np.clip((sg[1] + t * (sg[3] - sg[1])).astype(int), 0, H - 1)
        keep.append(grass[ys, xs].mean() < 0.3)
    cand = cand[np.array(keep)]
    if len(cand) < 4:
        return [], None, []

    F0, cx0, cy0, ks0, th_cap, seed_src = seed_model()
    r1, th1 = _rays(cand[:, 0:2], F0, cx0, cy0, ks0)
    r2, th2 = _rays(cand[:, 2:4], F0, cx0, cy0, ks0)
    normals = np.cross(r1, r2)
    nn = np.linalg.norm(normals, axis=1)
    ok = (nn > 1e-9) & (th1 < th_cap) & (th2 < th_cap)
    cand, normals, nn = cand[ok], normals[ok] / nn[ok, None], nn[ok]
    if len(cand) < 4:
        return [], None, []
    lens = np.hypot(cand[:, 2] - cand[:, 0], cand[:, 3] - cand[:, 1])

    tol = np.sin(np.radians(float(os.environ.get('AXIS_TOL_DEG', 2.5))))
    rng = np.random.default_rng(0)
    mids = 0.5 * (cand[:, 0:2] + cand[:, 2:4])
    cell = np.clip((mids / [W / 8, H / 6]).astype(int), 0, [7, 5])
    cell_id = cell[:, 0] * 6 + cell[:, 1]

    def axis_score(inl):
        """Dispersion-weighted: sqrt of per-cell length sums, summed over an
        8x6 grid. A local pencil (floodlight glare fan, netting corner fan —
        every concurrent bundle votes like a line family) saturates its one
        cell; posts and building edges spread across the scene win."""
        sc = 0.0
        for cid in np.unique(cell_id[inl]):
            sc += np.sqrt(lens[inl][cell_id[inl] == cid].sum())
        return sc

    best = None
    for _ in range(4000):
        i, j = rng.choice(len(normals), 2, replace=False)
        u = np.cross(normals[i], normals[j])
        n = np.linalg.norm(u)
        if n < 1e-6:
            continue
        u = u / n
        if u[1] > 0:
            u = -u
        # PHYSICAL PRIOR BOX — up in the camera frame for a roughly-level
        # (|roll| ≤ 20°) mount tilted down 20-60°:
        #   up_cam = Rz(roll)·Rx(tilt) @ (0,-1,0)
        #          = (sin r · cos t, −cos r · cos t, −sin t)
        # so u_z ∈ [−0.87,−0.34] (NEGATIVE — the first runs' +z winners were
        # horizontal ground families and glare pencils), |u_x| ≤ 0.35,
        # u_y ≤ −0.45.
        if u[2] > -0.25 or abs(u[0]) > 0.35 or u[1] > -0.45:
            continue
        inl = np.abs(normals @ u) < tol
        score = axis_score(inl)
        if best is None or score > best[0]:
            best = (score, u, inl)
    if best is None or best[2].sum() < int(os.environ.get('VP_MIN_INLIERS', 6)):
        return [], None, []
    _, up_cam, inl = best
    # least-squares refine on inliers: up = smallest right singular vector of
    # the (length-weighted) inlier normal matrix
    Wn = normals[inl] * np.sqrt(lens[inl])[:, None]
    _, _, Vt = np.linalg.svd(Wn, full_matrices=False)
    up_ref = Vt[-1]
    if up_ref[1] > 0:
        up_ref = -up_ref
    inl = np.abs(normals @ up_ref) < tol
    up_cam = up_ref
    kept = cand[inl]
    klen = lens[inl]
    print(f'  up-axis (camera frame, seed={seed_src}): '
          f'[{up_cam[0]:+.3f},{up_cam[1]:+.3f},{up_cam[2]:+.3f}] '
          f'{inl.sum()} inlier segments')

    # chain collinear VP-consistent fragments (building edges fragment):
    # two segments chain when their support directions agree and the gap
    # between nearest endpoints is small and along the shared direction.
    order = np.argsort(-klen)
    kept = kept[order]
    used = np.zeros(len(kept), bool)
    chains = []
    for i in range(len(kept)):
        if used[i]:
            continue
        chain = [kept[i]]
        used[i] = True
        grew = True
        while grew:
            grew = False
            pts = np.array([[p for sg in chain for p in ((sg[0], sg[1]),
                                                         (sg[2], sg[3]))]])[0]
            c = pts.mean(0)
            _, _, vt = np.linalg.svd(pts - c, full_matrices=False)
            d0 = vt[0]
            proj = (pts - c) @ d0
            lo, hi = proj.min(), proj.max()
            for j in range(len(kept)):
                if used[j]:
                    continue
                sj = kept[j]
                dj = np.array([sj[2] - sj[0], sj[3] - sj[1]])
                dj = dj / np.linalg.norm(dj)
                if abs(dj @ d0) < 0.985:
                    continue
                pj = np.array([[sj[0], sj[1]], [sj[2], sj[3]]])
                perp = np.abs((pj - c) @ vt[1])
                if perp.max() > 6:
                    continue
                pr = (pj - c) @ d0
                gap = max(lo - pr.max(), pr.min() - hi)
                if gap > 0.6 * (hi - lo) + 20:
                    continue
                chain.append(sj)
                used[j] = True
                grew = True
        chains.append(chain)

    # sample each chain as a polyline (points along each member segment)
    out = []
    for chain in chains:
        pts = []
        for sg in chain:
            n = max(4, int(np.hypot(sg[2] - sg[0], sg[3] - sg[1]) / 8))
            for t in np.linspace(0, 1, n):
                pts.append((sg[0] + t * (sg[2] - sg[0]),
                            sg[1] + t * (sg[3] - sg[1])))
        pts = np.array(sorted(pts, key=lambda p: p[1]))
        span = np.hypot(*(pts[-1] - pts[0]))
        if len(pts) >= 6 and span >= vminlen:
            out.append(pts)
    return out, up_cam, kept


import time as _time
_t = _time.time()
pitch = detect_pitch_lines()
print(f'pitch detect {_time.time()-_t:.1f}s ({len(pitch)} lines)')
_t = _time.time()
verts, up_cam, vsegs = detect_vertical_lines()
print(f'vertical detect {_time.time()-_t:.1f}s ({len(verts)} chains)')

viz = img.copy()
lines_out = []
for i, pts in enumerate(pitch):
    lines_out.append({'name': f'pitch_{i}', 'family': 'pitch',
                      'pts': (pts / s).tolist()})
    for (x, y) in pts.astype(int):
        cv2.circle(viz, (int(x), int(y)), 2, (0, 0, 255), -1)
for i, pts in enumerate(verts):
    lines_out.append({'name': f'vert_{i}', 'family': 'vertical',
                      'pts': (pts / s).tolist()})
    for (x, y) in pts.astype(int):
        cv2.circle(viz, (int(x), int(y)), 2, (0, 255, 255), -1)
cv2.imwrite(f'/tmp/{SITE}-auto-annotate.png', viz)

out_path = os.path.join(HERE, f'{SITE}-auto-lines.json')
json.dump({'lines': lines_out,
           'up_axis_camera': None if up_cam is None else
           [float(v) for v in up_cam],
           'source': os.path.basename(SRC)}, open(out_path, 'w'), indent=1)
print(f'{len(pitch)} pitch lines, {len(verts)} vertical chains'
      + ('' if up_cam is None else ', up axis found'))
print(f'→ {out_path} ; overlay /tmp/{SITE}-auto-annotate.png')

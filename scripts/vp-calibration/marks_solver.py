"""Python twin of src/lib/panorama/pitch-solver.ts — score admin pitch marks
through a generated mesh. Same algorithm end to end: raw-frame mark px → world
ray via barycentric interpolation over the mesh's triangle-referenced UVs, then
a Hartley-normalized DLT homography (pitch metres → ray direction) whose
per-mark angular residual is expressed in raw-frame px via the local mesh
px-per-radian scale. Port validated against the stored server-side result
(kuwait-marks.json storedReprojectionErrorPx).

Marks json shape (kuwait-marks.json): {marks: [{name, uv:[x,y]}...], lengthM,
widthM, frameWidth, frameHeight}. Mark world points follow pitch-marks.ts:
origin corner_nw, +x toward corner_ne (length), +y toward corner_sw (width),
midline_n/s at x = length/2.

Only triangle-referenced vertices are read — culled vertices remain in
vertices.bin with garbage values (the standing mesh invariant), and triangles
are triples WITHIN each projection's n_indices block (Spiideo meshes can carry
ragged blocks).
"""
import json
import os

import numpy as np

MOUNT_S = np.array([[0, -0.218849, 0.975731],
                    [-1.000013, 0, 0],
                    [0, -0.975762, -0.218884]], np.float64)

MARK_WORLD = {
    'corner_nw': lambda L, W: (0.0, 0.0),
    'corner_ne': lambda L, W: (L, 0.0),
    'corner_se': lambda L, W: (L, W),
    'corner_sw': lambda L, W: (0.0, W),
    'midline_n': lambda L, W: (L / 2, 0.0),
    'midline_s': lambda L, W: (L / 2, W),
}


def load_mesh(mesh_dir):
    """scene.json + vertices.bin + indices.bin → triangle-level geometry."""
    scene = json.load(open(os.path.join(mesh_dir, 'scene.json')))
    verts = np.fromfile(os.path.join(mesh_dir, 'vertices.bin'),
                        np.float32).reshape(-1, 5).astype(np.float64)
    indices = np.fromfile(os.path.join(mesh_dir, 'indices.bin'), np.uint32)
    tris, tri_proj, tex_to_world = [], [], []
    base = 0
    for pi, p in enumerate(scene['projections']):
        R = np.array(p['camera']['rotation'], np.float64).reshape(3, 3)
        tex_to_world.append((R @ MOUNT_S).T)
        span = p['n_indices'] // 3
        for t in range(span):
            s = base + t * 3
            if s + 2 >= len(indices):
                break
            tris.append(indices[s:s + 3])
            tri_proj.append(pi)
        base += p['n_indices']
    return {'verts': verts, 'tris': np.array(tris, np.int64),
            'tri_proj': np.array(tri_proj, np.int64),
            'tex_to_world': np.array(tex_to_world)}


def _tri_rays(mesh, t):
    """Unit world rays of triangle t's three vertices (3,3) + their uv (3,2)."""
    v = mesh['verts'][mesh['tris'][t]]
    tw = mesh['tex_to_world'][mesh['tri_proj'][t]]
    g = np.column_stack([v[:, 0], v[:, 1], np.ones(3)])
    r = (tw @ g.T).T
    return r / np.linalg.norm(r, axis=1, keepdims=True), v[:, 2:4]


def uv_to_ray(mesh, x_px, y_px, frame_w, frame_h):
    """Raw-frame pixel → (unit world ray, px_per_radian) or None outside
    coverage. Vectorized point-in-triangle over the whole mesh, first hit wins
    (matches the TS scan order)."""
    u, v = x_px / frame_w, y_px / frame_h
    verts, tris = mesh['verts'], mesh['tris']
    ua, ub, uc = (verts[tris[:, k], 2] for k in range(3))
    va, vb, vc = (verts[tris[:, k], 3] for k in range(3))
    d = (vb - vc) * (ua - uc) + (uc - ub) * (va - vc)
    with np.errstate(divide='ignore', invalid='ignore'):
        w0 = ((vb - vc) * (u - uc) + (uc - ub) * (v - vc)) / d
        w1 = ((vc - va) * (u - uc) + (ua - uc) * (v - vc)) / d
    w2 = 1.0 - w0 - w1
    eps = -1e-6
    hit = (np.abs(d) >= 1e-12) & (w0 >= eps) & (w1 >= eps) & (w2 >= eps)
    idx = np.nonzero(hit)[0]
    if len(idx) == 0:
        return None
    t = idx[0]
    rays, uvs = _tri_rays(mesh, t)
    w = np.array([w0[t], w1[t], w2[t]])
    tw = mesh['tex_to_world'][mesh['tri_proj'][t]]
    vv = mesh['verts'][mesh['tris'][t]]
    f0 = float(w @ vv[:, 0])
    f1 = float(w @ vv[:, 1])
    ray = tw @ np.array([f0, f1, 1.0])
    n = np.linalg.norm(ray)
    if not n > 0:
        return None

    def edge_scale(i, j):
        ang = np.arccos(min(1.0, abs(float(rays[i] @ rays[j]))))
        px = np.hypot((uvs[i, 0] - uvs[j, 0]) * frame_w,
                      (uvs[i, 1] - uvs[j, 1]) * frame_h)
        return px / ang if ang > 1e-9 else 0.0

    return ray / n, max(edge_scale(0, 1), edge_scale(0, 2))


def ray_dlt_homography(world, rays):
    """Hartley-normalized DLT: pitch metres (X,Y,1) → unit ray direction.
    `world` (N,2) pitch coords, `rays` (N,3) unit rays. Returns H (3,3).
    Shared by solve_marks (mesh rays), auto_fit's joint refinement + marks
    mount (fit rays), and gates.py GATE F — one implementation so the mount
    solve and its consumers cannot drift."""
    world = np.asarray(world, np.float64)
    rays = np.asarray(rays, np.float64)
    c = world.mean(axis=0)
    mean_dist = np.mean(np.linalg.norm(world - c, axis=1))
    s = np.sqrt(2) / mean_dist if mean_dist > 0 else 1.0
    wn = (world - c) * s
    A = []
    for (X, Y), (rx, ry, rz) in zip(wn, rays):
        p = np.array([X, Y, 1.0])
        A.append(np.concatenate([np.zeros(3), -rz * p, ry * p]))
        A.append(np.concatenate([rz * p, np.zeros(3), -rx * p]))
        A.append(np.concatenate([-ry * p, rx * p, np.zeros(3)]))
    _, _, Vt = np.linalg.svd(np.array(A))
    Hn = Vt[-1].reshape(3, 3)
    T = np.array([[s, 0, -s * c[0]], [0, s, -s * c[1]], [0, 0, 1.0]])
    return Hn @ T


def solve_marks(mesh, marks, length_m, width_m, frame_w, frame_h):
    """DLT pitch-metric→ray homography + per-mark reprojection error.
    Returns dict with homography, per_mark_err_px/rad, reprojection_error_px,
    span_px (longest pairwise corner distance in raw px — the normalizer for
    the benchmark's %-of-pitch-span currency)."""
    rays, world, scales, names = [], [], [], []
    for m in marks:
        hit = uv_to_ray(mesh, m['uv'][0], m['uv'][1], frame_w, frame_h)
        if hit is None:
            raise ValueError(f"mark {m['name']} outside mesh coverage")
        rays.append(hit[0])
        scales.append(hit[1])
        world.append(MARK_WORLD[m['name']](length_m, width_m))
        names.append(m['name'])
    rays = np.array(rays)
    world = np.array(world)
    if len(rays) < 4:
        raise ValueError('need at least 4 marks')

    H = ray_dlt_homography(world, rays)

    per_px, per_rad = {}, {}
    for i, name in enumerate(names):
        pred = H @ np.array([world[i, 0], world[i, 1], 1.0])
        n = np.linalg.norm(pred)
        dot = abs(float(pred @ rays[i])) / (n or 1.0)
        err = float(np.arccos(min(1.0, dot)))
        per_rad[name] = err
        per_px[name] = err * scales[i]

    corners = [m['uv'] for m in marks if m['name'].startswith('corner')]
    span = 0.0
    for i in range(len(corners)):
        for j in range(i + 1, len(corners)):
            span = max(span, float(np.hypot(corners[i][0] - corners[j][0],
                                            corners[i][1] - corners[j][1])))
    return {'homography': H, 'per_mark_err_px': per_px,
            'per_mark_err_rad': per_rad,
            'reprojection_error_px': max(per_px.values()),
            'span_px': span}


def score_marks_file(marks_path, mesh_dir):
    mj = json.load(open(marks_path))
    mesh = load_mesh(mesh_dir)
    return solve_marks(mesh, mj['marks'], float(mj['lengthM']),
                       float(mj['widthM']), int(mj['frameWidth']),
                       int(mj['frameHeight'])), mj

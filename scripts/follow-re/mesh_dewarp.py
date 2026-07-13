"""Mesh-based dewarp — replicate Spiideo's EXACT calibration (VirtualPanoramaPlayer.tsx
::buildExactPanorama) so the WHOLE pitch flattens, not just the centre. Our fisheye
fit (single K1) curves at large pan because the real VP is TWO projections with
independent rotations + a fixed mount tilt — a single radial lens can't represent it.

Approach (per specialists): render the mesh once per view with frag colour = source
(u,v) → read back → that IS a cv2.remap map1/map2. Then cv2.remap the raw frame.
Mesh accuracy at fisheye-path speed; drops into render_follow_compare's dewarp_maps.

Vertex float layout (buildExactPanorama, NOT the header's [x,y,z,u,v]):
  f0,f1 = image-plane coord   f2,f3 = source texture UV   f4 = seam-blend alpha
World pos = transpose(R·S)·(f0,f1,1);  R = per-projection rotation, S = MOUNT_S.

  python3 mesh_dewarp.py <mesh_dir> <raw_frame.png> --pan <deg> --tilt <deg> --fov <deg>
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
import cv2
import moderngl

# Sensor-mount tilt, verbatim from VirtualPanoramaPlayer.tsx MOUNT_S (356-360).
MOUNT_S = np.array([[0.0, -0.218849, 0.975731],
                    [-1.000013, 0.0, 0.0],
                    [0.0, -0.975762, -0.218884]], np.float64)

_CTX = None
_UV_MAPS: dict = {}


def ctx():
    global _CTX
    if _CTX is None:
        _CTX = moderngl.create_standalone_context()
    return _CTX


def load_mesh(mesh_dir: str):
    sc = json.load(open(f"{mesh_dir}/scene.json"))
    V = np.frombuffer(open(f"{mesh_dir}/vertices.bin", "rb").read(), np.float32).reshape(-1, 5)
    I = np.frombuffer(open(f"{mesh_dir}/indices.bin", "rb").read(), np.uint32)
    projs = []
    voff = ioff = 0
    for p in sc["projections"]:
        nv, ni = p["n_vertices"], p["n_indices"]
        vv = V[voff:voff + nv]
        R = np.array(p["camera"]["rotation"], np.float64).reshape(3, 3)
        tw = (R @ MOUNT_S).T                                   # textureToWorld = transpose(R·S)
        img = np.column_stack([vv[:, 0], vv[:, 1], np.ones(nv)])  # (f0,f1,1)
        world = (tw @ img.T).T.astype("f4")                    # Nx3
        uv = vv[:, 2:4].astype("f4")
        tris = I[ioff:ioff + ni].astype(np.int64) - voff        # global → local rebase
        t3 = tris[:len(tris) - len(tris) % 3].reshape(-1, 3)    # Spiideo meshes can have ni % 3 != 0 — iterate triples tolerantly like the TSX
        keep = np.all((t3 >= 0) & (t3 < nv), axis=1)            # drop out-of-range (TSX 492-500)
        projs.append(dict(world=world, uv=uv, tris=t3[keep].reshape(-1).astype("i4")))
        voff += nv; ioff += ni
    return projs, sc


def camera_basis(pan, tilt):
    """Camera axes for the follow view. forward/right/up canonical (TSX 518-520),
    oriented by pan (about up) then tilt (about the panned right)."""
    def rot(v, axis, a):
        axis = axis / np.linalg.norm(axis); c, s = np.cos(a), np.sin(a)
        return v * c + np.cross(axis, v) * s + axis * (axis @ v) * (1 - c)
    fwd, right, up = np.array([0, 0, 1.]), np.array([1, 0, 0.]), np.array([0, -1, 0.])
    d = rot(fwd, up, pan); rn = rot(right, up, pan); d = rot(d, rn, tilt)   # orient (TSX 1112-1118)
    # right = cross(z, up) → (1,0,0) at pan 0, matching Spiideo's captured projectionMatrix
    # (x_ndc = ray.x/ray.z, scale +1, NOT mirrored). up' = cross(x, z) keeps vertical.
    z = d / np.linalg.norm(d)
    x = np.cross(z, up); x /= np.linalg.norm(x)
    y = np.cross(x, z); y /= np.linalg.norm(y)
    return x.astype("f4"), y.astype("f4"), z.astype("f4")


# PINHOLE projection of the world RAY (Spiideo's shader: gl_Position = proj·coord.xyzz,
# i.e. divide by the ray's own camera-frame z). Rotating the ray into the camera frame
# then dividing by its z is the true undistort; a standard perspective matrix on the ray
# as a w=1 point leaves a residual bow. See VirtualPanoramaPlayer.tsx 341-342.
VS = ("#version 330\nuniform vec3 cx;uniform vec3 cy;uniform vec3 cz;uniform float focal;uniform float asp;\n"
      "in vec3 w;in vec2 uv;out vec2 vuv;\n"
      "void main(){vuv=uv;float dx=dot(w,cx),dy=dot(w,cy),dz=dot(w,cz);"
      "gl_Position=vec4(focal/asp*dx, focal*dy, dz*0.5, dz);}")
FS = "#version 330\nin vec2 vuv;\nout vec4 f;\nvoid main(){f=vec4(vuv,0.0,1.0);}"   # encode UV in RG


_PROG = None
_FBO: dict = {}          # (W,H) -> (tex, fbo)
_VAOS: dict = {}         # id(projs) -> [vertex_array,...]  (static geometry, built once)


def _program():
    """One shared shader program — compiling a new one per call leaks GL variants
    ('exceeded compiled variants footprint') and crashes after a few thousand bakes."""
    global _PROG
    if _PROG is None:
        _PROG = ctx().program(vertex_shader=VS, fragment_shader=FS)
    return _PROG


def _fbo(W, H):
    m = _FBO.get((W, H))
    if m is None:
        c = ctx(); tex = c.texture((W, H), 4, dtype="f4")
        m = (tex, c.framebuffer(color_attachments=[tex])); _FBO[(W, H)] = m
    return m[1]


def _vaos(projs):
    """Per-projection VBO/IBO/VAO built ONCE (mesh geometry is static) and reused."""
    key = id(projs)
    v = _VAOS.get(key)
    if v is None:
        c = ctx(); prog = _program(); v = []
        for p in projs:
            inter = np.hstack([p["world"], p["uv"]]).astype("f4")
            vbo = c.buffer(inter.tobytes()); ibo = c.buffer(p["tris"].tobytes())
            v.append(c.vertex_array(prog, [(vbo, "3f 2f", "w", "uv")], ibo))
        _VAOS[key] = v
    return v


def bake_uv_map(projs, pan, tilt, fov, W, H, aspect=16 / 9):
    """Render the mesh → per-output-pixel source (u,v). Returns normalized u,v (−1 where no mesh).
    Reuses a cached program/framebuffer/geometry so it can be called millions of times."""
    c = ctx()
    prog = _program()
    x, y, z = camera_basis(pan, tilt)
    prog["cx"].value = tuple(map(float, x)); prog["cy"].value = tuple(map(float, y)); prog["cz"].value = tuple(map(float, z))
    prog["focal"].value = float(1 / np.tan(np.radians(fov) / 2)); prog["asp"].value = float(aspect)
    fbo = _fbo(W, H); fbo.use()
    c.clear(-1.0, -1.0, 0.0, 0.0)                               # -1 sentinel = no mesh
    c.disable(moderngl.CULL_FACE)                              # DoubleSide
    for vao in _vaos(projs):
        vao.render()
    data = np.frombuffer(fbo.read(components=4, dtype="f4"), "f4").reshape(H, W, 4)
    data = np.flipud(data)                                      # glReadPixels bottom-row-first
    return data[:, :, 0], data[:, :, 1]                         # normalized u,v (and −1 where no mesh)


def dewarp(frame, projs, pan, tilt, fov, W=1280, H=720):
    u, v = bake_uv_map(projs, pan, tilt, fov, W, H)
    th, tw = frame.shape[:2]
    m1 = (u * tw).astype("f4"); m2 = (v * th).astype("f4")
    m1[u < 0] = -1; m2[u < 0] = -1                              # borders where no mesh
    return cv2.remap(frame, m1, m2, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)


def main():
    md, framep = sys.argv[1], sys.argv[2]
    a = sys.argv
    pan = np.radians(float(a[a.index("--pan") + 1])) if "--pan" in a else 0.0
    tilt = np.radians(float(a[a.index("--tilt") + 1])) if "--tilt" in a else -0.35
    fov = float(a[a.index("--fov") + 1]) if "--fov" in a else 38.0
    out = a[a.index("--out") + 1] if "--out" in a else "/tmp/follow-pair/mesh_dewarp_out.png"
    projs, sc = load_mesh(md)
    print(f"loaded {len(projs)} projections, {sum(len(p['tris'])//3 for p in projs)} triangles")
    frame = cv2.imread(framep)
    o = dewarp(frame, projs, pan, tilt, fov)
    cv2.imwrite(out, o)
    print(f"wrote {out}  (pan={np.degrees(pan):.0f}° tilt={np.degrees(tilt):.0f}° fov={fov:.0f}°)")


if __name__ == "__main__":
    main()

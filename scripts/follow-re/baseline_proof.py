"""LAYER-0 CERTIFICATION ARTIFACT — is our flatten (mesh/calibration/dewarp) visually
indistinguishable from Spiideo's render? The judge is the USER, not a metric.

Method (hard lessons baked in):
  - Framing locked under TRANSLATION-ONLY alignment (similarity is EXACTLY degenerate with
    camera fov=scale and roll=rotation — it can hide them; translation-only cannot).
  - Our renderer runs EXACTLY as production (no roll DOF): a convention gap must SHOW.
  - Residual pointing offset folded into pan/tilt via a NUMERICAL Jacobian (render +0.5deg,
    measure the response) — no sign conventions trusted.
  - 6 moments spanning the full pan range (both goals + midfield).

Artifacts (judge-ready): /tmp/imitation/baseline_proof/
  proof_sheet.png  — per moment: hard-seam split | their-edges-on-ours | diff heatmap
  flicker.mp4      — ours/theirs alternating, exposure-matched. Swimming lines = geometry gap.

  python3 baseline_proof.py           (CLIP=b923d40f default)
"""
from __future__ import annotations
import json, os, glob
import numpy as np
import cv2
from scipy.optimize import minimize
from scipy.spatial import cKDTree
import mesh_dewarp as MD

G8 = os.environ.get("CLIP", "b923d40f")
CLIPS = {"b923d40f": 900, "d9fee1fc": 677}
WOFF = CLIPS[G8]
RAW = glob.glob(f"/tmp/follow-pair/raw_{G8}*_s{WOFF}.mp4")[0]
PLAY = glob.glob(f"/tmp/follow-pair/play_{G8}*_s{WOFF}.mp4")[0]
REG = f"/tmp/imitation/reg_{G8}.json"
OUT = "/tmp/imitation/baseline_proof"
PW, PH = 960, 540
projs, _ = MD.load_mesh("/tmp/follow-pair/mesh")
sift = cv2.SIFT_create(5000); bf = cv2.BFMatcher()
UV = np.vstack([p["uv"] for p in projs]); WORLD = np.vstack([p["world"] for p in projs])
RAYN = WORLD[:, :2] / WORLD[:, 2:3]; uv_tree = cKDTree(UV)


def uv_to_pantilt(u, v):
    rn = RAYN[uv_tree.query([[u, v]])[1][0]]
    x, y = float(rn[0]), float(rn[1]); n = np.sqrt(x * x + y * y + 1)
    return np.degrees(np.arctan2(-x, 1)), np.degrees(-np.arcsin(y / n))


def render(rawf, pan, tilt, fov):
    u, v = MD.bake_uv_map(projs, np.radians(pan), np.radians(tilt), fov, PW, PH)
    th, tw = rawf.shape[:2]
    m1 = (u * tw).astype("f4"); m2 = (v * th).astype("f4"); m1[u < 0] = -1; m2[u < 0] = -1
    return cv2.remap(rawf, m1, m2, cv2.INTER_LINEAR)


def expmatch(our, ref):
    """channel-wise mean/std match ours->theirs so the judge sees GEOMETRY, not color grade."""
    o = our.astype(np.float32); r = ref.astype(np.float32)
    for c in range(3):
        om, osd = o[:, :, c].mean(), o[:, :, c].std() + 1e-6
        rm, rsd = r[:, :, c].mean(), r[:, :, c].std() + 1e-6
        o[:, :, c] = (o[:, :, c] - om) * (rsd / osd) + rm
    return np.clip(o, 0, 255).astype(np.uint8)


def main():
    os.makedirs(OUT, exist_ok=True)
    reg = json.load(open(REG))
    rt = np.array(reg["t"]); rpx = np.array(reg["pano_x"]); rpy = np.array(reg["pano_y"]); fw = np.array(reg["footw"])
    order = np.argsort(rpx)
    picks = [order[2], order[len(order)//5], order[2*len(order)//5], order[3*len(order)//5],
             order[4*len(order)//5], order[-3]]
    capr = cv2.VideoCapture(RAW); capp = cv2.VideoCapture(PLAY)
    vw = cv2.VideoWriter(f"{OUT}/flicker.mp4", cv2.VideoWriter_fourcc(*"mp4v"), 3, (PW, PH + 40))
    print(f"{G8}: 6 moments across pan range (pano_x {rpx[picks].round(2)})")
    sheet = []
    for i in picks:
        t = float(rt[i])
        capr.set(cv2.CAP_PROP_POS_MSEC, t * 1000); okr, rawf = capr.read()
        capp.set(cv2.CAP_PROP_POS_MSEC, t * 1000); okp, playf = capp.read()
        if not (okr and okp):
            continue
        theirs = cv2.resize(playf, (PW, PH))
        k2, d2 = sift.detectAndCompute(cv2.cvtColor(theirs, cv2.COLOR_BGR2GRAY), None)

        def matches(im):
            kk1, dd1 = sift.detectAndCompute(cv2.cvtColor(im, cv2.COLOR_BGR2GRAY), None)
            if dd1 is None:
                return None, None
            good = [a for a, b in bf.knnMatch(dd1, d2, k=2) if a.distance < 0.8 * b.distance]
            if len(good) < 15:
                return None, None
            src = np.float32([kk1[m_.queryIdx].pt for m_ in good])
            dst = np.float32([k2[m_.trainIdx].pt for m_ in good])
            return src, dst

        def med_shift(im):
            src, dst = matches(im)
            if src is None:
                return None
            dvec = dst - src; t0 = np.median(dvec, axis=0)
            e = np.linalg.norm(dvec - t0, axis=1); inl = e < 12
            if inl.sum() < 10:
                return None
            return np.median(dvec[inl], axis=0)

        def resid_trans(x):
            src, dst = matches(render(rawf, x[0], x[1], x[2]))
            if src is None:
                return 1e3
            dvec = dst - src; t0 = np.median(dvec, axis=0)
            e = np.linalg.norm(dvec - t0, axis=1); inl = e < 12
            if inl.sum() < 15:
                return 1e3
            t0 = np.median(dvec[inl], axis=0)
            return float(np.median(np.linalg.norm(dvec[inl] - t0, axis=1)))

        pan0, tilt0 = uv_to_pantilt(rpx[i], rpy[i])
        fov0 = float(np.clip(fw[i] * 95.0, 18, 50))
        x0 = np.array([pan0, tilt0, fov0])
        S = np.array([x0, x0 + [2, 0, 0], x0 + [0, 2, 0], x0 + [0, 0, 4]])
        res = minimize(resid_trans, x0, method="Nelder-Mead",
                       options=dict(initial_simplex=S, maxiter=250, xatol=0.02, fatol=0.02))
        pan, tilt, fov = res.x
        ours = render(rawf, pan, tilt, fov)

        # numerical-Jacobian pointing fold (sign-convention-proof)
        sh0 = med_shift(ours)
        if sh0 is not None and (abs(sh0[0]) >= 1.0 or abs(sh0[1]) >= 1.0):
            shp = med_shift(render(rawf, pan + 0.5, tilt, fov))
            sht = med_shift(render(rawf, pan, tilt + 0.5, fov))
            if shp is not None and sht is not None:
                J = np.column_stack([(shp - sh0) / 0.5, (sht - sh0) / 0.5])
                try:
                    d = np.linalg.solve(J, -sh0)
                    if np.all(np.abs(d) < 8):
                        pan += float(d[0]); tilt += float(d[1])
                        ours = render(rawf, pan, tilt, fov)
                except np.linalg.LinAlgError:
                    pass
        # last polish: pure translation with replicated border (no black bands)
        sh = med_shift(ours)
        if sh is not None and (abs(sh[0]) >= 0.5 or abs(sh[1]) >= 0.5):
            M2 = np.float32([[1, 0, sh[0]], [0, 1, sh[1]]])
            ours = cv2.warpAffine(ours, M2, (PW, PH), borderMode=cv2.BORDER_REPLICATE)
        r = resid_trans([pan, tilt, fov])
        ours_m = expmatch(ours, theirs)
        print(f"  t={t:5.1f}s pano_x={rpx[i]:.2f} pan={pan:+.1f} tilt={tilt:+.1f} fov={fov:.1f} "
              f"translation-only residual={r:.2f}px")

        split = theirs.copy(); split[:, :PW//2] = ours_m[:, :PW//2]
        cv2.line(split, (PW//2, 0), (PW//2, PH), (0, 255, 255), 1)
        cv2.putText(split, "OURS", (PW//4 - 40, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 255, 0), 2)
        cv2.putText(split, "SPIIDEO", (3*PW//4 - 70, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (200, 200, 200), 2)
        ed = cv2.Canny(cv2.cvtColor(theirs, cv2.COLOR_BGR2GRAY), 60, 140)
        ov = ours_m.copy(); ov[ed > 0] = (0, 0, 255)
        diff = cv2.absdiff(cv2.cvtColor(ours_m, cv2.COLOR_BGR2GRAY), cv2.cvtColor(theirs, cv2.COLOR_BGR2GRAY))
        dh = cv2.applyColorMap(cv2.convertScaleAbs(diff, alpha=2.0), cv2.COLORMAP_INFERNO)
        row = np.hstack([cv2.resize(x, (480, 270)) for x in (split, ov, dh)])
        cv2.putText(row, f"t={t:.0f}s  pan {pan:+.0f}  resid {r:.1f}px", (8, 20),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 255, 255), 1)
        sheet.append(row)
        for j in range(12):
            im = (ours_m if j % 2 == 0 else theirs).copy()
            bar = np.zeros((40, PW, 3), np.uint8)
            lbl = "OURS (dewarped raw, exposure-matched)" if j % 2 == 0 else "SPIIDEO Play"
            col = (0, 255, 0) if j % 2 == 0 else (255, 255, 255)
            cv2.putText(bar, f"t={t:.0f}s  pan {pan:+.0f}  {lbl}", (10, 27), cv2.FONT_HERSHEY_SIMPLEX, 0.7, col, 2)
            vw.write(np.vstack([bar, im]))
    vw.release(); capr.release(); capp.release()
    cv2.imwrite(f"{OUT}/proof_sheet.png", np.vstack(sheet))
    print(f"\nwrote {OUT}/flicker.mp4 + proof_sheet.png")
    print("JUDGE: flicker swims/bends = geometry gap. Static image w/ color shimmer only = certified.")


if __name__ == "__main__":
    main()

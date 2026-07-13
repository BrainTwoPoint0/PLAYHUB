"""STRAIGHTNESS TEST — the honest instrument for "the pitch lines look curved".

A correct rectilinear (pinhole) dewarp maps every STRAIGHT world line to a STRAIGHT image
line. So: render our dewarp, detect the longest bright PITCH LINES, fit a straight chord to
each, and measure how far the actual line BOWS away from that chord (px, and % of length).
Do the same on Spiideo's Play frame at matched framing. If ours bows and theirs doesn't, our
mesh has residual distortion — a real Layer-0 bug the point-based 'proofs' missed.

Output /tmp/imitation/straightness/: sheet.png (ours|theirs, detected line + straight chord
drawn, bow annotated) at several framings across the pan range.

  python3 straightness_proof.py
"""
from __future__ import annotations
import json, os, glob
import numpy as np, cv2
from scipy.optimize import minimize
from scipy.spatial import cKDTree
import mesh_dewarp as MD

G8 = os.environ.get("CLIP", "b923d40f"); WOFF = {"b923d40f": 900, "d9fee1fc": 677}[G8]
RAW = glob.glob(f"/tmp/follow-pair/raw_{G8}*_s{WOFF}.mp4")[0]
PLAY = glob.glob(f"/tmp/follow-pair/play_{G8}*_s{WOFF}.mp4")[0]
REG = f"/tmp/imitation/reg_{G8}.json"; OUT = "/tmp/imitation/straightness"
PW, PH = 1280, 720
projs, _ = MD.load_mesh("/tmp/follow-pair/mesh")
sift = cv2.SIFT_create(5000); bf = cv2.BFMatcher()
UV = np.vstack([p["uv"] for p in projs]); WORLD = np.vstack([p["world"] for p in projs])
RAYN = WORLD[:, :2] / WORLD[:, 2:3]; uv_tree = cKDTree(UV)


def uv_to_pantilt(u, v):
    rn = RAYN[uv_tree.query([[u, v]])[1][0]]; x, y = float(rn[0]), float(rn[1]); n = np.sqrt(x*x+y*y+1)
    return np.degrees(np.arctan2(-x, 1)), np.degrees(-np.arcsin(y / n))


def render(rawf, pan, tilt, fov):
    u, v = MD.bake_uv_map(projs, np.radians(pan), np.radians(tilt), fov, PW, PH)
    th, tw = rawf.shape[:2]; m1 = (u*tw).astype("f4"); m2 = (v*th).astype("f4"); m1[u < 0] = -1; m2[u < 0] = -1
    return cv2.remap(rawf, m1, m2, cv2.INTER_LINEAR)


def longest_lines(img, want=2):
    """detect bright, long, straight-ish pitch-line segments; return list of (pts Nx2, p1, p2)."""
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    # white lines: top-hat to isolate thin bright structures on grass
    th = cv2.morphologyEx(g, cv2.MORPH_TOPHAT, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (25, 25)))
    _, bw = cv2.threshold(th, 25, 255, cv2.THRESH_BINARY)
    lines = cv2.HoughLinesP(bw, 1, np.pi/180, threshold=80, minLineLength=PW//3, maxLineGap=25)
    if lines is None:
        return []
    segs = sorted((l[0] for l in lines), key=lambda s: -np.hypot(s[2]-s[0], s[3]-s[1]))
    out = []
    for x1, y1, x2, y2 in segs:
        if any(abs(np.arctan2(y2-y1, x2-x1) - np.arctan2(s[3]-s[1], s[2]-s[0])) < 0.15 and
               abs((x1-s[0])+(y1-s[1])) < 40 for s, _, _ in out):
            continue
        # sample the ACTUAL bright ridge near the chord to measure real bow
        p1, p2 = np.array([x1, y1], float), np.array([x2, y2], float)
        L = np.linalg.norm(p2-p1)
        if L < PW//3:
            continue
        d = (p2-p1)/L; nrm = np.array([-d[1], d[0]])
        pts = []
        for s in np.linspace(0, L, 60):
            c = p1 + d*s
            best, bv = None, 30
            for off in range(-14, 15):
                q = (c + nrm*off).astype(int)
                if 0 <= q[1] < PH and 0 <= q[0] < PW and bw[q[1], q[0]] > 0:
                    if abs(off) < bv:
                        bv, best = abs(off), c + nrm*off
            if best is not None:
                pts.append(best)
        if len(pts) >= 20:
            out.append((np.array(pts), p1, p2))
        if len(out) >= want:
            break
    return out


def bow_of(pts, p1, p2):
    """max & rms perpendicular deviation of pts from the straight chord p1->p2 (px)."""
    d = (p2-p1)/np.linalg.norm(p2-p1); nrm = np.array([-d[1], d[0]])
    dev = (pts - p1) @ nrm
    return float(np.max(np.abs(dev))), float(np.sqrt(np.mean(dev**2))), np.linalg.norm(p2-p1)


def match_frame(rawf, theirs, pan0, tilt0, fov0):
    k2, d2 = sift.detectAndCompute(cv2.cvtColor(theirs, cv2.COLOR_BGR2GRAY), None)
    def resid(x):
        our = render(rawf, x[0], x[1], x[2])
        k1, d1 = sift.detectAndCompute(cv2.cvtColor(our, cv2.COLOR_BGR2GRAY), None)
        if d1 is None: return 1e3
        good = [a for a, b in bf.knnMatch(d1, d2, k=2) if a.distance < 0.8*b.distance]
        if len(good) < 25: return 1e3
        s = np.float32([k1[m.queryIdx].pt for m in good]); t = np.float32([k2[m.trainIdx].pt for m in good])
        dv = t - s; tm = np.median(dv, 0); e = np.linalg.norm(dv-tm, 1); inl = e < 12
        return float(np.median(np.linalg.norm(dv[inl]-np.median(dv[inl], 0), 1))) if inl.sum() > 15 else 1e3
    x0 = np.array([pan0, tilt0, fov0])
    S = np.array([x0, x0+[2, 0, 0], x0+[0, 2, 0], x0+[0, 0, 4]])
    r = minimize(resid, x0, method="Nelder-Mead", options=dict(initial_simplex=S, maxiter=200, xatol=0.03, fatol=0.03))
    return r.x


def draw(img, pts, p1, p2, mx, rms, L, who):
    im = img.copy()
    cv2.line(im, tuple(p1.astype(int)), tuple(p2.astype(int)), (0, 255, 255), 1)   # straight chord (yellow)
    for q in pts.astype(int):
        cv2.circle(im, tuple(q), 2, (0, 0, 255), -1)                                # actual ridge (red)
    cv2.putText(im, f"{who}: bow {mx:.1f}px ({100*mx/L:.1f}% of {L:.0f}px)  rms {rms:.1f}",
                (10, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0) if mx < 3 else (0, 128, 255), 2)
    return im


def main():
    os.makedirs(OUT, exist_ok=True)
    reg = json.load(open(REG)); rt = np.array(reg["t"]); rpx = np.array(reg["pano_x"]); rpy = np.array(reg["pano_y"]); fw = np.array(reg["footw"])
    order = np.argsort(rpx)
    picks = [order[len(order)//6], order[len(order)//2], order[5*len(order)//6]]
    capr = cv2.VideoCapture(RAW); capp = cv2.VideoCapture(PLAY)
    rows = []
    for i in picks:
        t = float(rt[i]); capr.set(cv2.CAP_PROP_POS_MSEC, t*1000); okr, rawf = capr.read()
        capp.set(cv2.CAP_PROP_POS_MSEC, t*1000); okp, playf = capp.read()
        if not (okr and okp): continue
        theirs = cv2.resize(playf, (PW, PH))
        pan0, tilt0 = uv_to_pantilt(rpx[i], rpy[i]); fov0 = float(np.clip(fw[i]*95, 20, 46))
        pan, tilt, fov = match_frame(rawf, theirs, pan0, tilt0, fov0)
        ours = render(rawf, pan, tilt, fov)
        for label, im in (("OURS", ours), ("SPIIDEO", theirs)):
            ll = longest_lines(im, want=1)
            if ll:
                pts, p1, p2 = ll[0]; mx, rms, L = bow_of(pts, p1, p2)
                panel = draw(im, pts, p1, p2, mx, rms, L, label)
                print(f"  t={t:4.0f}s pan={pan:+.0f} {label:8s}: line len {L:.0f}px  BOW max {mx:.1f}px ({100*mx/L:.1f}%)  rms {rms:.1f}")
            else:
                panel = im.copy(); cv2.putText(panel, f"{label}: no line found", (10, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2)
            rows.append(cv2.resize(panel, (640, 360)))
    capr.release(); capp.release()
    grid = np.vstack([np.hstack(rows[k:k+2]) for k in range(0, len(rows), 2)])
    cv2.imwrite(f"{OUT}/sheet.png", grid)
    print(f"\nwrote {OUT}/sheet.png  (yellow=straight chord, red=actual pitch-line ridge; gap=bow)")
    print("If OURS bow >> SPIIDEO bow, our mesh has residual distortion = a real geometry bug.")


if __name__ == "__main__":
    main()

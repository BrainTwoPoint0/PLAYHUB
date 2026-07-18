"""Per selected framing: SIFT-match our matched-framing render to their Play
frame, fit a 4-DOF similarity, report rotation (deg), scale, translation."""
import json, os, sys
import numpy as np, cv2
sys.path.insert(0, os.path.join(os.environ['WS'], 'PLAYHUB', 'scripts', 'follow-re'))
import mesh_dewarp as MD

SP = os.environ['SP']
projs, _ = MD.load_mesh(os.path.join(os.environ['WS'], 'PLAYHUB', 'public', 'vp-mesh-kuwait'))
fr_json = json.load(open(f"{SP}/framings.json"))
RAW = f"{SP}/raw_afb81f5f-12a3-4250-bc3d-d1824f82e94e_s900.mp4"
PLAY = f"{SP}/play_afb81f5f-12a3-4250-bc3d-d1824f82e94e_s900.mp4"
capr = cv2.VideoCapture(RAW); capp = cv2.VideoCapture(PLAY)
sift = cv2.SIFT_create(3000); bf = cv2.BFMatcher()
for fr in fr_json:
    capr.set(cv2.CAP_PROP_POS_MSEC, fr['t']*1000); okr, raw = capr.read()
    capp.set(cv2.CAP_PROP_POS_MSEC, fr['t']*1000); okp, play = capp.read()
    if not (okr and okp): continue
    u, v = MD.bake_uv_map(projs, np.radians(fr['pan']), np.radians(fr['tilt']), fr['fov'], 960, 540)
    H, W = raw.shape[:2]
    mu = (u*W).astype(np.float32); mv = (v*H).astype(np.float32)
    mu[u<0] = -1; mv[v<0] = -1
    ours = cv2.remap(raw, mu, mv, cv2.INTER_LINEAR)
    theirs = cv2.resize(play, (960, 540))
    g1 = cv2.cvtColor(ours, cv2.COLOR_BGR2GRAY); g2 = cv2.cvtColor(theirs, cv2.COLOR_BGR2GRAY)
    k1, d1 = sift.detectAndCompute(g1, None); k2, d2 = sift.detectAndCompute(g2, None)
    if d1 is None or d2 is None: continue
    m = bf.knnMatch(d1, d2, k=2)
    good = [a for a, b in m if a.distance < 0.75*b.distance]
    if len(good) < 12:
        print(f"t={fr['t']:.0f}s: only {len(good)} matches"); continue
    p1 = np.float32([k1[a.queryIdx].pt for a in good])
    p2 = np.float32([k2[a.trainIdx].pt for a in good])
    Msim, inl = cv2.estimateAffinePartial2D(p1, p2, method=cv2.RANSAC, ransacReprojThreshold=4.0)
    if Msim is None: continue
    rot = np.degrees(np.arctan2(Msim[1,0], Msim[0,0]))
    scale = float(np.hypot(Msim[0,0], Msim[1,0]))
    print(f"t={fr['t']:.0f}s pan={fr['pan']:.1f}: rot={rot:+.2f}deg scale={scale:.3f} "
          f"tx={Msim[0,2]:+.0f} ty={Msim[1,2]:+.0f} inliers={int(inl.sum())}/{len(good)}")

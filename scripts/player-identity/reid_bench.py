"""Re-ID benchmark with REAL ground truth (chain id = same player).

Query: a player's crop at t1.  Gallery: every player's crop at t2 = t1+gap.
Rank-1 = did we pick the right player out of the field?

Compared:
  POSITION  — constant-velocity prediction, i.e. what the stitcher does today
  COLOUR    — HSV histogram, upper/lower body (kit)
  CNN       — ResNet50 ImageNet embedding
  COMBINED  — position gate + appearance rank

The decisive slice is the HARD subset: cases where position picks the WRONG
player. Those are the occlusion breaks. Can appearance rescue them?
"""
import json, os, collections
import numpy as np
import cv2
import torch
import torchvision

OUT = os.path.dirname(os.path.abspath(__file__))
man = json.load(open(f'{OUT}/crops_manifest.json'))
by_t = collections.defaultdict(dict)      # t -> chain -> record
for m in man:
    by_t[round(m['t'], 1)][m['chain']] = m
times = sorted(by_t)

# ---- embeddings --------------------------------------------------------------
dev = 'mps' if torch.backends.mps.is_available() else 'cpu'
net = torchvision.models.resnet50(
    weights=torchvision.models.ResNet50_Weights.IMAGENET1K_V2)
net.fc = torch.nn.Identity()
net.eval().to(dev)
MEAN = torch.tensor([0.485, 0.456, 0.406]).view(3, 1, 1)
STD = torch.tensor([0.229, 0.224, 0.225]).view(3, 1, 1)

def colour_feat(im):
    im = cv2.resize(im, (64, 128))
    hsv = cv2.cvtColor(im, cv2.COLOR_BGR2HSV)
    fs = []
    for a, b in ((0, 64), (64, 128)):          # torso / legs
        h = cv2.calcHist([hsv[a:b]], [0, 1], None, [12, 6],
                         [0, 180, 0, 256]).flatten()
        fs.append(h / (h.sum() + 1e-6))
    v = np.concatenate(fs)
    return v / (np.linalg.norm(v) + 1e-9)

imgs, cfeat = {}, {}
batch, keys = [], []
for m in man:
    im = cv2.imread(f"{OUT}/crops/{m['file']}")
    if im is None:
        continue
    k = (round(m['t'], 1), m['chain'])
    imgs[k] = im
    cfeat[k] = colour_feat(im)
    r = cv2.resize(im, (64, 128))[:, :, ::-1].copy()
    t = torch.from_numpy(r).permute(2, 0, 1).float() / 255
    batch.append((t - MEAN) / STD)
    keys.append(k)
nfeat = {}
with torch.no_grad():
    for i in range(0, len(batch), 128):
        chunk = torch.stack(batch[i:i + 128]).to(dev)
        f = net(chunk).cpu().numpy()
        f /= np.linalg.norm(f, axis=1, keepdims=True) + 1e-9
        for k, v in zip(keys[i:i + 128], f):
            nfeat[k] = v
print(f'{len(nfeat)} crops embedded on {dev}')

# ---- velocity per chain at each t (from crop metric positions) ---------------
by_chain = collections.defaultdict(list)
for m in man:
    by_chain[m['chain']].append(m)
for v in by_chain.values():
    v.sort(key=lambda m: m['t'])

def vel(chain, t):
    v = by_chain[chain]
    pts = [(m['t'], np.array(m['metric'])) for m in v if abs(m['t'] - t) <= 4.1]
    if len(pts) < 2:
        return np.zeros(2)
    (ta, pa), (tb, pb) = pts[0], pts[-1]
    return (pb - pa) / max(tb - ta, 1e-6)

# ---- benchmark ---------------------------------------------------------------
def run(gap):
    res = {k: [0, 0] for k in ('POSITION', 'COLOUR', 'CNN', 'COMBINED')}
    hard = {k: [0, 0] for k in ('COLOUR', 'CNN', 'COMBINED')}
    for t1 in times:
        t2 = round(t1 + gap, 1)
        if t2 not in by_t:
            continue
        g = by_t[t2]
        if len(g) < 4:
            continue
        gal = list(g.keys())
        gpos = np.array([g[c]['metric'] for c in gal])
        for cq, mq in by_t[t1].items():
            if cq not in g:
                continue                      # no ground truth at t2
            k1 = (t1, cq)
            if k1 not in nfeat:
                continue
            gk = [(t2, c) for c in gal]
            if any(k not in nfeat for k in gk):
                continue
            # POSITION: constant-velocity prediction
            pred = np.array(mq['metric']) + vel(cq, t1) * gap
            dpos = np.linalg.norm(gpos - pred, axis=1)
            pick_pos = gal[int(dpos.argmin())]
            res['POSITION'][0] += pick_pos == cq; res['POSITION'][1] += 1
            # APPEARANCE
            sc_col = np.array([float(cfeat[k1] @ cfeat[k]) for k in gk])
            sc_cnn = np.array([float(nfeat[k1] @ nfeat[k]) for k in gk])
            for name, sc in (('COLOUR', sc_col), ('CNN', sc_cnn)):
                res[name][0] += gal[int(sc.argmax())] == cq; res[name][1] += 1
            # COMBINED: reject implausible positions, then rank by appearance
            plaus = dpos < max(6.0, 9.0 * gap)     # 9 m/s ceiling
            sc = sc_cnn.copy()
            sc[~plaus] = -9
            res['COMBINED'][0] += gal[int(sc.argmax())] == cq
            res['COMBINED'][1] += 1
            # HARD subset: position got it WRONG
            if pick_pos != cq:
                for name, s in (('COLOUR', sc_col), ('CNN', sc_cnn), ('COMBINED', sc)):
                    hard[name][0] += gal[int(s.argmax())] == cq
                    hard[name][1] += 1
    return res, hard

print('\nRank-1 accuracy — pick the right player out of the field at t+gap')
print(f'{"gap":>5} {"n":>5} {"POSITION":>9} {"COLOUR":>8} {"CNN":>8} {"COMBINED":>9}   '
      f'| HARD (position was wrong): n  COLOUR  CNN  COMBINED')
for gap in (2, 4, 6, 8, 10):
    res, hard = run(gap)
    if res['POSITION'][1] < 20:
        continue
    n = res['POSITION'][1]
    line = f'{gap:>4}s {n:>5} '
    for k in ('POSITION', 'COLOUR', 'CNN', 'COMBINED'):
        a, b = res[k]
        line += f'{a / max(b, 1) * 100:>8.1f}%' if k != 'POSITION' else f'{a / max(b, 1) * 100:>8.1f}%'
    hn = hard['CNN'][1]
    line += f'   | {hn:>4} '
    for k in ('COLOUR', 'CNN', 'COMBINED'):
        a, b = hard[k]
        line += f'{a / max(b, 1) * 100:>6.1f}%' if b else '     -'
    print(line)

# gallery size context
sizes = [len(by_t[t]) for t in times]
print(f'\ngallery size (players to choose between): median {np.median(sizes):.0f} '
      f'max {max(sizes)}   -> chance rank-1 ~= {100 / np.median(sizes):.0f}%')

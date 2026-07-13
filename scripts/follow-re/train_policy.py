"""Imitation follow policy: a tiny non-causal TCN that maps raw-VP features
(player + motion-energy histograms) → the Spiideo camera framing (pano_x pan, pano_y
tilt, log-zoom). Trained by imitation on paired (raw, Spiideo) matches, held out by
MATCH. Loss = Huber(position) + λ·Huber(velocity); the velocity term is MANDATORY —
without it the net mean-collapses to midfield (= the terrible heuristic).

  python3 train_policy.py --holdout <game> --data /tmp/imitation --out /tmp/imitation/policy

Reports, on the held-out match, the learned policy vs the two incumbents (motion-centroid,
player-mean) on: pano_x residual (RMS/P95), velocity RMS (commitment), phase-lag, and
action-in-frame (|pred−teacher| < half a 32° crop). Saves the predicted pano_x/y/zoom
trajectory for the side-by-side render.
"""
from __future__ import annotations

import json
import sys
import glob
import os

import numpy as np
import torch
import torch.nn as nn

GAMES = ["b923d40f", "986c7896", "424e420a", "22776d6c", "48e16a16"]
# pano_x → azimuth degrees (this scene): mesh_pan = -(px*W-CX)/F radians
F_, CX_, W_ = 1158.15, 1820.72, 3840.0
def panox_deg(px):
    return np.degrees((px * W_ - CX_) / F_)


class TCN(nn.Module):
    """Non-causal dilated temporal conv. ~40k params. Sees ±~1s context per output."""
    def __init__(self, dim, hid=48, out=3, dils=(1, 2, 4, 8)):
        super().__init__()
        layers = []
        c = dim
        for d in dils:
            layers += [nn.Conv1d(c, hid, 5, padding=2 * d, dilation=d), nn.GELU(), nn.BatchNorm1d(hid)]
            c = hid
        self.body = nn.Sequential(*layers)
        self.head = nn.Conv1d(hid, out, 1)

    def forward(self, x):            # x: [B, dim, L]
        return self.head(self.body(x))


def load(data):
    D = {}
    for g in GAMES:
        p = f"{data}/ds_{g}.npz"
        if os.path.exists(p):
            D[g] = np.load(p)
    return D


def huber(a, b, w=None, delta=0.02):
    e = a - b
    q = torch.where(e.abs() < delta, 0.5 * e ** 2 / delta, e.abs() - 0.5 * delta)
    if w is not None:
        q = q * w
    return q.mean()


def main():
    a = sys.argv
    holdout = a[a.index("--holdout") + 1] if "--holdout" in a else "424e420a"
    data = a[a.index("--data") + 1] if "--data" in a else "/tmp/imitation"
    out = a[a.index("--out") + 1] if "--out" in a else "/tmp/imitation/policy"
    lam = float(a[a.index("--lam") + 1]) if "--lam" in a else 3.0
    dev = "mps" if torch.backends.mps.is_available() else "cpu"

    D = load(data)
    train = [g for g in D if g != holdout]
    if holdout not in D or not train:
        print(f"missing data: have {list(D)}, holdout {holdout}"); return
    print(f"train {train}  holdout {holdout}  device {dev}")

    Xtr = np.concatenate([D[g]["X"] for g in train])
    Ytr = np.concatenate([D[g]["Y"] for g in train])
    xm, xs = Xtr.mean(0), Xtr.std(0) + 1e-6
    ym, ys = Ytr.mean(0), Ytr.std(0) + 1e-6

    def seq(g):
        X = (D[g]["X"] - xm) / xs
        Y = (D[g]["Y"] - ym) / ys
        w = D[g]["w"]; w = w / (w.mean() + 1e-6)
        return (torch.tensor(X.T[None], dtype=torch.float32),          # [1, dim, L]
                torch.tensor(Y.T[None], dtype=torch.float32),
                torch.tensor(w[None, None], dtype=torch.float32))

    seqs = {g: seq(g) for g in D}
    net = TCN(Xtr.shape[1]).to(dev)
    nparam = sum(p.numel() for p in net.parameters())
    opt = torch.optim.AdamW(net.parameters(), lr=3e-3, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, 400)
    print(f"params {nparam}")

    for ep in range(400):
        net.train(); tot = 0.0
        for g in train:
            X, Y, w = (t.to(dev) for t in seqs[g])
            pred = net(X)
            lp = huber(pred, Y, w)
            lv = huber(pred[..., 1:] - pred[..., :-1], Y[..., 1:] - Y[..., :-1], w[..., 1:])
            loss = lp + lam * lv
            opt.zero_grad(); loss.backward(); opt.step()
            tot += float(loss)
        sched.step()
        if ep % 80 == 0 or ep == 399:
            print(f"  ep {ep:3d} loss {tot/len(train):.4f}")

    # ---- eval on held-out ----
    net.eval()
    X, Y, w = (t.to(dev) for t in seqs[holdout])
    with torch.no_grad():
        pred = net(X).cpu().numpy()[0].T * ys + ym          # [L,3] un-standardized
    Yh = D[holdout]["Y"]; t = D[holdout]["t"]
    teacher_px = Yh[:, 0]
    pol_px = pred[:, 0]
    bmo = D[holdout]["base_motion"]; bpm = D[holdout]["base_playermean"]

    def metrics(px):
        res = np.abs(panox_deg(px) - panox_deg(teacher_px))
        vel = np.diff(panox_deg(px))
        vteach = np.diff(panox_deg(teacher_px))
        velrms = np.sqrt(np.mean((vel - vteach) ** 2))
        # phase lag: xcorr of velocity signals
        va = (vel - vel.mean()); vb = (vteach - vteach.mean())
        cc = np.correlate(va, vb, "full") / (np.linalg.norm(va) * np.linalg.norm(vb) + 1e-9)
        lag = int(np.argmax(cc) - (len(vb) - 1))
        aif = float(np.mean(res < 16.0))                    # within half a 32° crop
        return dict(res_rms=float(np.sqrt(np.mean(res ** 2))), res_p95=float(np.percentile(res, 95)),
                    vel_rms=float(velrms), lag=lag, action_in_frame=aif)

    rep = dict(holdout=holdout, train=train, params=nparam,
               policy=metrics(pol_px), motion_centroid=metrics(bmo), player_mean=metrics(bpm))
    os.makedirs(out, exist_ok=True)
    np.savez(f"{out}/pred_{holdout}.npz", pred=pred, teacher=Yh, t=t,
             base_motion=bmo, base_playermean=bpm)
    torch.save(dict(state=net.state_dict(), xm=xm, xs=xs, ym=ym, ys=ys, dim=Xtr.shape[1]),
               f"{out}/net_{holdout}.pt")
    json.dump(rep, open(f"{out}/report_{holdout}.json", "w"), indent=1)

    print(f"\n=== HELD-OUT {holdout} (pano_x → degrees) ===")
    print(f"{'':16} {'res_RMS°':>9} {'res_P95°':>9} {'velRMS°':>9} {'lag':>5} {'in-frame':>9}")
    for k in ("policy", "motion_centroid", "player_mean"):
        m = rep[k]
        print(f"{k:16} {m['res_rms']:9.2f} {m['res_p95']:9.2f} {m['vel_rms']:9.3f} {m['lag']:5d} {m['action_in_frame']*100:8.0f}%")


if __name__ == "__main__":
    main()

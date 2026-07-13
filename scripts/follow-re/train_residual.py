"""Does the imitation NET add value OVER a calibrated heuristic? Anchor the policy to a
strong, generalizing prior (linear blend of player-mean + motion, fit on train) and let
a small TCN learn only the RESIDUAL correction (lead the action, expand scale, de-bias).
With few matches this beats predicting absolute pano_x from scratch (which overfits the
per-match offset). Pan channel only — the product-critical DOF.

  python3 train_residual.py --holdout <game> [--data DIR] [--wd 3e-3]
"""
from __future__ import annotations

import sys
import numpy as np
import torch
import torch.nn as nn

GAMES = ["b923d40f", "986c7896", "424e420a", "22776d6c", "48e16a16"]
F_, CX_, W_ = 1158.15, 1820.72, 3840.0
def deg(px): return np.degrees((px * W_ - CX_) / F_)


class TCN(nn.Module):
    def __init__(self, dim, hid=32, dils=(1, 2, 4, 8), p=0.1):
        super().__init__()
        layers = []; c = dim
        for d in dils:
            layers += [nn.Conv1d(c, hid, 5, padding=2 * d, dilation=d), nn.GELU(),
                       nn.BatchNorm1d(hid), nn.Dropout(p)]; c = hid
        self.body = nn.Sequential(*layers); self.head = nn.Conv1d(hid, 1, 1)
        nn.init.zeros_(self.head.weight); nn.init.zeros_(self.head.bias)   # start = prior

    def forward(self, x): return self.head(self.body(x))


def metrics(px, teach):
    r = np.abs(deg(px) - deg(teach)); v = np.diff(deg(px)); vt = np.diff(deg(teach))
    return (float(np.sqrt(np.mean(r ** 2))), float(np.percentile(r, 95)),
            float(np.sqrt(np.mean((v - vt) ** 2))), float(np.mean(r < 16.0)),
            float(np.corrcoef(px, teach)[0, 1]))


def main():
    a = sys.argv
    hold = a[a.index("--holdout") + 1] if "--holdout" in a else "424e420a"
    data = a[a.index("--data") + 1] if "--data" in a else "/tmp/imitation"
    wd = float(a[a.index("--wd") + 1]) if "--wd" in a else 3e-3
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    D = {g: np.load(f"{data}/ds_{g}.npz") for g in GAMES}
    tr = [g for g in GAMES if g != hold]

    # blend prior fit on train (pm, mo → teacher_px)
    pm = np.concatenate([D[g]["base_playermean"] for g in tr])
    mo = np.concatenate([D[g]["base_motion"] for g in tr])
    te = np.concatenate([D[g]["Y"][:, 0] for g in tr])
    A = np.stack([pm - 0.5, mo - 0.5, np.ones_like(pm)], 1)
    coef, *_ = np.linalg.lstsq(A, te - 0.5, rcond=None)
    def prior(g):
        return 0.5 + coef[0] * (D[g]["base_playermean"] - 0.5) + coef[1] * (D[g]["base_motion"] - 0.5) + coef[2]

    Xtr = np.concatenate([D[g]["X"] for g in tr])
    xm, xs = Xtr.mean(0), Xtr.std(0) + 1e-6
    res_tr = np.concatenate([D[g]["Y"][:, 0] - prior(g) for g in tr])
    rm, rs = res_tr.mean(), res_tr.std() + 1e-6

    def seq(g):
        X = (D[g]["X"] - xm) / xs
        r = (D[g]["Y"][:, 0] - prior(g) - rm) / rs
        w = D[g]["w"]; w = w / (w.mean() + 1e-6)
        return (torch.tensor(X.T[None], dtype=torch.float32),
                torch.tensor(r[None, None], dtype=torch.float32),
                torch.tensor(w[None, None], dtype=torch.float32))
    S = {g: seq(g) for g in GAMES}
    net = TCN(Xtr.shape[1]).to(dev)
    opt = torch.optim.AdamW(net.parameters(), lr=2e-3, weight_decay=wd)
    sch = torch.optim.lr_scheduler.CosineAnnealingLR(opt, 300)

    def huber(a, b, w, d=0.3):
        e = a - b; q = torch.where(e.abs() < d, 0.5 * e ** 2 / d, e.abs() - 0.5 * d); return (q * w).mean()

    for ep in range(300):
        net.train()
        for g in tr:
            X, r, w = (t.to(dev) for t in S[g]); p = net(X)
            loss = huber(p, r, w) + 2.0 * huber(p[..., 1:] - p[..., :-1], r[..., 1:] - r[..., :-1], w[..., 1:])
            opt.zero_grad(); loss.backward(); opt.step()
        sch.step()

    net.eval()
    X = S[hold][0].to(dev)
    with torch.no_grad():
        rr = net(X).cpu().numpy()[0, 0] * rs + rm
    te_h = D[hold]["Y"][:, 0]
    pri = prior(hold)
    pol = np.clip(pri + rr, 0.05, 0.95)

    print(f"holdout {hold}  blend coef pm={coef[0]:.2f} mo={coef[1]:.2f} b={coef[2]:.3f}  wd={wd}")
    print(f"{'model':26}{'resRMS°':>9}{'resP95°':>9}{'velRMS°':>9}{'in-frame':>10}{'corr':>7}")
    for name, px in [("policy (residual+prior)", pol), ("blend prior alone", pri),
                     ("motion heuristic", D[hold]["base_motion"]),
                     ("player-mean heuristic", D[hold]["base_playermean"])]:
        rms, p95, vr, af, cc = metrics(px, te_h)
        print(f"{name:26}{rms:9.2f}{p95:9.2f}{vr:9.3f}{af*100:9.0f}%{cc:7.3f}")
    np.savez(f"{data}/policy/pred_res_{hold}.npz", pred=pol, prior=pri, teacher=te_h,
             base_motion=D[hold]["base_motion"], base_playermean=D[hold]["base_playermean"], t=D[hold]["t"])


if __name__ == "__main__":
    main()

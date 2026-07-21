#!/usr/bin/env python3
"""Self-contained unit tests for the transition-hold post-pass (P1 + spine-rejection).
Run: python3 scripts/portrait-crop/test_transition_hold.py
Real-clip acceptance (0.20/0.50/0.65 eyes-on) lived in the calibration scratch; this covers the logic.
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from transition_hold import bridge_and_hold, trusted_anchor_mask, MAX_PAN_PX_S, GAP_MAX_S

ok = 0; fail = 0
def check(name, cond, detail=""):
    global ok, fail
    if cond: ok += 1
    else: fail += 1; print(f"  FAIL  {name}  {detail}")

def gap(dx, gap_s, fps=10, pad=6, spike=False):
    """pad confident balls at x=1000, a placeholder gap, then pad balls at x=1000+dx."""
    pos = []; t = 0.0
    for _ in range(pad): pos.append({"time": round(t, 3), "x": 1000, "y": 500, "source": "ball", "conf": 0.9}); t += 1/fps
    gs = t
    for k in range(1, int(gap_s*fps)): pos.append({"time": round(gs+k/fps, 3), "x": 9999, "y": 9999, "source": "cluster", "conf": 0.3})
    t = gs + gap_s
    for _ in range(pad): pos.append({"time": round(t, 3), "x": 1000+dx, "y": 500, "source": "ball", "conf": 0.9}); t += 1/fps
    return pos
def mid(r): return r[len(r)//2]

# --- bridge / gate / kill-recenter ---
r = bridge_and_hold(gap(400, 2.0)); check("short reachable gap BRIDGES", mid(r).get("bridged") and mid(r)["x"] != 9999, mid(r))
r = bridge_and_hold(gap(400, 5.0)); check("reachable but LONG gap (>2.5s) HOLDS", not mid(r).get("bridged") and mid(r)["x"] == 1000)
r = bridge_and_hold(gap(2000, 1.0)); check("too-fast gap HOLDS (no wrong bridge)", not mid(r).get("bridged") and mid(r)["x"] == 1000)
check("hold uses the anchor x, never frame-centre (960)", mid(r)["x"] == 1000)

# --- lead-in caps the hold->anchor step ---
r = bridge_and_hold(gap(1500, 12.0))
step = max(abs(r[i]["x"]-r[i-1]["x"]) for i in range(1, len(r)))
check("lead-in caps step at <= max_pan*dt", step <= MAX_PAN_PX_S*(1/10.0) + 1, f"step={step}")
check("lead-in still lands on the real anchor", r[-1]["x"] == 2500)

# --- guards ---
bad = [{"time":0.0,"x":100,"y":1,"source":"ball","conf":0.9},{"time":2.0,"x":200,"y":1,"source":"cluster","conf":0.3},{"time":1.0,"x":300,"y":1,"source":"ball","conf":0.9}]
check("non-monotonic time -> no-op", bridge_and_hold(bad)[1]["x"] == 200)
sparse = [{"time":i*0.1,"x":500,"y":1,"source":"ball" if i in (0,50) else "cluster","conf":0.9 if i in (0,50) else 0.3} for i in range(100)]
check("too-sparse clip (frac<2%) -> no-op", all(a["x"]==b["x"] for a,b in zip(sparse, bridge_and_hold(sparse))))

# --- spine / anchor-trust (motion-aware support) ---
iso = [{"time":i*0.1,"x":100,"y":1,"source":"ball" if i==5 else "cluster","conf":0.9 if i==5 else 0.3} for i in range(11)]
check("lone confident spike (no confident neighbours) REJECTED", not trusted_anchor_mask(iso)[5])
fast = [{"time":i*0.04,"x":100+i*40,"y":1,"source":"ball","conf":0.8} for i in range(11)]  # 1000px/s confident chain
check("fast confident chain KEPT (motion-aware, not fixed-radius)", all(trusted_anchor_mask(fast)))
pair = [{"time":i*0.1,"x":100+i*400,"y":1,"source":"ball","conf":0.9} for i in range(2)]  # a lone pair
check("a wrong PAIR cannot self-validate (min_support=2)", not any(trusted_anchor_mask(pair)))

# --- degenerate ---
check("empty -> empty", bridge_and_hold([]) == [])

print(f"{ok} passed, {fail} failed")
sys.exit(1 if fail else 0)

# mot-eval — standardized identity metrics for the stitcher / Tier-2b

**Date:** 2026-07-18
**Question:** Can we score identity (not duration) in standard, comparable
metrics — and what do the shipped stitcher's numbers actually look like?
**Verdict:** GO — harness works end-to-end on 2 adult Veo matches; the
baseline table below is Tier-2b's reference point.

Contract (locked in `docs/roster-cardinality-tracker.md` §"Eval harness"):
dev on Veo GT / final sign-off on Spiideo + HCT jersey GT (regime split);
crossing-correlated cuts; per-T right/lost/wrong curve on stock HOTA/IDF1.

## Scripts (this dir)

- `fetch_veo.py` — prefix-driven S3 inventory of banked captures (~25
  ADULT 105m matches exist as of 2026-07-18 — far more than the one the
  docs recorded) + tracking.json cache (`cache/`, gitignored).
- `veo_gt.py` — GT loader: strict scaleKnown guard, grid check (uniform
  0.4s lattice verified on both matches), **jersey-chained identities**
  ((team, jersey) strict-majority merge; overlap → refuse; ≤10s seams
  must pass the <9 m/s physical test), runs split at Veo gaps >1.2s +
  period boundaries. GT never interpolated across gaps.
- `fragment_synth.py` — crossing-correlated cut hazard
  q(t)=q0(1+β·crowded), moment-matched to 22s lifetime + 0.59
  crowded-death; independent gap sampler (mass 1.5-5s); Veo noise floor
  measured per match (4th-diff kernel on stationary windows), quadrature
  top-up to 0.06m; `validate_marginals` = HARD GATE before any score.
- `score.py` — trackers.eval in-memory HOTA/CLEAR/Identity (Euclidean
  point similarity, zero_distance = 2·gate, gate 1m); per-T curve with
  three outcomes RIGHT/WRONG/LOST (P(wrong) = ship veto); frame-INDEX
  stepping for horizons (µs keys carry float truncation — arithmetic
  t0+T·1e6 misses). Hand-computable 2-player-crossing smoke test.
- `run_baselines.py` — no-stitch / legacy-1.5s / shipped-2.5s via the
  ceiling_eval module-global pattern; `--noise0`, `--gatescale=X` arms.

## Data

Dev set (adult, scaleKnown, plausible widths):
`20260416-hollands-blair-u23-vs-snodland-vf29eae4` (105×67.3, 1751s,
1 period) and `20260419-sefa-women-first-team-vs-hammersmith-v0aef861`
(105×70.9, 6465s, 3 periods). tracking.json only (no video; no Glacier
coupling).

## Findings (2026-07-18 baselines, seed 0, gate 1m)

Jersey-chaining is what makes T=60 measurable: gid spans 113.6/218.0s
median, 1720/3245s p90 (vs 65.6s raw trackId median). Veo's own noise
σ=0.104-0.143m already exceeds the 0.06m Spiideo floor → top-up 0 (the
zero-added-noise question closed itself). Synth marginals passed the
hard gate on both matches (frag median 14.4/14.8s, mean life 23.5/24.1s,
crowded-death 0.562/0.533, gap mass 0.607).

| match | variant | chains | HOTA | AssA | DetA | IDF1 | MOTA |
|---|---|---|---|---|---|---|---|
| HB-u23 | no-stitch | 1625 | 0.255 | 0.073 | 0.882 | 0.135 | 0.868 |
| HB-u23 | legacy-1.5s | 1228 | 0.268 | 0.082 | 0.876 | 0.143 | 0.866 |
| HB-u23 | shipped-2.5s | 1020 | 0.291 | 0.097 | 0.877 | 0.164 | 0.870 |
| SEFA-W | no-stitch | 4961 | 0.196 | 0.044 | 0.880 | 0.088 | 0.867 |
| SEFA-W | legacy-1.5s | 3781 | 0.208 | 0.050 | 0.874 | 0.098 | 0.865 |
| SEFA-W | shipped-2.5s | 3152 | 0.223 | 0.057 | 0.875 | 0.109 | 0.868 |

Per-T P(right)/P(wrong)/P(lost), shipped-2.5s (both matches agree ±0.02):
T=5s 0.88/0.00/0.12 · T=15s 0.67/0.01/0.32 · T=30s 0.46/0.01/0.53 ·
T=60s 0.22-0.24/0.01/0.75-0.77.

**Reading:** DetA ≈ 0.88 vs AssA ≈ 0.04-0.10 says it in one line — we see
nearly everything and can hold identity on almost nothing. The stitcher's
precision doctrine shows up as P(wrong) ≤ 0.01 at every horizon (losses
dominate, wrong-follows don't — the honest-loss design working). The
shipped ceiling beats legacy on every association metric with no
P(wrong) cost, confirming the 07-15 ship decision in standard metrics.
**Tier-2b's target is the AssA/IDF1/P(right) columns**: an N-slot global
assignment should lift them multiples, and any candidate that moves
P(wrong) off ~0.01 fails the veto regardless of its other numbers.

## Caveats

- Synthetic fragmentation emulates Spiideo's regime (2.5Hz here vs 5Hz
  production; `_endpoint_velocity`'s ≤5-sample window spans 2s not 1s) —
  rankings, not absolute numbers, transfer. Final sign-off on Spiideo +
  HCT jersey GT per the contract.
- Veo units self-consistent ≈ metres on adult matches (~8%); the
  `--gatescale` arm bounds sensitivity if it ever matters.
- `spiideo_crosscheck` (ceiling_eval bridge-P/R on real Spiideo) not yet
  wired into the runner — run it manually per candidate as the regime
  check.

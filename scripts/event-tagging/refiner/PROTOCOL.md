# Goal-moment refiner spike — pre-registered protocol (2026-07-24)

AGREED PLAN item 2. Gates were locked 2026-07-23 (memory: event-tagging-workstream) BEFORE this
session; this file freezes the operational details BEFORE any refiner number is computed.
Written before the dataset builder ran. Do not edit after the first eval.

## Scope (v1)

Re-rank + re-time ONLY. The refiner consumes the frozen chain's survivors and cycles; it never
adds, drops, merges, or splits an episode. Recall is structurally untouched by construction.
Suppression (auto-hiding low-confidence cards) is a later, separately freeze-gated change.

## Arms

- **team-free (day one, this session):** no team identity anywhere. `hs_grid` (half_sep) and any
  role/kit-derived channel are BANNED. Kickoff geometry restricted to the rolefree12 columns
  (FEATURE_KEYS minus gk_min_dgl/gk_cy — the freeze's KO_COLS).
- **kit-uplift (queued, not this session):** adds half_sep-family features. Measured vs team-free
  ON THE SILHOUETTE-GATED SUBSET ONLY (per-match kit silhouette ≥ 0.35, the shipped per-match
  gate); per-match silhouette logged into provenance. Verdicts reported PER CONDITION; the two
  arms are never averaged into one number. Kit-usable matches are a non-random sample — a pooled
  comparison confounds with match type.

## Data

- Veo dev corpus: 236 freeze sidecars + cached OOF series (pko/dctx/ev, per-fold OOF models,
  from the 07-21 freeze runs). Decode = CURRENT PRODUCTION config: TAU_PEAK=0.45,
  DCTX_FLOOR=0.80, 45s merge, sub-anchors = first peak per dead→live cycle (SPLIT_LIVE_THR=0.5,
  split="any" semantics). Decode reproduction is verified against freeze_results_tau045.json
  episode lists before any feature is extracted.
- Folds: the freeze's match-grouped 5-fold (SEED=7 permutation of sorted sidecar names). The
  refiner is trained on train-fold matches and scored on test-fold matches only (its input
  series are already OOF w.r.t. the underlying chain models).
- Final timing eval: the 131 `human_scrub` stamps (goal-MOMENT times, ball-crossing) across the
  reviewed Spiideo matches, exported from `playhub_goal_candidate_events`. Spiideo inference uses
  the refiner trained on ALL 236 Veo matches (disjoint domain, no leakage).

## Gates (locked)

1. **Precision (confidence re-rank):** refiner-ranked P@4 on freeze OOF, ALL bands, 236 matches,
   same P@K semantics as `stoppage_veo_freeze.summarize` (top-K survivors that are not FPs; FP =
   survivor covering no clean goal within the 90s pre-window). Bar: **must exceed BOTH the locked
   0.492 (span-alone, floor-080 record) AND span-alone on the same tau045 decode = 0.497**
   (both reproduced in this session before any refiner number existed). R@8 and per-band numbers
   reported for context; the gate is ALL-bands P@4.
2. **Timing (localizer):** on the 131 human_scrub stamps, scored ONCE against the reproduced
   production decode of each stamped match:
   - refiner median |err| **< 5s**, AND
   - refiner beats the shipped sub-anchor estimator (nearest covering sub-anchor − 20s, the
     chip-estimate rule from spiideo_split_check: earliest sub-anchor s in the covering card with
     s−45 ≤ g ≤ s, widened to 90s, fallback card anchor − 20) under the bootstrap below.
     Stamp→card matching identical for baseline and refiner (paired by stamp).
3. **Recall:** no gate — structurally unchanged (nothing suppressed, nothing re-timed outside
   its episode).

## Pre-locked bootstrap (one look)

- Statistic: Δ = median(|err_baseline|) − median(|err_refiner|) over the paired stamp set.
- Primary: percentile bootstrap over STAMPS, paired (each resample recomputes both medians on
  the same resampled stamps), B = 10,000, numpy default_rng(7), 95% two-sided CI.
  **PASS iff CI lower bound > 0** (and the <5s absolute bar holds).
- Secondary (reported, not gating): by-match cluster bootstrap (resample matches with
  replacement, keep all their stamps), same B/seed/CI — honesty check on match-level correlation
  (few clusters ⇒ wide; reported as-is).
- Stamps with no covering survivor card in the reproduced decode are excluded from BOTH arms
  identically and their count reported (coverage is the chain's property, not the refiner's).
- ONE look: the stamp eval script runs after the Veo-side model is locked (constants + model
  hash recorded below before running). No re-tuning after seeing stamp numbers; if the gate
  fails, the spike reports NO-GO for the timing gate.

## Veo-side development targets (iteration allowed here, never on stamps)

- Localizer: per-cycle offset regression, target δ = cycle_anchor − goal_t for the goal matched
  to that cycle (same matching rule as the stamp scorer). Veo OOF reference: sub-anchor−20 gives
  |err| med 4.7s / p90 12.2s on hit goals (07-22 measurement, floor-080 decode).
- Confidence: per-episode P(covers a clean goal within 90s), team-free features, HGB.

## Addendum (2026-07-24, written after Veo OOF v1, BEFORE any Spiideo feature or stamp was computed)

Known transfer hazard: the stoppage model's dctx SATURATES on Spiideo small-sided (Nazwa medP
0.94–0.99; envelope-v1 falsification — "the ranking transfers, the calibration doesn't").
The v1 feature set uses absolute dctx/ev levels. Mitigation decided now:

- features.py gains per-match QUANTILE-NORMALIZED variants of every dctx/ev level feature
  (percentile of the value within the match's finite dctx distribution).
- Label-free covariate check (allowed — no stamps touched): compute the Spiideo matches'
  FEATURES ONLY from their reproduced decodes; compare distributions vs Veo training.
- Pre-declared decision rule: if the Spiideo per-match median of the absolute dctx level
  features (dctx_m30 on cycles; dctx_mean_ep on episodes) falls outside the Veo training
  [q05, q95] on half or more of the stamped matches → ship the NORM-ONLY variant (absolute
  dctx/ev levels dropped); otherwise ship ABS+NORM combined. The Veo OOF gate is re-checked
  for whichever variant ships. No stamp is read at any point in this decision.

## Locked before the one look (2026-07-24, before any stamp was exported or read)

- Covariate check result: episode dctx_mean_ep out-of-band on 7/9 Spiideo matches (cycle 0/9)
  → pre-declared rule selects **NORM_ONLY** (absolute dctx/ev level features dropped).
- Veo OOF numbers for the locked variant: confidence P@4 ALL 0.6734 (span 0.4968; locked bar
  0.492) — PRECISION GATE PASS on Veo OOF; localizer per-goal |err| med 1.85s / p90 13.71s
  vs sub-anchor−20 med 5.16s / p90 22.69s.
- Models: HGB classifier (max_iter=300, lr=0.06, leaves=31, min_leaf=40, seed=7) + HGB
  absolute-error regressor (max_iter=400, lr=0.06, leaves=31, min_leaf=30, seed=7), trained on
  all 236 Veo matches, norm_only columns (ep 39 / cy 39).
- models_final.pkl sha256: ccee6a35d3af803c7ab8b559fc9637c81aea19ae240eb8d58e1d405a761d3aab
- Fallback rules: goal→cycle matching = features.match_goal (earliest covering card 45→90s,
  earliest qualifying sub-anchor, fallback anchor cycle); missing features stay NaN (HGB
  native); δ̂ clipped to [−30, 90]; stamps with no covering survivor card excluded from both
  arms identically and counted.
- Spiideo decode reproduction: 9/9 matches EXACT (every latest-epoch DB candidate anchor
  reproduced ±2s under the rows' own detector version).
- The stamp eval (stamp_eval.py) runs ONCE after this block is written. No edits after.

## Kit-arm addendum — PRECISION HALF (2026-07-24, written BEFORE any kit number was computed)

Post-freeze handoff (Spiideo label freeze `cad1615d`, 12 matches / 201 goals; holdout = live
review queue). This section locks the kit-arm precision gate before the first run.

**What this measures.** The CEILING of team-identity uplift on confidence re-ranking: on Veo,
team comes from Veo roles (exact), so `hs_grid` is perfect-team half_separation. A Spiideo
deployment gets team from kit clustering (per-match silhouette ≥ 0.35 gate, byte-identical
team-free fallback when the gate fails) — strictly noisier. Therefore: a FAIL here kills kit
productization for confidence outright (the ceiling didn't clear); a PASS authorizes the
realistic kit-clustered measurement, not production wiring (that stays Karim's call).

**Arm definition.** Feature set = team-free NORM_ONLY columns (the shipped variant) + the
HS keys below, computed from the sidecars' `hs_grid` (1s grid, role-teams-as-kits) aligned to
the stored `veo_matches.json` survivors (episode bounds verified against the stored record
before any feature is used; the recomputed team-free numbers must reproduce P@4 ALL 0.6734
exactly or the run aborts).

- Episode: `hs_anchor` (hs at anchor), `hs_ko_max` (max over [anchor−10, anchor+12] — the v3
  kickoff-scan window), `hs_mean_ep` ([t0, t1]), `hs_pre` ([t0−90, t0−45]),
  `hs_post` ([t1+5, t1+35]), `hs_rel` (hs_anchor − match median hs), `hs_q` (quantile of
  hs_anchor within the match's finite hs distribution).
- Cycle (computed + saved for the future timing half; NOT gated or interpreted this session):
  `hs_at_s`, `hs_ko_max_s` ([s−10, s+12]), `hs_pre30` ([s−35, s−5]), `hs_rel_s`, `hs_q_s`.

hs is a bounded fraction in [0.5, 1] by construction (majority-half share), not a model
calibration channel — abs levels are admitted; the `_rel`/`_q` forms cover residual per-match
drift. Same HGB params, same folds, same rank_eval semantics as the locked run.

**Gate (locked).** PASS iff BOTH:

1. kit-arm confidence P@4 ALL (236 matches, freeze OOF, same decode) **> team-free NORM_ONLY
   P@4 ALL (0.6734)** recomputed on the identical dataset, AND
2. fold-level P@4 (computed over each fold's matches, all bands pooled) improves in **≥ 3/5
   folds**.

Per-band P@4/R@8 and Δ magnitude reported for the productize decision; the two arms are never
averaged. Veo OOF remains the dev side (iteration permitted, reported transparently); no stamp
and no holdout-queue label is touched by this measurement.

## Localizer v2 — pre-registered gate (2026-07-24, no v2 number exists)

The 141-stamp corpus is SPENT (v1's one look, 2026-07-24). v2's one look runs ONLY on
`human_scrub` stamps from matches fully reviewed AFTER freeze commit `cad1615d` (the holdout
queue; the 12 frozen matches are excluded), with:

- Minimum evidence before the look: **≥ 80 stamps across ≥ 4 matches** (below that, the look
  is not spent and must not be taken).
- Gate: identical to v1 — median |err| **< 5s** AND beats the shipped sub-anchor−20 estimator
  under the v1 bootstrap spec (paired percentile, B=10,000, rng(7), CI lower bound > 0),
  stamp→card matching identical for both arms.
- Development iterates on Veo only; the Veo-side model + constants + hash are recorded here
  before the look, exactly as v1 did.
- Machine-minted markers (`anchor_offset` / `estimate`) are NEVER eval stamps — human_scrub
  only (the timing-corpus poisoning invariant).

# Phase 0 — Event Tagging Feasibility: GO/NO-GO

**Verdict: Veo-parity GO** (restart classification given the instant). This is **NOT** roadmap-item-4
(provider-agnostic) GO — the product does not transfer to Spiideo/security-cam yet, because restart-instant
recovery from tracks alone fails (caveat 1). Do not blur the two: classification transfers; the product does not.
Plan: `~/.claude/plans/silly-soaring-trinket.md`. All code here; corpus pulled to scratch (251 captures, `veo-panoramas/{slug}/`).

## What was measured

Trajectory-only, **ball-free, provider-independent** event tagging: player normalized-pitch
positions + roles → restart class. No pixels, no ball, no deep net (shallow tree ensemble over
kinematic features). Labels = Veo's own machine-generated `match-events` → this is **agreement
with Veo (distillation)**, not human ground truth. 234 usable matches (training/trial/practical
and <15-event sessions filtered). Corpus format spread: 21×22 (U6 small-sided) → 105×80 (adult).

## The gate — PASS

Candidate = every `ball_in_play` resumption; gold = nearest Veo restart within tolerance, else
`none`. Match-grouped 5-fold (a match never split across train/test), out-of-fold pooled.
**Strictest ±1.0s window** (looser only helps):

| class     | precision | recall | F1       | gate (≥0.60) |
| --------- | --------- | ------ | -------- | ------------ |
| corner    | 0.84      | 0.87   | **0.86** | PASS         |
| goal_kick | 0.75      | 0.82   | **0.78** | PASS         |
| throw_in  | 0.75      | 0.74   | **0.75** | PASS         |
| kick_off  | 0.76      | 0.73   | **0.74** | PASS         |

**4/4 gated restart classes clear F1 ≥ 0.60.** The classification sub-problem — the novel, hard part —
is solved from tracks alone. Its FEATURES (normalized coords + GK role) are provider-neutral, so
classification _would_ transfer — but the product does not (caveat 1), and every F1 here is agreement
with a possibly-noisy teacher, not human truth (caveat 2). "4/4" is a Veo-parity claim, not a truth claim.

## Key findings

1. **`ball_in_play` bonus.** Veo's `step-events` carries an in-play/out-of-play segmentation
   (~104 intervals/match), banked in every `tracking.json`. Restart events sit on its resumption
   boundaries: throw_in/corner/goal_kick/kick_off at 88–96% within 1s (full corpus).
2. **Clock is coherent.** `videoTimeMs = period_start + periodTimeMs` to −0.15s median — the
   alignment canary passes at the arithmetic level.
3. **Discriminative kinematics** (measured, not guessed): corner = a player in the corner; throw_in
   = a player on a touchline, mid-pitch; goal_kick = the **GK** hugging a goal-line, central; kick_off
   = a taker on the centre spot, split halves, no boundary-hugger. A hand rule reached corner only
   (~0.63); the learned model over the same features reached 4/4 (0.74–0.86) — that delta IS what the
   model buys.
4. **free_kick** (Karim's gating add): far less risky than the single probe implied — 85% of free
   kicks sit on a resumption boundary across the corpus (the probe match was an outlier). Not yet
   modelled (currently absorbed by `none`); **reported, not gating**, per the plan.

## Honest caveats (do not gloss)

- **Restart-INSTANT detection from tracks is the real provider-independence gap.** The classifier is
  fed candidate instants from `ball_in_play` (Veo-only). Recovering instants from player motion alone
  (for Spiideo / security-cam) tops out at ~0.5 recall / ~0.3 precision with a naive freeze detector —
  youth football has too many natural lulls. This needs a real stoppage model (ball-out inference /
  learned sequence), and it is the crux of the non-Veo transfer. **On Veo footage it's a non-issue**
  (`ball_in_play` is free), so **Veo-parity restart tagging is shippable now**; full provider-independence
  is gated on this.
- **Distillation ceiling — AUDITED 2026-07-20 (Karim, 64 clips via the harness).** Veo tag **PRECISION**
  (are its sampled tags correct? — NOT recall, NOT whether Veo misses restarts) **95% overall (61/64)**,
  **32/32 on the four GATED restart classes** + free_kick 8/8. Read carefully: 0/32 is a strong LOWER
  BOUND, not proof of perfection — treat Veo as trustworthy-ENOUGH, not an oracle; and because it measures
  precision only, our model's F1 recall stays "recall of Veo's tags," never ground-truth recall. Net: the
  gated F1s reflect real type accuracy against a high-precision teacher (not agreement-with-noise). The one
  genuine Veo error: a **`goal` false-positive at a period boundary** (halftime/quarter restart misread as a
  goal because a kickoff follows) — filterable via `step-events` periods, **Phase-1 day one**. Other 2 misses
  = taxonomy edges (direct-free-kick-as-shot, penalty↔free-kick). Timing: only ~10/64 rated {late:5,on:1,
  early:4} — thin; ±1.0s stands because the MODEL gate passed at it, NOT because the audit re-proved it.

## Recommendation (ordering per Karim, 2026-07-20)

**Veo-parity GO to Phase 1.** Run these NOT serialized:

1. **Audit harness (BUILT) + audit, IN PARALLEL with free_kick modelling.** The audit is foundational, not
   polish: it sets whether ±1.0s is the right window and whether we're copying Veo's mistakes (if Veo's throw_in
   tags are ~80% precise, our 0.75 is agreement with a noisy teacher). Harness = `audit_bundle.html` (one self-
   contained file): blind-first — you watch the real **Veo follow-cam mp4** (public `c.veocdn.com`, seeked to
   the event via `currentTime = videoTimeMs/1000`; independent of the tracking → true teacher-trust check),
   classify + mark the instant, THEN Veo's tag is revealed. Overhead dots (from `player-tracking`) synced beside
   it as a reference. Exports type-agreement % (Veo's precision ceiling) + timing-offset distribution (sets the
   window). **Deliberately NOT the raw panorama `.ts`** (9GB, region-presign, PTS-3600 + per-match GOP) — that
   is founder/agent-time inversion for a 30–50-event spot-check, and the follow-cam is already on Veo's clock.
   Alternative if the harness isn't worth reusing: eyeball ~40 events directly in the Veo UI to unblock Phase 1.
2. **Phase 1 Veo-parity pipeline** for the four restart classes → feeds portrait/moments beyond goals.
3. **Restart-instant-from-tracks as its OWN workstream** — NOT Phase 1 polish. It is the roadmap-item-4
   (provider-agnostic) unlock and the gate on any Spiideo/security-cam transfer. Needs a real stoppage model
   (ball-out inference / learned sequence), not a motion threshold.

Shots/goals/penalty stay reported-not-gated; free_kick reported-not-gated until modelled.

## Phase 1 — Veo-parity producer (classify→emit), held-out emit numbers (2026-07-20)

`emit_events.py` runs the Phase-0 classifier over a match's `ball_in_play` candidates and emits the four
gated restart classes as canonical events (`phase1_events.CanonicalEvent`; conf-gated; goals stay Veo-sourced

- period-FP-filtered; NO geometry adapters, NO DB — held until a persist target exists). Metric below is
  **emitted events vs VEO restart tags (±1s), NOT ground truth, NOT the per-class GroupKFold ceiling**; precision
  is a lower bound (a real restart Veo didn't tag scores as a FP).

**STRATIFIED held-out (9 matches, 3 per pitch band, model trained on 227 without them):**

| MIN_CONF | overall P/R | small <50m | medium 50–90m (9v9) | full ≥90m (11v11) |
| -------- | ----------- | ---------- | ------------------- | ----------------- |
| 0.50     | 0.79 / 0.69 | 0.71/0.60  | 0.85/0.75           | 0.77/0.70         |
| 0.80     | 0.89 / 0.51 | 0.85/0.39  | **0.93/0.57**       | 0.86/0.52         |
| 0.90     | 0.92 / 0.35 | 0.88/0.24  | 0.94/0.37           | 0.91/0.40         |

- **The global P≥0.92 @ R~0.68 operating point does NOT exist** — at P0.92 (MIN_CONF 0.90), recall is 0.35.
  (An earlier non-stratified tail-5 run read 0.90/0.78 @ 0.50 — optimistic; stratifying corrected it to 0.79/0.69.)
- **Per-format thresholds are the design**, precision-first for a publishing product: **medium/9v9 → MIN_CONF 0.80
  (P0.93/R0.57)**, full/11v11 → 0.90 (P0.91/R0.40), **small-sided → review-only** (precision tops ~0.88, recall craters).
- CFA/SEFA (the product target) are 9v9 = the medium band = the strong regime.
- **Thresholds LOCKED in code** (`emit_events.format_threshold`), not just prose: medium 0.80 / full 0.90 /
  small `None` (no auto-emit). `emit_match` resolves per-format by default.
- **One CFA emit artifact produced** (`emit_artifact.py` → `cfa_emit_artifact.json`, `cfa-u11-vs-cfa-green`
  68×41, trained held-out): 29 product-shaped canonical events (corner 9 / goal_kick 11 / kick_off 8 /
  throw_in 1), all conf 0.83–0.97, **P 0.90**. BUT **recall 0.25 on this match** (26/105 Veo tags) — and
  candidate coverage was 93% (NOT the limiter), so the low recall is the precision-first 0.80 threshold +
  low per-match classifier confidence. **Per-match recall variance is LARGE even in the medium band** — the
  0.57 stratified average does NOT hold per-match; this real CFA game gets 25% coverage at 90% precision.
  Assisted-auto (portrait posture) tolerates incomplete coverage, so it's a valid START, but **verifying
  recall across several CFA matches + deciding if 0.80 is too aggressive for CFA is a day-one follow-up.**
- **xnp-u11 autopsy:** its R=0.56 was the CLASSIFIER on a tiny 40×24 pitch (classifier-recall-given-candidate ~64%),
  not candidate coverage (87%). The small-sided gap is a model-improvement lever (small-sided features / per-class
  thresholds / pre-restart freeze), not a candidate problem.

## CFA multi-match recall panel — DAY-ONE FOLLOW-UP DONE (2026-07-20)

Ran the WHOLE CFA slice held out (all 22 CFA matches excluded from training; model fit on 214 non-CFA),
`cfa_panel.py` + `cfa_perclass_sweep.py`. Decomposed recall into (A) candidate coverage → (B) classifier
argmax → (C) confidence gate. All numbers emit-vs-Veo-tags (±1s, precision a lower bound), NOT ground truth.

**Verdict on the two day-one questions:**

1. **Is 0.80 too aggressive for CFA? — Partly, and the length key can't fix it.** CFA aggregate at 0.80 is
   **P0.87 / R0.48** (below the stratified-medium design P0.93/R0.57 — CFA is a harder slice than the medium
   average). The 0.80 gate is the single biggest recall lever: recall waterfall is 100% → **92% coverage** →
   **73% classifier** → **48% at 0.80** (the gate alone costs 25 pts, all recoverable/correct predictions).
   BUT recall grades hard by AGE — **u9 median R0.35, u10 0.37, u11 0.73, u12 0.81** — and this is **invisible
   to `format_threshold`**: Veo presets youth pitch LENGTH to 68.0m for every age (width is fitted), so the
   length key gives all youth the same 0.80 and cannot separate a u9 from a u11. **The single cfa-green artifact
   (R0.22) was a genuine hard-u11 outlier, not the norm** — most CFA u11/u12 sit R0.73–0.83 at 0.80, at/above design.

2. **Does throw_in need its own threshold? — YES, but the naive fix is BACKWARDS.** throw_in is the class to keep
   STRICTEST, not lower. The "1 emitted vs 40 Veo tags" on cfa-green was **27/40 classified `none`** (model sees
   no restart at all) + 5 no-candidate + only 6 called throw_in (5 below 0.80) — a classifier→none problem, not a
   gate problem (aggregate: throw_in→none = 107, its dominant loss). And throw_in precision collapses fastest when
   relaxed (**P0.83@.80 → 0.60@.50**), so lowering it buys ~nothing and costs the most precision. Its ceiling
   (B/#veo = 67%) is a features/model limit.

**The real lever = per-class thresholds, and they're the OPPOSITE of the intuition.** corner and kick_off are
over-gated at 0.80; throw_in is correctly gated; goal_kick is in between. Precision-first knees (P≥0.85 bar,
from `cfa_perclass_sweep.py`):

| class     | knee            | P    | R    | note                                                                   |
| --------- | --------------- | ---- | ---- | ---------------------------------------------------------------------- |
| corner    | **0.50**        | 0.91 | 0.73 | precision-robust — 0.80 is pure waste (+0.12 R at ZERO precision cost) |
| kick_off  | **0.65**        | 0.86 | 0.55 | +0.17 R over 0.80                                                      |
| goal_kick | **0.75**        | 0.85 | 0.52 | +0.08 R                                                                |
| throw_in  | **0.80** (keep) | 0.83 | 0.48 | relaxing tanks precision; loss is classifier→none                      |

Blended per-class = **P0.86 / R0.55** vs uniform-0.80 **P0.87 / R0.48** — a clean Pareto gain (+7 R for −1 P),
purely by RELAXING corner/kick_off, not touching throw_in. (A looser P≥0.80 bar → corner .50 / kick_off .50 /
goal_kick .65 / throw_in .80 ≈ **P0.83 / R0.61**.) The exact bar is a product-posture decision (unattended P≥0.90
vs light-review P≥0.85 vs tolerant P≥0.80).

**Structural recall ceiling (the real work, NOT threshold):** the 73% classifier ceiling is set by (i)
**kick_off↔goal_kick** mutual confusion (50 kick_off→goal_kick, 28 back — central-restart geometry on youth
pitches) and (ii) **throw_in→none** (107 — throw_in candidates look like generic play resumptions). These are
features/model levers. Candidate coverage is NOT the limiter anywhere in CFA (87–96% per class).

**SHIPPED (2026-07-20, Karim called the bar = light-review P≥0.85):** per-class medium thresholds now LIVE in
`emit_events.format_threshold` → `MEDIUM_PER_CLASS = {corner 0.50, kick_off 0.65, goal_kick 0.75, throw_in 0.80}`.
`emit_match` resolves per predicted class (`thr[cls]` when the band returns a map; scalar override path for sweeps
intact; `none`-safe). **Full band UNCHANGED (0.90 flat, its own band — knees NOT copied over) and small UNCHANGED
(None, review-only)** per Karim's two constraints. Unit-tested training-free (per-class map applied, scalar override
intact, no KeyError on `none`).

**Guardrail — non-CFA medium sanity (`noncfa_medium_sanity.py`, 20 held-out non-CFA medium matches deduped by
`-v<id>`, model trained on the rest incl CFA): PASS on the primary bar (no medium-band regression).** Knees vs
flat-0.80: OVERALL **P0.84/R0.40 vs P0.87/R0.33** (recall +0.07, precision −0.03 — same Pareto shape as CFA, recall
does NOT drop). Per class: corner +0.17R, kick_off +0.15R, goal_kick +0.08R, throw_in unchanged (same 0.80). **One
honest generalization gap: corner@0.50 holds P0.91 on CFA but only P0.83 on non-CFA medium** (corner is precision-
robust on CFA specifically, less so elsewhere) — still a favorable trade (+0.17R for −0.09P) and no overall
regression, but corner/throw_in sit at P0.83, just under the 0.85 line on this holdout. **Cheap follow-up if a
strict per-class P≥0.85 is wanted everywhere: nudge corner 0.50→0.55–0.60** (on CFA that's P0.92 at ~zero recall
cost; non-CFA fine grid not yet run). Left at 0.50 as adopted.

**STILL NOT DONE (deliberate):** the age axis needs a non-length signal (width? event density? per-match
calibration?) since length is a constant preset — near-term product is CFA u11+/SEFA so this is a follow-up, not
tonight. Structural classifier ceiling (kick_off↔goal_kick, throw_in→none) is the real modelling work later.
free_kick feasibility is the next queued item.

## free_kick feasibility spike — VERDICT: NO-GO as a distinct/provider-indep class (2026-07-20)

**Question:** can free_kick be spotted from player tracks _without_ leaning on the `ball_in_play`
resumption boundary (the crutch that carries the other four)? **Answer: no.** free_kick has no geometric
signature and its off-boundary cases are unreachable without bip. It rides the bip crutch at _marginal_
quality, no better than the four and worse. Scripts: `fk_boundary.py` (split + signature), `fk_model.py`
(5-class model + candidate ceiling), `fk_offboundary.py` (freeze recall + wall/cluster). 236 usable matches,
1875 free_kick events. All numbers emit-vs-Veo-tags (precision a lower bound), NOT ground truth.

**1. On/off-boundary split.** 79% of free_kicks sit within ±1.0s of a bip START (58% @0.5s, 81% @2.0s —
so ~85% claim was optimistic at the strict window). The **21% off-boundary are genuinely mid-play**, not
just outside tolerance: nearest-bip-start **p90 = 16.4s** (foul/quick-fk that bip never registered as dead).

**2. No geometric signature (the crux).** At the event instant, free_kick geometry is central/symmetric with
no boundary-hugger (cx 0.49, cy 0.50, frac_left 0.50, min_dtl 0.06) — **indistinguishable from kick_off and
open-play**. On- vs off-boundary fk geometry is also near-identical. The "wall" hypothesis is too weak in youth
football: max players within r=0.06 is **3 at fk instants vs 2 at random in-play** (mean 3.20 vs 2.60) — a real
but tiny separation, not a discriminator.

**3. Model — WITH the bip crutch (same basis as the four gated classes, GroupKFold, ±1.0s):**

| class     | prec | rec  | F1       |                                 |
| --------- | ---- | ---- | -------- | ------------------------------- |
| free_kick | 0.65 | 0.44 | **0.53** | marginal PASS (weakest of five) |

Adding free_kick as a 5th class **does NOT regress the four** (throw_in 0.72/0.76, corner 0.83/0.88,
goal_kick 0.73/0.85, kick_off 0.75/0.73 — within noise of the 4-class table). But free_kick's recall 0.44 is
far below corner 0.88 / goal_kick 0.85, and it smears across every class in the confusion matrix. **Overall vs
all Veo fk tags** (not candidate-conditioned): recall 647/1875 = 0.35, precision 0.65 → **F1 ≈ 0.45**. Precision
0.65 is **below the 0.85 light-review bar** the four restarts hold — not emit-ready at product posture.

**4. Model — WITHOUT the bip crutch (the actual session question).** Off-boundary fk recovered by the
provider-independent freeze detector: **0.43 corpus / 0.29 per-match recall at ~0.3 precision** (RESULTS caveat 1).
Compounded with the 0.44 classifier recall over a signature-less geometry, the non-bip free_kick path lands
**≈0.19 recall at sub-0.3 precision — well below the 0.50 gate.**

**Verdict:** **NO-GO** for free_kick as a distinct gated class or a provider-independent one. It is not
separable by geometry and its off-boundary fraction is unreachable without bip. The geometry lever is
**exhausted** — the only real lever left (ball-placement / defensive-wall detection) barely exists in youth
football and would need the ball, breaking provider-independence.
**Recommendation:** if free_kick is wanted in the Veo-parity producer at all, add it as the 5th class (it's
free and doesn't hurt the four) but keep it **review-only / out of the auto-emit set** — precision 0.65 fails
the P≥0.85 bar. Do NOT gate it, do NOT retune the four for it. Revisit only after the restart-instant-from-tracks
workstream lands (it's the same unlock, plus a signature fk still won't have).

## Workstream realignment — GOALS are the social product (Karim, 2026-07-20)

Social highlights = **goals**. kick_off = supporting structure (chaptering / restart-after-goal). free_kick
(parked), throw_in (features hole, low social value), shot (later) are **not** the publishing gate. **Do NOT
block social on the four-class restart producer.** Near-term cash = Veo clubs (CFA/SEFA): Veo goal + the
period-boundary FP filter (`phase1_events.is_goal_period_fp`) is the source of truth, and that path already
ships (portrait drafts). Provider-independent (Spiideo) goals = a separate, later workstream (needs ball→net /
aim-track-near-box / a learned stoppage→kick_off model — not more restart geometry).

### kick_off → goal corroborator — MEASURED (`kickoff_goal_corrob.py`, 236 matches)

Hypothesis: a **bip gap (dead spell) + kick_off, with period-start kick_offs filtered out** ⇒ a recent goal.
Causal chain: goal → ball out / celebration → centre kick_off. Measured against Veo goal + kick_off tags
(NOT ground truth):

- **A. goal → next kick_off latency:** median **20s**, p75 26s, p90 37s (n=1641) — tight and consistent, so
  the window is not sensitive (W=45s ≈ W=90s).
- **B. "bip gap" separates:** dead-spell before post-goal kick_offs median **20s** vs other kick_offs **176s**
  (the long ones are period starts / halftime). The period-start filter (±15s of a `periods` start) removes 440
  of 2139 kick_offs.
- **C. corroborator (concept ceiling):** non-period-start kick_off with dead≥1s ⇒ goal in [−90s,0]:
  **PRECISION 0.95 (1598/1674), per-match median 1.00; RECALL 0.96 (1610/1682 goals followed by such a kick_off).**

**Honest caveats (why this is a ceiling, not a shipping number):**

1. **Measured with Veo's OWN kick_off tags**, so 0.95/0.96 is partly Veo self-consistency (Veo may emit the
   kick_off _because_ it emitted the goal). Independence from the goal tag is unproven → this is **not yet a
   goal-RECALL booster on Veo** (it can't be assumed to catch goals Veo missed). The **76/1674 non-period
   kick_offs with NO goal in 90s** are the interesting residue (missed goals? mislabeled dropped-ball restarts?)
   — not inspected; too small to bank on.
2. A **produced** corroborator would use the _classifier's_ kick_off (P~~0.75/R~~0.73 @thr0.65), not Veo's, so
   real quality < the 0.95 concept ceiling.
3. On Veo, goals are already source-of-truth → the corroborator's independent value is **mostly chaptering +
   reinforcing the period-FP filter**, not new goals. Don't over-invest here.

**The real prize** this de-risks: on the provider-independent (Spiideo) path, "**track-derived stoppage +
centre-restart kick_off**" is a goal PROXY with a 0.95/0.96 ceiling _given clean inputs_. It's gated on
provider-independent stoppage detection (the freeze detector is ~0.3 precision today) — measure that compound
before building. That is the Spiideo-goals workstream, roadmap-after-Veo, **not** more free_kick/throw_in.

## GOAL→Spiideo transfer — tier-B PROOF CLEARS light-review on Veo (2026-07-20)

**Setup (Karim):** Veo goals = labelled teacher. Build a goal detector whose inputs ALSO exist on Spiideo
(player tracklets + pitch geometry, optional aim-track), prove it recovers Veo goals held-out, THEN run on
Spiideo. **Hard constraint — at inference NO Veo-only signals:** no `match-events`, no `ball_in_play`, no Veo
ball track (role 6). This retires restart tagging as the goal path (`kickoff_goal_corrob` used bip + the Veo
kick_off _tag_ — both banned here; it stays a side quest). Script: `goal_transfer.py`.

**Label:** clean Veo goal (`phase1_events.clean_events`, period-boundary FPs dropped). 1670 goals / 236 matches.

**Framing:** a goal → celebration LULL → CENTRE restart (kick_off), a full-team reset to own halves — the most
track-distinctive restart. **Candidates = track-derived motion resumptions** (`freeze_detect`, position-delta
motion, min_dead 3s — NOT bip). A candidate is positive iff a clean goal sits in `[t-90s, t-2s]`. Goal-level
P/R, GroupKFold by match (out-of-fold), detections merged @30s for a fair precision.
**Candidate-recall ceiling = 0.96** (a goal has a track resumption in +[1,90]s) → recall loss is the
classifier/gate, NOT "goals have no track signal."

| tier             | features                                                 | thr0.5 P/R  | thr0.7 P/R      | thr0.8 P/R  |
| ---------------- | -------------------------------------------------------- | ----------- | --------------- | ----------- |
| **B (transfer)** | players (roles 0-3) + pitch geom, **ball-free bip-free** | 0.77 / 0.60 | **0.89 / 0.43** | 0.94 / 0.28 |
| A (oracle)       | + Veo ball (role 6)                                      | 0.76 / 0.62 | 0.89 / 0.44     | 0.95 / 0.29 |

**Tier B clears the P≥0.85 light-review bar at R~0.43 (thr 0.7), held-out, on Spiideo-shaped inputs — a real
transfer GO, not a Veo crutch.** R0.43@P0.89 is assisted-auto grade (like the portrait pipeline), NOT full
Veo goal parity.

**Dominant features port to Spiideo** (measured pos-rate bottom→top quartile): `half_sep` **0.10→0.34** (the
post-goal team-reset-to-halves signature — the kickoff), `dist_center` 0.28→0.14 (someone on the centre spot).
The **pre-goal goal-mouth cluster is weak** (`gm_goalmouth` 0.13→0.17, `lull` 0.17→0.19) — the signal is the
post-goal RESET, not the scramble. That is exactly what you'd hope transfers to tracklets.

**Ball oracle — honest framing (the tier-A feature was buggy first; fixed):** the raw "ball beyond the goal-line
plane, central" signal is **P0.10 / R0.80** — in youth football the ball goes behind a goal line constantly
(out-of-play, wide pitches, imperfect normalized scale), so it over-fires ~10×. Its _usable_ information (goal vs
ball-went-out-behind) is only unlocked by the SAME stoppage→centre-restart context tier B already has → adding a
proper ball feature (penetration depth + beyond flag, short pre-kickoff window) lifts tier A by **+0.01 recall**.
So the Veo ball is a **teacher-quality lever at most, NOT a Spiideo requirement** — and as banked (2D foot-plane,
no net geometry) it isn't even a clean oracle. The recall gap from tier B (0.43) to the `kickoff_goal_corrob`
ceiling (0.95/0.96, which used the Veo kick_off TAG) is the cost of DETECTING the kickoff from tracks vs being
handed the tag — that is the modelling frontier, not the ball.

**Tier C (aim-track / camera path) — DEFERRED, not failed:** `camera_directions.det` is NOT banked in this
corpus (only player+ball frames). Testing the follow-cam aim/zoom proxy needs a re-fetch; do NOT block the
B→Spiideo path on it. It's the one extra signal Spiideo already has, so it's a pilot-time add.

**One feature is team-dependent:** `half_sep` uses roles 0-3 for team side (the strongest feature). Spiideo
tracklets carry team side (left/right from the H-solve), so it ports — but flag if a venue lacks clean team
assignment; the model leans on it.

**VERDICT: tier B = CONTINUE (transfer GO at assisted-auto grade).** Next gate is a **Spiideo pilot** — port the
same features onto Spiideo tracklets (+ aim-track for tier C), eyes-on a Nazwa/FP match vs any weak labels — NOT
more Veo retuning. If the ball oracle is ever built properly it only boosts the Veo teacher, not the Spiideo path.

## NEXT SESSION — Spiideo pilot (scoped, Karim 2026-07-20; START FRESH THREAD)

Veo proof is CLOSED — do NOT retune tier B further. Tier B @ P0.89/R0.43 on Spiideo-shaped inputs is enough
to open the real gate: does it fire on actual Spiideo tracklets? Constraints (hard):

1. **One venue only — the Nazwa pilot with ready tracklets** (known-good H / roster; the tracklets artifact the
   spotlight/roster work already validated — start there, NOT a sweep across venues).
2. **Exact tier-B feature defs from `goal_transfer.py`**: motion-resumption candidates (freeze-style position-delta
   activity → dead→live, min_dead ~3s) + `half_sep` / `dist_center` / centre-restart geometry + goal-mouth
   pre-window. **NO bip, NO ball** (Spiideo has neither). Reuse the functions; don't reinvent.
3. **Output = a timestamp list for eyes-on**, not DB / portrait / emit wiring. Candidate goal instants + prob,
   sorted, with a clip-seek time. Nothing persisted.
4. **Success = Karim watching clips**, NOT a P/R number — there are NO Veo labels on Spiideo. Count: obvious
   goals caught / obvious false fires on one match.
5. **Tier C (aim-track) ONLY if tier B is thin** on Spiideo — don't build the camera-path feature first.
6. **Flag team-side quality FIRST.** `half_sep` is the dominant feature and needs clean L/R team assignment.
   If Spiideo tracklets don't carry reliable team side, `half_sep` is garbage → that's the first failure mode to
   diagnose (does the model still fire without it? is there a team-free substitute?). Check this before trusting
   any output.

Data note: Spiideo tracklets = the `panorama-meshes/{gameId}/tracklets.json` artifact (per-player metric
positions, team side, opaque ids) — project into the canonical normalized-pitch frame via the venue pitch cal,
same as `goal_transfer` uses Veo-normalized coords. Loader is NOT `veo_corpus` (that's Veo-only) — needs a small
Spiideo tracklets reader. See [[spiideo-tracklet-items-gotcha]] (per-stream 16s item cadence, uuids persistent).

## Files

`veo_corpus.py` loader · `label_stats.py` distribution+alignment · `restart_features.py` kinematic features
· `restart_baseline.py` hand-rule floor · `restart_model.py` learned classifier (the gate) · `freeze_detect.py`
provider-independence probe · `audit_sample.py` builds `audit_data.json` (attaches follow-cam URLs) ·
`audit.html` / `audit_bundle.html` blind-first audit UI.

Regenerate the audit set: `python audit_sample.py <corpus> audit_data.json 8 standard_urls.tsv` then rebuild
the bundle (inline `audit_data.json` into `audit.html` as `window.AUDIT_DATA`). Open `audit_bundle.html`.

Phase 1: `phase1_events.py` canonical event record + goal-period-FP filter (`is_goal_period_fp`, one-sided
end-only) · `emit_events.py` the classify→emit producer (`train(exclude=…)` for honest held-out) · `sweep_emit.py`
stratified held-out + MIN_CONF sweep with per-stratum P/R · `cfa_panel.py` CFA held-out per-class P/R + recall
decomposition (A/B/C) + per-match variance · `cfa_perclass_sweep.py` fine per-class threshold grid (0.50–0.90).

free_kick spike: `fk_boundary.py` on/off-boundary split + per-class geometry signature · `fk_model.py` 5-class
model (adds free_kick) + candidate ceiling, single corpus pass · `fk_offboundary.py` off-boundary freeze recall
(provider-indep ceiling) + wall/cluster separation.

kick_off corroborator: `kickoff_goal_corrob.py` goal→kickoff latency + bip-gap separation + corroborator P/R
against Veo goals (period-start filtered).

goal→Spiideo transfer: `goal_transfer.py` ball-free/bip-free goal detector in tier A/B feature ablations
(track-resumption candidates + player-geometry + optional Veo-ball oracle), goal-level held-out P/R vs clean
Veo goals.

## GOAL→Spiideo transfer — PILOT RUNNABLE on the Nazwa match (2026-07-20)

Ported the tier-B features (`goal_transfer.py`) onto ONE real Spiideo match — the Nazwa pilot game
`d9fee1fc` (local artifact `lockstep-backup-20260718/artifacts/d9fee1fc-.../tracklets.json`). Script:
`spiideo_goal_pilot.py`. No DB / portrait / emit / persistence. Eyes-on is the gate (no Veo labels on Spiideo).

**TEAM-SIDE HEALTH (item 6, the first thing checked) — `half_sep` is UNAVAILABLE.** The Spiideo tracklets carry
NO team side and NO role. Public artifact = `{id, t, pan, tilt}` (camera angles); raw stream = `{uuid:[{timeOffset,x,y}]}`
(opaque id + position only); `build_track.py` never assigns team. So the dominant Veo feature (`half_sep`,
pos-rate 0.10→0.34) **cannot be computed**. This contradicts the RESULTS note above that "Spiideo tracklets carry
team side from the H-solve" — the H-solve gives pitch _position_, not team _identity_. Getting team side would
need a new clustering step (kit colour off the raw panorama, or L/R attack-direction inference) — not in this pilot.

**What the pilot runs instead (team-free tier-B subset):** candidates = motion resumptions (freeze-style
position-delta activity on pan/tilt → dead→live, min_dead 3s; 116 candidates, 56 after 30s merge). Features:
`dist_center` (the #2 Veo feature, 0.28→0.14, already team-free), `pan_spread` (both halves populated),
`mid_gap`+`symmetry` (a team-free RESET proxy standing in for half_sep). Confidence = a transparent reset-score
along the Veo-proven directions (celebration-length lull band ~12-32s + centred + wide), **NOT** a re-trained
Veo-model probability (no Veo corpus is local; over-tuning was explicitly banned).

**Coordinates:** the artifact is camera pan/tilt DEGREES (pan∈[-90,90], tilt∈[-82,83]), not a metric pitch frame.
The STRONG transferable signal is the post-goal RESET, detectable directly in pan/tilt, so the pilot does not block
on pan/tilt→pitch projection (that needs the venue mesh + cal — a tier-C add). Centre proxy = occupancy-weighted
median (pan,tilt) ≈ (-9.9, -28.1); distances axis-normalized by robust per-axis scale.

**Eyes-on shortlist (restart instant → scrub; goal ≈ restart-20s):** top non-[P] candidates —
30:04, 46:40, 02:34, 04:38, 21:03, 01:17, 47:18, 31:03, 03:23. `t` is the tracklet (raw-VP) clock; produced-video
scrub may drift ≤1.5s. Run `python spiideo_goal_pilot.py <tracklets.json>` for the full 22-row table.

**Two eyes-on caveats baked into the output:** (1) centre-restart geometry can't separate a post-GOAL kickoff from
a PERIOD-START kickoff — `[P]` flags the opening (0:28) + longest-dead restart; and the 2nd-half kickoff near the
midpoint (~28:00) is a suspect. This recording's longest dead spell is only 53s ⇒ halftime is trimmed out, so the
2nd-half kickoff looks like an ordinary mid-match restart (no periods stream here to filter it, unlike the Veo
corroborator). (2) No team side ⇒ the strongest reset signal is degraded to its spatial shadow.

**VERDICT: runnable, hand to Karim for eyes-on.** The real question the clips answer: with `half_sep` gone, does the
team-free reset-score still land on the actual goals, or is it just ranking every centre restart? If it's thin, the
next lever is team-side assignment (so `half_sep` comes back) BEFORE tier-C aim-track — team side is the bigger miss.

## GOAL→Spiideo transfer — EYES-ON FAILED, team-free path PARKED (Karim, 2026-07-20)

Karim eyes-on'd the guided shortlist for Nazwa `d9fee1fc`: **0 goals in the top-8** — the shortlist was ranking
centre restarts / stoppages, not goals. **Clean NO on team-free tier-B.** Verdict: Veo's P0.89 transfer GO
leaned on `half_sep` (the dominant feature), and the team-free substitutes (`dist_center` + `pan_spread` + lull
band) are NOT enough to survive on Spiideo. Root cause is not the pilot code — it's the missing feature: Spiideo
carries no team side, and centre-restart geometry alone cannot separate a post-goal kickoff from an ordinary
centre restart / the 2nd-half kickoff.

**Decisions (Karim):** do NOT widen to a 2nd match; do NOT wire anything (no DB/portrait/emit). `spiideo_goal_pilot.py`
stays as the runnable reference; the team-free path is parked, not deleted.

**Next lever (in order):**

1. **Restore team/side so `half_sep` can run** — kit-colour clustering off the raw panorama, or attack-direction
   over a window. This is the _real_ port of the Veo GO (NOT aim-track). Requires a new team-assignment step on the
   tracklets (the raw stream is `{uuid:[{t,x,y}]}` — no team; assignment must be derived).
2. **Re-run this exact Nazwa pilot with `half_sep` live**, eyes-on the new shortlist.
3. **Only if that still fails:** rethink — aim-track-near-box, ball vision, or accept Veo-only goals for the social
   product.

**Handoff to the team-side / identity session:** eyes-on failed (0/8 goals in the guided shortlist); team-free goal
path parked; **build team-side assignment next (kit colour / attack direction), then re-pilot `d9fee1fc`** with
`half_sep` live using `spiideo_goal_pilot.py` as the harness (swap the reset proxy for real `half_sep`). Banner left
in `scripts/player-identity/NEXT-SESSION.md`.

## GOAL→Spiideo transfer v2 — REAL half_sep RESTORED, Step-0 gate PASSED, shortlist READY for eyes-on (2026-07-20)

Executed the "next lever": restored team side + metric pitch geometry, so `half_sep` (the dominant Veo feature that
the team-free v1 lacked) is now REAL on Spiideo. All code + artifacts in `spiideo-goal-pilot-v2/` (self-contained,
runnable, README + shortlist + annotated frames). **Awaiting Karim's eyes-on** — the only gate (no labels:
`playhub_recording_events=0`, highlights=0).

**Step 0a — panorama live (load-bearing gate):** HEAD confirmed `panoramas/d9fee1fc-.../d949295d-...mp4` = 2.31 GB,
Standard storage (not Glacier), `panorama_capture_status=ready`. 3840×2160, 25 fps, 56 min, single-lens (no seam).

**Step 0b — kit-cluster GO/NO-GO: GO (kits separate, unlike HCT's both-dark clash).** 643 torso samples over 64
open-play frames (YOLO person boxes in a play window → grass-normalised two-tone `kit.shirt_lab`) → **silhouette
0.564 per-crop / 0.555 per-object, natural k=2** (bar = B2's 0.35; B2's accepted clustering scored 0.674). The two
clusters are **yellow** (b≈150) vs **navy** (b≈126); territorial pan bias 13.5° in the expected direction. Projection
sanity `proj_check.jpg`: pan/tilt→ray→mesh→pixel lands on every player's feet.

**Step 1 — real half_sep (metric projection + kit teams):** each detected player → team (kit centroid, GK/ref → other)

- pitch metres (`inv(H_local)` composed from artifact `pan/tilt` → world ray) → `goal_transfer.half_separation` over
  kit teams. Validated on frames: **1.00 at the opening kickoff** (5L yellow / 5R navy, textbook split), **0.5 at a
  goalmouth scramble** (both teams same half — correctly demoted), 0.6–0.75 mid-play.

* **⚠️ Mesh-epoch gotcha (documented in the README):** the ACTIVE DB calibration (2.79 px) was marked on a DIFFERENT
  mesh epoch (2026-07-18-night tangential refit + re-mark) than the lockstep artifact/mesh — its homography does NOT
  round-trip the marks on the lockstep mesh (corners off 20–40 m). Fix: the mark PIXELS are physical (mesh-independent);
  `pitch_solve_local.py` re-solves the pitch homography from the 6 mark pixels through the lockstep mesh's barycentric
  `uvToRay` → an H consistent with the artifact frame (round-trip max 1.08 m, midline 0.1–0.3 m; player cloud then
  matches the job's own `polygonSpanM=[21.5,13.2]`). Also: `nearest-UV` lookups are AMBIGUOUS (4 overlapping mesh
  projections in uv space) — use barycentric for pixel→ray, direct trig for pan/tilt→ray.

**Step 2 — re-pilot shortlist (`shortlist.txt`).** `reset_free` (the team-free half_sep SHADOW) swapped for real
`half_sep`; aim-track pre-restart swing bundled as an independent sensor (camera swung to an end = shot/goal). Ranked
by a half_sep-dominant reset score. **Top non-period candidates: 2:34, 4:21, 46:16, 3:23, 1:17** — all `half_sep=1.0`,
celebration-length dead spells (16–36 s), large camera pre-swing (44–62°). Annotated frames confirm the top candidates
are team-separated goal-aftermath/kickoff scenes (e.g. 2:34: navy bunched at their goal, yellow spread in attack),
categorically different from v1's undifferentiated centre-restarts.

**Honest ceiling (unchanged from Veo):** `half_sep=1.0` fires for ANY team-split moment, not goals uniquely (Veo's
top-quartile pos-rate was 0.34); it CONCENTRATES goal-like kickoffs, the lull band + centre-spot + aim swing sharpen
it, but centre-restart geometry still cannot separate a post-goal kickoff from a period-start kickoff (`[P]` flags the
opening + longest-dead; the 2nd-half kickoff near the midpoint is also a suspect — no Spiideo `periods` stream).

**NEXT:** Karim eyes-on the shortlist on /watch (scrub `goal~` ≈ restart−20 s, then `restart`). Success = obvious goals
caught / obvious false fires on this one match. If it passes: freeze, widen to 1–2 more Spiideo matches, THEN
(explicitly-approved, separate step) wire goal tags into the portrait/highlights path. If thin: tier-C aim-track-near-box
is the next add. DO NOT wire anything or write DB/production until Karim approves.

## STOPPAGE MODEL SPIKE — dead-before-kickoff gate CLEARS on Nazwa (2026-07-21)

Workstream re-prioritized by Karim: goals for ANY recording is the top priority, overriding the 07-20
"Veo-only default / stoppage model later" decision. This spike builds item 1 (the learned stoppage model)
and closes the loop the v3 pilot left open: its 8 residual FPs were open-play centre transits, separable
only by CONTEXT (ball dead -> reset -> restart). Code: `stoppage_features.py` (player-only kinematic
channels + multi-scale context), `stoppage_model.py` (labels from bip, GBT, edge decode), `stoppage_diag.py`,
`stoppage_trigger.py` (event-triggered channel analysis), `stoppage_localize.py` (boundary head),
`stoppage_viterbi.py` (semi-Markov duration decode), `stoppage_context.py` (the product query),
`stoppage_train_full.py` + `stoppage_clf_full.pkl` (inference artifact), `stoppage_spiideo.py` (Nazwa transfer).

**Supervision:** Veo `ball_in_play` = ~24k labeled dead/live segments across 236 usable matches, aligned to
the same tracks. Spiideo-conditions discipline throughout: no ball, no Veo speed column, no jersey, no
GK/outfield roles; team channels EXCLUDED from the transfer model (kit-team is per-instant on Spiideo).

**1. Committed gate (autonomous resumption-instant recovery, ±2s, match-grouped 5-fold):** 25-match runs
plateaued ~0.55/0.53 across FOUR decode architectures (hysteresis, matched-filter edges, two-stage boundary
localizer, semi-Markov Viterbi) — but the plateau was DATA STARVATION: the full 236-match corpus reached
**P0.68 / R0.66** (per-match median 0.68) with raw-metric features. Gate 0.7/0.7 = near-miss; aligned-features
rerun result in `stoppage_full_v3_out.txt`. Diagnosis trail: dead gaps are long (med 15.6s, none <2s); the
dead spell is VISIBLE before 85% of resumptions (pre-window maxP med 0.97); the loss is edge placement — the
kinematic transition ONSET sits at the bip start (med_speed min at -1s, frac_slow peak -2..-1s, min_dtl
v-shaped min AT 0) but P(dead) ramps over ~4s.

**2. The product query — dead-context — is what v3 actually needs, and it clears.** score(t) = mean P(dead)
over [t-6s,t-1s]. Held-out Veo (40 matches, safe channels, domain-aligned features): **TPR 0.94 on kick_off
tags @ FPR 0.11 on HARD kickoff-lookalike open-play negatives** (centre-occupied + half-separated mid-play
instants = the Veo analogue of v3's FP class). Hard negatives score barely above easy ones (med 0.04 vs
0.03) — dead-context is near-orthogonal to kickoff geometry, so it COMPOSES with the P_ko gate instead of
duplicating it. TPR-all is lower (~0.86 @0.4) — quick throw-ins have weak dead spells; goals don't care.

**3. TRANSFER — first attempt FAILED with a clean diagnosis, then PASSED. Do not regress this:**
raw 1-frame metric speeds do NOT transfer. The Spiideo artifact tracks are Kalman-smoothed 5 Hz (0.2s
displacements crushed ~3x: Nazwa med_speed read 0.55 m/s vs corpus 1.41) and fragment churn (16s-median
chains) jerks a naive centroid (read 2.6x HIGH). The model saturated P(dead)=0.96 for the whole match.
Fixes (now baked into `frame_channels`, cache-v3): (a) speeds over a ~1s displacement baseline;
(b) centroid speed over the matched player subset only; (c) motion channels RELATIVE to the match's own
median play speed v0 (frac_slow thr = 0.5*v0); spreads as pitch fractions; taker distances stay metric with
pitch dims as context. The aligned features also IMPROVED Veo held-out numbers — relative normalization is
simply the better representation.

**4. Nazwa result (the 12 v3 survivors, retrospective vs Karim's 07-20 eyes-on labels):** goals score
0.96-0.99 = the TOP of the deadctx distribution; FPs spread 0.38-0.96. Two "high FPs" are episode
duplicates (2806 is 32s before the 2838 goal kickoff = same goal aftermath; 745/777 one stoppage pair).
After a 45s episode merge, ranking by dead-context: **precision@4 = 4/4 — all four goals ranked 1-4**,
first FP at #5 (0.86 vs goal-min 0.96). v3's P_ko ranking had goals interleaved at 3/4/7/10.

**Honest caveats:** (a) n=12, retrospective, same match+labels Karim already judged — the threshold must NOT
be locked from this; (b) the model still over-predicts dead in absolute terms on Nazwa (81% of frames >0.5) —
the RANKING transfers, absolute calibration does not; use within-match percentile calibration if a hard
threshold is ever needed; (c) match goal COUNT still unknown (the recall fork from 07-20 stands); (d) the
projection chain uses the pilot's re-solved H_local — productionizing needs the mesh-epoch-consistent H per
game (same gotcha as the v2 pilot).

**NEXT:** (1) fresh eyes-on = regenerate the shortlist with deadctx live + the tau->0.35 recall probe scored
by deadctx (recovers goals v3's gate dropped, at shortlist quality the 33%-precision version couldn't afford)

- Karim watch for the goal-count denominator; (2) if that passes, wire the composition (motion-resumption
  candidates x P_ko x deadctx x period filter) as the Spiideo goal producer behind the same review-first
  posture as portraits; (3) ball-label bootstrap (project Veo metric ball through alignment.veo into native
  panorama pixels; ~1M+ auto-labels; hand-label ~500-1k clean teacher frames; speed-gated co-teaching) stays
  the parallel strategic lever — direct evidence vs inferred context.

## VEO FREEZE — frozen chain on held-out Veo, ship gate: GO (marginal, review-first) (2026-07-21)

The FROZEN Nazwa shipping chain (continuous tracklet-fed P_ko -> trailing dead-evidence [max deadctx over
[t-30,t-5] >= 0.90] -> peaks P_ko>=0.5 + 45s merge -> envelope [opening = earliest P_ko>=0.5 kickoff,
end = last activity block] -> period_gap_clf @0.5 -> pre-declared ranking .35hs/.35lull/.15swing/.15pko)
run on the whole Veo corpus, **match-grouped 5-fold out-of-fold** (236 matches / 1670 clean goals; the three
models — stoppage/dead, kickoff, period-gap — re-fit per fold on TRAIN matches with the shipped
hyperparameters; every constant frozen at the Nazwa value). Track source = tracking.json player positions
through the SAME feature path as Spiideo tracklets (no bip, no ball, no Veo speed col at inference; roles
used only as the two-kit-team partition for half_sep — the accepted kit-cluster stand-in; aim swing = 0,
camera_directions not banked). Labels = clean FootballGoal (`is_goal_period_fp` filtered). An episode
[t0,t1] hits a goal iff `t0-PRE <= goal <= t1` (PRE=45s for the current clip window, 90s = the Veo-measured
goal->kickoff latency envelope). Success bar written and locked from the fold-1 smoke BEFORE the full run
(scratchpad success-bar.md): medium recall90>=0.75 @ shortlist<=18, precision>=0.30, leak<=2%.

| band                 | matches | goals | recall45 | recall90 | precision | shortlist med | P@8  | R@8  |
| -------------------- | ------- | ----- | -------- | -------- | --------- | ------------- | ---- | ---- |
| **medium (product)** | 117     | 869   | 0.67     | **0.75** | **0.31**  | 16            | 0.36 | 0.36 |
| full                 | 42      | 270   | 0.59     | 0.76     | 0.30      | 18            | 0.40 | 0.35 |
| small                | 77      | 531   | 0.70     | 0.75     | 0.37      | 14            | 0.42 | 0.45 |
| ALL                  | 236     | 1670  | 0.67     | 0.75     | 0.33      | 15            | 0.38 | 0.39 |

**Verdict vs the locked bar: GO — marginal, review-first only.** Medium recall90 0.748 (bar 0.75, binomial
SE ±1.5% on 869 goals), precision 0.313 (bar 0.30), period-kickoff leak 1/2034 episodes. Duplicate-TP
inflation checked: 55/1246 TP episodes — precision honest. Per-match variance is real: medium per-match
recall90 med 0.75, p25 0.60, **p10 0.33** (1 in 10 matches gets a third of its goals).

**What the audit says (all automatable on Veo; the 2-3-match human three-way watch stays queued,
non-blocking):**

- **Miss taxonomy (419/1670):** `no_dead_evidence` 187 (the 0.90 floor — set on Nazwa's SATURATED deadctx
  distribution — bites on Veo-native calibration; exactly RESULTS caveat (b) from the spike) ·
  `pko_below` 160 (best-P_ko med 0.30; the tau->0.35 probe would recover 61) · period_filter 28 ·
  opening-drop 26 · no_grid 10. 36 misses are goals at the final whistle (no kickoff follows —
  structural ceiling, ~2%).
- **Floor sensitivity (recall-side only; precision needs a re-decode):** floor 0.80 -> medium recall90
  0.806 (+50 goals), 0.70 -> 0.829. **A floor-0.80 re-decode with precision measured is the single
  highest-value chain revision — queued, NOT applied (frozen).**
- **FP taxonomy (2561 ours-only episodes):** open_play 1506, other_restart 1022 (corners/goal-kicks with
  genuine dead context — the known class), `veo_kickoff_no_goal` 29 (the corroborator residue: real
  kickoffs Veo never attached a goal to — candidate VEO recall misses for the human watch),
  period_kickoff_leak 4 (the period clf works), flagged_goal 0.
- **RANKING DOES NOT TRANSFER — ship the shortlist, not the top-8.** P@8 ≈ base precision on every band;
  goal rank med 8 of ~16. Component audit: on Veo held-out the **lull term is INVERTED** (FP episodes —
  restarts after long stoppages — carry LONGER lulls, med 8.8s, than goal kickoffs, 6.0s), hs separates
  mildly (0.71 vs 0.61), pko mildly (0.88 vs 0.80). The Nazwa 5/6-in-top-8 was n=1. Weights were NOT
  refit (frozen); rank-feature revision is a measured follow-up.
- **Envelope:** opening err vs first period start med +10.9s but only 50% within 45s (health metric
  missed); impact channels small (opening-drops 1% of medium goals, leak 0.05%) — structurally OK,
  cosmetically noisy. The fold-1 port bug (requiring dead-evidence on the opening kickoff — warm-up reads
  LIVE, so the true opening rarely has it, and post-goal kickoffs got mislabeled "opening", eating early
  goals) is fixed: opening = earliest P_ko>=0.5 peak WITHOUT the evidence floor, the v2/v3 semantics.

**Product consequences for the Spiideo review-first producer (the GO shape):** clip pre-roll must be 90s
(recall45->recall90 gap = kickoff detection lag; at 45s pre-roll a quarter of caught goals aren't in
their own clip); present the FULL ~15-clip shortlist unranked (or ranked but exhaustive) — the ranking
only orders, it does not concentrate; expect ~1-in-3 clips to be a goal, ~7-min review per match;
small-sided is NOT weaker on Veo (0.75/0.37 — the strongest precision band), so the Nazwa small-sided
caution downgrades from "may stay weaker" to "unproven per-venue, not structurally worse."

**Reproduce:** `STOPPAGE_CACHE=<cache-v3> python stoppage_veo_freeze_prep.py <corpus> <sidecar_dir>` (one
pass, ~10 min) then `python stoppage_veo_freeze.py <sidecar_dir>` (5 folds, ~25 min) then
`python stoppage_veo_freeze_report.py freeze_results.json`. Frozen constants live at the top of
`stoppage_veo_freeze.py`, each annotated with its source script.

**NEXT (in value order):** (1) floor-0.80 re-decode with precision measured (the one cheap recall lever);
(2) wire the review-first Spiideo producer (behind portrait-style review posture; nothing auto-publishes);
(3) the queued 2-3-match human three-way watch (our-miss / veo_kickoff_no_goal residue / ours-only);
(4) rank-feature revision (drop or invert lull, add deadctx-at-anchor) — measured on this same freeze
harness before any re-freeze; (5) ball-label bootstrap unchanged as the strategic parallel lever.

## FLOOR 0.80 RE-DECODE — ADOPTED (2026-07-21, closes freeze NEXT #1)

Full 5-fold re-decode at `DCTX_FLOOR=0.80`, everything else frozen (same harness/sidecars/fold seed; adopt
rule locked in Cursor's plan BEFORE the numbers: ADOPT iff medium recall90>=0.75 AND precision>=0.30 AND
shortlist med<=18 AND leak<=2%). Engineering: the OOF P_ko/deadctx/evidence series are now cached per match
(`--series-dir`), so a floor re-decode costs ~1 min instead of a ~25-min refit; the refactor was verified to
reproduce the 0.90 baseline **bit-for-bit (236/236 matches identical)** before the 0.80 decode ran.

| medium (product band)  | floor 0.90  | **floor 0.80** |
| ---------------------- | ----------- | -------------- |
| recall45               | 0.673       | **0.754**      |
| recall90               | 0.748       | **0.812**      |
| precision              | 0.313       | 0.309          |
| shortlist med          | 16          | 18             |
| period leak            | 1/2034      | 2/2224 (0.09%) |
| per-match recall90 p10 | 0.33        | **0.50**       |
| P@8 / R@8              | 0.36 / 0.36 | 0.37 / 0.40    |

**All four adopt criteria pass → ADOPT.** The floor was the binding constraint exactly as diagnosed: +64pp
recall45 / +64 goals recall90 for a precision cost of 0.004 and +2 clips/match. The tail matches benefit
most (p10 recall90 0.33→0.50 — the floor was wiping out matches whose native calibration ran low). Other
bands: full 0.76→0.84 recall90 @ P 0.305, small 0.75→0.79 @ P 0.354 — same shape everywhere. Remaining
miss taxonomy is now dominated by `pko_below` 160 (the kickoff classifier, unchanged by the floor) +
period/opening drops 63 + `no_dead_evidence` 76 (floor 0.70 buys only +15 medium goals — the floor lever
is now spent; next recall lever is the kickoff path, not dead-context).

**Applied:** `DCTX_FLOOR=0.80` is the freeze default (`stoppage_veo_freeze.py`) and mirrored in the pilot
(`stoppage_trackko.py`, whose rank/period-apply scripts import it; `stoppage_recall_sweep.py DCTX_MIN`).
Artifacts: `freeze_results_floor080.json` (the new baseline reference), `freeze_results.json` (0.90),
`freeze_results_f90_verify.json` (refactor-equivalence proof). Reproduce:
`python stoppage_veo_freeze.py <sidecars> --dctx-floor 0.80 --series-dir <series>`.

**NEXT (updated):** (1) wire the review-first Spiideo producer at floor 0.80 (full shortlist, 90s pre-roll);
(2) human 2-3-match three-way watch; (3) rank-feature revision on this harness; (4) kickoff-path recall
(pko_below is now the dominant miss class — tau probe recovers 61/160 recall-side, needs the same
precision-measured discipline as this re-decode); (5) ball-label bootstrap.

## SPIIDEO PRODUCER WIRED (2026-07-22) — goal-detect Batch class + platform-admin review, commit `1f451db6`

The frozen chain is production code: `infrastructure/batch/goal-detect/` (CPU-only, vendored
inference-only ports — every module names its frozen source; senior review diffed all of them against
the originals and found ZERO functional drift). Full plan: `~/.claude/plans/giggly-jumping-ullman.md`.
Product decisions (Karim): approve = `goal` event into `playhub_recording_events` (source='ai_detected',
provider='spiideo', provider_event_id=candidate id, visibility='public' v1) → /watch timeline marker;
platform-admin-only review during the pilot; chronological full shortlist (no ranking — measured
non-concentrating); clips 90s pre-roll.

**PHASE-1 STOP-SHIP GATE — PASSED, twice, and this is the log (per Karim's explicit ask):** the ported
chain run on the LIVE Nazwa tracklets artifact with the LIVE ACTIVE DB calibration (scene `131777a6-…`,
2.79px reprojection, `calibration_unusable_reason` → USABLE, mesh epoch `b923d40f` == registry — NOT the
pilot's H_local.npy) reproduces the pilot's **6/6 eyes-on goals at kickoff anchors
[989, 1142, 1373, 1626, 2479, 2838]**; 21 episodes → 19 survivors (≈ freeze shortlist med 18; precision
on this match 6/19 = 0.32 ≈ the measured 0.31), envelope 154–3335s, projection drop rate 0.03%.
Run 1 = the initial port; run 2 = after the pan-mirror guard (byte-identical episode set). Gate script:
scratchpad `nazwa_gate.py`. Note the port scans the WHOLE match (the freeze's validated behavior), so a
few warm-up-region episodes survive that the pilot's hand-derived 777s envelope excluded — that leakage
is inside the freeze's measured precision.

**Reviewed by 5 specialists, all findings fixed:** DB (NULL provider_recording_id voided the NULLS-DISTINCT
unique backstop → route refuses + partial unique index on (provider, provider_event_id) applied; redundant
index dropped) · API (idempotent double-approve, 23505 convergence, prototype-safe action lookup, DB-errors
no longer masquerade as 404, localized notices) · security (sha pins FAIL CLOSED before unpickle; job-role
S3 write DENY on the weights prefixes — the veo-capture keys/* threat model; goal-review-clips bucket
verified private with zero storage policies) · infra (pins verified byte-for-byte vs S3; clip retry-resume;
AWS_REGION pinned in the job def; IAM sweep registration verified both halves) · senior (staleness gate
BEFORE clips + digest-keyed clip paths — stale-adoption impossible; reconciliation extracted pure +
7 tests incl. the pinned zero-survivors-supersedes-drafts behavior; sweep calibration pre-gate;
started_at-NULL CAS arms; constants.json wired as a frozen-constant drift canary; |pan|≥89.5° mirror guard).

**Deployed & verified:** 9 tf resources + 2 in-place policy edits (`-target`, plans eyeballed, 0 destroy) ·
CodeBuild image → ECR · invalid-UUID smoke = died at the UUID parse AFTER imports (module resolution
healthy, zero data risk) · Lambda live with GOAL_DETECT_JOB_DEF/QUEUE set · migrations applied + types
regenerated · gates: tsc clean, 1075 app tests, 52 sweep tests, 12 job pytests, build OK, Netlify pushed.
**Sweep DISABLED (`GOAL_DETECT_SCENES` empty).** Enable-order invariant documented in sync-lambda.tf:
allowlist a scene only when its calibration is green-band + epoch-current (the sweep pre-gates only on
"an active row exists").

**Remaining before Nazwa enable:** set `goal_detect_scenes` tfvar + re-apply the Lambda target → sweep
drill (watch claim→submit→ready; "0 submitted, N claimable" = check IAM first) → clips + candidates
eyes-on → E2E approve → /watch marker. **Follow-ups (deliberate):** clip-prefix purge on recording
deletion (minors' footage lifecycle — M1, security); orphaned clip objects across artifact epochs
accumulate (digest-keyed, never adopted, never deleted); sweep observability (8th job class on
console.error-only); venue-admin review = flag flip later; visibility='private'+access-checked reads
alignment (footnote); `constants.json` canary covers 6 chain constants (extend if chain.py grows).

## NAZWA ENABLED + E2E PASSED (2026-07-22, Karim in the loop) — the producer is LIVE

**Enable sequence executed:** calibration band verified GREEN server-side (rel 0.00089 vs the 0.005
boundary; epoch match) → `goal_detect_scenes` tfvar + Lambda `-target` apply → **the sweep's first
autonomous claim→submit worked on its own tick** (claimed the newest Nazwa recording; the earlier
"0 submitted, 19 claimable" line was the in-flight cap honoring my manual pilot claim, NOT the IAM
trap — no row ever carried 'sweep submit failed'). That sweep-submitted job completed fully
autonomously: 18 candidates + 18 clips, zero manual involvement.

**One production bug found on the very first pilot run and fixed same-hour:** the Supabase project's
global storage cap is **50MB** (measured: a 60MB POST returns HTTP 400 wrapping a 413 body) and a
550s-span episode produced a 648s clip that blew it. Fix: `CLIP_MAX_S=300` + a 1000kbps maxrate
ceiling (worst case ~38MB) + the upload error now names the size. Retry resumed from the 6 banked
clips (the digest-keyed skip guard doing exactly its job). Pilot run 2: **ready, 19 candidates,
19 clips.**

**E2E APPROVE — PASSED, with a plot twist that produced the best product finding of the session.**
Karim reviewed the 16:28 candidate strip clip and called "not a goal"; the raw-panorama re-cut of the
same 176s window flipped the verdict — **goal confirmed at 1:11 into the clip (969s match time)**,
matching his two earlier eyes-on confirmations. The approve chain end-to-end: strip → inline clip →
approve → `ai_detected` goal event (`48971541`, provider='spiideo', provider_event_id=candidate id,
public) → **"16:08 Goal" marker live on /watch**. The estimated event timestamp (anchor−20s = 968s)
landed **1 second** from the true goal moment.

**Two VALIDATED product follow-ups from the E2E (queue in this order):**

1. ~~Review clips from the raw panorama~~ **RETRACTED same night (frame-level evidence):** the
   autofollow did NOT hide the goal — same-instant frames from the strip clip (offset 71s), the
   produced video (t=969s), and the raw panorama all show the identical goal aftermath (keeper
   down, scorer wheeling away). Sources share one clock; the clip cutter is frame-accurate. The
   false "not a goal" was an incomplete watch: the goal sits 1:11 into a ~3-min clip. **The REAL
   finding: the reviewer has no cue WHERE in a long clip to look.** Fix = start the inline strip
   player ~10s before the estimated goal (clip-relative: anchor−20−clip_start−10) and/or a
   "goal expected here" tick on the scrub bar. Produced-render clips stay (they're the better,
   zoomed review view — verified pointing at the finish).
2. **Unapprove path** — Karim wanted to undo an approve mid-review before the recheck flipped him;
   the repair-state design anticipated event deletion but the pilot deliberately shipped without it.

**State at close:** producer LIVE on the Nazwa allowlist, draining ~19 remaining recordings at
1/tick autonomously; 2 matches fully processed (37 candidates, 37 clips); 1 approved goal on /watch.

## FULL PILOT REVIEW (Karim, 2026-07-22 late) — NINE goals; the 6-goal denominator was an undercount

With the seek-to-goal player live, Karim reviewed the entire 19-candidate strip: **9 approved goals**
(anchors 512, 891, 988, 1134, 2054, 2200, 2464, 2814, 3315), all as public /watch markers. FIVE were
unknown to every prior eyes-on round (8:32, 14:51, 34:14, 36:40, 55:15) — the sweep-based eyes-on that
"closed" the denominator at 6 was itself recall-limited; treat historical per-match totals as lower
bounds. Match precision 9/19 = **0.47** (freeze average 0.31).

**New product gap (next item):** one candidate = one marker, but the 1134 merged episode (~550s span)
contains THREE known goals (the 1142/1373/1626 kickoffs) — multi-goal flurries collapse to a single
marker. Options: approve-many per candidate (event per confirmed goal moment), or split merged episodes
on distinct dead→live cycles before candidate emission. The hint-copy lesson applies here too: in
merged episodes the anchor−20 estimate marks only the FIRST kickoff's goal.

## WHAT KARIM'S 19 LABELS TAUGHT US (2026-07-22, post-review analysis)

The full pilot review produced the FIRST complete Spiideo-native goal/no-goal label set (9/10 across
all 19 candidates, review-grade, stored on the candidate rows — every future review session grows this
corpus at zero marginal cost; the review-first producer doubles as a labeling machine).

1. **Detector confidences carry ~zero goal signal within the shortlist** (approved P_ko med 0.89 vs
   rejected 0.90; deadctx saturated ~0.99 both) — Spiideo-side confirmation of the freeze's
   ranking-doesn't-concentrate finding. The human review IS the classifier; not a crutch.
2. **EPISODE SPAN separates — and it generalizes.** Nazwa labels: approved med span 89s vs rejected
   16s. Tested immediately on the 236-match freeze record (OOF, no fitting): TP med 14s vs FP 0s;
   **ranking by span ALONE beats the shipped hs/lull/swing/pko composite — P@4 0.492 / R@8 0.474 vs
   P@4 ~0.43 / R@8 0.418** — despite span being FREE, provider-native (no kit/YOLO/aim-track), and
   already in every candidate row. Mechanism: goals spawn LONG stoppage chains (celebration → reset →
   multiple kickoff-grade peaks); routine restarts are single short peaks. This is the measured
   direction for the queued rank-feature revision (and a natural input to any future auto-approve
   posture); adopt via the freeze harness, not per-venue tuning.
3. **Complete-review > sweep-review for ground truth**: 5 of 9 goals were invisible to every prior
   research-grade eyes-on pass. Sweep-based denominators are lower bounds.

**KARIM'S RULING ON THE THREE LEARNINGS (2026-07-22): 1 and 3 adopted as stated. 2 adopted with a
hard limit — span is REVIEW RANKING ONLY** (strip now sorts span desc, shipped `d253442e`);
**auto-approve on span is PARKED** until a precision curve at stated span thresholds exists over more
reviewed matches (the floor-0.80 re-decode discipline). Reason: long span ≠ one goal — injuries,
delays, and multi-goal merged episodes also inflate span; a span floor would mint one marker for
multi-goal bags and false-approve long non-goal stoppages.

## MULTI-GOAL MARKERS SHIPPED (2026-07-22, late) — N markers per candidate, reviewer-side only (commit `2b7ce617`)

The 7.6% episode-collapse marker loss (94/1234 recovered goals on freeze; pilot 18:54 episode = 3
goals / 1 marker) is closed on the REVIEW side — the frozen chain is untouched (no chain.py /
terraform / batch changes). Cursor plan `multi-goal_markers_2705a60c` followed as locked.

**Schema:** `playhub_goal_candidate_events` link table (NOT uuid[]) — `(candidate_id, event_id)` PK,
`event_id` plain uuid no FK (audit-log lesson), `stamp_source` (`anchor_offset`|`human_scrub`) +
`stamp_seconds`, RLS deny-all, CASCADE from candidates. Backfilled from `approved_event_id` (9/9
verified, 0 dangling). `approved_event_id` stays the PRIMARY/first stamp for repair-state compat.
New events carry `provider_event_id = their own id` (partial unique stays one-row-per-marker);
legacy events keep `provider_event_id = candidate id` — BOTH keyings honored in repair discovery
and the unapprove safety-net delete.

**API (PATCH, platform-admin, count-CAS):** `approve` (+optional `timestampSeconds`, default
anchor−20), `add_goal` (requires ts; from draft = approve path; while approved = append),
`remove_event` (one marker; last one = unapprove semantics → draft), `unapprove` (delete ALL linked
events FIRST, not gated on the stamp). GET returns `events: [{eventId, stampSource, stampSeconds}]`
per candidate. **Load-bearing invariants:** (1) LINK-BEFORE-EVENT — the link row is written first,
the event gets `id = provider_event_id = link.event_id`, so a mid-flight failure leaves a
discoverable link with no marker, never a public marker no unapprove can find; do NOT "compensate"
by deleting the link on an event-insert error (ambiguous failures commit server-side — senior C1);
(2) the primary stamp is a CAS (`status='approved' AND approved_event_id IS NULL`) with rollback of
this request's own event+link on loss — closes the approve/unapprove interleave orphan (security M1)
and the repair double-mint (senior H2); (3) remove_event orders delete-event → repoint-primary →
drop-link so every failure converges on retry; (4) retries return the ACHIEVED state, never an error
for the outcome the admin wanted (approve idempotent, remove-of-gone-marker 200, reject/restore at
target state 200); (5) 502-with-code = "retry to finish" (`event_write_failed` / `goal_add_failed` /
`event_delete_failed`), all localized. Never return a module-level cached NextResponse (one-shot
body — H1). Human scrub stamps beat a stale anchor-offset pending link's estimate.

**Strip UI:** "Add goal at this moment" on the playing card (stamps `clip_start + currentTime` on
the produced clock; from draft it approves), per-marker mm:ss chips with per-chip remove, unapprove
= clear all; the playing card's signed clip URL is PRESERVED across refreshes (a fresh URL reloads
the video and resets the playhead — would have broken the exact scrub-stamp-scrub workflow this
ships; senior H3). en/es/ar.

**Reviews:** senior (C1 compensation-strands-marker + H1 cached response + H2 double-mint + H3
playhead reset — all fixed), security (M1 interleave orphan — fixed; L1 legacy-lookup scoping, L2
ts ceiling 86400 — fixed), api-architect (idempotency matrix MUSTs/SHOULDs — fixed; add_goal
client-eventId idempotency deliberately SKIPPED: duplicates are visible removable chips, and a
client-controlled id adds surface), database (pass; 0-dangling backfill query verified live).

**Gates:** 1103 unit tests (18 new on the pure decision lib `src/lib/goal-review/multi-goal.ts`),
tsc clean, lint clean, build OK; migration applied + types regenerated. Deploy `2b7ce617` pushed.

**Eyes-on protocol (Karim, pilot recording `29db2c00…`, candidate 18:54 / anchor 1134):** play the
clip → scrub to each of the 3 goals (~18:42, ~22:33, ~26:46 match time) → "Add goal at this moment"
×3 (the first replaces nothing — the existing anchor-based marker stays as a 4th chip; remove it if
the human stamp supersedes it) → 3 human markers on /watch → remove one chip → 2 left → unapprove →
0 markers + draft.

**Follow-ups (deliberate):** ~~route-level failure-matrix tests~~ DONE (`e43ba522`, 31 tests —
scripted order-recording supabase stub w/ exact-drain assertion, panorama-source pattern [a
mocked-route pattern DID exist; the earlier "none exists" note was wrong]; pins link-before-event,
delete-before-flip, CAS-race rollback scope, every delete's provider/source/recording guards, and
the full retry matrix; 3 mutants verified killed); add_goal exactly-once via optional client event id if duplicate chips
ever annoy; chips for repair-state pending links render as normal chips (arguably a feature —
removable); seek-to-latest-stamp on clip reopen (polish).

**Eyes-on gap found + fixed same session (commit `7f58bbe9`):** the 300s clip cap (the 50MB storage
fix) TRUNCATES long merged episodes — the 18:54 pilot's clip covers 17:24–22:24, so goals 2 (~22:33)
and 3 (~26:46) sit past the clip's end and "Add goal at this moment" could not reach them: the
flagship multi-goal episode was exactly the case the capped clip can't cover. Fix: cards take a
TYPED match time (mm:ss / h:mm:ss / seconds, read off /watch; `parseClockInput` in the pure lib,
Enter-to-add) — reviewer-side, chain untouched. Also confirmed live: the 18:34 anchor−20 estimate
sits exactly on the ball crossing the line (Karim eyes-on) — second consecutive exact landing.

**EYES-ON PASSED (Karim, 2026-07-22 ~10:40): the 18:54 pilot flurry carries 3 markers.** Goals
confirmed at 18:34 (anchor−20 estimate — ball crossing the line, second consecutive exact landing),
22:13 and 26:51 (human stamps via the typed time field; Karim's first attempt used the /watch MANUAL
event path — markers existed but weren't candidate-linked; deleted + re-added through the card).
DB verified: 3 links (1 anchor_offset primary legacy-keyed + 2 human_scrub new-keyed), all
ai_detected public events, zero manual leftovers. Note the true goal moments (22:13/26:51) sit
20/5s off the kickoff-derived estimates (22:33/26:46) — merged-episode member anchors are not
per-goal estimates; the human stamp is the precise label.

**PILOT FULLY STAMPED (Karim, 2026-07-22 ~12:30): 11 markers / 9 candidates, 9 human-precise.**
Karim re-stamped every goal: the 18:54 flurry carries 3, seven single-goal candidates got their
estimate marker replaced with an exact human time, two anchor estimates kept (incl. the E2E-exact
968). First per-goal timing-error distribution for the chain: |human − (anchor−20)| ranges 0–68s,
and several true goals sit AFTER their episode's anchor — merged-episode anchors are earlier
stoppage members, not the goal's own kickoff. This match = the calibration reference for episode
splitting / tighter auto-timing (both still parked). Marker inventory: stamps [531, 879, 968*,
1114*, 1333, 1611, 2102, 2188, 2494, 2834, 3321] (* = anchor estimate).

**FIRST EYES-ON-CONFIRMED PRODUCTION RECALL MISSES (2026-07-22, Karim reviewing `017121fb`, Jul-18
match): EIGHT on one match** — goals at ~1306s (21:46), ~1989s (33:09), ~2158s (35:58), ~2321s (38:41), ~2383s (39:43), ~2896s (48:16), ~3459s (57:39), ~3589s (59:49), each with NO covering episode — 21:46 sits between candidates 1214
(ends 1225) and 1515; 33:09 AND 35:58 both fall in the single 1853→2764 gap — a ~15-min stretch
where the detector emitted nothing, now holding two confirmed goals. FOUR of the six misses (33:09, 35:58, 38:41, 39:43 — a ~7-min goal flurry) sit inside the single 1853→2764 window; 48:16 falls in the NEXT gap (2770→3340), so the degradation is match-wide, not one glitch window. DIAGNOSED
same-hour from the live tracklets artifact (game 1ad6512c): (a) input-dropout FALSIFIED — chain
coverage through the whole window is healthy (108-151/min vs match median 134); (b) the real
anomaly is OFF-PITCH CONTAMINATION: pitchFilterCompare shows rect 6394 vs polygon 3909 chains
(39% of tracked bodies outside the marked pitch; rosterN=30 on a small-sided pitch) vs near-parity
on the pilot match (1908/1890). Off-pitch crowds inflate the percentile rect (the HCT lesson) and
pollute the kickoff-formation geometry — the prime suspect for stretch-wise P_ko suppression.
NEXT EXPERIMENT (Karim to green-light the enable): flip the Nazwa scene into FIELD_FILTER_SCENES
(polygon filter, dry-run-validated 2026-07-18), re-enrich + re-detect the weak-recall matches, and
measure miss-recovery against the eyes-on-confirmed missed goals — first causal test on the recall
frontier. Review decisions survive re-runs by design (status-CAS reconciliation). This match (8 candidates, the
smallest shortlist in the backlog) looks like a weak-recall match — the freeze measured per-match
recall90 p10 = 0.50, and a thin shortlist is itself a recall warning sign worth surfacing to the
reviewer. Consistent with the freeze's measured recall90 0.81. Handling: recorded as a
MANUAL /watch marker (not stamped onto a neighboring candidate — that would misattribute the goal
to an unrelated episode and corrupt the timing corpus). Accumulate these: eyes-on-confirmed misses
with timestamps are the ground truth for the queued kickoff-path (`pko_below`) recall work, and a
reviewer-side "add missed goal" affordance (marker + miss record in one action) is the natural
follow-up if these become frequent.

## MISS AUTOPSY + POLYGON CAUSAL TEST (2026-07-22, recording `017121fb`, Jul-18 Nazwa)

**Phase 1 — per-miss autopsy of the frozen chain (production decode reproduced EXACTLY: same
chain.py/artifact/calibration/banked models; 9 episodes + envelope [86,3590] byte-identical to the
job's provenance).** All EIGHT eyes-on-confirmed misses are `pko_below` — the single-gate result:
dead-evidence saturated (0.97–1.00) at every miss (the stoppage model saw every dead spell), zero
P_ko peaks ≥ τ=0.5 anywhere in any [G+2,G+90] kickoff window (best 0.04–0.46). Match-wide P_ko
p50/p90/p99 = 0.001/0.078/0.443 — the kickoff classifier was suppressed for the WHOLE match. 39% of
bodies fed to it sat outside the marked 30×15 pitch (matches pitchFilterCompare 3909/6394). 59:49
(3589s) additionally structural: tracks end at 3602s, its kickoff is past the artifact end (the
freeze's ~2% final-whistle class). Scripts + window dumps: session scratchpad `miss-autopsy/`.

**Phase 2 — polygon re-enrich + re-detect, THIS MATCH ONLY (Karim's green light; env-override
`FIELD_FILTER_SCENES` on a manual tracklets submit — tfvar untouched, no venue enable).** New
artifact: `pitchFilter: polygon`, 6243→3844 objects, rosterN 30→24, no fallback, H/eval identical.
Goal-detect re-run (manual reset + submit; job `504dd5a2`):

- **7/7 recoverable misses RECOVERED** (scored against 7, excluding structural 3589): every one now
  carries an in-window P_ko peak 0.62–0.96 with saturated dead-evidence, and every one is covered by
  a shortlist candidate (1378, 2012, 2212, 2323 ×2 — the 38:41+39:43 flurry shares one episode —
  2912, 3475). Off-pitch bodies at the miss instants fell ~5–6 → ~1–3.
- **CONTAMINATION CAUSALLY CONFIRMED**: same frozen chain, same calibration, only the artifact's
  chain population changed → P_ko at the missed kickoffs went 0.04–0.46 → 0.62–0.96.
- Shortlist 8 → **17 candidates** (18 episodes − opening drop); envelope [57, 3589]; period filter
  fired on nothing. All 13 known goals except the structural one are covered = goal recall on this
  match 6/14 → **13/14 (0.93)**. Episode-level precision-vs-known-labels ≥ 11/17 (0.65) pending
  review of 5 unknown-status candidates (820, 1595, 2643, 3071, 3387 — complete-review lesson says
  some may be MORE goals); old run was 6/8 (0.75) at recall 0.43.
- **Review decisions survived by design**: 6 approved + 2 rejected rows untouched (4 reviewed-kept
  by reconcile, 4 unmatched-but-standing); 13 new drafts inserted. ⚠️ Reviewer note: drafts 433,
  1378, 1717 re-anchor stoppages whose goals are ALREADY approved on old rows 566, 1515, 1768
  (polygon shifts peaks >45s = past the reconcile radius) — reject as duplicates (or move the
  approval); 1378 also spans miss-goal 21:46, which already has a manual /watch marker.
- **Path identity confirmed** (the user's gate): the polygon filter ships `poly_chains` into the
  same public `panorama-meshes/{gameId}/tracklets.json` that goal-detect `fetch_tracklets` reads —
  the exact artifact path the 07-18 dry-run compared on.

**NOT done (deliberate):** no `FIELD_FILTER_SCENES` venue-wide enable — that decision is Karim's,
now with the causal number in hand. τ-relaxation for near-misses (0.44/0.46 on rect) parked —
polygon first was the right causal order. Note the OTHER Nazwa matches (incl. the 9-goal pilot
`d9fee1fc`, rect/polygon near-parity 1908/1890) predict ~no change from polygon; this match's 39%
contamination looks crowd/session-specific — per-match `pitchFilterCompare` divergence is a cheap
weak-recall warning signal worth surfacing.

**ENABLE (2026-07-22 afternoon, Karim's green light after the causal test): NAZWA POLYGON FILTER IS
LIVE — and it turned out it already was.** The live `playhub-sync-recordings` Lambda (LastModified
2026-07-22T00:26Z — the goal-detect enable-drill's `-target` apply) already carries
`FIELD_FILTER_SCENES=131777a6…,315f936b…` from the pre-staged tfvars line; the sweep passes it into
every tracklets submit (index.ts:1386). So NO terraform action was taken today — nothing changed,
nothing else could change. Every tracklets build sweep-submitted after 00:26Z ships polygon for
those scenes; the Jul-18 match's rect artifact simply predates the apply. Backlog re-enriches
NATURALLY as tracklets re-builds happen — deliberately NO mass goal_detect reset (duplicate drafts
past the 45s reconcile radius are real review noise; proven on this match: 3 of 13 new drafts
duplicated already-approved goals and were rejected as such).

⚠️ **Surfaced to Karim: HCT `315f936b` is ALSO in the live env** — the 07-18 note gated HCT enable
on a dry-run rerun after the b3 jersey pilot settled, and no explicit HCT-enable authorization is
in the record. The b3 work did validate the HCT polygon premise (7,077/26,461 inside at the same
apron), so it is defensible — but it should be a decision, not a side effect. Karim to confirm or
have it pulled from the tfvar.

**Review cleanup on `017121fb` (per Karim):** duplicate drafts 433/1378/1717 REJECTED (draft-CAS,
no event side-effects). add_goal-then-reject on 1378 deliberately skipped: add_goal from draft IS
the approve path, and 21:46 already carries its manual marker — no linkage worth the invariant
risk. Denominator correction from the events table: candidate 566 carries TWO linked markers
(8:53 + 10:02, a stamped flurry) → **15 known goals; old-run coverage 7/15, polygon run 14/15.**
The 5 unknown drafts stay for eyes-on, prioritized by the span finding: **3071 (span 119s, top
prior), 820 (53s), 1595 (28s), 2643/3387 (point episodes, weak)** — frame strips inconclusive
(goalmouth activity everywhere; stills can't separate goal aftermath from goal-kick resets).

**FULL REVIEW COMPLETE (Karim, 2026-07-22 ~15:45, `017121fb`): 16 known goals, 14 candidate-linked
markers + 2 manual.** Verdicts on the 13 polygon drafts: 6 approved (2012, 2212, 2323 ×2-marker
flurry, 2912, 3475, and **3387 = a 16TH GOAL at 3374s/56:14 nobody had** — found only because the
complete-pass review covered all five unknowns), 7 rejected (3 duplicates + 820/1595/2643/3071).
Karim replaced his manual markers for the recovered misses with card-stamped, candidate-linked ones
(1989/2159/2321/2383/2896/3459); manual markers remain only for 21:46 (its covering episode was the
1378 duplicate, rejected) and 59:49 (structural, no candidate possible). **Final match accounting:
episode precision 12/17 goal-bearing (0.71, vs old-run 6/8=0.75 at less than half the recall);
episode goal-coverage 15/16 (0.94; only the final-whistle 59:49 uncovered).** Detector FP episodes:
820, 1595, 2643, 3071, 3328. **Span-prior humility (n=5): the span ranking inverted here — 3071
(119s, top prior) was NOT a goal; 3387 (point episode, weakest prior) WAS.** Review-ranking only,
never a filter — reconfirmed. This match is now the second complete label set (21 candidates
labeled) and the polygon causal test's closed-book: contamination diagnosed → polygon fix →
7/7 recovered → +1 bonus goal surfaced by the wider shortlist.

**HCT RULING (2026-07-22, delegated by Karim — "your call"): KEEP `315f936b` in
`FIELD_FILTER_SCENES`.** Rationale: the per-venue reviewed number the 07-18 gate wanted exists (b3
premise measurement, 7,077/26,461 inside at the exact shipped apron config); the fail-safe lattice
degrades loudly to rect on any anomaly; HCT is the chronic-contamination venue the filter was built
for (and polygon improves the jersey substrate); current blast radius ≈ zero (all backlog HCT
recordings are pre-tracker-rollout, so nothing re-enriches until a new HCT match). Standing check:
when the FIRST polygon-enabled HCT tracklets build lands, review its meta (`pitchFilterCompare`,
no `fallback`) + validation PNG before trusting downstream re-detects there.

## EPISODE SPLIT MEASURED (2026-07-22, workstream A) — split-at-emission FAILS the locked bar; SUB-ANCHORS ON THE MERGED CARD are the measured win

**Question:** should merged episodes split on distinct dead→live cycles before candidate emission, so
flurries (pilot 18:54 = 3 goals / 1 card) stop sharing one card? Measured on the freeze harness
(236 matches, 5-fold OOF, cached series — decode-only, ~1 min/variant) + the two fully-labeled
Spiideo matches (25 candidate-linked human stamps). Rule and adopt bar LOCKED before any split
decode ran (session scratchpad `split-adopt-bar.md`): split between consecutive qualifying peaks iff
dctx dipped below 0.5 (the stoppage model's midpoint — play went live) between them; variant 5S
requires a >=5s dip; bar = medium recall90>=0.80, precision>=0.30, shortlist med<=20, leak<=2%,
collapse<=47; if neither variant passes, report and stop — no variant C invented against the
numbers. Harness gained a default-off `--split {any,5s}` flag, verified to reproduce the floor-080
baseline **bit-for-bit (236/236)** before any split ran.

**Split-at-emission: NO (both variants fail bar axis 3, and the honesty check is worse).**

| medium band               | baseline (floor-080) | split=any     | split=5s      |
| ------------------------- | -------------------- | ------------- | ------------- |
| recall45 / recall90       | 0.754 / 0.812        | 0.772 / 0.832 | 0.772 / 0.832 |
| precision (harness)       | 0.309                | 0.315         | 0.308         |
| shortlist med             | 18                   | **32**        | **30**        |
| collapse (ALL, 45s)       | 94/1234              | 26            | 27            |
| anchor−20 \|err\| med/p90 | 8.2s / 56.2s         | 5.2s / 23.4s  | 5.4s / 24.4s  |

The card explosion (4183→7205 surviving episodes ALL-bands) is not benign: **duplicate-TP episodes
explode 108→981** (every restart in a post-goal cluster reaches back <=90s to the same goal), so
**honest precision — unique-goal TPs / cards — drops 0.295→0.188**, and open_play FP cards go
1734→3048 (long non-goal stoppage chains un-bundle into junk cards). The naive precision holding at
~0.31 is duplicate-TP inflation, exactly the class the original freeze flagged at 55/1246. Verdict
per the locked rule: report and stop.

**The hybrid — merged card stays THE review unit, split sub-anchors ride on it — takes the gains
without the costs.** Sub-anchors = the first peak of each dead→live cycle inside the episode (the
split=any segmentation, used as per-cycle kickoff estimates, NOT as cards). Cards, recall,
precision, shortlist: byte-identical to today by construction. Measured on the same freeze data:

- **marker-level collapse within cards: 94 → 4** (the 4 residuals are goals 7–32s apart sharing one
  kickoff cycle — dctx never reads live between them; structural, same class as below);
- **per-goal timing: |goal − (sub-anchor−20)| med 4.7s / p90 12.2s** vs 8.2s / 56.2s for the card
  anchor (n=1234 hit goals) — the p90 collapse is the multi-goal/late-goal tail;
- review clutter bounded: sub-anchors per card med 1, p90 3, max 14; 41% of cards carry >=2.

**Spiideo per-case check (25 candidate-linked human stamps, production decode reproduced locally —
pilot rect artifact + 017121fb polygon artifact, same banked models/H; 017121fb byte-verified vs job
provenance by the 07-22 autopsy; all 16 log-visible pilot cards match the DB rows' anchors AND spans
exactly):** stamp-estimate |err| med 26s → 7s (human-scrub-only: 33s → 8s). Flurries: pilot
1134-card **3/3 resolved** (sub-anchors 1134/1371/1628 = −0/+18/−3s from Karim's stamps); 017121fb
533/602 **2/2 resolved** (−5/+6s); 017121fb 2321/2383 **1/2 UNRESOLVED** — the card carries ONE
sub-anchor because the two kickoff cycles are too compressed for the trailing dctx to dip below 0.5
between them. Same residual class: a goal whose following kickoff never starts a new cycle also
keeps the old estimate (stamp 1833 on card [1717,1853]: err −136s unchanged). Sub-anchors fix the
~96% of collapse that is separable; the compressed-flurry remainder is a measured structural floor
of this signal, not a tuning miss.

**Recommendation (Karim's call — NOTHING shipped to chain.py/batch/UI this session):** adopt the
hybrid. Ship path is additive: `detect()` episodes gain a `sub_anchors` list (decode-time only,
episode boundaries untouched → reconcile, review decisions, card counts all unaffected); candidate
rows/provenance carry it; the review card surfaces each sub-anchor−20 as a pre-filled "possible goal
moment" chip feeding the existing typed-time add_goal path (multi-goal chips shipped `2b7ce617`).
Reviewer behavior change: on a flurry card, tap N pre-filled moments instead of scrubbing a 550s
clip. If adopted, the freeze-side split logic ports to chain.py under the same
verify-bit-for-bit-with-split-off discipline used here.

**Artifacts:** `freeze_results_split_any.json`, `freeze_results_split_5s.json`,
`freeze_results_verify_nosplit.json` (equivalence proof) in scripts/event-tagging;
`stoppage_veo_freeze.py --split` flag (default off, baseline-verified); Spiideo check script +
locked bar in session scratchpad (`spiideo_split_check.py`, `split-adopt-bar.md`).

## EVAL LAYERS + PROVIDER INDEPENDENCE (2026-07-22, settled framing)

Karim asked whether we should build an eval that runs on Veo raw panoramas and scores vs Veo's
goals — as a permanent "works like Veo" baseline while the big success is Spiideo / any 180° cam
without Veo or Spiideo AI.

**Veo's sensor (clarified):** Veo match-events / player-tracking almost certainly come from the
wide/panoramic tracking world, **not** the autofollow Play mp4 (follow render is a product of that
world; measured worst for jersey crops). Same _shape_ as Spiideo: raw wide → tracks → events.

**Our chain also never eats pixels.** Production goal-detect = Spiideo tracklets → kickoff/dead/
envelope chain. The Veo freeze = Veo mes-derived sidecars → **same chain** vs Veo clean goals
(236 matches). That _is_ the decision-layer baseline ("does our model recover what Veo tagged,
given Veo-quality tracks?"). Do not confuse it with a missing raw-`.ts` eval.

| Layer    | Spiideo prod             | Veo freeze today         | "Eval on Veo `.ts`"   |
| -------- | ------------------------ | ------------------------ | --------------------- |
| Pixels   | Spiideo raw VP           | —                        | banked Veo `.ts`      |
| Tracks   | Spiideo tracklets stream | Veo mes-derived sidecars | needs **our** tracker |
| Decision | `chain.py`               | same                     | same                  |
| Labels   | human review stamps      | Veo goals                | Veo goals             |

**Independence stack** (success = tag ANY 180° recording without Veo/Spiideo AI):

1. Raw 180° video (any cam)
2. **Our** tracker → tracklets ← the real gap today
3. Our decision layer → events ← already ours; Veo freeze is its regression rail
4. Our identity → jersey ← banked Veo `.ts` + tracking.json are the labeller corpus

**Settled rules:**

- Keep the **Veo freeze as permanent accept gate** for every chain change (hybrid, τ, retrain):
  must not regress medium recall90 / precision / shortlist bar.
- Add a **Spiideo-label freeze** once ~10 matches are fully reviewed (domain gate the Veo freeze
  cannot see — small-sided geometry, contamination). Jul-18 + pilot labels are the start.
- **Do not** build "run the kickoff chain on Veo raw panoramas" next unless the upstream is **our**
  tracker on the `.ts`. Re-wrapping Veo mes tracks and calling it pano eval is still Veo AI
  upstream — not an independence step. Banked Veo panoramas stay for jersey/identity until then.
- When investing in an owned tracker, Veo `.ts` + Veo goals becomes the right end-to-end lab
  (`our tracks → chain → vs Veo goals`); Spiideo raw VP + human stamps is the domain check.

**Near-term order unchanged:** adopt/ship hybrid sub-anchors → Veo freeze as gate → grow Spiideo
label set → owned tracker only when scheduled as the independence investment.

## SUB-ANCHORS HYBRID ADOPTED + SHIPPED (2026-07-22 evening, Karim's call) — commits `50645fd6` / `b49fb306` / `e7895b4f`

Split-at-emission stays rejected; the hybrid is production. **Additive only, verified at every layer:**
the frozen decode is byte-identical (merge-unchanged pinned by `test_detect_merge_unchanged_by_dctx`;
reconcile untouched; card counts, recall, precision unchanged by construction).

**Chain (`b49fb306`):** `detect()` gains optional `dctx`; episodes carry `sub_anchors` = first peak of
each dead→live cycle (`SPLIT_LIVE_THR=0.5` dip between consecutive peaks, NaN ≠ live evidence;
endpoints excluded from the dip check — strictly interior slice). `DETECTOR_VERSION` →
`freeze-2026-07-21-floor080-subanchors` (informational; nothing branches on it). Candidate rows gain
nullable `sub_anchors_s numeric[]` (migration `20260722170000`, applied; `[0] = anchor_s`); provenance
episodes carry `subAnchors`. Pre-hybrid rows stay NULL → no chips; drafts backfill on natural
re-detection refreshes (no mass reset — the standing duplicate-drafts rule).

**Review surface (`e7895b4f`):** cards with ≥2 cycles render "Possible goal moments" chips (amber
dashed, distinct from stamped emerald markers); one click posts the EXISTING `add_goal` at
`sub_anchor − 20` — the click IS the human decision, nothing auto-approves; single-cycle cards render
byte-identical to before. Chips suppress within `HINT_SUPPRESS_S=10s` of an existing stamp and dedupe
post-clamp. en/es/ar.

**Review-driven invariants (4 specialists + 2 delta re-reviews; api + senior converged on the
provenance one independently):**

- **Chip stamps are NOT human labels.** They send strict-boolean `estimate: true` and record as
  `stamp_source='anchor_offset'` — `human_scrub` remains a human-precise label (the timing corpus).
  The repair-restamp branch writes the resolved source, so a later genuine scrub supersedes a chip
  estimate, never the reverse; a scrub confirming a chip's exact second UPGRADES the link.
- **Same-timestamp `add_goal` converges** (exact equality; deterministic earliest-link pick): adopts
  the existing link and re-runs the idempotent `ensureGoalEvent`, so a retry after `goal_add_failed`
  COMPLETES a link-without-marker state instead of minting a duplicate public marker. Safe because two
  genuine goals never share a second and chips repost identical values. Dedupe-lookup failure = 502
  fail-closed (proceeding would mint the exact duplicate the lookup prevents).
- GET mapper drops NULL array elements (`Number(null)=0` would render a phantom actionable 0:00 chip);
  `subAnchorHints` bounds to `[0, MAX_TIMESTAMP_S]`.

**Gates:** 1158 vitest (41 across the three goal-candidate suites, 16 new) + 12 chain / 7 reconcile
pytest, tsc clean, build OK. **Acceptance (new chain.py on both labeled matches, production models/H):**
pilot 19/19 cards reproduce — the 1134 flurry card carries 15 chips incl. all three true goals'
estimates (1114/1351/1608 vs stamps 1114/1333/1611); `017121fb` 17/17 — the 533/602 flurry card offers
528/608 (−5/+6s from stamps), and the compressed 2321/2383 card honestly shows NO extra chip (single
cycle — the measured structural residual, ~4% of collapse; no false promise). **Venue note:** Nazwa's
saturated deadctx yields many cycles (pilot 13/19 cards ≥2 chips, max 15; `017121fb` 7/17) vs the
freeze-corpus median of 1/card — the hint row is more present at this venue than the freeze numbers
imply; watch the pilot's worst flurry card before drawing UX conclusions.

**Follow-ups (deliberate, not done):** add `SPLIT_LIVE_THR` to the banked `constants.json` canary at
the next re-bank (adding it now would fail every job against the current bank); pre-existing
restamp-vs-ambiguously-committed-event timestamp divergence (api SHOULD — the 23505-converged event
keeps its old ts while link+response report the new one; requires a mid-flight ambiguous failure);
chip-count cap if the worst Nazwa flurry card reads as clutter in review.

**ROW HINT CAP ADDED PRE-PUSH (same evening, Karim's gate: "spot the worst flurry card before prod").**
The pilot's 1134 card would have rendered 15 chips (12 false offers styled like real ones). Measured
fix rather than eyeballed: **within-episode cycle ranking by per-cycle max P_ko separates** — unlike
the dead cross-episode ranking — so `sub_anchors_s` (the ROW) now carries the anchor cycle + top-7
rest by cycle P_ko (`SUB_ANCHORS_ROW_CAP=8` in chain.py; full list + per-cycle P_ko stay in
provenance). **K chosen by measurement, and the per-case check earned its keep: K=5 (99.2% freeze
retention) DROPPED the pilot 512-card's stamped-531 goal cycle; K=8 = 99.9% freeze retention
(1233/1234 OOF) and ZERO stamped-goal-cycle losses across both labeled matches.** Worst card 15→8
chips; med/p90 (1/3) untouched; ≤8-cycle cards pass through byte-identical. Do not lower the cap
without re-running `cap_check.py` (session scratchpad) against the stamped corpus.

## ENVELOPE-OPENING ROBUSTNESS — MEASURED NO (2026-07-22 night; roadmap item 1)

Target: warm-up P_ko blips claiming the envelope opening (0f9c00fa: 0.52 blip at t=22 → env0≈4 →
three warm-up cards leaked past the ±60s opening drop). Rule + bar locked BEFORE decoding
(scratchpad `opening-adopt-bar.md`): variants = higher opening bar TAU_OPEN∈{0.7,0.8} (fallback to
the frozen 0.5 rule, never to activity blocks; no dead-evidence — fold-1 stands) ± a pre-env0
hard-cut (`drop='pre_match'` for anchors < env0−60). Harness gained default-off `--opening-tau` /
`--pre-env-cut` (baseline reproduced bit-for-bit before any variant ran).

**Structural finding first: the Veo freeze corpus has ZERO warm-up-class survivors** (0/4183 cards
sit before period-1 start − 45s across all 236 matches — Veo recordings are match-trimmed). So
freeze can only gate the RISK axes; the benefit exists only on Spiideo (3 labeled matches, 3
warm-up cards total).

**Every variant fails the locked bar, on exactly the fold-1-sensitive axes:**

|            | recall90 (med) | early-goal r90 (P1+300s, n=162) | opening ≤45s | pre_match drops |
| ---------- | -------------- | ------------------------------- | ------------ | --------------- |
| baseline   | 0.812          | 0.667                           | 49.6%        | 0               |
| τ_open 0.7 | 0.804          | 0.611                           | 42.8%        | 0               |
| τ_open 0.8 | 0.797          | 0.562                           | 37.7%        | 0               |
| 0.7 + cut  | 0.804          | 0.599                           | 42.8%        | 26              |
| 0.8 + cut  | 0.793          | 0.531                           | 37.7%        | 66              |

Mechanism: true opening kickoffs are often WEAK peaks; a raised bar skips them and latches onto a
later strong (often post-goal) kickoff → env0 moves late → the opening drop + pre-env cut eat real
early goals. The v2/v3 "no dead-evidence on the opening" lesson generalizes: the opening peak is
structurally low-confidence, and ANY strictness there trades warm-up noise for early-goal recall at
a terrible rate (3 junk cards/worst-case Spiideo match vs −5 to −14pp early-goal recall on Veo).

**Verdict: report and stop (locked-bar discipline).** The warm-up leak stays priced into review
(reject-on-sight; the period filter and geometry already kill most of it — 3/30 cards on the worst
observed match). Future attempts need a DIFFERENT signal — pre-declared candidates for a future
session: sustained-live corroboration AFTER the candidate opening (match started = play persists),
or an activity-level match-start detector — measured against this same bar, especially early-goal
recall 0.667. The `--opening-tau`/`--pre-env-cut` flags stay in the harness (default off,
baseline-verified) as instrumentation. Artifacts: `freeze_results_open{07,08}{,preenvcut}.json` +
`freeze_results_verify_noopen.json`.

## TIMING OFFSET KEPT + τ_PEAK 0.45 PASSES THE BAR (2026-07-23; bars locked before numbers)

**Timing offset (marker estimate, not a decode change): KEEP 20.** Against Veo goal GT (1,497
goal/cycle pairs, floor-080 survivors + split-any cycles), raw goal→kickoff-cycle latency median is
EXACTLY 20.0s — the original constant is empirically optimal to within noise. The |err|-minimizing
offset is 17 but buys only 0.8s median (< the locked 2s adopt threshold) and worsens p90. No change.

**τ_peak probe (decode change, full freeze bar): 0.45 ADOPTS; 0.40/0.35 fail.** Variants lower ONLY
the candidate-peak gate; the opening scan stays at 0.5 (the 07-22 opening measurement stands — the
warm-up surface must not move). Default-off `--tau-peak` flag, baseline bit-for-bit verified.

| medium               | baseline      | **0.45**          | 0.40          | 0.35          |
| -------------------- | ------------- | ----------------- | ------------- | ------------- |
| recall45 / recall90  | 0.754 / 0.812 | **0.772 / 0.837** | 0.796 / 0.848 | 0.814 / 0.869 |
| precision            | 0.309         | **0.302**         | 0.298 ✗       | 0.295 ✗       |
| shortlist med / leak | 18 / 0.09%    | **19 / 0.21%**    | 19 / 0.21%    | 19 / 0.24%    |

0.45 = +2.5pp recall90 (~+31 medium goals) for −0.7pp precision and +1 card/match; per-match p10
holds at 0.50. 0.40/0.35 breach the 0.30 precision floor — out, per the locked rule.

**Spiideo spot-check at 0.45 (2 labeled matches, chain-series decode): PASS.** Zero stamped-goal
coverage lost (14/14 on polygon 017121fb, 11/11 on the rect pilot). Candidate delta modest and
two-signed: +5 pre-filter episodes on 017121fb, −3 on the pilot — **lower τ also BRIDGES episodes**
(new intermediate peaks fuse neighbors under the 45s merge), which the sub-anchor chips absorb by
design. Note for the ship: episode shapes move, so re-runs on reviewed matches would mint some
duplicate drafts past the reconcile radius — τ_peak applies to FUTURE detects, no backlog reset
(standing rule).

**SHIP PLAN (awaiting Karim's go — touches terraform):** (1) chain.py `TAU_PEAK=0.45` on the
candidate gate only (TAU=0.5 keeps the opening + diagnosis semantics), DETECTOR_VERSION bump;
(2) re-bank constants.json to a NEW dated weights prefix with TAU_PEAK — and fold in the standing
SPLIT_LIVE_THR canary item — models unchanged, new CONSTANTS_SHA256; (3) `-target` apply the job-def
env (prefix + sha) — the deliberate canary friction working as designed; (4) CodeBuild image
rebuild + invalid-UUID smoke. Freeze artifacts: `freeze_results_tau{045,040,035}.json` +
`freeze_results_verify_notau.json`.

## GOAL-MOMENT REFINER SPIKE — TEAM-FREE ARM (2026-07-24; AGREED PLAN item 2, gates locked 07-23)

**Scope:** re-rank + re-time ONLY (v1 never adds/drops/merges an episode — recall structurally
untouched; suppression stays a later separately-freeze-gated change). Full pre-registration in
`refiner/PROTOCOL.md` (gates restated + bootstrap spec + covariate rule, all written BEFORE the
corresponding numbers existed). Code: `refiner/` (features.py shared extractor, dataset.py,
train_eval.py, spiideo_decode.py, covariate_check.py, stamp_eval.py). Team-free throughout —
half_sep/hs_grid/roles BANNED; kickoff geometry = rolefree12.

**Data.** Veo dev corpus = the 236 freeze sidecars + cached OOF series, decoded at CURRENT
production config (TAU_PEAK 0.45, floor 0.80, sub-anchors): reproduction vs
freeze_results_tau045.json = 0/236 drift. 4,393 survivor episodes (1,371 TP90), 7,849 cycles;
freeze fold assignment reused (refiner strictly OOF). Spiideo = the 9 reviewed Nazwa matches:
production decode reproduced locally (chain.py + banked models + live cal 30×15) — **9/9 EXACT**
(every latest-epoch DB candidate anchor ±2s under the rows' own detector version; DB unions span
epochs so subset-containment is the honest check).

**Transfer hazard handled by pre-declared rule.** Absolute dctx features are known not to
transfer (Nazwa saturation). Added per-match quantile-normalized dctx/ev variants; label-free
covariate check: episode `dctx_mean_ep` medians sit ABOVE the Veo q95 band on 7/9 Spiideo
matches → NORM_ONLY variant locked (drops absolute dctx/ev levels). Cost on Veo ≈ zero
(P@4 0.6734 vs 0.6702 full; localizer 1.85s vs 1.77s med).

**GATE VERDICTS (team-free arm):**

1. **Precision (confidence re-rank): PASS.** HGB P(TP90) per episode, 39 team-free features,
   match-grouped 5-fold OOF, freeze P@K semantics. **P@4 ALL 0.6734 vs span-alone 0.4968
   same-decode / 0.492 locked bar** (+18pp); R@8 0.585 vs 0.473; per-band P@4 medium 0.634 /
   full 0.708 / small 0.714; per-fold P@4 0.61–0.71 (every fold clears). Span-alone bar
   reproduced exactly (0.492 on the floor-080 record) before any refiner number existed.
2. **Timing (localizer): FAIL — one look spent, no re-tuning.** Per-cycle offset regression
   (δ = sub_anchor − goal; abs-error HGB; clip [−30,90]). Veo OOF: med 1.85s / p90 13.7s vs
   sub-anchor−20 med 5.16s / p90 22.7s. **131 human_scrub stamps (primary; n=130 scored, 1 stamp
   had no covering survivor card, excluded from both arms): refiner med 6.45s vs baseline 8.00s —
   paired bootstrap ΔMedian 95% CI [0.16, 3.30] (excludes 0; by-match cluster CI [−0.16, 2.80]),
   but the absolute bar med<5s is NOT met → FAIL.** Sensitivity (all 141 stamps, 9 matches):
   6.29s vs 8.00s, CI [0.48, 3.20], same verdict. The improvement is real but transfer-shrunk
   (3.3s gain on Veo → 1.5s on Spiideo) and the Spiideo baseline itself is worse than Veo's
   (8.0s vs 5.2s) — the dead-onset/dctx-shape signal the localizer leans on is exactly what
   saturates on Nazwa.
3. **Recall: unchanged by construction** (nothing suppressed; estimates only).
4. **Kit-uplift arm: NOT RUN (day-one = team-free per plan).** When run: silhouette-gated subset
   only, per-match silhouette logged into provenance, verdicts reported per condition, arms never
   averaged. NOTE the timing corpus is now SPENT for this refiner — any localizer v2 (kit or
   team-free) must take its one look on stamps from FUTURE reviewed matches, never these 141.

**NOTHING WIRED.** The passing confidence model is a candidate input for the PARKED auto-approve
posture / future ranking surfaces (span stays the shipped review-side signal; review strip stays
chronological per Karim's ruling) — a product decision for Karim, not this spike. Artifacts:
`refiner/veo_oof_results.json`, `refiner/stamp_eval_results.json`, `refiner/models_final.pkl`
(sha256 ccee6a35…, norm_only, trained on all 236).

**Ops gotcha for reruns:** chain.series' per-grid-point single-row sklearn predicts thrash OpenMP
when parallelized (9 procs × N threads = barrier storm, 30min+/match); `OMP_NUM_THREADS=1` makes
the full 9-match reproduction run in minutes.

### Auto-approve precision curve (same session, freeze OOF, norm_only confidence — Karim's ask)

"At confidence >= X, precision is Y" — the number the span ruling said auto-approve needed
(P@4 is ranking; a floor needs a curve). Veo OOF only, no stamps. `refiner/auto_approve_curve.py`
-> `auto_approve_curve.json`. Precision = TP90 fraction of qualifying cards (agreement-with-Veo,
a LOWER bound; unique-goal dedup not applied — duplicate-TP cards were ~4% at baseline and shrink
at high floors). Coverage = clean goals covered by a qualifying card (90s window).

Medium band (the product regime), cards/match in parens:

| conf floor | precision   | fold spread | goal coverage90 |
| ---------- | ----------- | ----------- | --------------- |
| 0.50       | 0.703 (4.8) | 0.674–0.727 | 0.514           |
| 0.80       | 0.826 (2.3) | 0.800–0.848 | 0.292           |
| 0.85       | 0.855 (1.8) | 0.826–0.893 | 0.239           |
| 0.90       | 0.891 (1.2) | 0.839–1.0   | 0.165           |
| 0.95       | 0.942 (0.6) | 0.917–1.0   | 0.089           |

ALL bands: 0.90 -> P0.889/cov 0.190; 0.95 -> P0.916/cov 0.113. Reading: an auto-approve floor at
0.90-0.95 would mint ~0.6-1.3 markers/match at review-grade precision while the remaining ~85-90%
of goals keep flowing through human review — auto-approve as a REVIEW ACCELERATOR (pre-approved
top slice), not a review replacement. Any wiring decision is Karim's, via the freeze-harness
discipline, and the confidence signal BADGES/TIERS cards — it must not reorder the strip out of
chronology (complete-pass ruling stands).

### Standing decisions recorded (2026-07-24, post-spike review)

- **Localizer-as-hints: DEFERRED, not decided.** The failed <5s gate keeps it unwired as a timing
  SOURCE. Using it as the seek-point behind the chips (hints-only, click = human decision) would
  beat the shipped anchor−20 estimate (6.45s vs 8.00s med, CI excludes 0) but means wiring a
  failed-gate model — Karim must explicitly green-light it with its own stated bar. Do NOT
  re-litigate the <5s gate itself.
- **Kit-uplift arm scope:** the PRECISION half can run now (Veo team labels, freeze OOF,
  silhouette-gated subset, per-match silhouette in provenance, arms never averaged). The TIMING
  one-look must WAIT for stamps from future reviewed matches — the 141-stamp corpus is spent.

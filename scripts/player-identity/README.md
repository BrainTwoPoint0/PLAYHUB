# Player identity / spotlight accuracy — research record (2026-07-15)

Investigation of two defects Karim reported after watching the spotlight on
the pilot game (`d9fee1fc`, Nazwa, 56 min):

1. rings drift off players toward the pitch **corners**
2. tracking **loses a player when they pass behind another**

Both were measured. The headline: **(1) is a real ~1 m effect at the pitch
edges caused by non-planarity, and (2) is the actual product blocker — and
appearance-based re-ID cannot fix it.**

These scripts are the record + the reusable method. They expect a local cache
(`cache/trk_items.json`, `cache/det_*.json`, `mesh/`, `prod-solve.json`)
built the way `extract_crops.py` / `produced_overlay.py` do it; they are
research tools, not production code (same status as `scripts/follow-re/`).

---

## 1. Produced-video overlay — `produced_overlay.py`

Renders spotlight rings onto Spiideo's **produced auto-follow mp4** by
projecting tracklet pan/tilt through the aim-track camera pose.

Camera model (verified symbolically against `VirtualPanoramaPlayer.tsx`):

```
dir(pan,tilt) = (-sin pan cos tilt, -sin tilt, cos pan cos tilt)
camera at origin looking along dir(aim_pan, aim_tilt), world up = (0,-1,0),
three.js lookAt basis, PerspectiveCamera.fov = VERTICAL degrees
```

**Validated** by also projecting Spiideo's own detections (green) — they land
on players, so the aim-track + projection chain is correct.

### ⚠️ This overlay is NOT accurate enough to judge the spotlight by

`time_align.py` + `fov_diag.py` quantified its own error against YOLO people
detected directly in the produced frames:

| | |
|---|---|
| best time offset | **dt = 0** (no time bug; ±3 s scan only worsens) |
| error vs fov | 43 px @ fov 15-25° → **72 px @ fov 45-70°** (corr +0.30) |
| error vs frame edge | 40 px centre → **96 px at r>0.75** (corr +0.44) |
| floor (narrow fov, central) | ~40 px |

Spiideo rendered the Play mp4 with **their** projection; this overlay assumes
a pinhole. It degrades exactly where a pinhole breaks down.
**The Explore player is immune** — it projects the ring through the *same*
camera that draws the pixels, so it is self-consistent by construction.
Only judge the artifact on raw frames (`tracklets-validate.png`) or in Explore.

## 2. The corner error — `residual_field.py`, `field_shape.py`

Measured in **metres on the grass** (rayn residual → metric via H⁻¹), on an
unbiased loose-gate (0.06) correspondence set. *Note: the 0.03 product gate
truncates exactly where error is worst, so it understates — always diagnose
at a loose gate.*

```
far end  y=-27.9 : |d| ~1.15 m,  dy = +0.79..+1.25   (points INWARD)
centre   y~0     : |d| ~0.05 m                        (essentially perfect)
near end y=+26.1 : |d| ~0.79 m,  dy = -0.69..-1.64   (points INWARD)
```

- **radial/isotropic**, not a uniform shift (`|mean unit vector| = 0.185`)
- vectors align to a nadir near the touchline/halfway (where the mast is) to
  within ~15-20°
- **NOT the lens/mesh**: `corr(|d|, |rayn|) = +0.006`, flat across every
  quartile (0.27/0.23/0.22/0.21 m). Clean null — the calibration is not the
  culprit (consistent with the "calibration is at the data floor" finding).

**Why this proves non-planarity:** a homography maps any *flat* plane exactly
— tilt and height are absorbed for free. A systematic residual is only
possible if the surface genuinely isn't planar. Candidate mechanisms (NOT
separable from one game): pitch camber, a range-dependent bias in Spiideo's
tracker, or foot-point bias in the detections at long range.
`height_model.py` attempts an explicit crown fit — **it did not converge**
(nadir ran to 850 m); do not claim "the pitch is crowned" as established.

### Correction attempts — `fit_correction2.py` — NOT SHIPPED

A polynomial residual field looked like it halved the corner error under a
30 s-block-alternating split (0.795 → 0.369 m at the ends). **That split
leaks spatially** — fit and val contain the same pitch locations. Under a
strict *whole-window-excluded* test the corner median did **not** improve
(1.18 → 1.25 m; only the within-0.30 m fraction rose 2% → 12%).

> **Rule:** when fit and eval can touch the same region of the underlying
> domain, "held-out" is a lie. Hold out the DOMAIN (a whole window / venue /
> corner), not the samples. This is the same class of mistake as the eval
> gate that let the sheared H ship twice.

Also note `fit_correction2.py` scores on a **fixed** correspondence set:
re-matching after correcting makes the median self-selecting (more far-field
points enter the gate and drag it up even as accuracy improves).

Centre-of-pitch error is **0.22 m** = the tracker + detection noise floor.
No registration fix can go below it.

## 3. Identity — `extract_crops.py`, `reid_bench.py` — **the real blocker**

Chain statistics on the pilot (56 min, ~16 players):

| | |
|---|---|
| chains | **2094** |
| median identity duration | **14 s** (max 366 s; only 4 > 300 s) |
| total tracked player-time | **101% of ideal** |
| chain deaths while another player is <1.5° away | **59%** (vs 36% at random; median separation at death 1.11° vs 3.41°) |

**We see every player the whole match; we just cannot keep their name.**
Detection is solved and free. Re-identification is not.

### The benchmark (free ground truth)

Within a chain Spiideo held identity → two crops from the same chain **are**
the same player. 844 crops, 5 windows across the match, **median crop 117 px
tall (99% ≥64 px)** — resolution is *not* the limit (Market-1501 uses 128×64).

Rank-1, "pick the right player out of the field at t+gap" (chance ≈12%):

| gap | POSITION (stitcher today) | COLOUR | ResNet50 | DINOv2 |
|-----|--------------------------|--------|----------|--------|
| 2 s | **91.8%** | 56.2% | 52.6% | 56.1% |
| 6 s | 74.6% | 36.3% | 36.3% | 43.0% |
| 10 s | 54.8% | 35.5% | 38.6% | 42.1% |

**HARD subset (position picked WRONG — the occlusion breaks): appearance
rescues only ~20%.** Naive position-gate + appearance-rank fusion was *worse*
than position alone.

### Why — the ceiling is the kit

Stratified by team (k-means on colour, per chain):

| gap | mixed field (chance 12%) | same-team only (chance 25%) |
|-----|--------------------------|-----------------------------|
| 2 s | COLOUR 56.2% / DINOv2 56.1% | COLOUR 62.5% / DINOv2 **66.4%** |
| 10 s | COLOUR 35.5% / DINOv2 42.1% | COLOUR 43.4% / DINOv2 **53.0%** |

Lift over chance: **3.5-4.7× in a mixed field, only 2.1-2.6× among
teammates**. Appearance reads the **kit**, not the player. DINOv2 beats
colour within-team (real per-person signal in body shape/hair) but would
still pick the wrong teammate ~half the time at 10 s — worse than honestly
reporting "lost" for a follow-my-kid product.

### Verdict

- **Do not build generic appearance re-ID.** Measured ceiling; the ceiling is
  the kit. `supervision` (Roboflow) is a utility lib (annotators + ByteTrack),
  not a detector — and detection isn't the bottleneck (101% coverage, free).
  ByteTrack associates on motion + IoU, the exact signal that vanishes in an
  occlusion.
- **Jersey number is the unlock** — and it is precisely what **both** Veo and
  Spiideo do. The Perform recon found Spiideo's identity comes from
  jersey-numbered **event tags**, not from their tracking stream. Neither
  competitor solved this with appearance; they sidestepped it. → Phase 5 kit
  detection; CFA's 11,366 team-labelled highlights are the corpus.
- **Narrow cheap win first:** `build_track.stitch`'s ambiguity gate *refuses*
  bridges precisely at occlusions (by design — "no-follow beats wrong-follow"),
  compounding Spiideo's breaks. There it is a **2-way** choice, not 1-in-8 —
  a far easier problem than full re-ID, and where the ~20% lives.
- **Karim's photo-glimpse "find yourself" picker** offloads identity to the
  *human*, who can recognise themselves at 117 px where every embedding
  fails. But it is downstream of chain length: at a 14 s median a user would
  identify themselves ~240× per match. Fix identity duration first.

---

# 4. The stitcher, measured (2026-07-15 late) — the "cheap win" above is FALSE

Scripts: `fetch_tracklets.py` (cache builder) → `stitch_diag.py` (noise + death
taxonomy), `uuid_reuse.py`, `ceiling_probe.py`, `ceiling_eval.py`.
Data: 4 games / **3 venues** — Nazwa `d9fee1fc` (tune), Football Plus `b3bf24bf`
+ `f9d6898f`, HCT Dubai `4b4ecece` (all held out). Venue is the domain; the
tuning game is never quoted as evidence on its own.

## 4.1 The ambiguity gate is not the problem. It was never the problem.

§3 claimed the stitcher's ambiguity gate "refuses bridges precisely at
occlusions… that is where the ~20% lives". Measured share of chain deaths
caused by that gate:

| bucket | Nazwa | FB+ | FB+ | HCT |
|---|---|---|---|---|
| `a_no_candidate` | 34.4% | 58.3% | 20.4% | 7.8% |
| `b_gate_distance` | 63.1% | 39.6% | 76.6% | 88.7% |
| **`c_ambiguity`** | **0.0%** | **0.2%** | **0.0%** | **0.1%** |
| `d_claimed` | 0.1% | 0.5% | 0.4% | 0.4% |

**0.0-0.2%.** The gate barely runs, because the 1.5 s ceiling gets there first.
The whole "2-way choice at a crossing" framing described a code path that
essentially never executes. *Lesson: a plausible mechanism read off the source
is a hypothesis, not a finding. This one survived a full session, a written
recommendation, and a specialist review before anyone counted.*

Noise, for the record (it was assumed, never measured): σ = **0.054-0.067 m**
(2nd- and 4th-difference kernels agree → acceleration is not contaminating it),
σ(d_fwd) ≈ 0.08-0.11 m **at gap→0**. 2nd-diff autocorr lag1 = −0.40 vs −0.667
for white → the residual is correlated, consistent with Spiideo already
smoothing their tracker output. Note the gap→0 caveat: at 2.5 s the association
statistic's σ is ~1-2 m, so `AMBIGUITY_FLOOR_M = 0.5` is ~5σ where it was
calibrated and **under 1σ** where it now operates. Open item.

## 4.2 The real constraint is upstream, and it is absolute

`uuid_reuse.py`: when a uuid vanishes and returns, is it the same player? Test
is physical — implied speed |Δp|/Δt against a null that substitutes a
*different* uuid live at the same instant.

- Re-appearances **are** genuine: 100% physically reachable vs **28-74%** for
  the null (median 0.86-1.39 m/s vs 4.5-13.7).
- **But the longest intra-uuid gap anywhere is 1.6 s, and there are ZERO
  re-appearances past 2 s.** Once a player is lost for >2 s they come back as
  a brand-new uuid, forever.
- Scale: **2488 uuids for ~16 players in 56 min** ≈ a fresh identity every
  ~22 s per player (±40%: assumes 16 players, and the count is pre-roster).

`build_track.py`'s docstring said "uuid reuse is not trusted across absences" —
that was an *assumption*, and the previous persistence result (0.29 m seam jump,
n=3122) only ever covered ADJACENT items. It is now measured. The tracker mints
identities and never takes them back; **no stitcher can recover an identity the
upstream never kept.** That, not our gates, is why chains are short.

Meanwhile 70-86% of deaths have their nearest plausible continuation **1.5-5 s**
out — beyond the ceiling. (Caveat: that statistic uses a loose reach budget
`d_fwd ≤ max(2, 7·gap)` = 21 m at 3 s, and it has **no null**, unlike the uuid
test. Treat "1.5-5 s" as the shape, not a precise number.)

## 4.3 A real bug: the ambiguity gate *demoted the winner*

Found by a unit test written against the gate's stated intent.

The rival filter was `x > d` — strictly worse edges only. Refusing an edge does
**not** claim its endpoints, so the greedy loop went on to reach the runner-up,
whose worse-only filter **could not see the better edge just rejected**. Its
rival list came up empty and it was accepted.

So when the gate fired it did not refuse an ambiguous bridge. It **discarded
the best candidate and took the second-best** — reliably choosing wrong exactly
where it had judged the choice unsafe. Measured: **3.6-5.4% of every bridge in
production**. Fixed (rivals = any other *still-claimable* edge touching either
endpoint): demotions **12→1, 10→0, 23→0**, with **median chain duration
unchanged**.

That last clause is the important one. A correctness fix that removes 4-5% of
wrong-follows moved the headline metric by **zero** — which is direct evidence
that **median chain duration cannot see identity errors at all** (§4.5).

## 4.4 The gap ceiling: raised 1.5 s → 2.5 s (SHIPPED)

Past 1.5 s the accel envelope `0.8 + 0.5·4·gap²` is useless — 13 m at 2.5 s,
51 m at 5 s, wider than the pitch. So the envelope goes **linear**
(`0.8 + 1.5·gap`) from 1.5 s to `STITCH_EXT_GAP_S = 2.5`. Purely additive: the
≤1.5 s path is byte-identical (verified — the OFF arm reproduces every baseline
exactly).

`ceiling_eval.py` — inject a gap of τ into a long fragment (uuid = free GT), run
**production's own `stitch_edges` + `stitch_assign`**, ask whether it rejoined
the true pair:

| true gap | ceiling 1.5 (before) | ceiling 2.5 (after) |
|---|---|---|
| 0.6 s | 99.3% prec / 81% recall | 98.3% / 79% |
| 1.0 s | 99.0% / 79% | 98.7% / 76% |
| **1.4 s** | **18.9% / 1.4%** | **95.4% / 60%** |
| **2.0 s** | **0% / 0%** | **94.3% / 52%** |
| 2.4 s | 0% / 0% | 16.2% / 1.4% |

(precision/recall on the **crowded** subset — cuts with another player <2 m,
matching real deaths at 51-83% — not the optimistic all-cuts figure.)

**The finding that reversed the recommendation:** when the true continuation is
beyond the ceiling, the stitcher does **not** refuse — it bridges to a
**stranger**. At a 1.4 s break today it makes **86 wrong bridges and 20 right
ones**. The extension takes that to **47 wrong and 948 right**: better on
*both* axes. A ceiling does not buy safety, it just relocates the cliff — note
2.4 s now collapses exactly as 1.4 s used to.

Effect on real games: median **+9 to +22%** (Nazwa 14.0→16.0 s, FB+ 10.2→12.4
and 11.2→13.0, HCT 8.2→9.0).

> **Method note, and it is the main lesson of the session.** The first version
> of `ceiling_eval.py` scored a hand-rolled "unique candidate in a linear
> envelope" rule and reported 98%. Production never restricts to unique
> candidates — it takes the best whenever the ambiguity margin passes, a
> strictly larger and more dangerous set. **The number described a branch the
> shipped code does not use**, and it was quoted to Karim as the basis for a
> ship decision. Score the decision function you are shipping, by calling it.
> That is what the `stitch_candidates`/`stitch_edges`/`stitch_assign` seams are
> for.

## 4.5 What this means for the roadmap

**Duration and purity are the same dial turned opposite ways.** A wrong bridge
makes chains *longer*. So median chain duration — the metric this work is
naturally reported on — *rises* under the failure mode it risks, and §4.3 is
the proof: removing 4-5% wrong bridges moved it by zero.

The product metric is a survival curve: **P(the ring is still on the person you
clicked, T seconds later)** for T = 5/15/30/60 s. Nothing here reports that yet.

And chains compound: purity = `q^(k−1)` for k segments. Bridging ~90% of breaks
means ~10 segments, so even q = 0.95 → **63% pure**. Geometry cannot reach the
q that long chains demand — this is arithmetic, not pessimism.

**Which is the real argument for jersey, and it is stronger than "10× duration":
jersey stops the compounding.** With a per-fragment jersey posterior you don't
chain at all — you assign fragments to a 22-slot roster. Errors become i.i.d.
against a *label*, so P(correct at T) is flat in T instead of `q^k`. A jersey
signal that is only ~70% per fragment still yields a near-perfect roster when
pooled over 100 fragments. Geometry's ceiling is ~20-28 s at high purity;
**jersey's ceiling is the whole match, and it gets there by not chaining.**

## 4.6 Open items (measured, not done)

- **`AMBIGUITY_FLOOR_M = 0.5` is calibrated for gap→0** (~5σ) and is <1σ at
  2.5 s. Fix properly by normalising the cost: `d_fwd / σ_true(gap)`, with
  σ_true measured from the injected cuts, and a dimensionless floor. Then one
  constant is valid at every gap.
- **The envelope is isotropic.** A real reachable set is elongated along `v`
  and asymmetric (braking is cheap, reversing is expensive). Decompose the
  residual into along/cross-track; the along-track lower bound is what would
  recover decelerating players, who are probably a chunk of `b_gate_distance`.
- **`b_gate_distance` may be partly self-inflicted.** `_endpoint_velocity` fits
  the last ≤5 samples — the second *before the tracker lost the player*, i.e.
  when constant-velocity is least valid, and (if Spiideo pre-smooths) lagged.
  Free test: compare the *static* residual `|p_head − p_tail|/gap` against
  9 m/s. Reachable-but-CV-rejected ⇒ the gate SHAPE is the bug, not the ceiling.
- **The gap-distribution statistic has no null.** `uuid_reuse.py` has one and
  is disciplined because of it. Point the same tool at this.
- **The artifact cannot distinguish a bridged gap from tracked data.**
  `smooth_and_resample` interpolates across the hole, publishing ~12 fabricated
  5 Hz samples at 2.5 s. So a wrong bridge renders as a *confident solid ring*
  gliding from player A to player B. Emit `bridged: [[t0,t1]…]` per object and
  reuse the client's existing lost-state dash inside those intervals — the
  rendering-layer form of "no-follow beats wrong-follow".
- **`SEAM_MAX_GAP_US = 1.0 s` discards the only trustworthy upstream identity
  signal we have.** Re-appearances to 1.6 s are measured genuine; raising the
  seam to ~2.0 s recovers them (~1.4% of deaths — small, but it is *upstream
  truth* rather than a geometric guess). Tighten `SEAM_SPEED` 12 → 9 if so:
  12 m/s over a 1.6 s seam authorises a 19 m jump, which is not a gate.
- **`KF_SIGMA_M = 0.3`** is annotated "pilot MAD estimate"; measured σ is
  0.054-0.067 — a 25× variance error. Left alone deliberately: 0.3 is what
  produced the validated smoothness, so changing it is its own risk.
- **`a_no_candidate` ranges 7.8% → 58.3% across venues** with no story. Until
  that 7× spread is explained, none of these percentages are venue-independent
  constants — and the shipped ceiling is a venue-independent constant.

# Calibration benchmark — frozen baselines (2026-07-18)

Scoreboard for the lens/mount auto-calibration workstream. A candidate fit/mesh
is judged by `gates.py` (extended 2026-07-18 with GATE E + %-of-span currency +
`REPORT` json output); the target for automation is **every metric ≤ its frozen
baseline, and line-bow / mark-reprojection < 0.3% of pitch span** (~10px at 4K).

## Metrics

- **GATE A line-bow** — hand-snapped lines unprojected through the fit,
  re-rendered through a virtual pinhole aimed at each line; max perpendicular
  bow as % of the line's rendered chord. For long pitch lines the chord ≈ the
  pitch span, so the 0.3% target applies to `worst_long_chord_pct` (lines with
  chord ≥ 40% of the longest). Gate: `BOW_PCT_MAX`.
- **GATE E mark reprojection** — admin marks (playhub_pitch_calibrations)
  scored through the generated mesh exactly as the product does
  (`marks_solver.py` = pitch-solver.ts port, validated to 1e-10 px against the
  stored server result). Max per-mark px / pitch span px (longest pairwise
  corner distance in raw px). Gate: `MARK_PCT_MAX`.

## Frozen baselines

| venue        | worst long-chord bow | GATE A wmed rms | GATE E marks             | coverage |
|--------------|----------------------|-----------------|--------------------------|----------|
| kuwait/Nazwa | 2.09% (near_touch)   | 5.9px           | 13.8px / 3118px = 0.44%  | 98.2%    |
| footballplus | 1.64% (near_touch)   | 2.1px           | (no admin marks yet)     | 71.7%    |
| hct          | 1.58% (laneA_2)      | 2.5px           | (no admin marks yet)     | 97.2%    |

kuwait's baseline is the **ACCEPTED AUTO FIT** (disc-constrained, eyes-on
2026-07-18 round 3 — see below); the fit is frozen at
`baselines/kuwait-accepted-fit.json` and is GATE G's incumbent reference
for future candidates (auto_fit prefers it over the hand fit). The
superseded hand-fit baseline (2.14 / 6.0 / 1.02% / 99.3%) is preserved at
`baselines/kuwait-hand.json`.

footballplus now HAS admin marks (Karim marked scene b3595080 through the
calibration UI 2026-07-18, exported to footballplus-marks.json) — and they
exposed that the CURRENT hand fit is metrically broken: **127.5px max /
5.2% of span through the deployed game mesh** (reproduced offline; stable
under re-clicking — Karim re-marked corner_sw, 137.5→127.5). Root cause
class: footballplus's F was never disc-anchored (0.29·W prior, disc_ok
false) — plumb lines fix straightness, not the metric gauge. The
marks-joint auto refit (REFINE_F=1, sign-fixed mount) lands **GATE E 2.7px
= 0.09% of span** with GATE A at parity (1.67/2.12 vs 1.64/2.1) — staged
to `public/vp-mesh-footballplus-auto`, eyes-on pending. NOTE
`public/vp-mesh-footballplus` (the local "hand" mesh, 24px at marks) does
NOT encode the current footballplus-fit.json (4.6-5.2 deg ray-field apart
— it's an older lens generation); the deployed game meshes DO match the
current (broken-at-marks) fit.

## Recipes

```sh
cd PLAYHUB/scripts/vp-calibration
env SITE=kuwait LINES=kuwait-lines.json MESH=benchmarks/meshes/nazwa-b923 \
    MARKS=kuwait-marks.json REPORT=benchmarks/baselines/kuwait.json python3 gates.py
env SITE=footballplus LINES=footballplus-lines.json \
    MESH=../../public/vp-mesh-footballplus REPORT=... python3 gates.py
env SITE=hct LINES=benchmarks/hct-lines.json MESH=../../public/vp-mesh-hct \
    SEAM=0 REPORT=... python3 gates.py
```

Notes:
- `benchmarks/meshes/nazwa-b923` is the DEPLOYED game mesh
  (panorama-meshes/b923d40f…) the saved admin calibration was marked through —
  score marks through it, not a regenerated local mesh, when comparing against
  the stored 31.79px.
- `benchmarks/hct-lines.json` merges the two per-camera hand-line files with
  `camera` indices for gates.py cameras[] mode.
- **HCT is exempt from the auto-calibration path** (converted Spiideo mesh).
  Its baseline is gates A–C only; GATE D is skipped (`SEAM=0`) because
  hct-fit.json does not reproduce the shipped mesh's uv↔ray map (measured
  ~1300px median with the stored R, ~290px after a free Kabsch refit — the fit
  targets a different artifact than what ingest produced). Do not "fix" gate D
  for HCT by loosening it; the fit and mesh are genuinely different models.
- kuwait GATE A short box lines carry high pct-of-chord (5–8%) from hand-snap
  noise on 9–16 point lines; the long-chord metric is the stable one.

## RIM BLIND SPOT — eyes-on FAILED the auto fit while every gate passed (2026-07-18 ~03:00)

Karim A/B'd the meshes on /panorama-test (`?mesh=/vp-mesh-kuwait-auto` vs
`?mesh=/vp-mesh-kuwait`): hand "so much better", auto "still quite curved on
the near edges". Measured (datum-aligned ray-field residual vs the hand fit):
interior θ<75 agrees to ~1°, but **θ 85-92 diverges 4.8° median (~100-150px
of near-edge warp at product framing)** — the benchmark's gates all score the
INTERIOR (hand lines + marks reach θ≈80), so every number improved while the
rim extrapolated freely (refinement moved k1 0.001→−0.037 for the marks).

Facts that shape the fix:
- **The lens rim is strongly non-equidistant** (hand fit: +172px past r=Fθ at
  θ90, +715px at θ100) — so anchoring the rim to the solve's minimum-|k|
  curve is anchoring to the WRONG shape, and doing so contorted the optimizer
  into a **mirrored mount that the 50-mrad mark sanity cannot see** (marks
  fit fine on an upside-down decomposition). A physicality check on the
  decomposed mount (TILT∈(5,85), |ROLL|<30) now aborts that basin.
- **Capacity ablation (RIM_REF=hand RIM_W=10): the polynomial CAN do both** —
  marks 0.46% of span (best ever), bow 2.08/wmed 5.91 (still beat hand), rim
  residual 4.8→3.6° median. Not a shippable config (hand curve = circular for
  a new venue) and only partial rim recovery: the two fits disagree on CX by
  143px, which a radial-only anchor can't express.
- Conclusion: the auto pipeline needs a **rim information source** for
  unfitted venues before any fanout. Candidates: the disc edge as a
  constant-θ contour (it's annotated already), structures crossing the rim,
  reg-SIFT vs Spiideo's own render (Spiideo venues), or shipping the solve's
  interior with a mesh window capped at the constrained θ. And gates need a
  GATE G: rim ray-field residual vs the incumbent fit where one exists.

## Eyes-on round 2 (2026-07-18 ~03:45, Karim on /panorama-test)

- **HCT near-LEFT pitch corner not covered: CAPTURE limitation, not mesh.**
  Measured: cam A's strip ends at world pan −67.7° with uv-x exactly 0.0000
  (physical frame edge), while cam B reaches +75.1° (also frame-limited,
  uv-x 1.0). The two cameras are aimed asymmetrically relative to the pitch —
  ~8° less reach on the left. No mesh work can recover pixels the camera
  never captured; the fix is physical re-aim (Spiideo scene config).
  Cosmetic option: clamp the scene window's minPan (−75.65) to the actual
  −67.7 coverage so users can't pan into the void.
- **Football Plus AUTO fit: "quite curved on the near edges" — the rim blind
  spot is SYSTEMIC, not kuwait-specific.** Note footballplus has no marks, so
  its auto fit never entered the joint refinement — the curved rim there is
  the SOLVE's own minimum-|k| (near-equidistant) extrapolation, confirming
  that BOTH stages need a rim information source (the K_REG minimum-norm
  default is the wrong rim shape for these lenses; kuwait's hand fit is
  +715px past equidistant at θ100). Any rim fix must live where the no-marks
  path can use it too.

## DISC-RIM SOURCE + GATE G shipped (2026-07-18, second session)

The rim information source is the fisheye DISC EDGE as a constant-theta
contour (`disc_rim.py`, consumed by auto_fit's refinement + gates.py GATE G;
calibrate.py has an env-gated experimental hook). Staged for eyes-on:
`public/vp-mesh-kuwait-auto` = the disc-constrained auto fit, built with NO
hand-fit reference in the fitting path (judge on
localhost:3001/panorama-test?mesh=/vp-mesh-kuwait-auto vs /vp-mesh-kuwait).

**Numbers (kuwait auto, RIM_REF=disc RIM_W=1.5 RIM_SMOOTH_W=3 — the shipped
defaults):** marks **0.44%** of span (baseline 1.02, prior auto 0.63, hand-
anchored ablation 0.46 — best ever), bow **2.09%** (baseline 2.14), wmed
**5.9px** (6.00), disc-arc gate +0.54 deg, rim ray-field vs hand **3.25 deg
median / 6.30 p90** (rejected auto was 5.30/6.95; hand-anchored ablation
~3.6). GATE G therefore reports **FAIL at the provisional 2.0 deg bar — the
red is intentional**: Karim's verdict on the staged mesh is the datum that
either relaxes RIM_MAX_DEG to ~3.5 (if flat) or confirms the disc source is
insufficient alone (if still curved).

**What the disc edge is, physically (kuwait):** an out-of-focus housing
vignette, soft over ~50px, bright-gray at some azimuths and dark-on-dark
invisible at others — NOT a crisp optical circle. Multi-azimuth features are
NOT concentric (the traced bottom band edges read theta 82-87 through the
hand fit vs 88.2 on the annotated arc; the occluder is decentered/a different
edge) — so the source's intrinsic accuracy is ~±1-2 deg on the annotated arc
and ~±3 deg cross-azimuth. It reliably kills the 6-deg failure class; it
cannot pin the field below ~1 deg. Only the ANNOTATED arc is used
(`az_deg` [160,207] added to kuwait-disc.json; annotate_disc.py now stores
clicked points + az range). DISC_THETA_DEG=88.2 is the lens-class constant
measured through the kuwait hand fit on the exact rim_points() sampling —
**n=1**: footballplus's image circle extends past its frame (zero exterior
pixels; its `disc_ok:false` is physical) and HCT's 3840x1080 per-lens crops
show no rim, so no second venue can corroborate. A different lens SKU must
override (json `theta_deg` / env).

**Two measured dead ends (do not re-attempt without new evidence):**
- **Rim term in the FREE solve (calibrate.py DISC_W=1) flips the CY basin**:
  the solve ran to CX/CY (1682,860) — dragged toward the annotated circle's
  CENTRE, which is ~300px off the principal point (8-pt short-arc Taubin
  degeneracy) — k's changed sign, arc theta landed at 75 deg, mount
  mirrored (the physicality abort caught it). Under the solve's global
  soft_l1 the term perturbs the basin yet cannot enforce itself. DISC_W now
  defaults 0; the rim lives in the bounded refinement (same lesson as
  REFINE_LINES).
- **Curve-smoothness (RIM_SMOOTH_W) does not move the ray-field metric**
  (3.21→3.22→3.38→4.12 for W 1/3/10/30; interior degrades past W~10). The
  residual is CX-offset-dominated and a ONE-SIDED arc structurally cannot
  pin CX: with free k's it pins CX + r(theta_disc) jointly and the curve
  absorbs a centre slide (the refined fit sits at CX 2001 vs hand 1871 with
  the arc satisfied at +0.99 deg). Kept at W=3 as cheap anti-whip insurance
  (the pin alone let k4 whip: arc 0.26 deg while pixels just inside it read
  6.6 deg).

**Why the residual 3.25 deg may still pass eyes-on:** the admin marks reach
into the rim zone (corner_se theta 82.1, corner_sw 76.0) and hold the fit to
<=0.7 deg there, and the disc arc holds 88.2 — the product-visible pitch
surface is bracketed; the remaining divergence concentrates in off-pitch
periphery (frame-edge left/right at theta>85, incl. beyond-disc scallop
pixels that render as the content boundary). Also note the frozen-baseline
regression check passes: rim terms OFF reproduces 0.63/1.87/5.83 exactly.

**GATE G (gates.py, ON by default for single-camera fits):**
- incumbent mode (RIM_REF_FIT; auto_fit passes the hand fit automatically):
  reference-fit iso-theta sampling, Kabsch datum alignment on theta<=75,
  gates the theta 85-92 band median at RIM_MAX_DEG (2.0 provisional, 'off'
  disables). Frame-bounded domain on purpose — beyond-disc pixels render as
  the visible scallop boundary, so their field error is product-real.
- disc mode ({SITE}-disc.json with az_deg): annotated-arc mean theta vs
  DISC_THETA_DEG, DISC_TOL_DEG (2.0). Hand fit reads +0.04; the rejected
  auto read +5.97.
- Refit refusing both modes (no incumbent, no disc — e.g. footballplus
  today) currently runs WITHOUT a rim gate: that venue class still has no
  rim source (its auto rim remains solve-extrapolated; mesh-window capping
  or reg-SIFT vs Spiideo's render are the remaining candidates there).
- **Disc mode ALONE is never sufficient evidence** (CV review 2026-07-18):
  for a disc-refined candidate it re-evaluates the quantity the optimizer
  just minimized — convergence, not quality. It stays a hard gate because
  it catches non-disc-refined fits, but a marks-less fit with no incumbent
  (the exact class marks-less mode exists for) MUST be gated by eyes-on
  before its mesh ships. That path also has zero venues able to exercise it
  end-to-end today (kuwait has marks, footballplus/HCT no disc) — it is
  production-untested.
- New r(theta) INJECTIVITY check inside gate G (all single-camera fits,
  incl. RIM_W=0 paths): dr/dtheta must stay positive over (0, 100] deg — a
  folded curve double-covers the mesh domain and nothing else could see it
  (the rim pin's penalty path + the k3/k4 bounds protect refined fits, but
  no-disc venues had no check at all). The k3/k4 refinement bounds are
  load-bearing for bisection safety — see the comment at auto_fit's bounds
  before widening them.

Marks-less venues WITH a disc now get the rim in a lines+rim-only
refinement pass (auto_fit no longer skips refinement when marks are absent;
the mark-sanity abort is unavailable there — GATE G is the backstop).
Refinement CX/CY travel widened 120→160px when a rim reference is active
(the measured hand-vs-auto CX gap is 143px; a 120 bound parks on the bound).

Session probes (scratchpad, this session): spike_disc_theta*.py (rim
tracing + theta measurement), fit-smooth*/fit-rw* ablation fits.

## Eyes-on round 3 (2026-07-18 afternoon): AUTO FIT ACCEPTED as baseline

Karim A/B'd the staged disc-constrained mesh vs the hand mesh: **the auto
fit is better on the LEFT corner, the hand fit better on the RIGHT corner,
and overall he prefers the auto fit as the baseline.** The split matches
the measurement exactly: the annotated disc arc lives on the LEFT (az
160-207 — the auto rim is pinned there), while the RIGHT side has NO rim
observable (dark exterior, boundary invisible) and carries the residual CX
slide (GATE G az 330-30 ~3.1 deg). Consequences applied:
- accepted fit frozen at `baselines/kuwait-accepted-fit.json`; its report
  is the new `baselines/kuwait.json`; auto_fit's GATE G now references the
  accepted fit (RIM_MAX_DEG stays 2.0 — it measures drift from the
  accepted baseline, no relaxation needed; the pipeline reruns green and
  deterministic, 0.00 deg vs itself).
- **Prod swap DECIDED AGAINST for now (2026-07-18, Karim delegated the
  call):** the accepted fit is better-left/worse-right vs the deployed hand
  mesh (mixed, not strict), and a swap costs the full artifact lockstep
  (every Nazwa per-game mesh + aim-tracks at 4-7h/match + tracklets; admin
  marks were placed through the deployed mesh) — which the pending
  right-corner rim source would force paying a SECOND time. Trigger to
  revisit: a fit strictly better on BOTH corners (i.e., after open item 0
  lands). Until then prod stays on the hand meshes; the accepted fit's
  value (zero-annotation path validated + GATE G reference) is already
  banked.

## FOOTBALLPLUS REFIT (2026-07-18, after Karim's marking session)

The marking session doubled as the venue's E2E: the UI's "127.5px —
camera model needs a refit" banner was CORRECT (verified offline: fresh
mesh from the current fit reproduces 127.5 exactly; the error is stable
under re-clicking; the miss at midline_s is not rim-theta — it sits at
theta 51 — it's the un-anchored metric gauge). The auto pipeline with the
new marks (REFINE_F=1 because footballplus's F anchor is a guess, unlike
kuwait's disc-derived F) fixed it: mark residuals 0.76-2.29 mrad, GATE E
0.09% of span, interior parity. Two code discoveries en route:

- **H-SIGN BUG in the marks mount (auto_fit.py, fixed):** the DLT's
  homography is defined up to +/- sign; with the wrong sign the pitch sits
  BEHIND the camera and the decomposition reads as a mirrored mount
  (TILT 135/ROLL -179) even though marks fit at ~1 mrad — indistinguishable
  from the bad-basin signature until you check t_z. Fix: negate H when
  H[2,2] < 0 (pitch origin must be in the forward hemisphere). kuwait's H
  happened to come out positive, which is why the mirror abort had only
  ever fired on genuine bad basins before. GATE F and pitch-solver.ts are
  sign-invariant (up = r1 x r2 survives H -> -H) — only the mount stage
  consumed the sign.
- **GATE F hard-gate viability first sighting:** footballplus's indoor
  steel columns give 11 qualifying chains in 5 x-cols (median dev 4.83 deg,
  best chains 0.8-1.5) — the venue class the gate was designed for.
  Informative this run; worth PLUMB_MAX_DEG once the mount question below
  settles.

Open questions for eyes-on (staged: `?mesh=/vp-mesh-footballplus-auto` vs
`?mesh=/vp-mesh-footballplus`): the marks-mount TILT is 44.9 vs the hand
fit's 33.8 — an 11 deg disagreement with a discredited reference; a wrong
mount reads as leaning verticals when panning. And GATE G's 3.21 deg rim
red is measured against the discredited hand fit — if eyes-on accepts,
freeze this fit as `baselines/footballplus-accepted-fit.json` and the red
resolves the same way kuwait's did.

## THE NEAR-LINE CURVE IS REAL GROUND GEOMETRY — measured closed (2026-07-18 eve)

Karim's cross-venue observation ("the same curve on the entire line close to
the camera, Nazwa and Football Plus") is now diagnosed. Facts:
- Both footballplus lens models (old + refit, 4.6 deg apart in ray field)
  render the same bow; both kuwait fits ditto (~2.1%). A residual that
  survives every refit is either world geometry or a model-FAMILY blind
  spot.
- World-space reconstruction of the snapped near-touchline paint through
  the validated footballplus refit: **straight to ±5cm rms in PLAN view**
  over the covered 14m (smooth symmetric profile).
- **Tangential ablation (scratchpad ablate_tangential.py): Brown p1/p2
  freedom recovers only 23%** of the near_touch straightness residual
  (7.72 -> 5.91 mrad) at held marks — the radial family is NOT the
  bottleneck. (The fitted p2 drives the 6 marks to 0.05 mrad = overfit;
  do not ship tangential terms.)
- Mechanism: the paint is straight in plan but lives ON the ground surface
  — a few cm of crown/settle makes it genuinely NON-STRAIGHT IN 3D, and
  proximity amplifies the near line's image curvature. A correct camera
  model faithfully renders a genuinely curved line; no calibration can or
  should remove it. Spiideo's own de-warp shows the same paint.

Consequence: the near-line bow is at its physical floor (~5-6 mrad
footballplus, ~2% chord kuwait); further lens work targets it no more.
What remains model error is the CORNER warp (kuwait right corner — open
item 0). Making the near line LOOK straighter than reality would be a
deliberate cosmetic ground-height warp — a product decision, not
calibration. The 0.3% GATE E target remains reachable (footballplus is at
0.09%); the BOW_PCT 0.3 target is NOT reachable on crowned ground and the
frozen bow baselines (1.67/2.09%) are the honest ceilings.


## Eyes-on round 4 (2026-07-18 eve): REG-SIFT candidate joins the podium — PROMOTED

Karim rated `vp-mesh-kuwait-auto` (disc) and `vp-mesh-kuwait-regsift` as the
two best, both over the hand mesh. The instrumentation splits the tie: the
regsift fit passed EVERY gate including GATE G at 2.0 vs the then-accepted
disc fit (rim 1.02 deg median — the first kuwait fit fully green) and closes
most of the right-corner gap (within 0.1-0.3 mrad of hand there, where the
disc fit trails). PROMOTED to `baselines/kuwait-accepted-fit.json` +
`baselines/kuwait.json` (disc-auto report preserved as
`baselines/kuwait-disc-auto.json`; its fit remains in benchmarks/). Known
accepted cost: near_touch bow 2.30 vs 2.09 (the line's curvature is real
ground geometry; reg data has ~no bottom coverage). Kuwait numbers now:
bow 2.30 / wmed 5.95 / marks 0.49%.

Prod-swap trigger status: right corner at par with hand + left better =
effectively met. Plan: ONE artifact-lockstep session regenerating BOTH
venues' deployed meshes (kuwait + footballplus — FP's deployed model is the
measurably broken 127px one, the stronger case) with aim-tracks + tracklets
in lockstep. Footballplus regsift candidate (`vp-mesh-footballplus-regsift`)
still awaits eyes-on.


## Eyes-on round 5 (2026-07-18 night): FP regsift PROMOTED; near-corner up-curl = NON-RADIAL model error

Karim: "same with football plus" (regsift preferred) "but the edges on the
near side of the camera are still curved upwards." Promoted:
`baselines/footballplus-accepted-fit.json` = the regsift candidate (bow 1.59
/ wmed 2.13 / marks 0.11% — better than the marks-only refit on bow AND all
gates green; marks-only report preserved as
`baselines/footballplus-marksonly.json`).

Up-curl diagnosis (spatial breakdown of reg residuals through the promoted
fit): **bottom-right corner 10.2 mrad median vs 5.8 global floor, while the
pure theta>=85 band reads 4.8** — the error is REGIONAL, not
radial-symmetric, so no radial model can express it (the exact
tangential/decentering signature) and it sits exactly where the up-curl is
seen. Bottom-centre has ZERO reg matches (their camera never renders
textured near-centre ground) — why the reg constraint alone couldn't close
it. The scoped experiment (tangential p1/p2 constrained by the dense reg
data, whole-WINDOW holdout — never by frame, adjacent dwell frames are
near-identical) is running; if held-out bottom-corner residuals drop toward
the floor, tangential support enters the model (fisheye_model + generate_mesh
+ solver forward-model change); if not, the up-curl is real geometry like
the near-line bow.

## Open items (as of 2026-07-18 late)

0. **Right-corner rim source for kuwait-class venues** — the accepted fit's
   known weakness (eyes-on round 3): the right side has no disc observable.
   Candidates: a human annotation session on the bottom-right band edge
   where visible (annotate_disc now stores points + az span; NOTE the
   measured feature non-concentricity ±3 deg — treat a second arc as its
   own az range with its own theta, never pin it to 88.2), or reg-SIFT vs
   Spiideo's own render.
1. **E2E on a genuinely unfitted camera** — BLOCKED on a new venue still + its
   admin marks. Football Plus has a still + hand fit but no admin marks yet;
   marking it through the calibration UI unblocks both this and its GATE E
   baseline. NOTE: footballplus has NO visible disc edge (image circle
   exceeds the frame) — its rim needs a different source regardless.
2. **Fanout lockstep machinery** (plan task 6) — untouched; needs its own plan
   before building.
3. **Non-flat-ground handling** — the only remaining path from 0.63% to the
   0.3% target (box-line recall and more k's are both measured out — see
   notes below). Alternative: more marks per venue (box corners in the
   marking UI).
4. **SOLVE=full CY-basin fragility** — mitigated by the 50-mrad sanity abort
   in auto_fit; the real fix (multi-seed CY, pick by final marks residual) is
   still open. See the basin-fragility note below.

## Auto-fit results (2026-07-18, zero hand annotation)

`auto_fit.py` (auto_annotate lines → calibrate.py SOLVE=full → joint
lines+marks refinement of CX/CY/k1..k4 → marks-homography mount → mesh →
gates). Reports in `benchmarks/{site}-auto-report.json`.

| venue        | marks % of span       | long-chord bow  | wmed rms        |
|--------------|-----------------------|-----------------|-----------------|
| kuwait       | **0.63** (base 1.02)  | **1.87** (2.14) | **5.83** (6.00) |
| footballplus | (no marks yet)        | 1.64 (tie)      | 2.50 (2.13)     |

Notes:
- The refinement's `x_scale` is load-bearing (px-scale params vs k's — default
  scaling froze CX/CY at the seed twice). Lines get elementwise soft-L1;
  marks stay LINEAR (a global robust loss saturated on their large initial
  residuals and killed the gradient). `REFINE_F=1` changes nothing — keep F
  on the disc anchor.
- Kuwait's residual is dominated by midline_s (~19px ≈ 0.3m at 30×15m):
  plausibly ground non-planarity / click precision, not lens error. Getting
  from 0.63% to the 0.3% target likely needs more marks or non-flat ground
  handling, not more k's.
- **Box-line recovery: value ceiling measured ~zero (2026-07-18).** Appending
  the six HAND box lines to the auto set (the perfect-detector ceiling) moves
  marks 0.63→0.61% of span, bow 1.87→1.89 (noise), wmed unchanged — confirming
  the midline_s diagnosis above. Detector recall work on box lines is not on
  the metric's critical path; the attempted fragment-recovery change was
  REVERTED (see the NOTE in auto_annotate.detect_pitch_lines): it recovered
  no box line (their mask evidence is fat blobs / one 55k-px merged component,
  not clean fragments; lbox_front is invisible at +0.5 brightness) and its
  15-point extension of near_touch flipped the solve (next bullet).
- **SOLVE=full is basin-fragile in CY (2026-07-18, open).** 15 additional
  visually-on-paint points on near_touch moved the solved CY by +120px
  (2018/1155 → 2030/1276, k's collapse toward 0); the joint refinement's
  ±120px bounds could not reach back, the marks mount mirrored
  (TILT 136/ROLL 176) and the mesh lost half the frame. gates.py catches it
  (coverage 44% + a new empty-projection guard instead of a crash), but the
  solve→refine hand-off has no basin sanity check. Candidate fixes: score the
  solve output against the marks BEFORE refining (the marks DLT residual is
  cheap and mount-invariant), or multi-seed CY and pick by final mark
  residual — the tier2b "refine all near-tied basins, pick by final full
  eval" lesson applies verbatim. `REFINE_LINES` env on auto_fit.py now allows
  feeding extra lines to the (bounded, robustified) refinement only.
- GATE F (plumb verticals vs marks-mount up) added to gates.py; auto_fit
  passes VERTS automatically when marks exist. Informative unless
  PLUMB_MAX_DEG is set AND the venue has ≥6 chains at θ<70° across ≥3
  x-columns — see the negative result below for why kuwait never qualifies.
- **Plumb-verticals gate: codified as GATE F (2026-07-18), and the
  fence-post-recovery premise is MEASURED FALSE on kuwait.** The hoped-for fix
  (admit fence posts the grass gate swallowed, via a marks-DLT pitch-region
  mask instead) made the axis vote WORSE (11.7°→~20° from true up): the
  admitted pool is only ~6-8% true plumb — this cage's posts curve inward
  toward the roof netting, netting seams/rails dominate, and radial ground
  paint (halfway line) is geometrically indistinguishable from plumb (its
  great-circle plane contains up). Chain-first voting: 4-5% purity. A vote
  windowed to 8° of TRUE up still drifts to ~8° (so it cannot even verify a
  known-good mount here). The one consistent cluster (window columns, one
  building, θ 57-63°) reads 2-10° through the fit whose marks-mount is
  validated at 1.02° — night building edges aren't plumb references either.
  GATE F therefore self-disqualifies: it hard-gates (PLUMB_MAX_DEG) only when
  ≥6 chains at θ<70° span ≥3 x-columns; kuwait reports "insufficient,
  informative only". Probes: session scratchpad probe_{verts,posts,axis,gate}.
  The vertical DETECTOR in auto_annotate is unchanged (measured no-benefit).

## REG-SIFT RIM SOURCE (2026-07-18, third session) — Phase-0 + arbiter + constraint

The rim source for the azimuths the disc cannot see: register Spiideo's own
Play render against our banked raw VP (same optical centre — their virtual
camera is a rotation/zoom of the fisheye, so this is rotation-only
self-calibration). Harness: `regsift_harvest.py` (SIFT + mutual NN +
fit-free local-affine filter; corner windows targeted via the game's own
aim-track — corner dwells are rare, 5 small windows beat a whole match) →
`regsift_phase0.py` (coverage) → `regsift_arbiter.py` (per-frame render-px →
ray DLT; the H absorbs their pan/tilt/roll/zoom so only OUR ray field is
scored) → `regsift_promote.py` → `{site}-regsift.npz` consumed by
`regsift_rim.py` + auto_fit's REG_W term (opt-in). Kuwait game afb81f5f
(5 windows, 83k matches), FP game cc802fc9 (5 windows, 34k matches).
Constraint artifacts were promoted from TRAIN windows only (kuwait s60+s840,
FP s440+s620); all arbiter verdicts below are on held-out whole windows —
frame-level holdout leaks (adjacent dwell frames are near-identical scenes).

**Phase-0 coverage:** kuwait — dense theta<=84 on ALL azimuths incl. the
disc-blind right corner; theta 85-92 UNREACHABLE (their render never frames
that far out with matchable texture; the disc arc stays the only ~88 deg
anchor). footballplus — reaches theta 87-90 on BOTH sides (its image circle
exceeds the frame, so render framings map deeper): the venue class that had
NO rim source now has one covering the whole rim band. Their render's
non-pinhole floor is ~4.5 mrad and degrades at fov>45 (promote filters to
fov<=45).

**Arbiter validation:** on kuwait the instrument independently reproduces
Karim's eyes-on split with n=30k+ per side — hand better RIGHT (3.47 vs
4.15 mrad), accepted-auto better LEFT (4.09 vs 4.39). The measured
disagreement is genuinely lens-field (per-frame H absorbs all rotation; the
mount cannot explain it).

**Kuwait REG_W ablation (train s60+s840; holdout s1000/s1480/s3290):**
monotone dose-response — field improves everywhere with weight, hand-line
near_touch bow degrades: W=0.3 → gates at baseline (marks 0.43 BETTER, bow
2.10) but field barely moves; W=1 → beats accepted-auto on EVERY holdout row
(LEFT 2.68 vs 3.25, RIGHT 2.85 vs 3.28, interior included) and comes within
0.1-0.3 mrad of hand's right side, at bow 2.09→2.30 / marks 0.44→0.49.
DIAGNOSIS of the bow cost: the reg data has almost no BOTTOM-sector coverage
(near-touch framings are all wide-fov, filtered out), so CY moves ~100px on
left/right/top evidence while the bottom extrapolates — the hand-snapped
near_touch line is the only bottom witness. GATE G: W=1 drifts 1.02 deg from
the accepted fit at the rim while holding the disc arc (+0.39). **Staged for
eyes-on: `public/vp-mesh-kuwait-regsift` (the W=1 fit,
benchmarks/kuwait-regsift-candidate-fit.json) vs /vp-mesh-kuwait-auto vs
/vp-mesh-kuwait.** If the near edge reads worse, fall back to W=0.5
(benchmarks/kuwait-regsift-w05-fit.json, gates ~baseline). No candidate
strictly beats hand's right rim instrumentally (4.69 vs 4.38 mrad at W=1) —
if eyes-on agrees, the residual right-side gap is likely a RADIAL-MODEL
capacity limit (the two sides want different fields; hand's 143px CX offset
splits the difference differently) → a tangential/decentering term is the
next capacity CANDIDATE — but note the same-day finding that tangential
terms fit against the 6 marks OVERFIT and must never ship from marks alone
(near-line-curve session): any p1/p2 test must be constrained by the dense
reg correspondences and judged on held-out windows, and the near-touch bow
itself is REAL 3D ground geometry (crowned/settled), not lens error — its
baseline is a physical ceiling, not a target.

**Footballplus (train s440+s620; holdout s950/s2520/s2900):** W=0.3 improves
on the accepted marks-refit everywhere on holdout (ALL 6.90 vs 7.12, rim
85-95 6.20 vs 8.09, LEFT rim 5.01 vs 6.33) with gates at parity (bow 1.59
BETTER, wmed 2.13, marks 0.11 vs 0.09). W=1 collapses the rim further (2.60)
but degrades the interior on BOTH modalities (theta 0-60 8.26 vs 6.27, marks
0.28, wmed 3.17) — overfit to the register modality, REJECTED. **Staged for
eyes-on: `public/vp-mesh-footballplus-regsift` (the W=0.3 fit,
benchmarks/footballplus-regsift-candidate-fit.json) vs
/vp-mesh-footballplus-auto vs /vp-mesh-footballplus.**

**theta_disc cross-check (n stays 1):** a kuwait fit refined with REG only
(RIM_W=0, disc absent from the whole fit path) reads the annotated arc at
90.94 deg (+2.74 vs the 88.2 constant, sd 1.27). Because reg coverage stops
at theta ~84, that is an EXTRAPOLATED reading — not a second measurement of
theta_disc. Directionally consistent (the no-rim-info auto fit read +6.0;
reg pulls the extrapolation ~55% of the way to the disc truth), and the two
sources are complementary: the disc pins exactly where reg is blind. A true
n=2 for theta_disc still needs a second venue with a visible disc.

Gotchas: their render is only locally-projective — the per-frame H absorbs
the projective component of any field error, so the arbiter sees
NON-PROJECTIVE warp (what "lines render straight" needs), and absolute
differences are compressed; never read its mrad numbers as absolute field
error. The FOV_MAX=45 promote cut is load-bearing twice over (render
distortion above it + it silently removes all bottom-sector coverage — a
future bottom source needs the wide-fov frames it excludes). Raw/Play pair
windows fetched with the same -ss land on different keyframes — harmless
for static-background SIFT, fatal if you ever try moving-content
correspondences.

## GROUND / LINE-STRAIGHTENING (2026-07-18, fourth session) — flattener SHIPPED as display cosmetic; 3D ground models MEASURED OUT

Karim's "edges still curved upwards" (both venues, corners/frame edges) is
NOT residual calibration error: all candidate fits render every hand-snapped
line within 0.1-0.2% of each other (per-line GATE A pulled from the
reports); near_touch bows ~2.1-2.3% through EVERY fit including hand.

**The deviation is a WIGGLE, not a crown.** near_touch great-circle profile
through the accepted fit: -3.5 -> +9.8 -> -8.3 -> +3.9 -> +11.9 mrad along
the line (three sign changes); far_touch same ground from 30m: ±3 mrad.
Local turf undulation (±10-15cm at 4-7m viewing) fits the magnitudes; a
bottom-sector lens residual cannot be excluded (the reg-SIFT constraint has
NO bottom coverage — its fov<=45 filter removes every near-touch framing).

**Ground-model attempts, all measured out (ground_model.py, kept as the
record):** quadratic surface fails held-out near_touch (9.86 -> 10.52 mrad);
cubic (asymmetric u²v, v³) improves held-out (-> 8.77) but runs unphysical
(|z| > 2m at corners); quartic overfits (held-out 24.8). Plan-space
objectives blow up at grazing geometry (bought straightness with a -4m far
dome — score in VIEW angle, not plan metres). Empirical per-point height
inversion is ILL-CONDITIONED here because the mast stands ON the near
touchline: below-mast heights are unobservable (vertical rays), line-end
heights are unobservable (rays run along the line) — solved "heights" hit
the 50cm cap exactly where the percept lives. Even fitted direct, smooth
surfaces recover only ~25-35% — consistent with the tangential ablation's
23%.

**What shipped instead: `flatten_lines.py` + generate_mesh.py FLATTEN hook.**
A raw-frame displacement field moving each snapped line's pixels onto their
straight (best great circle) render target, RBF-interpolated with zero
anchors off-line (|D| p50 ~0.2px, p99 11-17px, max ~30px at kuwait's
near_touch). COSMETIC BY CONSTRUCTION — it straightens the paint whatever
the physical mix (turf vs lens); it is NOT calibration, must never feed
metric code, and spotlight/tracklet overlays will land up to the local
displacement off the warped pixels inside line bands (fine for A/B staging;
resolve before any prod swap). Verified: renders straighten visibly
(halfway kink at the near-touch junction gone; near line straight), gate E
through the warped kuwait mesh is a wash (5 of 6 marks improve; midline_s
13.7 -> 17.0px, it sits in the displaced band; 0.49 -> 0.55% of span).

**STAGED for eyes-on:** `public/vp-mesh-kuwait-flat` (accepted/regsift fit +
kuwait-flatten.json) and `public/vp-mesh-footballplus-flat` (accepted refit
+ footballplus-flatten.json, building-column lines excluded). Base-fit
copies for regeneration: {site}-flatbase-fit.json. If accepted, the flatten
field should be regenerated whenever a venue's accepted fit or snapped lines
change (the targets are fit-relative).

Addendum (same night, this session's two negatives that complete the GROUND
diagnosis): (1) tangential p1/p2 constrained by the FP reg data, whole-window
holdout: held-out bottom-right 10.51 mrad vs 10.17 control — NO improvement,
p1 sign-flips between folds; tangential is exhausted alongside radial.
(2) Their-render edge contamination ruled out: the bottom-right elevation
persists (~10.0 mrad) for matches CENTRAL in their frame (floor there 5.31)
— the arbiter's regional structure is not their de-warp's edge error.
Probes: scratchpad ablate_tang_reg.py + the crosstab in the session log.

**Flattener round 2 (same day):** Karim's eyes-on REJECTED the first build
("lines aren't straight") — root cause: the displacement field faithfully
encoded each snapped point's click noise (±2-3px at 50-150px spacing → line
WOBBLE at product zoom; the wide-framing verification renders averaged it
away — verify cosmetic warps at ZOOM), and the 'linear' RBF kernel kinks at
every sample. Fixed: per-line displacement smoothed along arc length
(UnivariateSpline, SNAP_TOL 2.5px), thin_plate kernel, explicit gaussian
decay (sigma 250px to nearest line sample) + magnitude cap (thin_plate
extrapolates unbounded — measured 61px overshoot off-line without the mask).
Both meshes regenerated in place. Gate E note: midline_s reads 29px through
the warped kuwait mesh (vs 13.7 unwarped) — the quantified form of the
"metric paths must use the unwarped mesh" rule. FP judging on /panorama-test
needs `&src=/vp-still-footballplus.mp4` (the page defaults to Nazwa footage).

**Round-2 verification in the REAL renderer:** headless Playwright against
the dev server's /panorama-test (drag to the near zone + wheel to ~950%
zoom, screenshot) — the actual three.js player renders the flat meshes'
lines smooth at product zoom, matching the offline mesh_dewarp stand-in.
Harness pattern: scratchpad player_shot.mjs (chromium via PLAYHUB's
playwright; goto with domcontentloaded — networkidle never fires on a
streaming video page).

**Flattener VERDICT (2026-07-18 eve, Karim eyes-on round 3): REJECTED —
approach retired, do not iterate a third time.** Two independent reasons,
both structural:
1. The displacement field BENDS UNSNAPPED STRAIGHT STRUCTURES: Karim's
   screenshot shows a large S-wave on the kuwait GOAL LINE — which is not in
   kuwait-lines.json — where the field around the snapped box/touchline
   samples bleeds onto it (reproduced offline: the box line bends in the
   flat mesh, straight in regsift). Fixing this requires snapping every
   straight structure in view (goal lines, fence bases, rails) AND a
   3D-consistent field — unbounded escalation. Staged flat meshes removed
   from public/ (regenerable: flatten_lines.py fields are kept + the
   FLATTEN hook stays in generate_mesh.py, both documented as retired).
2. The residual "squiggle" Karim sees at zoom exists in the RAW FOOTAGE:
   the halfway paint is physically ragged/wandering worn turf paint
   (raw-frame crop verified). No warp can straighten paint that is not
   straight; a warp that tries transfers the wiggle to the surrounding
   grass.

**Standing position after 4 sessions on this percept:** vp-mesh-kuwait-
regsift is Karim's accepted best ("the best fit"); the near-edge curvature
that remains is the camera's honest render of non-flat ground + ragged
paint and is NOT addressable in lens calibration (measured out three ways)
nor by display warps (measured out twice). Remaining genuine lever: the
modest lens share via p1/p2 tangential constrained by the dense reg-SIFT
data with window holdout — expected gain is the ~20-25% class, pursue only
if the percept still matters after the regsift fits reach prod.

## PROD-SWAP PLAN (drafted 2026-07-18, awaiting Karim scope sign-off)

Swap targets (both eyes-on accepted): kuwait = the regsift fit
(baselines/kuwait-accepted-fit.json, mesh == staged vp-mesh-kuwait-regsift);
footballplus = the marks refit (baselines/footballplus-accepted-fit.json,
mesh == staged vp-mesh-footballplus-auto). FP FIRST — its deployed model is
the broken-127px one.

Mechanism (from vp-materialize's ensureSceneMesh): per-game meshes are
COPIES of the canonical mesh at panorama-meshes/{source_game_id}/, resolved
via playhub_panorama_scene_meshes (Nazwa 131777a6 -> b923d40f, FP b3595080
-> f9d6898f). The swap switch = overwrite the canonical folder; future
games fan out the new mesh automatically.

Per venue:
1. BACK UP the canonical mesh folder (rollback = re-upload old files).
2. Upload the new venue mesh over panorama-meshes/{source_game_id}/
   (service role; scene.json LAST — the presence gate keys off it).
3. Overwrite the mesh files in every existing game folder on the scene
   (FP: 8 games with panoramas; Nazwa: 24).
4. Reset aim_track_* and tracklets_* columns (status/error/attempts ->
   NULL/NULL/0) on the scene's recordings -> the EXISTING sweeps rebuild
   everything against the new mesh autonomously. Cost: tracklets ~2min/game
   (18 total = noise); aim-tracks 4-7h/match on Batch (FP 8 + Nazwa 12 = 20
   jobs, in-flight cap 2 -> ~3-5 days trickle, tens of dollars). Analytic
   rotation-migration of old artifacts was considered and rejected: it
   preserves the OLD lens's recovery error and the sweeps make re-derivation
   free in engineering time.
5. Re-solve the venue's admin calibration through the new mesh (raw-px marks
   stay valid; one Solve click in the marking UI, or scripted PUT). FP's
   marks through its new mesh should read ~2.7px (vs stored 127.5).
6. Verify: watch-page Explore on one game per venue (Karim), stored
   calibration error updated, spotlight ring rides correctly on the pilot.

Known windows/risks: CDN + next revalidate 86400 -> up to ~1 day of
mixed old-mesh/new-artifact (or vice versa) per game; reads as a ~3 deg
ring/aim offset until caches settle — accepted (same class as the
aim-track republish staleness). Rollback at any point = restore canonical
+ game folders from backup and re-reset the artifact columns.

## TANGENTIAL (p1/p2) CAPACITY TEST (2026-07-18 late) — WINS on every axis, STAGED for eyes-on

The reg-SIFT-constrained tangential test (scratchpad tangential.py; NEVER
from the 6 marks alone): refit CX/CY/k1..k4 + Brown p1/p2 (F frozen)
against lines + marks(W20) + disc(W1.5) + reg train windows (W1), evaluated
on held-out windows. Result: p1=-0.0067 p2=-0.0108, and the fit improves
EVERY measured axis vs the accepted regsift baseline:
- holdout arbiter: ALL 2.96->2.52 mrad; RIGHT rim>78 8.73->3.54 (the
  radial-model left/right asymmetry limit, closed); LEFT rim par.
- line straightness: near_touch 10.73->8.33 (-22%, the predicted class),
  far_touch 1.95->1.36, others par.
- marks ALL improve (max 8.99 vs 11.2 mrad), disc arc 88.07 vs 88.2
  (accepted read 88.59), r(theta) monotonic to 100 deg.
Candidate frozen at benchmarks/kuwait-tangential-candidate-fit.json (P1/P2
keys; marks mount re-solved through the tangential model: TILT 40.646 YAW
0.961 ROLL -3.364). generate_mesh.py now applies P1/P2 when present (baked
into UVs — the player needs no change). STAGED: public/vp-mesh-kuwait-
tangential, A/B vs /vp-mesh-kuwait-regsift. ADOPTION COST if accepted:
fisheye_model/gates/auto_fit/marks_solver do not yet understand P1/P2 —
GATE A/G and future refits need the tangential unprojection plumbed
(tangential.py has the reference implementation); mesh-mediated paths
(GATE E, the product) work today.

**Tangential ADOPTED as kuwait accepted baseline (2026-07-18 late).** Karim's
eyes-on: tangential and regsift "both look good" — visual parity + strict
instrumental dominance = the tangential fit is the new accepted baseline and
prod-swap target. Frozen: baselines/kuwait-accepted-fit.json (P1/P2 keys) +
baselines/kuwait.json (its report, gates ALL PASS: marks 0.34% of span —
best ever, wmed 6.0, GATE G vs regsift rim 1.30 deg, disc arc -0.13).
Superseded regsift preserved at baselines/kuwait-regsift{,-report}.json.
Plumbing DONE: fisheye_model kb_params/project/unproject accept the 4-or-6
ks vector (P1/P2 flow to every consumer incl. gates + generate_mesh; radial
paths byte-identical, roundtrip 2.5e-4 px, matches the probe impl at 6e-8).
Remaining: auto_fit's REFINEMENT is still radial-only (a re-run of the
kuwait pipeline produces a radial fit; the tangential refit lives in the
session probe — port it into auto_fit before the next kuwait refit).
GATE A note: per-line n counts only the points visible in the fov-46
virtual framing (near_touch 60-64 of 159) — not an unprojection failure.

## PROD SWAP EXECUTED (2026-07-18, Karim "go")

Both venues live on the accepted fits (swap_meshes.py, promoted here):
- **Football Plus**: fresh mesh from baselines/footballplus-accepted-fit.json
  (regenerated + re-gated: marks 0.11% of span, PASS — NOTE the staged
  public/vp-mesh-footballplus-auto had drifted from the frozen fit and was
  refreshed to match). Canonical f9d6898f + all 8 game folders overwritten,
  verified by content hash.
- **Nazwa/kuwait**: the TANGENTIAL mesh (byte-identical to the staged
  vp-mesh-kuwait-tangential Karim eyes-on'd). Canonical b923d40f + all 24
  game folders, hash-verified. Pre-swap prod had TWO variants (23 games
  post-mount-fix + game 0e4ff5b8 on an older one) — per-variant backups +
  game->variant map in benchmarks/meshes/nazwa-prod-mesh-20260718/ (FP:
  fp-prod-mesh-20260718/). Rollback = re-upload per the map.
- Stale aim-track.json / tracklets.json artifacts DELETED (honest absence
  beats a ~3 deg-wrong overlay); aim_track_*/tracklets_* columns reset on
  all 32 recordings -> the existing sweeps rebuild against the new meshes
  (aim ~20 jobs at 4-7h, cap 2, ~3-5 days; tracklets ~2min/game).
- REMAINING MANUAL: re-solve both venues' admin calibrations in the marking
  UI (raw-px marks stay valid; FP should read ~3px vs the stored 127.5px);
  Karim eyes-on a watch page per venue once artifacts trickle in.

**FP tangential probe (2026-07-18 night, after Karim's "still quite curved"):**
the kuwait recipe run on FP (tangential + reg constraint, window holdout).
Result: p1=-0.0002 p2=+0.0009 — an ORDER smaller than kuwait's — with modest
holdout gains (LEFT rim 4.79->3.75, near_touch 6.72->6.07, rest par) and
marks slightly softer (max 3.48 vs 2.99 mrad). Verdict: FP's lens barely
wants tangential; the remaining visible curvature at FP is dominated by real
ground shape + ragged paint (same conclusion as Nazwa). Candidate staged at
public/vp-mesh-footballplus-tangential (benchmarks/footballplus-tangential-
candidate-fit.json) for eyes-on; expectation set to "barely visible". If
adopted, swap via swap_meshes.py (minutes); if not, FP stays on the accepted
refit and its curvature is accepted as physical.

**FP tangential ADOPTED + swapped (2026-07-18 night).** Karim: "better —
less curved at the near borders" (the remaining curvature on both meshes is
the physical ground/paint, accepted). Frozen as
baselines/footballplus-accepted-fit.json (refit preserved at
baselines/footballplus-refit.json; report refreshed, gates PASS: marks
0.13%, GATE G 1.14 deg vs refit). Second prod swap executed on the same 8
game folders (sha 40291af0aa8e) — it caught and deleted 3 aim-tracks the
sweeps had ALREADY rebuilt against the refit mesh (fast rebuilds are real);
artifact columns reset a second time so everything derives from the
tangential mesh. Optional: one more FP re-solve click (mount moved ~0.5
deg; expected ~4px).

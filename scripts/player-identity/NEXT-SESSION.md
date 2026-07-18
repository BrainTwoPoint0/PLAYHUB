# Next session — Phase 2: turn the Veo corpus into labelled crops

> **2026-07-17 UPDATE — EYES-ON DEMOS + 3 FINDINGS:** read
> `phase2c/probe/DEMOS-AND-HANDOVER.md`. Reader shown working on real footage
> (5 demo pages). Key durable findings: (1) deployment number is ON-PITCH
> **88.0%**, not the 91.5% headline (bench skew); (2) Veo's produced follow-cam
> is `render_type=standard/machine` 1920x1080 in `playhub_veo_match_content_cache`,
> range-fetchable from c.veocdn.com — NOT the panorama; (3) compute belongs on
> the RAW panorama (a panning follow-cam breaks tracking → floating chips),
> follow-cam is DISPLAY-only via re-projection. PARK decision unchanged.

Paste the block below. Everything it needs is already captured and running.

---

## The prompt

> Phase 2 of the Veo jersey corpus. Read `PLAYHUB/scripts/player-identity/NEXT-SESSION.md`
> first, then `veo-automations/VEO-API-REFERENCE.md` §"Player Moments" and the
> 2026-07-15 sections of the workspace `CLAUDE.md`.
>
> Goal: turn captured Veo panoramas + jersey labels into `(crop, jersey#)` training
> pairs for OUR jersey model. **Measure before building — this workstream falsified
> six confident inferences in one day, including four of mine.**
>
> Start with the gate, not the build: **does `solve_h.py` converge on Veo's
> geometry at all?** It was written for Spiideo's single panorama; Veo's is two
> 4K lenses. That is a research question, not a coding task. If it doesn't
> converge, stop and re-plan — do not force it.

---

## State (all live, nothing to set up)

|           |                                                                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Captures  | `playhub_veo_captures`, draining ~78/day, **oldest-first** (deadline queue)                                                         |
| Banked    | ~50 GB and growing; `veo-panoramas/{match_slug}/` in `playhub-recordings-eu-west-2`                                                 |
| Per match | `panorama.ts` (2× 3840×2160 HEVC, ~6-9 GB), `tracking.json` (labels), `match-events.json`, `alignment.veo`, `camera_directions.det` |
| Labels    | **97.4% jersey-labelled**, 2.5 Hz, metric on a **105×68** pitch                                                                     |
| Deadline  | Veo Glaciers the `.ts` at **~150d**. Confirmed: a 2026-02-16 match was already gone.                                                |

`tracking.json` carries its own schema. Columns:
`[trackId, roleTeam, xNorm, yNorm, JERSEY, ?, speedKmh, team]`

- `roleTeam`: 0=left GK, 1=left outfield, 2=right GK, 3=right outfield, **6=ball**
- `JERSEY`: **−1 = not read**
- **`x_m = (xNorm − 0.5) × field_length`, `y_m = (yNorm − 0.5) × field_width`,
  both read from that match's `alignment.veo`.** ⚠️ The **105×68 that this file
  and the schema block used to claim is WRONG** and scores at null level (0.075
  vs 0.860). Dims are per-match: 68×41.0, 68×42.8, 68×37.2, 105×73.4. Fixed in
  the job + backfilled 2026-07-15; see VEO-API-REFERENCE.md §"Player Moments".
- col5 unidentified (didn't need it)

## The plan

**Phase 2a — THE GATE: ✅ PASSED 2026-07-15, but the question below was the WRONG
one. `solve_h.py` is NOT needed and would have been a real mistake.** A
homography maps a plane to a _pinhole_ image; Veo's k1≈0.8 rational distortion
makes pitch→raw-pixel non-projective. `solve_h` only ever worked on Spiideo
because the **mesh did the undistortion first** and it solves in `rayn`, not
pixels. Veo ships that missing piece outright: **`alignment.veo` is a complete
camera model** (K + 14-param OpenCV rational D + lens→camera + camera→world +
per-match field dims). Project through it — no solve, no seed sweep, no rate
gate. Measured: **0.860 rate / 14.8px median** (cfa-u11), **0.845 / 16.9px** on
a **held-out** match (cfa-u10), vs nulls at 0.016–0.117. Proof render + scripts:
see `veo-automations/VEO-API-REFERENCE.md` §"alignment.veo is a COMPLETE camera
model". **Phase 2b is unblocked; use the per-match `field_*`, never a constant.**

<details><summary>The original 2a plan, kept for the record (it was wrong)</summary>
`solve_h.py` (`infrastructure/batch/player-tracklets/`) is production for Spiideo and its parts apply unchanged: `pitch_rect_metric`, `time_paired_sets`, `evaluate`, the per-region/held-out gates, the seed-rotation sweep. But Veo's panorama is **two lenses**, so:
- Solve **per lens**, not on the stacked frame. Extract with `-map 0:v:0` / `0:v:1`.
- YOLO the frame (`scripts/portrait-crop/yolov8x.pt`, tiled — small players die in a 640 letterbox), take foot points, Hungarian ICP against Veo's metric positions at the same instant.
- **Gate on `evaluate()`'s held-out rate + per-region signed bias**, exactly as the tracklets job does. Correct H ≈ 0.4-0.6 held-out rate; wrong H ≈ 0.01.
- `alignment.veo` (`{"calibration_version":"6.2","lens_left2camera":"..."}`) is an **independent cross-check** on our H — not a dependency. If our H and their calibration disagree, that's a finding.

**If it converges → Phase 2b.** If it doesn't, stop. Options then: use their calibration directly (build-time dependency, acceptable — the trained model is still ours), or reconsider.
</details>

### Phase 2b MEASURED (2026-07-16) — the filter is FACING, not crop size

> **Scripts + the three artifacts this section names are preserved in
> `phase2b/` — see `phase2b/RECORD.md`.** They were built in an ephemeral
> scratchpad; the copies in `phase2b/` are what survives. `facing_check.png` is
> the one to open first.

**The question is answered, and the answer is not the one the question assumed.**
Instrument: PARSeq fine-tuned on SoccerNet (never saw Veo footage or Veo labels),
validated BEFORE use (25.8% vs 0.8% null on correctly-framed crops; full-body
crops score AT null, so it needs a text RoI). 4,199 labelled crops, cfa-u11.

| h_px    | n    | ~digit px | AGREE | null | lift |
| ------- | ---- | --------- | ----- | ---- | ---- |
| 100-125 | 932  | 15        | 9.2%  | 4.9% | 1.9x |
| 125-150 | 1081 | 18        | 10.2% | 3.3% | 3.1x |
| 150-175 | 828  | 21        | 14.7% | 4.0% | 3.7x |
| 175-200 | 425  | 25        | 17.2% | 3.5% | 4.9x |
| 250+    | 312  | 39        | 21.5% | 3.8% | 5.6x |

Size helps monotonically — but **agreement never breaks ~50% at ANY size**, and
confidence dominates it: at **conf>=0.9, 50.6% agree vs 1.9% null (27x lift)**.

**That ~50% ceiling is the FACING problem, confirmed by eye** (`facing_check.png`):
every high-confidence AGREE crop is a player facing away with the number plainly
readable; every high-confidence DISAGREE crop is front/side-on with no number,
and PARSeq **hallucinates a digit anyway** (it has no "no text" class — on a
BLACK image it returns '8' at 0.84). Three things follow:

1. **Veo's labels are independently confirmed correct** — an independent reader
   agrees wherever the digit is visible.
2. **The pixels support the digit** whenever it is visible; 12-15px digits still
   beat null ~2x, so resolution is not the binding constraint at these sizes.
3. **The corpus filter is a LEGIBILITY/FACING filter, not a size threshold.**

**✅ PLAYER_H is now fitted PER-MATCH, not a constant** (`extract_crops.py`
`calibrate_player_h`, added 2026-07-16). The real child height ~1.41m is the
invariant; its expression in Veo units is `1.41/k` and k is per-match, so a
hardcoded 2.2 (cfa-u11's value) would reframe every crop on a match with a
different operator error — the SAME failure as the old `PLAYER_H=1.5m`, reversed.
The fit is **k-agnostic**: it back-solves the height that puts the projected head
marker on YOLO's observed box top, in that match's own units, so extraction never
needs k. It refuses (raises) rather than fall back to a constant if <20 players
match. Verified: self-calibrates to 2.25 on cfa-u11 (n=187) and the measurement
reproduces (conf>=0.9: 46.5% vs 2.7% null). **The value is at match #2** — do NOT
reintroduce a module constant.

**⚠️ AND: `alignment.veo` LENGTHS ARE NOT METRES (settled 2026-07-16, 1u≈0.64m).**
Veo solves the camera pose from the **operator-declared** pitch size, so both
inherit the operator's error — on cfa-u11 they declared 68×41 for a real ~43×26
(7v7) pitch, making the world 1.56× too big _self-consistently_. The ground fit is
**structurally blind** to this (foot rate flat 0.615 for s∈[0.60,1.50]); proven by
two known-size goals agreeing within 3% (k=0.646 and 0.627 ⇒ player 1.42/1.38m).
**SAFE for projection/crops** (use `PLAYER_H = 2.2` UNITS, measured). **WRONG for
heights, distances, and probably `speedKmh`.** Schema now says `unitsVerified:
false`; deployed + corpus backfilled. `k` is per-match — re-derive from a
known-size object before ever quoting metres.

### Phase 2c DONE (2026-07-16) — legibility filter null-tested and PASSED

> Full record: `phase2c/RECORD.md` **including the ADDENDUM — read it**. Filter
> = **`legibility >= 0.6 AND solo AND h_px >= 100`, keeping VEO's label** →
> ~85-90% human-graded AGGREGATE purity, 0 label contradictions, 11.5% yield
> (483 pairs/17 jerseys from 120s of one match). ⚠️ BUT the residual ~10%
> front-facing slip-throughs are **class-concentrated poison** (jersey 1:
> 17/20 crops are striped fronts from 2 tracks → class purity ~15%), the
> striped kits score HIGH on legibility (stripes read as text), so **raising
> the threshold does NOT fix it (graded, falsified)**, and per-class PARSeq
> agreement cannot rank classes for audit (real poison and PARSeq two-digit
> misreads both show 0%). Mandatory per-class eyeball audit + mitigation
> candidates in the addendum (per-track caps, velocity-facing signal, domain
> fine-tune of the legibility model).
> Battery: positive control 80.1% kept; synthetic nulls 0%; no size confound
> (within-band lift holds); no kit/team/lens exclusion; drop stream = fronts,
> BIBS, GKs. Key reinterpretation: the phase2b "~50% facing ceiling" was partly
> **PARSeq two-digit misreads** ("18"→'8', "21"→'27') — Veo's labels are even
> more right than measured, and PARSeq agreement is a DEFLATED lower bound on
> purity, never a purity number. The **solo gate** (reject crops where another
> tracked player's box covers >15%, pure geometry) kills the neighbour-number
> failure mode. Legibility weights are a plain state_dict (weights_only=True,
> shippable); PARSeq stays a local instrument.

### TRANSFER PROBE RUN 2026-07-16 — the from-scratch route is FALSIFIED at

### probe scale; the task itself transfers. READ `phase2c/probe/PROBE.md`.

> Trained on the as-is pipeline corpus (1,499 pairs, 2 matches, Karim's
> sequencing: no hand-cleaning, size gate first, blind eval, pre-registered
> bar). **Ours: 0.7% on 142 blind-graded Spiideo crops (= label-null 2.8%).
> PARSeq/SoccerNet ZERO-SHOT on the same crops: 59.9%** (63.2% at 64-100px,
> night). Plumbing verified (96.3% on train crops); held-out-NUMBER retrain
> scored **0.0%** — the model was a PLAYER RE-IDENTIFIER, never a digit
> reader; the 48.6% track-split val leaked player identity. Class-1 poison
> amplified on transfer exactly as predicted (28.9% FP).
> **Consequence: do NOT industrialize corpus→from-scratch-classifier. Route
> forward = STR architecture (RoI + sequence head) fine-tuned on the Veo
> corpus, re-evaluated against the FROZEN gt.json** (PARSeq zero-shot already
> sits in the marginal band with zero corpus; the corpus's job is closing
> 59.9%→75%+). Fine-tune from ORIGINAL Apache-2.0 parseq weights, never ship
> the paper's ckpt (weights_only=False).

**STR FINE-TUNE RUN (2026-07-16, same day) — THE CORPUS EARNS ITS KEEP.**
Arm A (shippable: Apache parseq + public SoccerNet jerseys): **76.1%** on the
frozen gt.json. Arm B (+ 3,875 Veo bands, 5 matches, AS-IS incl. poison):
**91.5%** (92.0% at 64-100px), McNemar p=0.0001, reading guard passed, no
poison regression. Checkpoints + corpus:
`s3://…/provenance/jersey-reader/2026-07-16-probe/`.

**DECISION (Karim, 2026-07-16): PARKED. Build nothing.** The 91.5% reader
sits on the shelf (S3 provenance + frozen eval harness); the corpus-pipeline
job class is deliberately not built (dose-response unmeasured, live numbered
surface = 4 recordings). **Un-park trigger: organized-football deployment
becomes near-term — and the first move THEN is the dose-response measurement
(275 matches vs 5), not the pipeline.** Don't hand-ship to HCT's 4 recordings
unless asked. Rec football stays a tracklet/appearance problem — the reader
is not a general identity solution. Full rationale: `phase2c/probe/PROBE.md`
§DECISION. Original filter rules stand: filter on facing/legibility + keep
**Veo's** label. Do NOT filter on "PARSeq agrees with Veo": that distils
PARSeq, biases the corpus to what it can already read, and caps our model at
its ceiling. Agreement is the right _validation_, the wrong _filter_. **Hold
this line even when the agreement filter looks tempting because it is
cleaner.**

**⚠️ GUARD before trusting the legibility classifier** (raised by the other
session, and it is the right catch): once the corpus is deliberately back-facing
only, **the classifier — not the reader — decides what our model ever sees.** A
bias in it propagates into the corpus _invisibly_, because nothing downstream can
observe the crops it silently dropped. Give it the SAME null treatment PARSeq got
before trusting it:

- a positive control (does it pass crops a human can obviously read?),
- a null (does it accept a random front-facing crop as often?),
- and check what it drops, by eye, stratified — the failure mode is a
  systematically excluded slice (one kit? one lighting? one distance?), which
  an aggregate accept-rate cannot see.
  Selection effects are the one class of error a downstream metric structurally
  cannot detect: the discarded crops leave no trace in it.
  **→ RUN 2026-07-16: PASSED on cfa-u11 (see phase2c/RECORD.md). Re-run the
  stratified drop audit on each NEW venue/kit before adding it to the corpus —
  one match is a sample, not a domain.**

**The legibility filter is a PERMANENT PRODUCTION COMPONENT, not a corpus tool**
(raised by the other session). It defines the input distribution the model is
trained on, so it MUST run at inference too: train on legible-back-facing crops
and at read time you have to gate on legible-back-facing, or you feed the model
crops it never saw. Design it knowing it ships — same code path, corpus-build and
inference.

**Yield is not a constraint:** 319 double-confirmed back-facing crops came from
**120s of ONE match** => ~10k/match => ~2.9M over CFA's 275.

### Phase 2b earlier state (2026-07-15 late) — superseded above, kept for the trail

**Done and trustworthy:**

- `scratchpad/extract_crops.py` (session scratchpad) builds `(crop, jersey)` pairs
  from geometry alone — no YOLO. Projecting the same metric position at Y=0 and
  Y=−PLAYER_H gives feet AND head, so pixel height is known for every tracked
  player. **Y is DOWN** (measured: head-above-feet 27/27 with Y-down, 0/27 with
  Y-up). 4,425 crops / 42 tracks from 3×40s windows of cfa-u11; **visually
  verified** (contact sheet: players centred, and Veo's labels are correct
  wherever a digit is legible — 10, 9, 25, 12, 6, 21 all checked).
- Reader obtained and RUNNING: **PARSeq fine-tuned on SoccerNet** from
  `mkoshkina/jersey-number-pipeline` (CVPR 2024, 87.4% on SoccerNet tracklets).
  `scratchpad/reader.py` wraps it (needs a PL 2.x shim for `EPOCH_OUTPUT`, and
  `torch.load(weights_only=False)` — **local instrument only, never near prod**).

**⚠️ BLOCKED: the instrument reads at NULL even on the largest crops.**
Agreement 0–8.3% vs null 1.7–8.3% on the 120 biggest (h_px 210–296). By the rule
above, a reader that fails at EVERY size indicts the instrument, not the pixels —
so **no threshold it currently reports would mean anything.** Two known causes,
both fixable, neither yet fixed:

1. **RoI.** PARSeq wants a tight TEXT crop; I fed it a geometric torso band and
   _looked at what the model sees_ — **the band lands on shorts/legs.** The paper
   uses **ViTPose** for exactly this and it is not optional. Either fetch ViTPose
   or calibrate the band properly.
2. **PLAYER_H=1.5 is an inferred constant, and it's wrong.** Back-solving from
   YOLO box heights on 126 matched players implies a **2.20m** player (p25 2.02,
   p75 2.28) — impossible for U11. The largest crops have their heads cut off,
   confirming the body is mis-framed inside the box. **This contradicts my own
   other numbers** (geometry says 101px median for a 1.5m player; YOLO measures
   ~83px ⇒ implies ~1.23m). Both cannot be right — resolve this BEFORE trusting
   any crop framing. Note the 83px-median figure that agreed with the earlier
   session was computed under the WRONG 105×68 scale, so that agreement was
   coincidence.

**Also note:** PARSeq has no "no text" class — on a **black image** it returns
`'8'` at 0.84 confidence. It will always emit a digit, which is exactly why the
null is non-negotiable and why raw "agreement" is meaningless without it.

**Phase 2b — crops. THE QUESTION IS NOT "is the label right".**
That conflates two failure modes with different tests, and the wrong one passes:

1. **Wrong label** (Veo's track swapped) — measured at ~0: _0 conflicting reads
   in 225 tracks_. Probably rare. A test of this **passes and tells you nothing**.
2. **Correct label on unreadable pixels** — the player is 40m out, the digits are
   ~5px, and the label is right only because it was _propagated from when they
   were close_. **This is the likely one, and it is still poison: it teaches the
   model to emit confident answers from noise.**

So the measurement is: **at what crop size does an INDEPENDENT read of the digit
agree with Veo's label?** With the null: **does a random OTHER jersey's crop
score as well at that size?** If it does, the pixels carry no digit information
there and that size is below threshold. That yields the size filter directly —
which is the number Phase 2b actually needs. **Filter on crop size, not on the
label.** Prior measurement: median player 83px (digits ~12px, too small), **p75
151px → ~23px digits, usable**.

- Use the per-match `field_length`/`field_width` from `alignment.veo` for the
  projection. Never the old constant.
- Free GT for validation: chain id ⇒ same player.
- Hold out a **DOMAIN** (venue/match), never samples. See README §4 and
  `fit_correction2.py`'s spatial-leak lesson.

## STANDING RULE — a score at null level means check the clock and the units FIRST

Before concluding "the method doesn't work", check the **time base** and the
**units**. Seven falsified inferences on this workstream, and this exact bug
appeared **twice in one day**, both times presenting as _"the method scores at
null"_ rather than _"the method is broken"_:

- **16s item cadence** (2026-07-15 am) — a hardcoded 10s compressed the tracklet
  timeline ~40%; every correspondence was garbage; the fix was a canary
  (`solve_h.lag_peak_s`), not a better solver.
- **PTS 3600 + keyframe drift** (2026-07-15 pm) — `panorama.ts` starts at 1h and
  `-ss` lands 0.2–2.9s late (**per-match** — GOP structure varies, don't assume a
  constant). Paired against the _requested_ time, the Veo gate scored **0.235**,
  indistinguishable from null. Paired against the **achieved** `pts_time − 3600`:
  **0.860**. Same code, same geometry — a wrong clock nearly killed a working
  method.

- **mpegts muxer PTS shift** (2026-07-15, building the crop corpus) —
  `ffmpeg -copyts -ss T -t D -i SRC -c copy out.ts` writes a segment whose
  absolute PTS are **+1.400s off** (`muxdelay` 0.7 + `muxpreload` 0.5).
  **`-copyts` does NOT protect** — it governs the demux side. Fix:
  `-muxdelay 0 -muxpreload 0 -avoid_negative_ts disabled` (round-trips to
  +0.0003s). **Reading the timestamp is not enough**: ffprobe AND showinfo both
  report the shifted value confidently and agree with each other. Only a
  **pixel-identical** cross-check (`mean abs diff == 0.000`) against a
  known-good frame caught it. Also: `ffprobe -read_intervals '%+#1'`'s "first
  frame" is not the earliest frame the decoder emits, so `first_pts + n/fps` is
  wrong on its own terms — read each frame's pts from `showinfo`.

The tell is a score sitting _suspiciously at_ null rather than _scattered around_
it. Sometimes the tell is visual instead: the crops were 70% grass while the
projection scored 0.86, so the geometry could not have been the fault. A broken method scores randomly; a mis-clocked or mis-scaled one scores at
null with a straight face. **Extract with `-copyts`, read the achieved
`pts_time` from `showinfo`, and never trust `-ss`.**

Corollary, from the 105×68 error: **one match is a sample, not a domain**, and a
**discrete-assignment objective saturates** — "100% of labels matched" succeeds
across a broad band of scales and is _not_ evidence that a continuous parameter
is exact. Always hold out a DOMAIN (match / venue / corner), never samples.

## Hard-won gotchas

- **`ffprobe` the artifact; don't do trigonometry on an assumed projection.** The 2048×2048 "panorama" is two lenses _stacked_ (2048×1024 each), not a 180° equirect — my px/° estimate was 2× wrong.
- **`player-moments` is FILTERED** (~59% of frames, ~6.8s runs). `player-tracking` is the real thing (continuous, 65.6s tracks). Never measure with the former.
- **`periods` come from `step-events`'s `match_ongoing`** — never invent a window. An invented one returns **200** and silently merges both halves, and **teams swap ends at half time**, so `side` flips meaning mid-track.
- **NEVER run a bare `terraform apply`** in this workspace — pre-existing drift would replace the ball-detection GPU CE and delete `aws_iam_role.spot_fleet` (hardcoded ARN ⇒ no dependency edge warns you). Always `-target`.
- **Veo = labeller, never a runtime dependency.** Production must never call `/api/mes/v2/`.
- Data protection: Karim's position is **settled** ("PLAYBACK owns the footage and can do whatever it wants with it"). Don't re-raise it.

## Worth doing while in here (cheap now, impossible at 300 matches)

- **Prefix-driven deletion** (`veo-panoramas/{slug}/`) — the DB provably under-reports what's in S3, so a key-driven purge misses objects.
- **Corpus manifest** — which capture fed which model version.
- **S3 lifecycle**: `GLACIER_IR` at 60d **filtered to objects >100MB** so the labels stay hot. ~2.2 TB Standard ≈ $52/mo → ~$11/mo.
- The 5-sweep-old open item: a CloudWatch alarm on `"submit failed for"` → `sync_alerts`. Cheap, covers all classes, and this workstream is the one where silence costs data.

## QUEUED — field-of-play polygon filter in the tracklets job (Karim's step 5, recon done 2026-07-18)

Sketch (Karim): field_polygon_rayn from the ACTIVE pitch calibration replaces the
percentile rect in filter_on_pitch/filter_chains_on_pitch, keyed per venue with
rect fallback, behind a dry-run flag logging kept/dropped chain diffs on a real
game before enabling. Recon facts for the plan:

- Rect today: solve_h.pitch_rect_metric (p3/p97 of all tracklet xy + 3m pad) →
  diag.pitch_lo/hi (also in tracklets-solve.json); filter_on_pitch
  (build_track.py:459, +2m apron, per-fragment median) pre-stitch;
  filter_chains_on_pitch (:473, exact rect, whole-chain median) post-stitch.
  Both test METRIC xy; jersey-labels/chains_source.py reuses them.
- Calibration: playhub_pitch_calibrations, one active row per scene (partial
  unique idx), marks JSONB = raw-frame px + pitch_length/width_m are the ground
  truth; field_polygon_rayn/homography are ADVISORY (recompute from marks —
  pitch-focus.ts is the consumption pattern). Solver emits fieldPolygonRayn in
  canonical nw,ne,se,sw order (pitch-solver.ts:429-445); z<=0 corners null.
- SPACE BRIDGE is the core decision: polygon is rayn, filters are metric —
  project the chain median through the job's own H (like build_payload
  build_track.py:743) OR build the metric quad from [0,0],[L,0],[L,W],[0,W]
  (needs the calibration H↔job H relationship thought through).
- Fetch: entrypoint._sb GET /rest/v1/playhub_pitch_calibrations?scene_id=eq.X
  &status=eq.active&select=marks,pitch_length_m,pitch_width_m,... (service role
  bypasses RLS); no row → rect fallback.
- Point-in-polygon: cv2.pointPolygonTest (opencv already pinned); no shapely.
- Dry-run precedent: spiideo-health DRY_RUN=1 "would drop N (rect kept M)"
  logging shape; no dry-run exists in the tracklets job yet (env-flag style).
- Plan-mode this before building (workflow rule); do NOT fold into B3.

## QUEUED — Tier-2b opening move: MOT/HOTA eval harness (contract locked 2026-07-18)

Full contract in `PLAYHUB/docs/roster-cardinality-tracker.md` §"Eval harness".
Plan-first in its own session. The three load-bearing constraints (do not
re-derive): dev-on-Veo / sign-off-on-Spiideo+HCT-jersey-GT regime split;
crossing-correlated fragment cuts matched to the measured gap distribution;
a per-T P(ring-on-right-player) curve layered on stock HOTA. Baselines:
shipped stitcher, 2.5s ceiling, no-stitch. Base lib: roboflow/trackers
(TrackEval-aligned evaluator + Optuna tuner, MIT).

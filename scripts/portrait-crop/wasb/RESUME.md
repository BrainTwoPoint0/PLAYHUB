# B-ball / WASB spike — RESUME STATE (2026-07-06)

## North star

PLAYHUB's OWN ball-following auto-follow that works on any fixed camera (replicate Spiideo Play, drop the Spiideo dependency). Controller is SOLVED (B4: lead + critically-damped spring + fov-on-spread, in VirtualPanoramaPlayer.tsx::stepFollow). The ONE limiter is BALL DETECTION on grassroots low-light panoramic footage (task #24). Spiideo follows the ball; we drive off player-centroid → ~6.5° residual.

## DECISIVE SPIKE RESULT (done)

WASB (nttcom/WASB-SBDT, HRNet heatmap, 88.2% broadcast-soccer SOTA) soccer weights **ZERO-SHOT** on our frozen holdout clip (veo_20260506_hb_cupfinal_goal_01, 747 frames, 492 dense ball labels), scored by WASB's own eval:

- **Recall 0.23% (TP=1 / ~500), Precision 1.3%, AP 0.0001, Accuracy 31.7% (all TN), RMSE 580px, dist_threshold=4.**
- Overlay (wasb_zeroshot_overlay.png) CONFIRMS: GT (green) correctly on the pitch → harness/coords VERIFIED CORRECT. WASB predictions (white) shoot into the stands/floodlights/trees — genuine domain failure, not a bug.
- Conclusion: **zero-shot SOTA does NOT transfer.** Domain gap (5-8px ball, dusk/low-light, busy panoramic background) requires FINETUNING. Cost so far ~$0.30 GPU.

## HOW TO RE-RUN THE SPIKE

`cd <scratchpad> && modal run wasb_spike.py` (this file). It: gdown soccer weights (GDrive id 1pg0MpMtKZ6ziYEr4oyfKYPOO3hjLw94l) → ffmpeg extract frames (0-indexed) → generate CVAT XML from our dense labels → run WASB eval on A10G → return accuracy + an 8-frame pred/GT montage. Deps pinned: torch==2.2.2 (weights_only), +matplotlib/scikit-image/filterpy. WASB repo: `git clone --depth 1 https://github.com/nttcom/WASB-SBDT.git` (script mounts it from scratchpad/WASB-SBDT — re-clone on resume).

## FINETUNE v1 RESULT (2026-07-06 session 2): COLLAPSED AT STOCK RES — resolution is the confound

30-epoch finetune on the 7 train clips (~2,170 dense frames), stock 512×288 recipe, A10G, ~$1:

- **TP=0 at EVERY checkpoint** (ep20/25/30 recall 0.0000; RMSE 907-939px). Corrected-GT zero-shot baseline: also TP=0, RMSE 584. Overlay (`wasb_finetune-v1_overlay.png`): preds still climb the floodlight mast.
- **Train loss FLAT at ~2.5e-4 ep18→30 = collapse-to-background.** The recipe failed mechanically, so v1 does NOT answer the data-vs-model question.
- Root cause hypothesis: clips are 1920×1080; at 512×288 input the 5-8px ball is **1.3-2px — below detectable scale**. (WASB's own soccer benchmark is 720p → their ball lands ~4px at input.)
- Weights: Modal volume `wasb-weights:/finetune-v1/`. Behavior DID change vs zero-shot (different FP pattern) → harness + weight-loading verified working.

## FINETUNE v2 @ 1280×720 RESULT (2026-07-06 session 2): collapse broken, recall@4px still ~1% — near-miss question OPEN

A100-40GB, 15ep, batch 2, milestones [8,12] (~2h ~$7). Full 2×2 on the frozen holdout @ dist=4px:

| arm                            | TP  | fires (TP+FP) | note                                         |
| ------------------------------ | --- | ------------- | -------------------------------------------- |
| zero-shot @288p (corrected GT) | 0   | ~79           | RMSE 584                                     |
| zero-shot @720p                | 1   | 731           | fires on ~98% of ALL frames — indiscriminate |
| finetuned @288p (v1, 30ep)     | 0   | ~184          | train-loss collapse                          |
| finetuned @720p ep15           | 4   | 58            | prec 6.5%, recall 0.92%, RMSE 839            |

- Training HEALTHY this time (loss 1.0e-4→6.2e-5, converged post-LR-drop). Mid-train holdout recall plateaued 1-2% (ep3 TP5/fires 354, ep6 TP4/89, ep9 TP6/153, ep12 TP3/140, ep15 TP4/61).
- **What finetuning learned: discrimination, not localization** — suppressed 92% of the zero-shot@720p false fires while keeping fires on ball-visible frames. Montage (`wasb_finetune-v2-720p_overlay.png`): preds now ON THE PITCH near the ball's neighborhood; floodlight streak mostly gone.
- RMSE 839 over 59 dets is consistent with bimodal (≈half near-misses + half ~1200px floodlights) → the 4px-at-1080p gate may be hiding real detections.
- Checkpoints: `wasb-weights:/finetune-v2-720p/checkpoint_ep{1..15}.pth.tar`. All epoch ckpts saved.

## THRESHOLD SWEEP RESULT (2026-07-06): **DATA BOTTLENECK CONFIRMED — VERDICT**

`wasb_thresh_sweep.py`, ep15 + ep3 × dist {8,16,32}: numbers IDENTICAL at 8/16/32 — **zero detections in the 8-32px annulus**. Dets are either ON the ball (≤8px) or on a different object entirely (>32px: players/bright spots). Not a localization-granularity problem.

- ep15: recall@8=recall@32 = 0.92% (TP=4). ep3 (344 fires, diagnostic): recall@8=recall@32 = 3.6% (TP=9, up from 5 @4px).
- Combined with the discrimination gain (731→58 fires) and on-pitch montage: the model has a WEAK ball signal, drastically underfit for dusk-grassroots-panoramic. 2,170 frames from 7 clips (5 matches, mostly one venue class) cannot teach ball-vs-distractor here. **The bottleneck is labeled data, not architecture, not resolution, not the eval gate.**

## MINING PIPELINE BUILT + VALIDATED (2026-07-07 session 3) — `scripts/portrait-crop/mining/`

`mine_candidates.py` (MOG2 + camera-compensated double-difference → tracklets → ball-likeness ranking → precision-first picks) + `diagnose.py`. Emits the standard `_raw.json` schema so EXISTING tooling works unchanged: `RAW_SUFFIX=_mog2raw.json node eval-dataset/oracle.mjs` scores it; `bootstrap-labels.ts --raw <mined>` emits CVAT prefill XML (verified end-to-end: 749-box "CVAT for video 1.1" file imports clean).

- **Validation vs all 8 dense-GT clips: candidate oracle 93-100% (dusk holdout 94%)** — the ball is recoverable everywhere. Prefill picks at CLAIM_MIN=0.30: goalkick 89% / hero 91% / holdout 82% precision (10-16% coverage in contiguous ball-flight runs); sefa "miss" was GT ending at the goal — visual check shows mined picks tracking the real loose ball after t=17.3. Known trade: static-ball freekick emits ~20 junk picks (motion mining is blind to a resting ball) — cheap to delete in CVAT; raising the threshold to 0.35 killed them but ALSO killed the dusk holdout's true picks (score 0.30-0.35), and dusk recall is the point.
- **CV-specialist review survived + co-adaptation lesson (2026-07-07)**: transform math verified correct; kept fail-closed motion estimation, finished-list memory bound, dead-code removal. FOUR "principled" review fixes MEASURED WORSE and were reverted with in-code notes: exclusive candidate assignment (true-ball tracklets 117→11), bounce-tolerant gating (400-frame ball+junk chimeras), camera-relative scoring (ball arc scores halved), half-res LK (warp jitter fragmented arcs), and skipping the "wasted" mid-pan mog2.apply (holdout picks 64→29 — apply advances MOG2's internal frame counter even at lr=0). **The stages are co-adapted; only change this file with the dense-GT validation loop.**
- Hard-won findings baked into the code comments: (1) eval clips are camera-FOLLOW renders → global motion compensation (LK+RANSAC affine, warp into middle frame) is ESSENTIAL, MOG2 only fires when pan<0.5px; (2) blob recipe must match detect_ball.py::motion_candidates (blur 3x3, min-area 8, extent .5, keep-LARGEST cap) — my first looser version flooded and scored 1%; (3) tracklet score: length norm /40 + small-area prior are what put true-ball tracklets at ranks 0-7; (4) chain-growing and DP-stitching claim strategies both measured WORSE than a plain 0.35 threshold (cascade to 45-48% precision) — keep the simple thing; (5) coverage/clip ~10-16% is FINE — picks come in contiguous runs (= 3-frame train stacks) and volume comes from source count.
- **Acquisition source confirmed**: `playhub_recording_events` has 5,267 Veo goal events across 836 recordings (timestamp_seconds + provider_recording_id + provider_event_id). ~400 clips → 20-50k frames.

### NEXT: clip fetcher → batch mine → CVAT — **fetcher BUILT 2026-07-08, BLOCKED on Veo ToS**

1. `PLAYHUB/scripts/portrait-crop/mining/fetch_goal_clips.ts` (BUILT): selects a diverse corpus from the 5,267 goal events — groups by match, EXCLUDES the 14 eval-dataset match slugs (leak audit, hardcoded), thins to ≤3 goals ≥30s apart/match, STRIDE-samples matches across the full match-date range (date is the slug `YYYYMMDD-` prefix; created_at is useless = all 2026-05-15 ingest). Dry-run VERIFIED: 400 clips / 400 distinct matches / 210 match-days / 2022→2026 / 0 leaks. Resolves each goal→Veo highlight `videos[].url` (largest rendition) via `getVeoSession()` (Playwright login proven working locally headless), curls the ~25s follow-render, writes `corpus/corpus-manifest.json`.
   - Run (once ToS cleared): `cd PLAYHUB && npx tsx --tsconfig tsconfig.json scripts/portrait-crop/mining/fetch_goal_clips.ts [--target 400] [--per-match 3]`. `--dry-run` = selection only (no Veo).
   - **⚠️ BLOCKER: every Veo API call 409s `updated_terms_acceptance_required` (confirmed on /api/app/user/ too → whole Veo integration down: veo-sync, academy content, fetcher).** A human must log into the Veo account (VEO_EMAIL) and accept updated ToS. Then the fetcher runs as-is.
   - **FETCHED 2026-07-08: 377 clips (23 had no rendered video), 5.1 GB, in `mining/corpus/` + `corpus-manifest.json`** — 377 matches / 209 match-days / 2022→2026. Veo unblocked after ToS accepted.
2. Batch prefill → CVAT. **⚠️ PREFILL FINDING 2026-07-08 (pilot on 10 fetched clips): MOG2 motion-mining does NOT generalize to the broad DAYTIME corpus.** The 82-91% precision was on the CURATED dusk-heavy 8-clip eval set. On fresh daytime Veo follow-renders the tracklet scoring latches onto PLAYER-CLUSTER motion, not the ball — visually confirmed even on the highest-scoring clip (picks on players/stands while the white ball sits elsewhere). At CLAIM_MIN 0.30 only 4/10 clips get any picks; at 0.20 8/10 do but precision is LOW. Handing these to CVAT would waste human time (correcting wrong boxes is slower than from-scratch). `mine_candidates.py` gained `--claim-min` (0.30 detector default) but that doesn't fix the precision.
   - **Prefill SOLVED with GPU-YOLO (2026-07-08): `mining/yolo_prefill_modal.py` (Modal A10G, `yolov8m_veo_finetuned.pt`).** Lean port of detect_ball.py's detection core (full-frame YOLO + SAHI-640 fallback for small balls, best-conf ball/frame; NOT the Norfair/DP tracking — prefill wants raw appearance picks a human verifies). Downloads clips from their public Veo CDN urls (no upload). Emits standard `_raw.json` (→ `bootstrap-labels.ts` + oracle.mjs unchanged).
     - **MEASURED vs the 8 GT eval clips — YOLO CRUSHES MOG2** (pick precision@60px / coverage): goalkick 98%/69% (MOG2 cov 10%), goal_01 69%/52% (16%), goal_02b 78%/68%, sefa_u19 51%/44%, **dusk holdout 48%/29% (MOG2 6%)** — YOLO even wins on dusk (the case MOG2 was built for → the Veo-finetuned YOLO is just better across the board; the old "YOLO fails on dusk" was raw-panoramic/older-weights, not these follow-renders). Outliers: passage_01 0% (anomaly), cfa_u9 static-ball freekick 35% (hard, ball at rest). ~50-98% precision on daytime = genuinely useful prefill.
     - **DONE 2026-07-08: all 377 prefilled → `corpus/*_yoloraw.json` = 147,249 ball-pick prefill labels** (median 54% coverage/clip; 260 clips ≥40%, only 31 weak).
   - **TEMPORAL REFINEMENT (`mining/refine_prefill.py`, 2026-07-08) — from user feedback verifying a stagnant goalkick:** raw YOLO picks the highest-conf ball PER FRAME independently, so a persistent floodlight/fence FP wins frames the ball can't physically be in. Fix (no GPU, on existing `_yoloraw.json`): (1) fwd-bwd DESPIKE anchored on raw picks (reject constant-velocity-prediction violations, recover the on-ball candidate); (2) windowed DOMINANT-CLUSTER rejection (parked ball = dense majority cluster; fixed background distractor = minority → dropped — user's "majority wins" insight); (3) stagnant-only gap-fill. **Measured vs 8 GT clips: precision 0.60→0.64 (up on 7/8, dusk 0.48→0.59), coverage 48→53%; user's clip 43% fewer wrong boxes.** Defaults locked (STAGNANT_ONLY=1, GAP_FILL=15; env RP_*). All 377 → `corpus/*_refined.json` (147k→165k picks). `prep_cvat_batch.sh` now prefers `_refined.json`. Residual persistent-background FPs need v3/pitch-mask.

## CLIP QUALITY CURATION (`mining/score_clips.py`, 2026-07-08 — 2nd user-feedback fix)

User hit a clip where prefill glued to a sideline BAG OF PRACTICE BALLS ("not worth annotating"). Root cause was MINE: batch-1 was picked by pick-COVERAGE, but a persistent distractor detected every frame HAS high coverage while being wrong — and the dominant-cluster refinement then locks onto whichever ball-like cluster is densest (can be the bag). **Coverage ≠ quality.** `score_clips.py` scores each clip: quality = coverage × (1−AMBIGUITY) × centrality × conf, where AMBIGUITY = strength of a 2nd strong candidate cluster >400px from the 1st (multi-ball / static distractor) and centrality uses the REFINED PICK median (edge-glued = bad). Validated: the bag clip → 0.20 (rank 269/377); good goal clips → 0.5+. 26 clips score <0.05 (skip). **Inherent limit: multi-ball training-ground clips + persistent background objects can't be fixed by post-processing — need v3 or a pitch-mask; curation routes AROUND them.**

## CVAT VERIFY — LIVE (2026-07-08)

CVAT at localhost:8080 (`~/cvat` compose), `automation` pw `/tmp/cvat_pw.txt`. **Batch 1 = 40 clips ranked by QUALITY** (`score_clips.py`, top-70 date-strided to 40, min quality 0.46 vs the bag clip's 0.20), symlinked `mining/corpus-batch1/`, created as tasks with REFINED prefill. Bad clips (bag-of-balls task 83 etc.) excluded. Task 25 (user's goalkick veo_20250122-soccer-elite-fa-u19) partially labeled + PRESERVED. cvat-batch-create.sh gained `CLIPS_DIR`. Scale-up: rank the rest via `score_clips.py --good-list` then create with `CLIPS_DIR=../mining/corpus`. Only label quality≥~0.3 clips; defer the rest for v3 re-prefill.

## READY FOR HUMAN VERIFY (2026-07-08) — the handoff

Everything up to CVAT is staged. The human steps:

1. **Create CVAT tasks** (needs a running CVAT + cvat-cli): `cd eval-dataset && CVAT_AUTH=user:pass CLIPS_DIR=../mining/corpus ./cvat-batch-create.sh` — uploads each corpus mp4 + imports its prefill XML in one shot (the `CLIPS_DIR` override was added for the corpus; XMLs auto-found in cvat-imports/). Start with the high-coverage clips for a fast calibration session.
2. **Verify/correct** per `eval-dataset/LABELING_SOP.md` §4 (ball-center, tight bbox, `O`=outside when absent). Prefill is 50-98% right on daytime clips → this is a verify pass, not from-scratch. Export → `eval-dataset/cvat-exports/`.
3. **Build the v3 dataset**: `cvat-to-labels.ts` → dense label JSONs → extend `tracknet/prep_dataset.py` (or `wasb_finetune.py`'s TRAIN_CLIPS) to the verified corpus.
4. **Finetune v3 — LAUNCHED 2026-07-08 21:49 BST** (Modal detached app `ap-4n5SGFu8GmKKeLTlMqOElF`, id in `/tmp/wasb_v3_app_id.txt`, logs `/tmp/wasb_v3_finetune.log`): `WASB_GPU=A100-40GB modal run --detach wasb_finetune.py --max-epochs 7 --inp-h 720 --inp-w 1280 --batch 2 --sched 4,6 --vi-step 3 --skip-baseline --vol-tag finetune-v3-bigcorpus`. Corpus = **24 train clips / 14,667 labelled frames** (vs v2's ~2,170 = 6.75×), TRAIN_CLIPS extended in wasb_finetune.py; epochs cut 15→10 & timeout 3h→7h because ~7× data/epoch. **Task 86 (`veo_20250201-fa5ca4fc…`) DELIBERATELY held out** of training as the honest witness (Karim: mixed good/bad-by-period) — score v2-vs-v3 on it offline post-train via detect_ball. Gate: oracle ≥60% (apex ≥40%) on frozen holdout `hb_cupfinal`, comparable to v2. **If it moves past the ~1% plateau → the data-scaling thesis holds** → then wire detector into `analyze_trajectory` as trusted action_pan (+ GOAL-HOLD heuristic above) → re-fit B4 → OUR OWN ball-follow (the Spiideo-independence moat). If flat → bottleneck isn't volume; look elsewhere before labelling more.
   - Keep MOG2 (`mine_candidates.py --claim-min`) only for the rare fully-occluded/at-rest-ball clip; YOLO is primary.
   - **GOAL-HOLD heuristic (Karim's insight 2026-07-08, from labeling tasks 84 + 111 — a CONTROLLER feature, NOT a detector fix)**: the detector's single worst failure mode is ball-in-net — it's occluded/still, so the model latches onto floodlights/tree-gaps (matches the "cross-pitch/net" bucket of the failure taxonomy). Don't try to win those frames with detection; route around them. We already have GROUND-TRUTH goal timestamps (5,267 rows in `playhub_recording_events`), so at runtime we don't infer "scored" from the ball (least reliable exactly then). Plan: (a) detect the goal mouth (posts+net) — static, large, high-contrast → far easier than the ball; fixed field region on our raw panorama, per-frame detectable on follow-renders; (b) on a goal event (or ball-confidence collapse INSIDE a goal region) HOLD framing on the net + suppress low-conf detections outside it; (c) resume follow on a high-conf, MOVING ball detection (kickoff/keeper clearance). WSC-Sports "operator holds on the net" behavior. Wire in `analyze_trajectory`/`stepFollow` alongside the v3 detector. Note: this does NOT change labeling discipline — still mark ball only where genuinely visible, leave net-occluded frames as not-visible (teaches the model not to fire on floodlights). Regression witness: CVAT task 86 (mixed good/bad by period) + task 111.
5. Human verify per LABELING_SOP.md (verify ≈10× faster than from-scratch; prefill is 82-91% right where it fires and marks everything else absent).
6. Then finetune v3: extend `wasb_finetune.py` TRAIN_CLIPS/dataset build to the new corpus → `--vol-tag finetune-v3-bigcorpus`.

## PREVIOUS NEXT STEP (superseded by the above): SCALE THE LABEL CORPUS (MOG2 semi-auto), then re-run the v2 recipe

The v2 harness is proven mechanically sound end-to-end (healthy loss, learns discrimination, all patches validated). The play:

1. **MOG2 semi-auto candidate mining**: background-subtraction (cv2.createBackgroundSubtractorMOG2) over many clips → small-fast-round blob candidates → rank by ball-likeness (size 4-10px, speed, trajectory smoothness) → human VERIFY/correct in CVAT (verify is ~10× faster than label-from-scratch). Target **20-50k verified frames across ≥20 matches / multiple venues + lighting conditions** (day/dusk/floodlit).
2. Source material is free: CFA has 262 Veo matches; LYL + SEFA + HB more. Veo's own ball won't transfer (broadcast-crop), use RAW panoramic.
3. Re-run: `WASB_GPU=A100-40GB modal run wasb_finetune.py --max-epochs 15 --inp-h 720 --inp-w 1280 --batch 2 --sched 8,12 --vi-step 3 --skip-baseline --vol-tag finetune-v3-bigcorpus` (train clips list + dataset build generalize; extend TRAIN_CLIPS or point at the new corpus).
4. Gate unchanged: temporal-source oracle ≥60% (apex ≥40%) on the frozen holdout before wiring into analyze_trajectory as trusted action_pan.
   Session-2 spend: ~$9 GPU total (v1 ~$1.5 A10G, v2 ~$7 A100, sweep ~$0.5 A10G).
   Finetune WASB (or the already-scaffolded TrackNetV2) on our **2,662 labeled ball-xy frames** and re-eval on the holdout via the SAME harness. Read the delta:

- recall 0%→meaningful → SCALE the label corpus (MOG2 semi-auto candidates → verify).
- barely moves → the bottleneck is DATA (labeling), not model.

### Finetune harness: `wasb_finetune.py` (this dir) — `modal run wasb_finetune.py`

- Patches WASB at container start: registers the shipped-but-disabled Trainer, fixes its stale `.inference_videos` import, fixes `VideosInferenceRunner.run()` DROPPING the `model=` arg (upstream bug — mid-training evals would silently re-eval the frozen weights), adds `runner.init_weights` (finetune from soccer ckpt), writes `configs/runner/train.yaml`.
- Train = 7 non-holdout labeled clips (~2,170 dense frames), trimmed to each clip's labeled range + renumbered from 0 (WASB's load_xml marks unannotated frames ball-not-visible → false negatives otherwise). Holdout untouched (all 747 frames, same eval condition as spike).
- Stock recipe: 512×288, adadelta lr 1.0 multistep, wbce heatmap loss, hflip+crop aug, 30 epochs, holdout inference every 5 (learning curve). Checkpoints → Modal volume `wasb-weights:/finetune-v1`.
- Runs a corrected-GT ZERO-SHOT baseline first, then final-epoch eval → clean A/B in one job. (best_model.pth.tar is holdout-selected = leaky; final-epoch is the honest number.)

### ⚠️ INDEXING FIX (discovered session 2): label JSONs are 0-INDEXED

CVAT-derived label JSONs (`eval-dataset/labels/*.json`) are **0-indexed** (3 clips start at frame 0; `prep_dataset.py` agrees; cvat-to-labels.ts docstring shows `"frame": 0`). `wasb_spike.py`'s `frame-1` shift was a 1-frame GT offset — harmless for the zero-shot verdict (preds 580px off in the stands) but would have corrupted finetune targets. `wasb_finetune.py` uses offset-0 for holdout, offset-fmin for trimmed train clips.

## KEY EXISTING ASSETS (all under PLAYHUB/scripts/portrait-crop/)

- `tracknet/train_modal.py` (A10G finetune scaffold, Volume `tracknet-weights`), `tracknet/vendor/detect.py` (3-frame heatmap→peak; ~98% WASB-compatible), `tracknet/dataset/match/labels/*.csv` (2,662 frames, TrackNet format frame,visible,x,y), `tracknet/detect_tracknet.py` (emits our _raw.json schema).
- `eval-dataset/` — `oracle.mjs` (our canonical scorer), `labels/*.json` (dense GT, 8 clips), `manifest.json` (frozen holdout + leak audits), `clips/*.mp4`.
- `detect_ball.py` — current prod YOLOv8-Forzasys baseline (`yolov8m_forzasys_soccer.pt`); emits the _raw.json schema {positions,all_candidates,scene_changes,frame_clusters}.
- Follow controller: `scripts/follow-re/analyze_trajectory.py` (currently DISTRUSTS ball, uses player-centroid — drop a good detector in here as trusted action_pan), `fit_follow.py` (re-fit B4 after).
- Panorama mapping: `follow-re/camera_model.py::raw_to_angle`, `dewarp_pano.py`, `VirtualPanoramaPlayer.tsx` lookup grid.
- Modal: authed (~/.modal.toml), volumes `tracknet-weights` + `goal-detection-frames`, secret `playhub-modal-shared-secret`, prod endpoint pattern in `modal_app.py` (A10G).

## REVERSE-ENGINEERING TOOLBOX (Spiideo Perform/Play + Veo) — where everything lives

The RE that got us here (recover trajectory, de-warp, calibrate, replicate) — a fresh session must know these:

### Code

- **`veo-automations/`** (WORKSPACE ROOT, not under PLAYHUB): autofollow-verify.mjs capture-pm-full.mjs capture-team-logo-upload.mjs capture-team-management.mjs cfa-aggregate-u11.mjs cfa-season-rollover-2026.mjs click-player-moments.mjs deep-explore-api.mjs explore-api.mjs explore-player-moments.mjs explore-spotlight.mjs explore-teams-and-privacy.mjs explore-video-and-embed.mjs kuwait-find-recording.mjs kuwait-vp-replicability.mjs nazwa-mesh-roles.mjs nazwa-projection-check.mjs pano-align.mjs pano-circle.mjs pano-shot.mjs pano-solve.mjs play-nazwa-capture.mjs probe-delete-and-privacy.mjs probe-involved-players.mjs spiideo-actions-recon.mjs spiideo-autodata-probe.mjs spiideo-cloudcontrol-recon.mjs spiideo-health-fetch.mjs spiideo-liveview-recon.mjs spiideo-liveview-start.mjs spiideo-perform-explore.mjs spiideo-perform-gl-recon.mjs spiideo-perform-net-recon.mjs spiideo-perform-recon.mjs spiideo-probe-switch.mjs spiideo-viewcontrols-probe.mjs test-invite.mjs test-remove-and-privacy.mjs veo-screenshot.mjs vp-coverage-test.mjs
  - Key: `spiideo-cloudcontrol-recon.mjs` + `spiideo-health-fetch.mjs` (internal api.spiideo.com JWT recon), `kuwait-vp-replicability.mjs` (materialize raw VP), `pano-align.mjs`/`pano-solve.mjs`/`pano-shot.mjs` (panorama registration/render).
- **`PLAYHUB/scripts/follow-re/`**: **pycache**
  - B1 register_trajectory (recover Spiideo (pan,tilt,fov) via gradient-NCC render-match), B2 analyze_trajectory (characterize the auto-director; where the ball/action signal feeds — currently distrusts ball → player-centroid), B4 fit_follow (fit our lead+spring controller), camera_model.py (gnomonic render + raw_to_angle inverse projection + NCC), dewarp_pano.py (equi-angular panorama remap), validate_* (AKAZE/RANSAC lock checks).
- **`PLAYHUB/scripts/vp-calibration/`**: annotate_disc.py, calibrate.py, dewarp_fisheye.py, generate_mesh.py, ingest_scene_mesh.py (fisheye disc/intrinsics fit → K/D + mount rotation → multi-projection de-warp mesh → publish to panorama-meshes/{gameId}/).
- **Runtime de-warp**: `PLAYHUB/src/components/video/VirtualPanoramaPlayer.tsx` (WebGL mesh render + lookup(u,v)→(pan,tilt) grid + stepFollow motion driver). Prod capture: `src/app/api/recordings/[id]/panorama-source/route.ts` + `infrastructure/batch/vp-materialize/`.

### Docs (READ THESE for the RE findings)

- Auto-memory: `~/.claude/projects/-Users-karimfawaz-Dev-Projects-PLAYBACK-Workspace/memory/` → `spiideo-perform-raw-recordings.md` (full Perform/Play RE: 3 API surfaces, raw-VP download, calibration mesh S3, Signality autodata), `spiideo-cloudcontrol-health-api.md` (internal api.spiideo.com JWT), `cfa-veo-season-rollover.md` + `lyl-veo-sync.md` (Veo API auth recipe).
- Vault: `~/Obsidian/second-brain/projects/playback/spiideo-perform-replica.md` (the 4-layer vision + RE decomposition) + `veo-api-reverse-engineering.md`.
- Key RE fact: Spiideo exposes NO camera-path data (view-controls/tagged-intervals empty) → we RECOVER trajectory from the (raw VP, Play production) pair via render-match registration. Signality autodata (premium ball/player tracking) is ABSENT on our grassroots recordings — which is WHY we need our own ball detector.

## DECISION 2026-07-09: RETIRE WASB → YOLO+SAHI+tracking is the ball signal

Reviewed all results with 3 specialists (computer-vision, ml-ops, prior-art) + web research. Verdict:

- **Same-metric A/B (decisive), frozen holdout hb_cupfinal, oracle.mjs, swept tolerance:** YOLO candidate-recall 30%(@4px)/35/37/38/38%(@60px) vs WASB-v3-best committed-recall 1.78%(@4px)→~3.6%(@32px). **~17× at the SAME 4px metric.** Kills the metric-mismatch doubt. (Caveat: YOLO number is candidate-recall = upper bound; needs a tracker to realize. YOLO is well-localised — flat 4→60px — so misses are true misses; ceiling on THIS clip ~38%.)
- **v3 verdict:** more data gave only 6→8 TP on one clip = inside Poisson noise (ml-ops); the "2× recall" was over-read. ep7 collapse = imbalanced-heatmap-loss over-suppression + no best-checkpoint selection (report best epoch, never last). WASB ~2% ceiling is architectural (CV): single-peak heatmap can't localise a 5px ball among identical distractors — proven by flat recall 4→32px (wrong-object, not near-miss).
- **Research:** every published method (WASB/DeepBall/FootAndBall/TrackNet) is broadcast-trained and fails on grassroots; our YOLO+SAHI already beats them. Leaders (Veo/Spiideo/Pixellot) detect ball+players jointly, prioritise TRACKING + temporal consistency over per-frame precision. No public grassroots ball benchmark → our 14.7k corpus is the asset.
- **Build plan (adopt-heavy):** finetune YOLO on 14.7k corpus (P2 stride-4 head, imgsz 1536, mosaic OFF, hard-negative distractor crops, add from-scratch hard frames to guard prefill label-bias; consider YOLOv11 +4.3% small-obj). Adopt **OC-SORT** (non-linear motion tracker; both CV+research picked it) + **ASAHI** (20-25% faster slicing) + track-guided ROI-scoped SAHI. Keep the MOG2 motion channel (93-100% candidate oracle) as proposals + const-velocity despike. Later: dual ball+player detection (+3-7%), GOAL-HOLD for ball-in-net.
- **⚠️ CRITICAL GAP:** the follow-re fit/analysis pipeline (register_trajectory/analyze_trajectory/fit_follow) is GONE from the machine — only stale camera_model/dewarp_pano .pyc survive; no saved GT trajectories. The deployed `stepFollow` (VirtualPanoramaPlayer.tsx) is intact, but the harness that MEASURES follow quality (degrees-of-residual gate) must be RECONSTRUCTED before we can validate any detector against the 6.5° player-centroid baseline or wire it into the live follow. This is now on the critical path.
- **Both specialists' hard requirement before more spend:** a proper eval — multi-clip test set (≥5-10 clips, ≥3-5k positive frames), separate val split for checkpoint selection, confidence intervals, best-checkpoint (not last-epoch) reporting.

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
| arm | TP | fires (TP+FP) | note |
|---|---|---|---|
| zero-shot @288p (corrected GT) | 0 | ~79 | RMSE 584 |
| zero-shot @720p | 1 | 731 | fires on ~98% of ALL frames — indiscriminate |
| finetuned @288p (v1, 30ep) | 0 | ~184 | train-loss collapse |
| finetuned @720p ep15 | 4 | 58 | prec 6.5%, recall 0.92%, RMSE 839 |
- Training HEALTHY this time (loss 1.0e-4→6.2e-5, converged post-LR-drop). Mid-train holdout recall plateaued 1-2% (ep3 TP5/fires 354, ep6 TP4/89, ep9 TP6/153, ep12 TP3/140, ep15 TP4/61).
- **What finetuning learned: discrimination, not localization** — suppressed 92% of the zero-shot@720p false fires while keeping fires on ball-visible frames. Montage (`wasb_finetune-v2-720p_overlay.png`): preds now ON THE PITCH near the ball's neighborhood; floodlight streak mostly gone.
- RMSE 839 over 59 dets is consistent with bimodal (≈half near-misses + half ~1200px floodlights) → the 4px-at-1080p gate may be hiding real detections.
- Checkpoints: `wasb-weights:/finetune-v2-720p/checkpoint_ep{1..15}.pth.tar`. All epoch ckpts saved.

## THRESHOLD SWEEP RESULT (2026-07-06): **DATA BOTTLENECK CONFIRMED — VERDICT**
`wasb_thresh_sweep.py`, ep15 + ep3 × dist {8,16,32}: numbers IDENTICAL at 8/16/32 — **zero detections in the 8-32px annulus**. Dets are either ON the ball (≤8px) or on a different object entirely (>32px: players/bright spots). Not a localization-granularity problem.
- ep15: recall@8=recall@32 = 0.92% (TP=4). ep3 (344 fires, diagnostic): recall@8=recall@32 = 3.6% (TP=9, up from 5 @4px).
- Combined with the discrimination gain (731→58 fires) and on-pitch montage: the model has a WEAK ball signal, drastically underfit for dusk-grassroots-panoramic. 2,170 frames from 7 clips (5 matches, mostly one venue class) cannot teach ball-vs-distractor here. **The bottleneck is labeled data, not architecture, not resolution, not the eval gate.**

## NEXT STEP: SCALE THE LABEL CORPUS (MOG2 semi-auto), then re-run the v2 recipe
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
- **`PLAYHUB/scripts/follow-re/`**: __pycache__ 
  - B1 register_trajectory (recover Spiideo (pan,tilt,fov) via gradient-NCC render-match), B2 analyze_trajectory (characterize the auto-director; where the ball/action signal feeds — currently distrusts ball → player-centroid), B4 fit_follow (fit our lead+spring controller), camera_model.py (gnomonic render + raw_to_angle inverse projection + NCC), dewarp_pano.py (equi-angular panorama remap), validate_* (AKAZE/RANSAC lock checks).
- **`PLAYHUB/scripts/vp-calibration/`**: annotate_disc.py, calibrate.py, dewarp_fisheye.py, generate_mesh.py, ingest_scene_mesh.py (fisheye disc/intrinsics fit → K/D + mount rotation → multi-projection de-warp mesh → publish to panorama-meshes/{gameId}/).
- **Runtime de-warp**: `PLAYHUB/src/components/video/VirtualPanoramaPlayer.tsx` (WebGL mesh render + lookup(u,v)→(pan,tilt) grid + stepFollow motion driver). Prod capture: `src/app/api/recordings/[id]/panorama-source/route.ts` + `infrastructure/batch/vp-materialize/`.

### Docs (READ THESE for the RE findings)
- Auto-memory: `~/.claude/projects/-Users-karimfawaz-Dev-Projects-PLAYBACK-Workspace/memory/` → `spiideo-perform-raw-recordings.md` (full Perform/Play RE: 3 API surfaces, raw-VP download, calibration mesh S3, Signality autodata), `spiideo-cloudcontrol-health-api.md` (internal api.spiideo.com JWT), `cfa-veo-season-rollover.md` + `lyl-veo-sync.md` (Veo API auth recipe).
- Vault: `~/Obsidian/second-brain/projects/playback/spiideo-perform-replica.md` (the 4-layer vision + RE decomposition) + `veo-api-reverse-engineering.md`.
- Key RE fact: Spiideo exposes NO camera-path data (view-controls/tagged-intervals empty) → we RECOVER trajectory from the (raw VP, Play production) pair via render-match registration. Signality autodata (premium ball/player tracking) is ABSENT on our grassroots recordings — which is WHY we need our own ball detector.

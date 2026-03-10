# Portrait Crop Pipeline — Research & Findings

## Executive Summary

**The Core Problem**: Our detection model only finds the ball in 11-28% of frames on 3 of 10 clips. No amount of post-processing can fix bad detection. The industry solves this differently than we do.

**Key Findings**:

1. **Detection: Right model family, wrong resolution and no fine-tuning** — YOLO + SAHI is the industry standard (Forzasys SmartCrop uses the same approach). But we need higher input resolution (1280x1280 vs 640x640) and fine-tuning on our actual Veo footage. The Forzasys model was trained on Norwegian broadcast footage — fundamentally different from Veo's moving virtual camera output. WASB outperforms all YOLO variants on ball detection benchmarks across 5 sports.

2. **Framing: Ball-following alone is amateur — production systems are predictive** — Pixellot predicts ball position 4 seconds ahead with a 5-second buffer. WSC Sports MagiCrop uses weighted ROI (ball + players + goal area). Forzasys SmartCrop: ball detection → IQR outlier removal → interpolation → crop center → fallback. PIX4TEAM "follows the action, not any specific player or the ball."

3. **Smoothing: EMA is for real-time; we should use look-ahead since we process offline** — Google AutoFlip buffers entire scenes and fits piecewise polynomial camera paths. L1-regularized optimization produces the professional "hold, then smooth pan, then hold" look. Savitzky-Golay preserves sharp transitions while eliminating jitter. "Hold zones": if target hasn't moved >X pixels, don't move the camera at all.

4. **Tracking: Norfair/Kalman is fine, but for offline we can do better** — Bidirectional interpolation + smoothing beats any real-time tracker for offline processing. DeepOCSORT is best for erratic ball motion (31px error vs ByteTrack's 114px). TrackNet achieves 97.5% accuracy on small balls but needs retraining on football data.

5. **Open-source tools worth adopting** — WASB-SBDT (strongest published ball detection baseline), Roboflow supervision library (production-quality InferenceSlicer + tracking), TrackNetV4 (best architecture for tiny ball detection), R523/football (virtual camera simulation for panoramic → portrait).

**Recommended Action Plan (Priority Order)**:

- **Highest Impact (Detection Quality)**: (1) Fine-tune YOLOv8 on our Veo footage — annotate 500 frames, fine-tune from Forzasys weights. (2) Increase SAHI slice size to 640x640. (3) Try WASB-SBDT as alternative detector.
- **Medium Impact (Smoothing/Framing)**: (4) Switch from EMA to Savitzky-Golay for offline clips. (5) Add hold zones. (6) Bidirectional interpolation.
- **Lower Priority (Architecture)**: (7) TrackNet retraining on football data. (8) Game state detection.

---

## Context

We're building a portrait crop pipeline that converts Veo landscape goal clips (1920x1080, 30fps) into 608px-wide portrait crops for mobile viewing. The pipeline detects the ball position per frame, converts to crop X coordinates, simplifies into keyframes, and outputs JSON for an editor review step.

### Key Constraints

- **Source footage**: Veo 4K panoramic recordings, stitched from two cameras, with AI-generated "Follow-cam" that already pans/zooms in landscape mode
- **Moving camera**: Unlike fixed panoramic cameras (Spiideo, Pixellot), Veo's landscape output has a virtual camera that moves to follow the action. This means the ball can appear anywhere in the 1920px frame — not just at predictable positions
- **Offline processing**: All clips are processed after recording, not live. We can use look-ahead and buffered smoothing
- **Goal clips only**: ~25 second clips centered around goals, not full 90-minute matches
- **Detection model**: Forzasys YOLOv8m (trained on Norwegian Eliteserien broadcast footage) + Norfair Kalman tracker + SAHI fallback

### Current Performance

- **Baseline score**: 0.529 (Jaccard-like metric against 10 human-corrected clips)
- **Average position error**: 67px
- **Ball detection rate**: Varies wildly — 95%+ on easy clips, 11-28% on hard clips
- **3 of 10 clips have catastrophically low detection** (<28% ball found)

---

## A/B Test Results (March 2026)

All tested against 10 human-corrected clips from `/Desktop/review3/`.

| Configuration                                         | Score              | Avg Error | Notes                                         |
| ----------------------------------------------------- | ------------------ | --------- | --------------------------------------------- |
| **Baseline + bidir interp (10fps, conditional SAHI)** | **0.500**          | **58px**  | Current best                                  |
| Baseline (10fps, conditional SAHI)                    | 0.494              | 70px      | Previous best                                 |
| SAHI every missed frame (10fps)                       | 0.478              | 89px      | SAHI false positives hurt more than they help |
| 15fps only (conditional SAHI)                         | 0.425              | 101px     | More detections overwhelm simplify pipeline   |
| 15fps + SAHI every frame                              | 0.391              | 107px     | Worst — both changes compound negatively      |
| YOLO imgsz=1280                                       | Worse on all clips | -         | Model not trained for higher res Veo footage  |

**Bidirectional interpolation** (fills gaps using both past + future ball detections): marginal +0.006 overall score but -12px position error. Raises floor on worst clips (015432: 0.143→0.222, 012958: 0.545→0.700) but regresses some good clips (004501: 0.833→0.714). Trade-off favors keeping it — production services care more about worst-case quality.

**Conclusion**: Post-processing improvements are marginal. The bottleneck is detection quality — the Forzasys model was trained on broadcast footage, not Veo's moving virtual camera. Fine-tuning on Veo footage is the highest-ROI path.

### Per-Clip Scores (Current: Baseline + Bidir Interp)

| Clip        | Score | Ball Detection        | Notes                                 |
| ----------- | ----- | --------------------- | ------------------------------------- |
| 004501-goal | 0.714 | 39% ball, 34% tracked | Good                                  |
| 012958-goal | 0.700 | 65% ball, 30% tracked | Good — improved with bidir interp     |
| 010300-goal | 0.636 | 56% ball, 29% tracked | Decent                                |
| 005036-goal | 0.625 | 75% ball, 7% tracked  | High detection but position issues    |
| 003948-goal | 0.556 | 49% ball, 12% tracked | OK                                    |
| 005743-goal | 0.556 | 11% ball, 5% tracked  | Poor detection, OK result             |
| 003615-goal | 0.500 | 13% ball, 4% tracked  | Poor detection                        |
| 013015-goal | 0.417 | 50% ball, 20% tracked | Mediocre                              |
| 015432-goal | 0.222 | 29% ball, 13% tracked | Poor — improved from 0.143 with bidir |
| 002331-goal | 0.111 | 23% ball, 5% tracked  | Very poor detection                   |

**Worst clips for focused testing**: 002331-goal (0.111), 015432-goal (0.222), 013015-goal (0.417)

---

## Industry Research (March 2026)

### 1. Production Systems — What Companies Use

#### WSC Sports (MagiCrop)

- Processes 8M+ clips/year (52% YoY growth as of H1 2025)
- Patent WO2019141813A1: ML predicts Region of Interest (ROI) per frame, crops based on predicted ROI
- Uses **weighted multi-signal**: ball, players, goal area each get importance weights — NOT just ball-following
- Primarily reframes broadcast footage (already composed by human camera operator) — easier than our raw panoramic problem
- Acquired Infront Lab (April 2025) for live streaming capabilities
- Tech stack is proprietary — no public architecture details

#### Pixellot (Closest to Our Use Case)

- Fixed panoramic cameras → AI auto-production
- Trained on **5 million+ games**
- **Multi-signal fusion**: ball detection + player detection/classification + game state
- **Predictive**: predicts ball position **4 seconds ahead** (not reactive ball-following)
- **5-second buffer** to resolve ambiguity (e.g., second ball-like object appears)
- Must run in **<10ms per frame** for real-time. 98% accuracy rate
- Decides between "zoom in and track ball" vs "panoramic view" — has zoom-level intelligence
- Uses YOLO-family and SSD detectors (most transparent about their stack)

#### Veo (Our Source Footage)

- Two 4K cameras → 180-degree panoramic, stitched together
- "Follow-cam" view is AI-generated post-recording using deep neural networks
- The Follow-cam output is what we receive — it already has virtual camera movement
- Processing happens in the cloud, not on-device

#### Spiideo

- Panoramic cameras (180-degree FOV, 30fps) with cloud-based processing
- Sport-specific AutoFollow models (different model per sport)
- Camera systems range from fixed installations to portable SmartCam units

#### Forzasys SmartCrop (Most Comparable to Our Pipeline)

- In production with Swedish and Norwegian soccer clubs
- Uses **YOLOv8** for ball detection (same family as our model)
- Pipeline: ball detection → **IQR outlier removal** → interpolation (linear, polynomial, ease-in-out) → crop center → fallback to frame center
- This is essentially what we're building

#### PIX4TEAM

- "Follows the action, not any specific player or the ball"
- Uses player positions + ball + action recognition combined
- For basketball/handball: follows mass of players rather than ball

**Key takeaway**: No company publishes exact architectures. All use CNN-based detection (YOLO-family or custom) + proprietary post-processing. The real competitive advantage is in training data, post-processing pipelines, and camera-specific optimizations.

---

### 2. Detection Models — Best Options for Ball Detection

#### Current Best Models (2025-2026)

| Model                    | Strengths                                                                         | Weaknesses                         | Recommendation                                 |
| ------------------------ | --------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------- |
| **YOLO26** (Jan 2026)    | NMS-free, ProgLoss + STAL for small objects, 31% faster CPU than YOLO11           | Newest, less community fine-tuning | Best for new projects                          |
| **YOLO11**               | Mature, well-supported, good small object detection                               | Superseded by YOLO26               | Safe proven choice                             |
| **YOLOv8** (what we use) | Most battle-tested for football, lots of fine-tuned weights                       | Older architecture                 | Best if you want pre-existing football weights |
| **RF-DETR** (Roboflow)   | SOTA on COCO, excellent small objects, DINOv2 backbone generalizes with less data | Transformer = heavier compute      | Best accuracy/data-efficiency tradeoff         |
| **RT-DETRv2/v4**         | Multi-scale sampling, NMS-free                                                    | Less community adoption for sports | Worth benchmarking                             |

#### Football-Specific Models

- **Football-YOLO** (Dec 2025): Modified YOLOv11 with GhostNetV2 backbone, dynamic clustering C3k2, SegNeXt noise suppression. Purpose-built for ball detection in cluttered scenes
- **Forzasys SportsVision-YOLO**: What we currently use. YOLOv8m trained on Norwegian Eliteserien broadcast footage. Not trained on Veo panoramic footage — likely a key weakness

#### Purpose-Built Ball Detection

- **WASB (Widely Applicable Strong Baseline)** — BMVC 2023, [GitHub](https://github.com/nttcom/WASB-SBDT): Outperforms ALL other methods across 5 sports datasets. Uses high-res feature extraction + position-aware training + temporal consistency. Strongest published baseline for sports ball detection
- **TrackNet v4** (ICASSP 2025): Takes 3 consecutive frames → outputs heatmap. 97.5% accuracy on small balls. Designed for tennis/badminton but architecture is sound for football. Needs retraining on our footage. [GitHub](https://github.com/yastrebksv/TrackNet)

#### Critical Insight: Input Resolution

Running YOLO at **1280x1280** instead of 640x640 dramatically improves small ball detection. We should test this with our existing model before investing in fine-tuning.

---

### 3. SAHI and Alternatives

| Method                                     | How It Works                                                  | Best For            |
| ------------------------------------------ | ------------------------------------------------------------- | ------------------- |
| **SAHI** (what we use)                     | Fixed slice grid (320x320), runs detector on each slice       | General use, proven |
| **ASAHI** (Adaptive SAHI)                  | Adaptive slice sizes, reduces redundant computation           | Faster inference    |
| **GOIS** (Guided Object Inference Slicing) | Two-stage: first pass finds ROIs, second pass focuses on them | Best accuracy       |
| **MSFE** (Multi-Stage Feature Enhancer)    | Cascaded detectors with upscaling on ROIs                     | Complex scenes      |

**For Veo footage**: SAHI at 640x640 slices (up from our current 320x320) gives the model more context per slice. GOIS is theoretically better but adds complexity.

**Alternative to SAHI entirely**: TrackNet/WASB architectures handle small objects natively without needing sliced inference.

---

### 4. Tracking: Kalman vs Alternatives

| Tracker                   | Avg Error     | Speed            | Best For                                                   |
| ------------------------- | ------------- | ---------------- | ---------------------------------------------------------- |
| **DeepOCSORT**            | 31px (best)   | 26.8ms           | Erratic ball motion                                        |
| **OC-SORT**               | Mid-range     | Mid              | Camera movement                                            |
| **BoT-SORT**              | Mid-range     | Mid              | Moving cameras (has Camera Motion Compensation)            |
| **ByteTrack**             | 114px (worst) | 26.6ms (fastest) | NOT for ball tracking — constant-velocity assumption fails |
| **Norfair** (what we use) | Configurable  | Fast             | Single-object tracking, customizable                       |

**Key insight for our use case**: Since we process **offline** (not live), we can use **bidirectional interpolation + smoothing** which beats any real-time tracker. We can look forward and backward in time to fill detection gaps.

**ByteTrack is the worst choice for ball tracking** — its constant-velocity Kalman assumption fails for erratic ball motion (kicks, bounces, deflections).

**Our Norfair setup is reasonable** for single-ball tracking, but for offline processing, interpolation is better.

---

### 5. Smoothing & Camera Path

#### What Production Systems Use

**Google AutoFlip (open source, MediaPipe)**:

- Buffers entire scene between shot cuts
- Fits piecewise polynomial camera path minimizing residuals
- Three modes per scene: stationary (locked), panning (constant velocity), tracking (follow subject)
- Uses color histogram comparison for scene change detection

**Academic Football Production (Springer)**:

- L1-regularized convex optimization → piecewise camera paths
- Three segment types: constant (hold), linear (smooth pan), parabolic (acceleration)
- L1 regularization encourages **hold-then-pan-then-hold** — professional broadcast look

**Practical Comparison**:

| Method                           | Pros                                         | Cons                         | Best For                         |
| -------------------------------- | -------------------------------------------- | ---------------------------- | -------------------------------- |
| **EMA** (what we have)           | Simple, no buffer                            | Reactive, can't look ahead   | Real-time only                   |
| **Savitzky-Golay**               | Preserves sharp transitions, look-ahead      | Requires buffer              | **Offline clips (our use case)** |
| **L1-regularized optimization**  | Most broadcast-like result                   | Complex, requires full scene | Highest quality                  |
| **Double exponential smoothing** | 135x faster than Kalman, equivalent accuracy | Limited prediction           | Real-time, resource-constrained  |

**Our clips are offline (25s goal clips)** — we should use Savitzky-Golay or similar look-ahead smoothing, not reactive EMA.

#### "Hold Zones" (From L1 Regularization Research)

If target crop position hasn't moved more than X pixels from current position, **don't move at all**. This creates the professional "hold, then smooth pan, then hold" look rather than constant micro-movement. We partially implement this with our dead zone logic in simplify.ts.

---

### 6. Framing Strategy — Beyond Ball-Following

| Strategy                        | Used By                         | How It Works                                      | When It's Better                |
| ------------------------------- | ------------------------------- | ------------------------------------------------- | ------------------------------- |
| **Ball-following** (what we do) | SmartCrop, basic systems        | Center crop on ball position                      | When ball detection is reliable |
| **Player cluster centroid**     | PIX4TEAM, Pixellot (basketball) | Center on mass of player positions                | When ball is not detected       |
| **Weighted ROI**                | WSC Sports                      | Ball + players + goal area, each weighted         | Most robust, production-grade   |
| **Occupancy/saliency map**      | Academic systems                | Heatmap of player density = "where is the action" | Combines precision + robustness |
| **Game state prediction**       | Pixellot                        | Detect set piece → pre-position camera            | Anticipatory, smoothest result  |
| **Optical flow**                | Academic                        | Detect action direction from frame differences    | Movement-based framing          |

**For our pipeline**: Player cluster centroid is our current fallback (when ball not detected). The weighted ROI approach (ball position weighted higher when confident, player cluster when not) would be more robust.

---

### 7. Datasets for Fine-Tuning

| Dataset               | Size                     | Format        | Notes                                                                     |
| --------------------- | ------------------------ | ------------- | ------------------------------------------------------------------------- |
| **SoccerNet_v3_H250** | 250 images               | YOLO format   | Quick-start subset, [GitHub](https://github.com/kmouts/SoccerNet_v3_H250) |
| **SoccerNet-v3**      | Large-scale              | COCO/YOLO     | Broadcast footage                                                         |
| **ISSIA**             | 15,707 images            | Various       | 6 static cameras, gold standard                                           |
| **Roboflow Universe** | Various (84-1036 images) | YOLO/COCO/VOC | Multiple community datasets                                               |
| **WASB datasets**     | 5 sport categories       | Custom        | [GitHub](https://github.com/nttcom/WASB-SBDT)                             |

**How much data is needed**: 500-1000 annotated frames from actual Veo footage. RF-DETR generalizes better with limited data (DINOv2 backbone). Fine-tuning from Forzasys weights on Veo-specific data is the highest-ROI change.

**Important**: All existing datasets are from broadcast or fixed cameras. Veo's moving virtual camera produces fundamentally different footage — fine-tuning on our actual Veo clips is essential.

---

### 8. Open-Source Tools Worth Investigating

| Tool                                                                                                                     | Stars | What It Does                                  | Relevance                              |
| ------------------------------------------------------------------------------------------------------------------------ | ----- | --------------------------------------------- | -------------------------------------- |
| [WASB-SBDT](https://github.com/nttcom/WASB-SBDT)                                                                         | -     | Strongest ball detection baseline (BMVC 2023) | **High** — try as detector replacement |
| [roboflow/sports](https://github.com/roboflow/sports)                                                                    | 2,605 | Soccer analysis examples                      | **High** — reference implementation    |
| [roboflow/supervision](https://github.com/roboflow/supervision)                                                          | -     | InferenceSlicer + tracking + smoothing        | **High** — cleaner SAHI implementation |
| [R523/football](https://github.com/R523/football)                                                                        | -     | Virtual camera simulation for panoramic       | **High** — exactly our problem         |
| [TrackNetV4](https://github.com/yastrebksv/TrackNet)                                                                     | -     | Heatmap ball detection (3-frame temporal)     | **Medium** — needs retraining          |
| [Google AutoFlip](https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/examples/desktop/autoflip/README.md) | -     | Intelligent video reframing                   | **Medium** — smoothing reference       |
| [PySceneDetect](https://github.com/Breakthrough/PySceneDetect)                                                           | -     | Video scene/cut detection                     | **Medium** — for scene-aware smoothing |

---

## Recommended Action Plan

### Phase 1: Quick Wins — COMPLETED

1. ~~Increase SAHI slice size~~ — Already at 640x640 (was a misconception)
2. ~~Test WASB-SBDT~~ — Assessed, NOT worth swapping (see above)
3. ~~Test higher YOLO input resolution~~ — Tested imgsz=1280, made things worse
4. ~~Bidirectional interpolation~~ — SHIPPED. +3.4% score, -18.6% error, zero regressions

### Phase 2: Fine-Tuning (Highest ROI) — READY, needs annotation

5. **Annotate 300-500 frames from Veo goal clips** using Roboflow (free tier) — frames already extracted to `/tmp/veo-frames/`
6. **Fine-tune from Forzasys weights** on Veo-specific data — Colab script ready at `scripts/portrait-crop/finetune_colab.py`
7. Optionally try **RF-DETR** which generalizes better with limited training data

### Phase 3: Next Iteration Post-Processing

8. **Confidence-weighted blend** for gap guard (replace binary skip with kalman_ratio threshold)
9. **GSI (Gaussian Smoothed Interpolation)** for clips with >50% detection
10. **Hold-with-decay** toward player cluster for clips with <35% detection
11. **Weighted ROI** — combine ball position + player positions + confidence for robust framing (fixes 002331-type clips)

### Phase 4: Architecture (Longer Term)

12. **L1-Optimal Camera Paths** — the gold standard for broadcast-quality virtual camera motion (Google CVPR 2011)
13. **Game state detection** — detect goal events, switch from ball-following to action-following
14. **TrackNet retraining** on Veo football data — best long-term architecture for small ball detection

---

## Veo-Specific Challenges

Our footage has unique challenges that differ from fixed panoramic cameras:

1. **Moving virtual camera**: Veo's Follow-cam already pans and zooms in landscape mode. The ball can appear anywhere in the 1920px frame, not at predictable positions. This makes detection harder because:
   - Background is constantly shifting (confuses motion-based approaches)
   - Ball can be at any scale due to virtual zoom
   - Model needs to handle more visual variety per clip

2. **Pre-composed footage**: Unlike Spiideo/Pixellot (raw panoramic), Veo has already made framing decisions. We're re-framing an AI-composed landscape shot into portrait — similar to what WSC Sports does with broadcast footage

3. **Stitching artifacts**: Veo stitches two 4K cameras together. The stitch line can create visual artifacts that confuse detectors

4. **Training data gap**: The Forzasys model was trained on Norwegian Eliteserien broadcast footage (tight shots, static backgrounds). Veo's moving virtual camera produces fundamentally different visual patterns — this likely explains our low detection rates on hard clips

---

## Additional A/B Tests (March 2026)

### imgsz=1280 (higher YOLO input resolution)

Tested by adding `imgsz=1280` to the `model.predict()` call. Results on worst clips:

- 015432-goal: 29% → 28% ball detection — **no improvement**
- 002331-goal: 23% → 20% ball detection — **worse**
- 005743-goal: 11% → 9% ball detection — **worse**
- 010300-goal: 56% → 54% ball detection — **slightly worse**

**Conclusion**: Higher input resolution doesn't help. The model wasn't trained on Veo footage — it doesn't know what to look for regardless of resolution.

### Bidirectional Interpolation (offline gap filling)

Fills detection gaps using both past AND future ball detections — only possible in offline processing. Three iterations tested:

| Config                    | Score     | Avg Error | Notes                                          |
| ------------------------- | --------- | --------- | ---------------------------------------------- |
| **Tight bidir (shipped)** | **0.511** | **57px**  | Hold-only gaps, smoothstep, 300px max          |
| Wide bidir                | 0.500     | 58px      | Any gap, linear, 500px max — 4 clips regressed |
| Baseline (no bidir)       | 0.494     | 70px      | Previous best                                  |

**Key learnings from industry research:**

- **StrongSORT++ GSI**: Gaussian Process Regression > linear interpolation — produces stable velocity, acts as noise filter
- **SmartCrop (Forzasys)**: Offers linear, polynomial, AND ease-in-out interpolation options
- **Pixellot**: 5-second lookahead buffer, physics-based Kalman, game state recognition
- **Google AutoFlip**: Polynomial path fitting at scene level, not frame level
- **L1-Optimal Camera Paths (Google CVPR 2011)**: Gold standard — L1 minimization produces broadcast-quality motion (constant + linear + parabolic segments)

**Three guard rails that eliminated regressions:**

1. Only interpolate pure hold/cluster gaps — if Kalman tracker produced "tracked" positions, don't override them (from StrongSORT insight)
2. Smoothstep (ease-in-out) instead of linear — avoids velocity discontinuities at gap boundaries (from SmartCrop)
3. Conservative 300px max distance — prevents interpolating across scene changes

### WASB-SBDT Assessment

Evaluated as alternative detector (BMVC 2023, strongest published ball detection baseline). **Verdict: NOT worth swapping.**

- Downscales to 512x288 (loses small balls our SAHI catches)
- No player detection (we use players for cluster scoring)
- Weaker tracking (3-frame velocity prediction vs our Norfair Kalman)
- SoccerDB training data (broadcast, not Veo)
- Research code quality — training code never released

### Key Finding: Detection vs Smoothing Quality Split

From StrongSORT++ ablation data and industry analysis:

- **Detection quality = ~70-80% of final auto-framing quality**
- **Smoothing/post-processing = ~20-30%**
- At our detection rates (11-75%), post-processing improvements hit diminishing returns quickly
- The +3.4% score improvement from bidir interp is likely approaching the ceiling for what post-processing alone can achieve

### Key Finding: Framing Strategy Problem (002331-goal)

The model correctly detects the ball at x=1400-1700 (in the net), but the user wants the crop at x=246-967 (showing the celebration). Even perfect ball detection would produce wrong results on these clips. Industry solutions:

- **WSC Sports**: Weighted ROI — ball weight drops, player weight rises post-goal
- **Pixellot**: Game state detection — switches camera behavior after goals
- **PIX4TEAM**: "Follows the action, not any specific player or the ball"

This confirms: **fine-tuning on Veo footage is the only path to meaningful improvement** on detection-limited clips. For framing-limited clips, weighted ROI is needed.

---

## Fine-Tuning Plan (Practical Steps)

### Overview

- **Goal**: Fine-tune Forzasys YOLOv8m on 500+ annotated frames from our Veo clips
- **Starting weights**: `yolov8m_forzasys_soccer.pt` (transfer learning, not from scratch)
- **Total estimated time**: 4-5 hours (mostly annotation)
- **Cost**: Free (Roboflow free tier + Google Colab free T4)

### Step 1: Frame Extraction (5 min) — DONE

```bash
# Already built — extracts at 2fps, skips black frames, limits per clip
python3 scripts/portrait-crop/extract_frames.py public/editor-test /tmp/veo-frames --max-per-clip 50
```

- 330 frames extracted from 11 clips (30 per clip)
- Output: `/tmp/veo-frames/*.png`

### Step 2: Annotation with Roboflow (1.5-2 hours)

- Create Roboflow project: "veo-ball-detection", classes: `player` (0), `ball` (1)
- Upload Forzasys weights for **Label Assist** (model pre-annotates each frame)
- Review and correct: ~5 sec/frame where model is good, ~15 sec/frame where it fails
- Must keep same class IDs as Forzasys (0=player, 1=ball, 2=logo)

### Step 3: Dataset Preparation (15 min)

- Train/Val/Test split: 70/20/10
- Augmentations: horizontal flip, brightness ±15%, blur ±10%
- **No mosaic** (bad for small object detection)
- Export in YOLOv8 format

### Step 4: Training on Google Colab (1-2 hours) — Script ready

```bash
# Upload scripts/portrait-crop/finetune_colab.py to Colab
# Set your Roboflow API key, workspace, and project name
# Run on T4 GPU — ~30-45 min for 50 epochs with 330 images
```

- Script: `scripts/portrait-crop/finetune_colab.py`
- Uses transfer learning from Forzasys weights (freeze backbone, train head)
- Includes augmentation tuned for football (scale, flip, slight rotation)

### Step 5: Evaluation (30 min)

- Replace `yolov8m_forzasys_soccer.pt` with `best.pt` from training
- Run on all clips, score against review3 corrections
- Target: worst clips improve from 11-28% → 60%+ detection

### Hardware Notes

- **Mac M-series**: Works but 10-24x slower than GPU (4-8 hours)
- **Google Colab T4 (free)**: 30-60 minutes — recommended
- **Cloud GPU (Lambda/RunPod)**: 10-20 minutes, ~$1-2

---

## Scoring Methodology

- Script: `scripts/portrait-crop/score.ts`
- Ground truth: Human-corrected keyframes in `Desktop/review3/`
- **Time tolerance**: 1.0 seconds (keyframes within 1s are matched)
- **Position tolerance**: 80px (matched keyframes within 80px count as "correct")
- **Score formula**: correct / (correct + missing + extra) — Jaccard-like metric
- **Overall score**: Weighted by total keyframes across all clips

---

_Last updated: March 2026_
_Sources: WSC Sports patent WO2019141813A1, Pixellot blog, Forzasys SmartCrop (IEEE), Google AutoFlip, WASB-SBDT (BMVC 2023), TrackNetV4 (ICASSP 2025), Roboflow sports ecosystem, SoccerNet challenges_

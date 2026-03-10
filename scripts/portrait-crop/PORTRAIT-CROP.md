# Portrait Crop — Technical Documentation

## Overview

Automated landscape-to-portrait (16:9 → 9:16) video cropping for Veo goal clips. Extracts a 608px-wide crop window from 1920x1080 panoramic footage, following the ball with smooth camera movement suitable for social media (Instagram Reels, TikTok, YouTube Shorts).

**Goal:** Automate the manual CapCut workflow for ~180+ goal clips, and eventually productize as part of the PLAYBACK Engine v2.

---

## Architecture

```
                    ┌──────────────────────┐
                    │   Input: 1920x1080   │
                    │   Veo goal clip      │
                    └──────────┬───────────┘
                               │
                    ┌──────────▼───────────┐
                    │   detect_ball.py     │
                    │   (Python + YOLO)    │
                    │                      │
                    │  1. SAHI 320x320     │
                    │     tiled detection  │
                    │     (sports ball)    │
                    │                      │
                    │  2. Standard YOLO    │
                    │     person detection │
                    │     (cluster centroid)│
                    │                      │
                    │  3. Confidence-first │
                    │     scoring + prox.  │
                    │     bonus            │
                    └──────────┬───────────┘
                               │ JSON (positions, scene_changes)
                    ┌──────────▼───────────┐
                    │     crop.ts          │
                    │   (TypeScript)       │
                    │                      │
                    │  1. Ball/cluster     │
                    │     separation       │
                    │  2. Outlier rejection│
                    │  3. Cluster filtering│
                    │  4. Weighted EMA     │
                    │     smoothing        │
                    │  5. Speed clamping   │
                    │  6. FFmpeg crop      │
                    └──────────┬───────────┘
                               │
                    ┌──────────▼───────────┐
                    │  Output: 1080x1920   │
                    │  Portrait video      │
                    │  + Debug overlay     │
                    └──────────────────────┘
```

---

## Current Pipeline

### detect_ball.py (Python)

**Detection approach:** SAHI (Slicing Aided Hyper Inference) for ball + standard YOLO for persons.

| Parameter                 | Value                          | Purpose                                              |
| ------------------------- | ------------------------------ | ---------------------------------------------------- |
| `SAHI slice size`         | 320x320                        | Smaller slices find ~15px balls in panoramic footage |
| `SAHI overlap`            | 25%                            | Prevents missed detections at tile boundaries        |
| `SAHI conf threshold`     | 0.1                            | Low threshold — scoring handles quality filtering    |
| `Person detection`        | YOLO class 0, conf 0.3         | Fast player cluster centroid                         |
| `MIN_BALL_AREA`           | 20                             | Reject noise                                         |
| `MAX_BALL_AREA`           | 3000                           | Reject large false positives                         |
| `Y-axis filter`           | Top 15% rejected               | Removes scoreboard/sky detections                    |
| `BALL_CLUSTER_BOOST_DIST` | 400px                          | Proximity bonus range                                |
| `Scoring`                 | conf + 0.15 \* proximity_bonus | Confidence-primary, no hard distance gate            |
| `Threshold`               | score > 0.2                    | Minimum to be considered valid                       |
| `Model`                   | yolov8x.pt (COCO)              | Generic weights, not soccer-specific                 |
| `Device`                  | MPS (Apple Silicon)            | Local development                                    |

**Output format:**

```json
{
  "positions": [
    { "time": 0.0, "x": 850, "y": 400, "w": 15, "h": 15, "conf": 0.6 }
  ],
  "scene_changes": [2.5, 8.3],
  "all_candidates": []
}
```

- `w > 0` = ball detected by SAHI
- `w = 0, y = 0` = cluster fallback (x = player centroid)
- `x = -1` = no detection at all

### crop.ts (TypeScript)

**Smoothing pipeline:**

1. **Separate** ball (w>0) from cluster (w=0) positions
2. **Outlier rejection** on ball detections (sliding window median, OUTLIER_WINDOW=5, OUTLIER_MAX_DEVIATION=400)
3. **Cluster filtering** — only use cluster when:
   - No ball detection within 1 second, OR
   - Cluster agrees with nearest ball position (<300px)
4. **Merge** with ball priority (ball conf → 0.8, cluster conf → 0.3)
5. **Final outlier pass** on all merged positions
6. **Weighted EMA** smoothing: alpha = 0.12 \* (0.5 + weight)
   - Ball: effective alpha ~0.216 (responsive)
   - Cluster: effective alpha ~0.096 (resistant to pull)
7. **Speed clamping** at MAX_PAN_PX_PER_SEC = 700

| Parameter             | Value                          |
| --------------------- | ------------------------------ |
| `DETECT_FPS`          | 5                              |
| `EMA_ALPHA`           | 0.12                           |
| `MAX_PAN_PX_PER_SEC`  | 700 px/s                       |
| `CROP_W`              | 608 px (9:16 from 1080 height) |
| `CROP_MAX_X`          | 1312 px (1920 - 608)           |
| `CENTER_CROP_X`       | 656 px                         |
| `OUTPUT_W x OUTPUT_H` | 1080 x 1920                    |

**Debug output:** Split original → darken → overlay crop window as a picture-in-picture comparison.

---

## Development History

### Approaches Tried (chronological)

| #   | Approach                                      | Result                     | Why it failed/succeeded                                                                                      |
| --- | --------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1   | **Gemini Flash video analysis**               | Failed                     | Gemini returns semantic descriptions, not pixel-level coordinates. Timestamp drift. Wrong tool for tracking. |
| 2   | **Standard YOLO ball detection**              | 3% ball detection          | Ball is ~15px in 1920x1080 panoramic — too small for standard YOLO without tiling                            |
| 3   | **YOLO BoT-SORT tracking**                    | 3% ball detection          | Same small-ball problem. BoT-SORT can't track what it can't detect.                                          |
| 4   | **SAHI 640x640 slices**                       | ~40% ball detection        | Better, but 640px slices still too large for reliable small ball detection                                   |
| 5   | **SAHI 320x320 + hard proximity gate**        | 48% ball, but bad tracking | Hard cutoff (500px from cluster) rejected correct ball detections during throw-ins, dead balls               |
| 6   | **SAHI 320x320 + confidence-primary scoring** | 72% ball detection         | Current approach. Confidence wins, proximity is just a small bonus.                                          |

### Key Bugs Fixed

1. **Proximity filter too aggressive** — Ball at x=600 (conf=0.83) rejected because cluster was at x=1266 (666px away). Real ball was consistently detected with high confidence but filtered out. Fixed by removing hard distance gate.

2. **Cluster-ball oscillation** — Cluster centroids at x=1000-1400 alternating with ball detections at x=450-500 every 0.2s caused crop to glide left/right. Fixed by cluster filtering (only use cluster when it agrees with nearby ball).

3. **False positive outliers** — Occasional high-confidence false positives (logos, sideline markers) pulled crop off target. Fixed by sliding-window median outlier rejection.

---

## Current Performance

**On 10 test clips (2026-03-05):**

- All 10 processed successfully
- Ball detection rate: ~50-72% (varies by clip)
- Cluster fallback: ~28-50%
- Quality: "SOOO much better" per user, but still has issues

### Known Remaining Issues

| Issue                             | Root Cause                                                | Potential Fix                                                  |
| --------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------- |
| **Too late to move after a shot** | EMA smoothing is sluggish for fast ball movements         | Savitzky-Golay smoothing (lookahead window)                    |
| **"Looks lost" during occlusion** | No ball trajectory prediction when ball is behind players | Norfair Kalman filter tracker (interpolates through occlusion) |
| **Occasional left-right gliding** | Low-confidence ball detections + cluster disagreement     | Soccer-specific YOLO weights (higher baseline confidence)      |
| **Generic COCO weights**          | yolov8x.pt not trained for small sports balls             | Forzasys soccer-specific weights (82% ball TP rate)            |

---

## Recommended Next Improvements (Priority Order)

### 1. Forzasys Soccer-Specific YOLO Weights (Highest Impact)

**What:** Replace `yolov8x.pt` (generic COCO) with `yolov8m_forzasys_soccer.pt` (trained on SoccerNet dataset).

**Why:** Reports 82% ball true-positive rate, specifically handles ball-at-foot scenarios. Drop-in replacement — same YOLO architecture, just better weights for football.

**Impact:** Would dramatically reduce cluster fallback rate and eliminate most false positives. Single biggest improvement available. May also reduce or eliminate the need for SAHI tiling if the model detects small balls natively — which would cut inference time significantly (SAHI is the main performance bottleneck, running ~30 tile inferences per frame).

**Source:** [Forzasys SportsVision-YOLO](https://github.com/ForzaETH/SportsVision-YOLO)

### 2. Norfair Kalman Filter Tracker

**What:** Replace raw position list with Norfair's tracked trajectories that interpolate through occlusions.

**Why:** When ball goes behind players, Norfair predicts where it should be based on velocity/trajectory instead of the crop "looking lost." Has camera motion compensation built in.

**Impact:** Fixes occlusion problem. Smooth predicted path instead of oscillation.

**Source:** [Norfair by Tryolabs](https://github.com/tryolabs/norfair)

### 3. Savitzky-Golay Smoothing (Validated by Pixellot's Approach)

**What:** Replace EMA with polynomial smoothing filter that uses a lookahead window.

**Why:** EMA is inherently reactive (only looks backward). Savitzky-Golay looks both forward and backward, producing smoother curves that anticipate fast movements. Used by RetargetVid for this exact use case.

**Validation:** Pixellot uses a 4-second predictive lead for their virtual camera panning. Since we process offline (not live), we can implement even longer lookahead — we have the full video available. This is an advantage WSC and Pixellot don't have in their live pipelines.

**Impact:** Fixes "too late after a shot" and reduces gliding artifacts.

**Source:** [RetargetVid](https://github.com/retargetvid/retargetvid)

### 4. Audio Signal Analysis (Future — Inspired by WSC Sports)

**What:** Analyze audio track (crowd noise, commentator reactions) as a secondary signal during ball occlusion.

**Why:** WSC Sports uses Mel-spectrogram audio analysis as one of their three analysis layers. When the ball is behind players and visual detection fails, a crowd roar or commentator exclamation signals that something important is happening — the crop should stay put or move toward the action rather than drifting.

**Impact:** Improved occlusion handling. Not a priority until visual detection is maximized, but worth noting as a proven technique at scale.

---

## Industry Landscape & Competitive Context

### WSC Sports (Gold Standard — $100M+ funded)

WSC Sports is the market leader in AI-powered sports video processing with 650+ clients (NBA, LALIGA, NHL, Serie A, Ligue 1, ESPN). Their **Magicrop** technology is the direct competitor to what we're building.

**What they do:**

- Software-only platform — ingests existing broadcast feeds (no hardware)
- ML-predicted Region of Interest (ROI) per frame → crop window follows ROI
- Multi-modal analysis: video (CNNs) + audio (Mel-spectrograms for crowd/commentator reactions)
- Sport-specific model variants (custom Magicrop for horse racing, cricket, etc.)
- PyTorch + ClearML + Kubernetes on Azure
- 10.2M highlights in 2024, 4M vertical/portrait crops (81% YoY growth)

**Key technical details:**

- Three-layer real-time analysis (video features, audio features, game state)
- > 98% event detection accuracy claimed
- Supervised learning on client data — different architectures per problem
- Patent US 10,417,500: ROI prediction per frame for cropping
- Temporal smoothing for jitter-free crop movement (specifics proprietary)
- Ball tracking confirmed sport-specific (cricket, soccer)

**What we can learn from WSC:**

- Sport-specific models are essential — generic doesn't cut it
- Multi-modal (video + audio) improves robustness during occlusion
- Game state detection helps predict ball trajectory contextually
- They serve professional broadcast footage (higher quality input than Spiideo panoramic)

### Pixellot (Hardware + Software)

- Fixed multi-camera arrays at venues, AI creates virtual camera director
- Deep learning runs <10ms/frame for real-time production
- **Predicts ball position 4 seconds ahead** for smooth virtual panning
- 98% camera accuracy claimed
- 200,000+ hours filmed
- Target: schools, colleges, amateur leagues

**What we can learn from Pixellot:**

- Predictive lead time (4 seconds) is critical for smooth camera movement
- Works with panoramic source material similar to our Spiideo footage
- Ball detection challenges with corners, occlusion, poor lighting acknowledged

### Veo (Portable Camera + Cloud)

- Single portable camera, 180-degree panoramic capture
- Cloud-based post-match AI processing for follow-cam
- Detects goals, corners, penalties, free kicks, goal kicks
- Target: youth/amateur clubs

**Our position vs these competitors:**

- We're building **offline portrait conversion from panoramic source** for Spiideo/Veo recordings — an underserved niche none of these three target directly
- WSC Sports works with broadcast footage (already human-directed, ball fills 50+ pixels) — fundamentally easier input than our raw panoramic (~15px ball)
- Pixellot does real-time virtual camera direction from multi-camera arrays — different hardware, different problem
- Veo does post-match follow-cam from panoramic — closest to our use case, but they don't offer portrait conversion
- Our approach (SAHI + YOLO + cluster fallback + smoothing) mirrors the fundamental architecture all three use

**Our key advantage: offline processing.** WSC, Pixellot, and Veo all need to process live or near-live. We process recorded clips, meaning we have access to future frames. This enables:

- Savitzky-Golay smoothing with full lookahead (they can't look ahead in live feeds)
- Multi-pass processing (outlier rejection, bidirectional smoothing)
- More expensive per-frame inference (SAHI tiling) since we're not latency-bound
- Batch optimization and retry on failure

### Open-Source Building Blocks

| Project                                                                               | What It Provides                                          | Relevance                           |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------- |
| [Forzasys SportsVision-YOLO](https://github.com/ForzaETH/SportsVision-YOLO)           | Soccer-specific pretrained YOLO weights (82% ball TP)     | Drop-in weight replacement          |
| [Norfair](https://github.com/tryolabs/norfair)                                        | Production Kalman tracker with camera motion compensation | Ball interpolation during occlusion |
| [RetargetVid](https://github.com/retargetvid/retargetvid)                             | Savitzky-Golay smoothing for crop windows                 | Better smoothing than EMA           |
| [abdullahtarek/football_analysis](https://github.com/abdullahtarek/football_analysis) | Ball interpolation when occluded                          | Reference implementation            |
| [Autocrop-vertical](https://github.com/autocrop-vertical)                             | FFmpeg pipeline for vertical cropping                     | Pipeline reference                  |
| [SoccerNet](https://www.soccer-net.org/)                                              | Largest labeled soccer dataset                            | Training data for fine-tuning       |

---

## Cost Analysis

### Per-clip processing cost (cloud GPU)

| Resource                                     | Cost            |
| -------------------------------------------- | --------------- |
| GPU compute (NVIDIA T4, ~25s clip)           | ~$0.01-0.02     |
| SAHI inference (~120 frames × 320x320 tiles) | Included in GPU |
| FFmpeg transcode                             | ~$0.005         |
| **Total per clip**                           | **~$0.02-0.03** |

At scale (1000 clips/month): ~$20-30/month in compute.

**Note:** SAHI tiling is the main cost driver (~30 tile inferences per frame at 320x320). If soccer-specific weights (Forzasys) detect the ball reliably without tiling, we could drop SAHI entirely for ball detection and cut inference cost by ~80%.

### Local development

- Runs on Apple Silicon (MPS) — no cloud cost during development
- ~2-3 minutes per 25-second clip
- Fans spin up significantly (GPU-intensive)

---

## File Structure

```
scripts/portrait-crop/
├── crop.ts              # Main orchestration (TypeScript)
├── detect_ball.py       # Ball detection (Python + SAHI + YOLO)
├── package.json         # Node deps (tsx, dotenv, @google/genai)
├── tsconfig.json        # TypeScript config
├── yolov8x.pt           # YOLO model weights (COCO, generic)
└── PORTRAIT-CROP.md     # This file
```

### Dependencies

**Python:** ultralytics (YOLO), sahi, opencv-python, numpy
**Node:** tsx (TypeScript execution), dotenv

### Running

```bash
# Single clip
npx tsx crop.ts "/path/to/goal.mp4"

# Batch (folder)
npx tsx crop.ts "/path/to/folder/"
# Outputs to folder/portrait_output/
```

---

## Strategic Assessment

### Are we on the right track?

**Yes.** Our SAHI + YOLO + player cluster architecture mirrors what commercial products use. The fundamental approach is sound. The gaps are:

1. **Model quality** — generic COCO weights vs soccer-specific (fixable with Forzasys weights)
2. **Tracking continuity** — no prediction during occlusion (fixable with Norfair)
3. **Smoothing responsiveness** — EMA is too reactive/sluggish (fixable with Savitzky-Golay)

None of these are architectural problems — they're component upgrades within the existing pipeline.

### Can this be commercialized?

**Yes, with the improvements above.** WSC Sports proves the market exists (4M vertical crops/year, growing 81% YoY). Our differentiator is working with panoramic sports camera footage (Spiideo/Veo), not broadcast feeds — a harder problem but an underserved market.

### What "good enough" looks like

**Important: WSC Sports is not an apples-to-apples comparison.** WSC processes broadcast footage where a human camera operator has already framed the action — the ball is typically 50+ pixels and prominently centered. We process raw panoramic footage where the ball is ~15px in a 1920-wide frame with no human direction. Our detection problem is fundamentally harder.

**The right benchmark for us:**

- **Minimum viable:** Faster than manual CapCut editing with quality acceptable for club social media posts (Instagram Reels, TikTok). Clubs currently spend 10-15 minutes per clip manually — if we automate to 2-3 minutes with 80%+ acceptable quality, that's a clear value proposition.
- **Commercial quality:** Ball/action in frame >90% of the time. Smooth camera movement with no visible jitter. Graceful handling of occlusion (hold position rather than oscillate). No more than 1-2 moments per clip where manual adjustment would be needed.
- **WSC-tier quality (aspirational):** >98% accuracy, sport-specific tuning, multi-modal analysis. This requires significant training data and engineering investment — target for v3+, not v1.

**WSC Sports quality bar (for reference):**

- Smooth, professional camera movement (no jitter or oscillation)
- Ball/action always in frame
- Sport-specific model tuning per sport
- Handles occlusion gracefully (multi-modal: video + audio)
- 4M+ vertical crops/year, deployed at 2024 Olympics
- $100M+ funding, 650+ clients providing training data

# Portrait Crop v5 Analysis — Research & Evidence Report

## Test Results Summary (v5 batch — 2026-03-06)

| Clip   | Verdict         | Ball %   | Simplified KFs | Root Cause                                                                 |
| ------ | --------------- | -------- | -------------- | -------------------------------------------------------------------------- |
| 012958 | PERFECT         | high     | 12             | --                                                                         |
| 005036 | PERFECT         | high     | 13             | --                                                                         |
| 010300 | GOOD ENOUGH     | moderate | 6              | --                                                                         |
| 003615 | PERFECT         | moderate | 7              | --                                                                         |
| 002331 | COMPLETELY LOST | 36%      | 5              | Ball exits frame at goal, 12.3s of pure cluster                            |
| 015432 | COMPLETELY LOST | 29%      | 7              | False positive detections, 200-500px x jumps between frames                |
| 004501 | UNNECESSARY KFS | 49%      | 12             | Good detection but simplification produces jitter + missing keyframe       |
| 003948 | LOST AFTER GOAL | 87%      | 8              | Excellent detection, but first frame x=0 (1128px off), ball lost post-goal |
| 005743 | JITTERY START   | 10%      | 11             | 4.7s blackout, YOLO finds nothing, cluster fallback jitters                |
| 013015 | TRACKED ISSUES  | moderate | 11             | Premature tracked snap + missing mid-clip keyframes                        |

**Pass rate: 4/10 PERFECT, 1/10 GOOD ENOUGH, 5/10 need improvement**

---

## 1. Keyframe Comparison: Generated vs User-Corrected

### Deletion Patterns by Source Type

| Source     | Generated | Deleted | Kept   | Deletion Rate |
| ---------- | --------- | ------- | ------ | ------------- |
| ai_ball    | 30        | 10      | 20     | 33%           |
| ai_cluster | 12        | 5       | 7      | 42%           |
| ai_tracked | 7         | 3       | 4      | 43%           |
| **Total**  | **49**    | **18**  | **31** | **37%**       |

### Starting Position Error (t=0)

| Clip   | Generated x    | Correct x | Error (px) | % of frame |
| ------ | -------------- | --------- | ---------- | ---------- |
| 002331 | 1312 (cluster) | 660       | **652**    | 34%        |
| 015432 | 194 (ball)     | 631       | **437**    | 23%        |
| 003948 | 0 (ball)       | 1128      | **1128**   | 59%        |
| 005743 | 853 (cluster)  | 853       | 0          | 0%         |
| 013015 | 522 (cluster)  | 522       | 0          | 0%         |

**Average t=0 error across clips with errors: 739px (38% of frame)**

### User Additions by Time Range

| Time Range           | Additions | %   |
| -------------------- | --------- | --- |
| t=0 (start override) | 4         | 19% |
| t=0-8s               | 3         | 14% |
| t=8-16s (middle)     | 7         | 33% |
| t=16-25s (end)       | 7         | 33% |

### Common Deletion Reasons

1. **Jittery rapid-fire** — 2-3 ball keyframes within 0.5s oscillating 100-200px (004501 t=2.6/2.8)
2. **Redundant duplicates** — same x as neighbor (013015 t=5.1 same x=412 as t=4.4)
3. **Post-goal false tracking** — ball detection at wrong position after goal (003948 t=21.8/22.8)
4. **Cluster at wrong position** — player centroid 200-500px from actual ball (015432 t=17-24)

---

## 2. Raw Detection Analysis

### Per-Clip Root Causes

**002331 — "Completely Lost"**

- Actually has 62% ball detection in first 5s — early detection is fine
- Ball exits frame right (x=1920) at the goal moment (t=12.2s)
- After that: 12.3 seconds of 100% cluster — YOLO never recovers
- Pipeline starts crop at x=1312 (far right) because first detection is a cluster centroid there

**015432 — "Completely Lost"**

- Has 42% ball detection but positions are CHAOTIC: 200-500px jumps between consecutive frames
- t=1.0s x=296 -> t=1.2s x=728 -> t=1.3s x=971 -> t=2.1s x=609 -> t=3.3s x=389 -> t=3.8s x=937
- These are false positives on different objects (player heads, white patches), not the real ball
- Kalman tracker cannot handle this noise — creates jerky crop

**005743 — "Jittery Clusters"**

- First 4.7 seconds: ZERO ball detections (all cluster with y=0, conf=1.0 — centroid-only fallback)
- Only 24 ball detections in entire 24.5s clip (10%)
- Ball is likely airborne/occluded/too small for YOLO in opening frames
- When detected, ball sizes are 14-21px — borderline for full-frame YOLO

**004501 — "Unnecessary Keyframes"**

- Good detection (92% in first 5s) — this is a simplification problem, not detection
- 7 of 12 generated keyframes kept by user
- Deleted: 3 jittery keyframes at t=2.3-2.8 (oscillating 148px in 0.5s) and 3 cluster/ball keyframes at t=18-21
- User added 1 keyframe at t=15.5 to bridge 9.5s gap

**003948 — "Lost After Goal"**

- Excellent 87% detection but first frame at x=0 (conf=0.45) — ball is actually at x=1128
- Brief 0.5s loss at goal moment, self-corrects — minor issue
- User replaced x=0 start and added mid-clip keyframe at t=15

### Pattern: Post-Goal Detection Collapse

| Clip   | Last 10s ball % | What happens                 |
| ------ | --------------- | ---------------------------- |
| 002331 | 0%              | Ball in net, 100% cluster    |
| 015432 | 12%             | Scattered false positives    |
| 005743 | 2%              | Ball invisible, hold/cluster |
| 004501 | 19%             | Ball kicked out, scattered   |
| 003948 | 98%             | Good recovery (exception)    |

---

## 3. Market Research: How Industry Leaders Handle These Failures

### Starting Position When Ball Not Detected

| System                 | Fallback Strategy               |
| ---------------------- | ------------------------------- |
| **Forzasys SmartCrop** | Frame center                    |
| **Pixellot**           | Wide panoramic view (multi-cam) |
| **WSC Sports**         | ML-predicted ROI (patented)     |
| **Our system**         | Player cluster centroid         |

**No published system uses player cluster centroid as primary fallback.** SmartCrop (closest to our system) uses frame center. Evidence: SmartCrop paper states "frame-centered cropping as a fallback in case of too few ball detections."

### Conditional SAHI for Low-Detection Clips

Our system disabled SAHI because Forzasys weights detect 91% without it. But failing clips have 10-36% detection. Research shows:

- SAHI improves recall for small objects by 5-7% AP
- **Conditional SAHI**: run full-frame YOLO first; if no ball, re-run with SAHI slicing (640x640, 0.2 overlap)
- Only adds latency on frames that need it (~10-36% of frames in problem clips)
- Previous 320x320 slices may have been too small — 640x640 matches YOLOv8 input resolution

**Source**: [SAHI Paper](https://arxiv.org/abs/2202.06934), [Ultralytics SAHI Guide](https://docs.ultralytics.com/guides/sahi-tiled-inference/)

### SmartCrop's Outlier Detection (Pre-Filtering)

SmartCrop uses **three outlier detection methods** on raw ball positions before interpolation:

1. IQR (Interquartile Range)
2. Z-score
3. Modified Z-score

This catches the noisy multi-candidate detections seen in clip 015432 (200-500px jumps).

**Source**: [SmartCrop Paper](https://oda.oslomet.no/oda-xmlui/bitstream/handle/11250/3164019/2024_mmm_demo_smartcrop.pdf)

### Jitter Reduction Techniques

| Technique                                              | Used By                 | Our Status                      |
| ------------------------------------------------------ | ----------------------- | ------------------------------- |
| Dead zone / hysteresis (don't move unless >N px shift) | Pixellot                | NOT implemented                 |
| Ease-in-out interpolation                              | SmartCrop               | NOT implemented (we use linear) |
| Max velocity cap per frame                             | Professional camera ops | Partially (HOLD_PAN_VELOCITY)   |
| Triple outlier rejection before smoothing              | SmartCrop               | NOT implemented                 |
| Scene-cut detection                                    | SmartCrop, our system   | Implemented                     |
| Predictive lead (4s lookahead)                         | Pixellot                | NOT implemented                 |

### Ball Detection Failure Modes (Literature)

| Failure Mode                | Relevant Clips        | Solution                               |
| --------------------------- | --------------------- | -------------------------------------- |
| Ball too small (<10x10px)   | 005743, 015432        | SAHI, higher resolution input          |
| Motion blur                 | All during fast kicks | Multi-frame detection (TrackNet-style) |
| Ball against white markings | 015432                | Better training data                   |
| Occlusion behind players    | 005743                | Temporal interpolation                 |
| Frame edge effects          | 003948 (x=0)          | Edge detection rejection               |
| Multiple ball-like objects  | 015432                | IQR outlier filtering                  |

**Sources**: [PMC Ball Detection Review](https://pmc.ncbi.nlm.nih.gov/articles/PMC12453710/), [TOTNet 2025](https://arxiv.org/html/2508.09650v1)

---

## 4. Recommended Improvements (Priority-Ordered)

### P0 — High Impact, Low Effort

**A. Replace cluster centroid fallback with frame center**

- When no ball detected, use frame center (x=656) instead of player cluster centroid
- SmartCrop uses this in production — proven approach
- Fixes: 002331 (x=1312 -> x=656, 4px from correct 660), 003948 (x=0 -> x=656)
- Change in: `detect_ball.py` lines 286-304

**B. Dead zone threshold in simplify.ts**

- Don't create a new keyframe unless target shifted >50px from previous position
- Eliminates micro-jitter from cluster keyframes bouncing 20-100px frame-to-frame
- Fixes: 005743 cluster jitter (x=853->692->601->701->549->700 in 4.7s)
- Change in: `simplify.ts` (add dead zone check in removeNearDuplicates or new filter)

**C. Minimum keyframe time spacing**

- Enforce minimum 0.8s between consecutive ball keyframes
- Removes rapid-fire jittery detections (004501 t=2.3/2.6/2.8)
- Already partially done by NEAR_DUPLICATE_TIME=0.5s but needs increase for ball-only pairs

### P1 — High Impact, Medium Effort

**D. Conditional SAHI fallback**

- Run full-frame YOLO first; if no ball detected, re-run frame with SAHI (640x640 slices, 0.2 overlap)
- Only triggers on frames where detection fails — no impact on good clips
- Fixes: 005743 (4.7s blackout), potentially 002331 and 015432
- Change in: `detect_ball.py` — add SAHI fallback in the detection loop

**E. IQR outlier detection on raw positions**

- Before passing to Kalman tracker, filter ball candidates by IQR on recent x-positions
- If a detection is >1.5\*IQR from the median of last 10 detections, reject it
- Fixes: 015432 (200-500px jumps between frames are clearly outliers)
- Change in: `detect_ball.py` — add IQR filter before tracker.update()

**F. Post-goal hold strategy**

- After detecting a goal event (ball reaches x<80 or x>1232), hold position for 3-5s
- Don't follow ball into the net or celebrate with players
- Detect goal: ball velocity >300px/s toward edge + reaches edge zone
- Fixes: 002331 (12.3s of lost tracking after goal), 003948 (brief confusion)
- Change in: `detect_ball.py` — add goal detection + hold logic

### P2 — Medium Impact, Medium Effort

**G. Ease-in-out interpolation**

- Replace linear interpolation in `interpolateCropX` with ease-in-out curve
- Creates acceleration/deceleration like a human camera operator
- SmartCrop uses this in production
- Change in: `types.ts` interpolateCropX function

**H. Fill mid-clip gaps with user-expected keyframes**

- Current fillLongGaps inserts from pre-RDP data, but these may also be wrong
- Consider inserting interpolated midpoint positions instead of raw detections
- Fixes: gaps at t=10-21 in 002331, t=0-13 in 015432

### P3 — Research / Future

**I. Multi-frame temporal detection**

- TrackNet-style 3-consecutive-frame input for blur-robust detection
- Would help with motion-blur failures but requires model retraining
- Reference: [TOTNet 2025](https://arxiv.org/html/2508.09650v1)

**J. Predictive lead (Pixellot-style)**

- Since we process offline, use future ball positions to smooth current crop
- Already partially done by bilateral processing in crop.ts (SG filter)
- Could be enhanced with explicit lookahead in interpolation

---

## 5. Impact Matrix

| Fix                      | Clips Fixed    | Effort  | Confidence  |
| ------------------------ | -------------- | ------- | ----------- |
| A. Frame center fallback | 002331, 003948 | 1 hour  | High        |
| B. Dead zone threshold   | 005743         | 1 hour  | High        |
| C. Min time spacing      | 004501         | 30 min  | High        |
| D. Conditional SAHI      | 005743, 015432 | 4 hours | Medium-High |
| E. IQR outlier filter    | 015432         | 2 hours | High        |
| F. Post-goal hold        | 002331, 003948 | 3 hours | Medium      |
| G. Ease-in-out interp    | All (quality)  | 1 hour  | Medium      |
| H. Better gap filling    | 002331, 015432 | 2 hours | Medium      |

**Estimated: fixes A+B+C alone would improve 4 of 5 failing clips with ~2.5 hours of work.**
Adding D+E would address all 5 failing clips.

---

## Sources

- [SmartCrop (MMM 2024)](https://oda.oslomet.no/oda-xmlui/bitstream/handle/11250/3164019/2024_mmm_demo_smartcrop.pdf)
- [SmartCrop-R (ACM 2025)](https://dl.acm.org/doi/10.1145/3715675.3715794)
- [SAHI Paper](https://arxiv.org/abs/2202.06934)
- [Pixellot Auto-Production](https://www.pixellot.tv/blog/behind-the-scenes-of-automated-production-how-does-it-work/)
- [WSC Sports Patents](https://patents.justia.com/assignee/w-s-c-sports-technologies-ltd)
- [Ball Detection Comprehensive Review (PMC 2025)](https://pmc.ncbi.nlm.nih.gov/articles/PMC12453710/)
- [TOTNet: Occlusion-Aware Tracking (arXiv 2025)](https://arxiv.org/html/2508.09650v1)
- [SportsVision-YOLO (Forzasys)](https://github.com/forzasys-students/SportsVision-YOLO)
- [PlayerTV Advanced Tracking](https://arxiv.org/html/2407.16076v1)

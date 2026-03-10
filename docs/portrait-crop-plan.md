# Portrait Crop — Improvement Plan

## Context

Portrait crop converts 1920x1080 panoramic Spiideo/Veo recordings into 608x1080 vertical crops for social media.
The pipeline: `detect_ball.py` (YOLO + Norfair tracker) -> `simplify.ts` (keyframe simplification) -> `/editor` (review UI) -> `crop.ts` (FFmpeg render).

## Problem Statement

Ball detection collapses during celebrations, replays, and airborne ball sequences. The fallback to player cluster centroids produces positions 400-770px off from correct framing. Users currently need 5-8 manual corrections per clip in these sections.

## Completed Work

- [x] Phase 1: Keyframe simplification pipeline (`src/lib/editor/simplify.ts`)
  - RDP line simplification (tolerance=90px)
  - Scene cut detection and smoothing
  - Zigzag/direction-reversal filtering
  - Near-duplicate removal
  - Hold-before-pan injection
  - High-velocity gap preservation
  - Suspicious cluster filtering
  - Reduces 141-151 raw detections to 15-19 keyframes
  - 21 unit tests passing

- [x] Phase 2: Portrait crop editor UI (`/editor`)
  - Video preview with draggable crop overlay
  - Timeline with scrub-to-seek
  - Keyframe add/delete/drag
  - Properties panel
  - Import/export keyframes JSON
  - Undo/redo (Cmd+Z / Cmd+Shift+Z)
  - Keyboard shortcuts (Space, arrows, K, Delete)

## Current Sprint: Detection Accuracy Improvements

### Step 1: Extend Norfair tracker grace period

- **Status:** DONE
- **Impact:** High | **Effort:** Low
- Changed `TRACKER_HIT_COUNTER_MAX` from 15 to 25 (3s -> 5s at 5fps)
- Kalman predictions now clamped to frame bounds instead of abandoned for cluster
- **File:** `scripts/portrait-crop/detect_ball.py`

### Step 2: Hold last known position instead of cluster fallback

- **Status:** DONE
- **Impact:** High | **Effort:** Low
- When tracker dies after 5s, holds last valid ball/tracked position (conf=0.3)
- Cluster fallback now only used when no ball has EVER been detected (clip start)
- Fallback priority: ball detection -> Kalman prediction (5s) -> hold last position
- **File:** `scripts/portrait-crop/detect_ball.py`

### Step 3: Minimum ball confidence threshold

- **Status:** DONE
- **Impact:** Medium | **Effort:** Low
- Added `MIN_BALL_CONFIDENCE = 0.35` — filters false positive ball detections
- Applied BEFORE scoring (in addition to existing score > 0.2 gate)
- **File:** `scripts/portrait-crop/detect_ball.py`

### Step 3b: Off-screen tracker predictions use hold fallback

- **Status:** DONE
- **Impact:** Medium | **Effort:** Low
- When Kalman prediction goes off-screen (x<0 or x>frame_w), use hold fallback instead of clamping to 0
- Prevents x=0 artifacts when tracker extrapolates ball off-screen
- **File:** `scripts/portrait-crop/detect_ball.py`

### Step 4: Validate on test clips

- **Status:** DONE
- Ran on 013015-goal.mp4, compared against user-corrected keyframes
- **Results (round 1):** 7 OK, 3 CLOSE, 8 OFF out of 18 user keyframes
- **Results (round 2, with simplification fixes):** 7 OK (5 perfect), 1 CLOSE, 6 OFF out of 14 user keyframes
- **Before improvements:** ~4 OK, ~2 CLOSE, ~12 OFF
- **First half (t=0-9):** 7/8 keyframes are perfect matches — detection+simplification works great
- **Remaining 6 OFF:** 4 celebration (event awareness), 1 ball-at-edge, 1 start transition
- **Key finding:** Ball tracking accuracy is solved for normal play. The remaining errors require event understanding (celebration tracking) which ball detection alone cannot provide
- **Scene cut fix:** t=10.8-11.0 replay transition now detected, SCENE_CUT_MARGIN increased to 1.2s to remove approach keyframes

### Step 5: Goal-clip phase model

- **Status:** INVESTIGATED, NOT FEASIBLE with current approach
- **Impact:** High | **Effort:** High (higher than initially estimated)
- Tested: drift toward player cluster centroid during holds — goes wrong direction (center-field, not celebration)
- Tested: dense sub-cluster detection (find tightest player grouping) — same problem, celebration group is not always the densest
- **Root cause:** Player positions alone cannot determine where celebration is happening. Players are distributed across the field; the celebrating group is a minority.
- **Viable approaches for future:**
  1. Gemini Flash scene analysis during detection gaps (identify celebration location from video)
  2. Per-player tracking with motion detection (identify which players are moving/celebrating)
  3. User feedback learning (store corrections, learn per-clip-type patterns)
- These require significantly more infrastructure than the current ball-tracking pipeline

### Step 6: Higher FPS + Ballistic trajectory extrapolation

- **Status:** DONE
- **Impact:** High | **Effort:** Medium
- Bumped default from 5fps to 10fps — caught a critical ball detection at t=13.714 (x=1021) during the goal shot that 5fps missed entirely
- Norfair tracker now extrapolates RIGHTWARD toward the goal instead of leftward
- Added `ballistic_fill()` post-processing: when ball was moving fast (>300px/s) before a gap, extrapolates trajectory with deceleration instead of holding position
- Tracker params adjusted for 10fps: `hit_counter_max=50` (~5s), `init_delay=2`
- **Results on 013015:** t=14.834 went from OFF (502px) to CLOSE (151px). Tracker now heads toward goal area.

### Step 6b: Use raw ball detection when tracker not yet confirmed

- **Status:** DONE
- **Impact:** High | **Effort:** Low
- **Root cause found:** When Kalman tracker dies after 5s, new ball detections require `init_delay=2` consecutive frames to re-initialize the tracker. Single-frame detections during replay were being THROWN AWAY and falling through to "hold last position".
- Added new code branch: when `best_ball` exists but `tracked_objects` is empty (tracker cold), use raw YOLO detection directly
- **Before fix:** t=17.818 ball at x=1192 conf=0.633 → IGNORED, held at x=1549
- **After fix:** t=17.818 ball at x=1192 conf=0.633 → USED as ball position
- **Results on 013015:** OFF went from 5 → 3 out of 13 user keyframes. Now detects ball during replay footage.
- **Remaining replay noise:** Sporadic ball detections in zoomed replay angles (x jumps between 203-1300) — some are correct, some are false positives from zoomed-in footage
- **File:** `scripts/portrait-crop/detect_ball.py`

### Step 7: filterTrackedDrift

- **Status:** DONE
- **Impact:** Medium | **Effort:** Low
- Removes `ai_tracked` keyframes at extreme edges (x<180 or x>1132) when both neighbors are in the central zone (250-1062)
- Catches Kalman tracker predictions that drift to wrong areas after losing the ball
- Surgically removes exactly 2 problematic keyframes across 5 test clips:
  - 010300 t=10.4 x=175 (tracked drift to far left)
  - 013015 t=16.5 x=1245 (tracked drift to far right)
- Zero false positives — no changes to the other 3 clips
- 3 new tests added (24 total)
- **File:** `src/lib/editor/simplify.ts`

### Step 8: fillLongGaps + bidirectional interpolation

- **Status:** PARTIAL — fillLongGaps DONE, bidirectional fill DEFERRED
- **fillLongGaps** (DONE): After RDP, if consecutive keyframes are >4s apart, re-insert the best keyframe from pre-RDP data closest to the midpoint. Prevents over-simplification of smooth trajectories. Runs iteratively. Added 1 test (25 total).
- **Bidirectional fill** (DEFERRED): Linear interpolation between gap endpoints was tested but interacts poorly with the simplification pipeline — smooth interpolation causes RDP to over-simplify, and linear paths don't match ballistic ball trajectories (shots on goal follow arcs). Needs quadratic/ballistic interpolation to be useful.
- **010300 t=3-9 false detections**: Ball is far left (goalkick waiting), but YOLO confidently (0.68-0.83) tracks a false object at x=1625 on the right for 6 seconds. This is a detection accuracy issue, not simplification.
- **File:** `src/lib/editor/simplify.ts`

### Step 9: Editor production deployment

- Remove test auto-load and public/editor-test/ files
- Connect to real pipeline (DB + API)
- AWS Batch GPU for cloud inference

## v3 Review Results (2026-03-06)

5-clip validation with user review:

| Clip   | Detection Rate | Keyframes                  | User Corrections | Issues                             |
| ------ | -------------- | -------------------------- | ---------------- | ---------------------------------- |
| 012958 | 85%            | 14                         | 0                | Perfect                            |
| 005036 | —              | 20                         | 1                | Minor end adjustment               |
| 013015 | —              | 19→18 (filterTrackedDrift) | 1                | t=14.5 gap during shot on goal     |
| 010300 | —              | 9→8 (filterTrackedDrift)   | 3                | t=5-10 detection gap               |
| 003615 | 16%            | 15                         | 3                | Opening far-left play not detected |

7 of 8 remaining corrections are detection failures during fast ball movement.

## Research: TrackNetV4 (Investigated, NOT suitable)

- Paper: arXiv 2409.14543, September 2024
- Only tennis/badminton pretrained weights — no soccer
- Downscales to 512x288 — ball becomes sub-pixel in panoramic footage
- TensorFlow-based (our stack is PyTorch/YOLO)
- Would require building a labeled soccer dataset from scratch
- Independent reproduction only achieved 73.4% accuracy (vs 95.2% claimed)

## Research: Industry Landscape (2026-03-06)

| Company              | Approach                                                  | Portrait crop?                    |
| -------------------- | --------------------------------------------------------- | --------------------------------- |
| WSC Sports           | Proprietary "Magicrop", 4M crops/year                     | Yes — closed SaaS                 |
| Pixellot             | DL trained on 5M+ games, 4-second predictive lookahead    | No portrait — live broadcast only |
| Veo                  | Server-side tracking, no portrait feature                 | No                                |
| Spiideo              | AI Autofollow, no portrait feature                        | No                                |
| SmartCrop (Forzasys) | Same YOLO weights as us + interpolation + scene detection | Academic paper, no public code    |

**Key insight:** Neither Veo nor Spiideo offer portrait auto-crop — we're building something they don't have.

**Pixellot's 4-second predictive lookahead** is their key differentiator for live. Since we process offline, we can do full bidirectional interpolation — strictly better than their approach.

**SmartCrop** (MMM 2024, Forzasys/Simula) is the closest published work to our pipeline. Uses the same SportsVision-YOLO weights. Their interpolation through detection gaps is the main technique we should adopt (Step 8).

### Step 9b: False lock detection

- **Status:** DONE
- **Impact:** High | **Effort:** Low
- Post-processing step in detect_ball.py: detects "jump then static" pattern
- When ball jumps >500px and subsequent detections have stddev <50px for >2 seconds, reverts to hold at pre-jump position
- Directly fixes 010300 goalkick false positive: YOLO tracked a false target at x=1625 for 6 seconds while real ball was far left
- Results: user corrections at t=5.1 and t=7.0 now within 28-31px of pipeline output (was 148-165px)
- Zero false positives across other 4 test clips
- **File:** `scripts/portrait-crop/detect_ball.py`

### Future improvements (not prioritized)

- **Bidirectional gap interpolation with ballistic curves** — use quadratic/parabolic path instead of linear for shot-on-goal trajectories
- SoccerNet v3 YOLO training data — fine-tune Forzasys weights on additional labeled soccer data
- 1/3rd rule framing — offset ball 1/3 from crop edge in direction of play (professional camera technique)
- Velocity-limited panning — Vsafe/Vunsafe/Vcritic thresholds (from GOTO50 open-source project)

## Test Clips

- `001159-goal.mp4` — Good first-half detection, some jitter mid-clip
- `013015-goal.mp4` — Ball lost at t=13s, 9-second detection gap during celebration
- 5-clip test set in `public/editor-test/` with raw detections in `/tmp/`
- More clips in `/Users/karimfawaz/Desktop/PLAYBACK/goal backlog/`

## Key Parameters (current)

| Parameter               | Value | Purpose                                                 |
| ----------------------- | ----- | ------------------------------------------------------- |
| TRACKER_HIT_COUNTER_MAX | 50    | Kalman prediction survives 5s without detection (10fps) |
| MIN_BALL_CONFIDENCE     | 0.35  | Filters false positive ball detections                  |
| RDP_TOLERANCE           | 90px  | Simplification tolerance                                |
| SCENE_CUT_THRESHOLD     | 300px | Jump threshold for scene cut detection                  |
| SCENE_CUT_MARGIN        | 1.2s  | Remove AI keyframes near scene cuts                     |
| NEAR_DUPLICATE_TIME     | 0.5s  | Merge keyframes closer than this in time+position       |
| ZIGZAG_THRESHOLD        | 100px | Direction reversal filter                               |
| R (Kalman)              | 4.0   | Measurement noise                                       |
| Q (Kalman)              | 0.8   | Process noise                                           |

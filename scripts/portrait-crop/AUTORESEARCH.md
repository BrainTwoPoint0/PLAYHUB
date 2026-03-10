# Portrait Crop Autoresearch

## Goal

Maximize the eval score (0–1) for automatic portrait crop of Spiideo 4K panoramic soccer footage.

**Current baseline: 0.540** (10 clips, 47 correct / 20 missing / 20 extra, 67px avg error)

## How the Pipeline Works

1. **Detection** (`detect_ball.py`): YOLOv8m + Norfair Kalman tracker → raw ball positions (x,y per frame)
2. **Conversion** (`types.ts:detectionsToCropKeyframes`): Ball x → crop left edge (center ball in 608px crop window within 1920px source)
3. **Simplification** (`simplify.ts:simplifyCropKeyframes`): 16-step pipeline reduces ~100+ raw keyframes to ~6-12 smooth ones
4. **Scoring** (`score.ts`): Greedy matching against human-reviewed ground truth (TIME_TOLERANCE=1.0s, POSITION_TOLERANCE=80px)

## Running the Eval

```bash
cd PLAYHUB/scripts/portrait-crop

# Full pipeline (needs GPU or ~60s/clip on CPU):
npx tsx eval.ts

# With Modal GPU (~5s/clip):
npx tsx eval.ts --modal

# Skip detection, only re-run simplify+score (instant):
npx tsx eval.ts --skip-detect
```

The script prints a single number to stdout (the score). All other output goes to stderr.

## Tunable Parameters

### Detection (detect_ball.py)

| Parameter                       | Current        | Description                                                   |
| ------------------------------- | -------------- | ------------------------------------------------------------- |
| `output_fps`                    | 5.0            | Frames sampled per second                                     |
| `imgsz` (line 171)              | 1280           | YOLO inference resolution                                     |
| `SCENE_CHANGE_THRESHOLD`        | 0.4            | Histogram correlation below this = scene change               |
| `MAX_BALL_AREA`                 | 3000           | Max bounding box area for ball                                |
| `MIN_BALL_AREA`                 | 20             | Min bounding box area for ball                                |
| `BALL_CLUSTER_BOOST_DIST`       | 400            | Distance within which ball near cluster gets confidence boost |
| `MIN_BALL_CONFIDENCE`           | 0.35           | Minimum confidence to accept a ball detection                 |
| `TRACKER_DISTANCE_THRESHOLD`    | 200            | Norfair max match distance                                    |
| `TRACKER_HIT_COUNTER_MAX`       | 50             | Frames tracker survives without detection                     |
| `TRACKER_INIT_DELAY`            | 2              | Detections needed to confirm track                            |
| `R` (Kalman measurement noise)  | 4.0            | Lower = trust detections more                                 |
| `Q` (Kalman process noise)      | 0.8            | Higher = allow faster direction changes                       |
| SAHI `slice_height/width`       | 320            | Tile size for sliced inference                                |
| SAHI `overlap_*_ratio`          | 0.2            | Overlap between tiles                                         |
| SAHI frequency                  | every 3rd miss | When to run SAHI fallback                                     |
| `MIN_VELOCITY` (ballistic fill) | 300            | px/s threshold for ballistic extrapolation                    |
| `MAX_EXTRAP_TIME`               | 2.0            | Max seconds to extrapolate                                    |
| `DECEL_FACTOR`                  | 0.85           | Per-frame velocity decay                                      |
| Bidir interp `MAX_GAP_TIME`     | 3.0            | Max gap to interpolate across                                 |
| Bidir interp `MAX_GAP_DISTANCE` | 300            | Max px distance to interpolate                                |
| IQR multiplier                  | 2.0            | Outlier rejection sensitivity                                 |
| Early confidence gate           | 0.5            | Min confidence for first 5 detections                         |

### Simplification (simplify.ts)

| Parameter                            | Current | Description                                        |
| ------------------------------------ | ------- | -------------------------------------------------- |
| `SCENE_CUT_THRESHOLD`                | 300     | px jump = scene cut                                |
| `SCENE_CUT_WINDOW`                   | 0.4     | seconds — jump must happen within this             |
| `SCENE_CUT_MARGIN`                   | 1.2     | seconds — remove AI keyframes near cuts            |
| `OUTLIER_CONF_THRESHOLD`             | 0.4     | Below this = suspect outlier                       |
| `OUTLIER_JUMP_THRESHOLD`             | 200     | px deviation from neighbors = outlier              |
| `RDP_TOLERANCE`                      | 55      | px — Ramer-Douglas-Peucker simplification          |
| `ZIGZAG_THRESHOLD`                   | 100     | px — direction reversals smaller than this removed |
| `NEAR_DUPLICATE_TIME`                | 0.5     | seconds — merge points closer than this            |
| `NEAR_DUPLICATE_PX`                  | 80      | px — if also within this distance                  |
| `DEAD_ZONE_PX`                       | 30      | px — min shift to create new keyframe              |
| `HOLD_PAN_VELOCITY`                  | 300     | px/s — threshold for inserting hold keyframes      |
| `preserveHighVelocity.minGapSeconds` | 2.0     | Minimum gap to check for velocity preservation     |
| `preserveHighVelocity.minVelocity`   | 150     | px/s — movement to preserve                        |
| `fillLongGaps.MAX_GAP`               | 4.0     | seconds — re-insert if gap exceeds this            |

### Scoring (not tunable — these define "correct")

- TIME_TOLERANCE = 1.0s
- POSITION_TOLERANCE = 80px

## Files

- `detect_ball.py` — detection (Python)
- `../../src/lib/editor/simplify.ts` — simplification (TypeScript)
- `../../src/lib/editor/types.ts` — conversion functions
- `score.ts` — standalone scorer (for manual testing)
- `eval.ts` — full eval harness
- `~/Desktop/review3/*_keyframes.json` — ground truth (10 clips)
- `../../public/editor-test/*.mp4` — test videos (11 clips, 10 with ground truth)

## Known Issues (per-clip analysis)

- **002331**: Score 0.125 — worst performer, only 1/8 correct. Short clip, camera far from action.
- **015432**: Score 0.286 — high avg error (230px), crop tracking wrong area
- **003615**: Score 0.429 — 3/6 correct, decent but misses some
- **010300**: Score 0.800 — best performer, long clip with clear ball tracking
- **005036**: Score 0.714 — high avg error (203px) despite 5/7 correct

## Running Sweeps

```bash
# Simplification parameter sweep (instant, uses cached detections)
npx tsx scripts/portrait-crop/sweep.ts

# Detection parameter sweep (slow — re-runs detect_ball.py per combo)
npx tsx scripts/portrait-crop/sweep-detect.ts                    # 3 worst clips
npx tsx scripts/portrait-crop/sweep-detect.ts --clips all        # All clips
npx tsx scripts/portrait-crop/sweep-detect.ts --clips 013015-goal,015432-goal
```

## Iteration Strategy

1. Start with simplification parameters (`--skip-detect`) since detection is slow
2. Focus on reducing "extra" keyframes (20 total) — these are unnecessary crop changes
3. Focus on reducing "missing" keyframes (20 total) — real movements being simplified away
4. Then iterate on detection parameters (`sweep-detect.ts` — runs locally, ~60s/clip/combo)
5. Worst clips (002331, 015432) may need fundamentally different approaches

## Detection Parameters (sweep-detect.ts)

All tunable via `--params '{"KEY": value}'` on detect_ball.py:

- `MIN_BALL_CONFIDENCE` (0.35) — minimum confidence to accept ball detection
- `IQR_MULTIPLIER` (2.0) — outlier rejection sensitivity
- `KALMAN_R` (4.0) — measurement noise (lower = trust detections more)
- `KALMAN_Q` (0.8) — process noise (higher = allow faster direction changes)
- `BIDIR_MAX_GAP_TIME` (3.0) — max seconds to interpolate across
- `BIDIR_MAX_GAP_DISTANCE` (300) — max px to interpolate across
- `EARLY_CONF_GATE` (0.5) — min confidence for first 5 detections
- `TRACKER_HIT_COUNTER_MAX` (50) — frames tracker survives without detection

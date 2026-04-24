# Portrait Crop — Eval Dataset

The gold-standard dataset that gates every change to the detection and smoothing pipeline. Anything merged that regresses metrics on the frozen holdout blocks the branch.

## Structure

```
eval-dataset/
  clips/              1080p Veo goal clips (.mp4)
  labels/             Per-clip JSON ground truth (see schema below)
  manifest.json       Clip metadata + leak audit
  results/            Eval runs (git-sha keyed JSON) — gitignored
```

## Target composition (15 clips total)

| Type            | Count | Notes                                                                 |
| --------------- | ----- | --------------------------------------------------------------------- |
| Goals           | 6     | The primary use case — fast transitions, ball often airborne          |
| Passage of play | 4     | Sustained attacking build-up, moderate ball speed                     |
| Edge cases      | 3     | 1 keeper long ball, 1 set piece, 1 corner with crowd in front of ball |
| "Cursed"        | 2     | 1 lens-flare / low-light, 1 two-ball scenario (warm-up ball visible)  |

Of these, **1 clip is the "hero"**: densely labeled every frame. The other 14 are labeled every 5th frame.

## Leak audit (MANDATORY)

Before adding a clip: confirm it was NOT in the training set of any checkpoint under evaluation.

- `yolov8m_forzasys_soccer.pt` — Forzasys training set (SoccerNet + Norwegian Eliteserien broadcast). Clips from those sources are NOT eligible.
- `yolov8m_veo_finetuned.pt` — if used, document every clip ID that went into fine-tuning in `manifest.json`. Eval clips must not overlap.
- Every future fine-tune must declare its training clip IDs into `manifest.json` so this audit stays correct over time.

Add the training provenance to each manifest entry's `leak_audit` field.

## Label format

`labels/<clip_id>.json`:

```json
{
  "clip_id": "veo_012958_goal",
  "dense": false,
  "label_fps": 5,
  "source_fps": 30,
  "frames": [
    { "frame": 0, "t": 0.0, "ball": { "x": 850, "y": 420, "visible": true } },
    { "frame": 6, "t": 0.2, "ball": { "x": 870, "y": 430, "visible": true } },
    { "frame": 12, "t": 0.4, "ball": { "visible": false } }
  ]
}
```

- `ball.x`, `ball.y` — centroid in pixels, source resolution (1920×1080)
- `ball.visible=false` — ball is not visible (occluded, off-frame, kicked out). No x/y.
- `label_fps=5` for sparse, original video fps for the hero dense clip
- Labels map to raw source frames by `frame` index, not clock time — guards against re-encode fps drift

## CVAT self-hosted — quickstart

Only the canonical `linear` bounding-box task needed. No interpolation tricks.

```bash
# One-time setup
git clone https://github.com/cvat-ai/cvat ~/cvat
cd ~/cvat
export CVAT_HOST=localhost
docker compose up -d
docker exec -it cvat_server bash -ic "python3 ~/manage.py createsuperuser"
# Open http://localhost:8080, log in.
```

Workflow per clip:

1. Upload clip to CVAT (Task → Create → add video → Label: `ball`, type: `rectangle`)
2. Step through at 5fps (or full fps for hero clip): draw bbox around ball, tag `visible=false` for occluded frames
3. Export as "CVAT for video 1.1" → convert to our schema with `scripts/portrait-crop/eval-dataset/cvat-to-labels.ts` (TBD — will scaffold on first use)

Time budget: ~30-40 min per sparse clip, ~2-3h for the hero clip. ~8-12h total.

## Running eval against this dataset

```bash
# Modal (fast, needs NEXT_PUBLIC_MODAL_CROP_URL)
cd scripts/portrait-crop
npx tsx eval.ts --modal --dataset eval-dataset

# Local (slow on CPU, fine for --skip-detect iterations)
npx tsx eval.ts --skip-detect --dataset eval-dataset
```

Output goes to `results/<git-sha>.json`. Diff against the regression pin (`results/pin.json`) to see deltas per clip + per metric.

# Eval results

`pin.json` is tracked in git — the frozen regression baseline. Every other `<sha>.json` is gitignored (per-run output).

Gate: any PR whose `<sha>.json` shows a clip in `pin.json.clip_ids` regress on detection_coverage, ball_in_crop_pct, mean_accel_abs, p95_accel_abs, or max_accel_abs by more than 5% must be re-justified before merge. Regressions on NON-pinned clips are informational only — those are the clips we want to improve.

Compare with:
```bash
node scripts/portrait-crop/eval-dataset/compare-to-pin.mjs eval-dataset/results/<sha>.json
```
(script TBD — first run will scaffold it if not present)

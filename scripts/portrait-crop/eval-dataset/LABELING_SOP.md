# Eval-Dataset Labeling Sprint — Step-by-Step

This is the runbook for the **8–12 hour dense ball labeling sprint** that produces ground truth for portrait-crop eval and supervised data for goal-detection (Phase 2 of `docs/goal-detection-plan.md`).

Everything downstream of this work depends on the labels being honest pixel coordinates against source-frame resolution.

---

## 0 · One-time setup

You need three things running locally:

1. **ffmpeg** (already installed if `ffprobe` works)
2. **Docker** (for CVAT)
3. **CVAT self-hosted**:
   ```bash
   git clone https://github.com/cvat-ai/cvat ~/cvat
   cd ~/cvat
   export CVAT_HOST=localhost
   docker compose up -d
   docker exec -it cvat_server bash -ic "python3 ~/manage.py createsuperuser"
   # Open http://localhost:8080, log in.
   ```

If CVAT is already up: `docker compose ps` in `~/cvat` should show running services.

---

## 1 · Download the 13 candidate clips

From `PLAYHUB/`:

```bash
npx tsx scripts/portrait-crop/eval-dataset/download-clips.ts
```

This pulls every clip listed in `manifest.json` (except the 2 `TBD_KARIM_PICKS_DURING_SPRINT` placeholders) into `eval-dataset/clips/`. Idempotent — re-running skips clips already on disk. Veo CDN URLs are public; no auth needed.

Verify:

```bash
ls -la scripts/portrait-crop/eval-dataset/clips/
# Should show 13 .mp4 files
```

---

## 2 · Roboflow leak audit (5 min, do BEFORE labeling)

Three set-piece clips (`veo_20250920_cfa_u9_corner_01`, `veo_20250927_cfa_u9_freekick_01`, `veo_20240918_goalkick_01`) predate the `yolov8m_veo_finetuned.pt` fine-tune. Verify each highlight_id is NOT in the Roboflow training set:

1. Open https://app.roboflow.com and go to `karims-workspace-wgkny/veo-ball-detection` v1
2. For each suspect clip, check the image filenames or source-frame metadata for `highlight_id`
3. If you find overlap, swap the clip:
   - For corner: re-run the cache query for any other corner-tagged highlight; only 1 exists currently — may need to remove that bucket entirely
   - For freekick: 1 alternative exists in cache (id `e747da0d-fea9-4b6b-b55e-22ebe1b6acd1`)
   - For goal-kick: 15 alternatives — easiest to swap

If you swap, update `manifest.json` (the `leak_audit.notes` and the `notes` URL).

---

## 3 · Pick the 2 cursed clips

While clips download, scrub through your Veo academy library (or `~/Desktop/review3/` legacy clips) for visually-interesting failures:

- **Lens flare / low-light / sunset** — anything where ball-vs-background contrast is bad
- **Two-ball scenario** — warm-up ball or coaching equipment visible alongside the match ball

Once picked, place the file in `eval-dataset/clips/` named per the manifest (`CURSED_01_lens_flare.mp4`, `CURSED_02_two_ball.mp4`) and update the manifest `source` field from `TBD_KARIM_PICKS_DURING_SPRINT` to the actual provenance.

Skip-if-no-good-candidate is acceptable — drop to 13 labeled clips rather than mislabel.

---

## 4 · Label in CVAT (the actual sprint, 8–12h)

For each clip:

### 4a. Create the task

- CVAT → **Tasks** → **Create new task**
- Name: same as the clip's `id` field in manifest.json (e.g. `veo_20260502_goal_01`)
- Upload the `.mp4` from `eval-dataset/clips/`
- Labels: add ONE label called exactly `ball` (lowercase), type `rectangle`

### 4b. Annotate

**Sparse clips** (label_fps=5; 14 of the 15):

- Step through video at the cadence that matches source_fps / 5 (Veo is 25fps → label every 5th frame; CVAT shortcut `D` advances one frame)
- Draw a tight bbox around the ball center; CVAT will interpolate between keyframes
- When ball is off-frame or fully occluded, mark the box as `outside` (CVAT keyboard shortcut `O`)
- Don't bother re-drawing every frame — CVAT's linear interpolation between your keyframes is what `--dense=false` ignores anyway

**Hero clip** (label_fps=25; `veo_20260502_goal_01`):

- Label EVERY frame. Slow and tedious — budget 2–3h.
- Same `ball` label, same `outside` convention
- Worth it because the hero clip drives the absolute-truth recall@p0.9 metric

### 4c. Conventions

- **Ball center**, not goalpost or shadow. If the ball is partially behind a player, label the visible part's center; that's the "where the ball actually is."
- **Tight bbox**, not whole-region — the eval's `RECALL_MATCH_RADIUS = 60px` tolerates moderate centroid noise but a sloppy bbox shifts the center.
- **Occluded ≠ off-frame**. CVAT has `outside` (visibility=false in our schema) and `occluded` (still visible but covered). Per our schema we only care about `outside` → `visible:false`; `occluded` boxes still get coordinates.

### 4d. Export

- CVAT task → **Actions** → **Export task dataset** → format **CVAT for video 1.1**
- Download the `.zip`; the relevant file is `annotations.xml` inside it
- Save as `eval-dataset/cvat-exports/<clip_id>.xml` (create this dir; ignore in git is fine)

---

## 5 · Convert CVAT → labels JSON

For each clip:

```bash
cd PLAYHUB
npx tsx scripts/portrait-crop/eval-dataset/cvat-to-labels.ts \
  --cvat scripts/portrait-crop/eval-dataset/cvat-exports/veo_20260502_goal_01.xml \
  --video scripts/portrait-crop/eval-dataset/clips/veo_20260502_goal_01.mp4 \
  --clip-id veo_20260502_goal_01 \
  --out scripts/portrait-crop/eval-dataset/labels/veo_20260502_goal_01.json \
  --dense    # only for the hero clip; omit for sparse clips
```

The script:

- Probes the video for actual source_fps (Veo is 25fps usually)
- Parses every `<track label="ball">` block in the CVAT XML
- Keeps only `keyframe="1"` boxes for sparse (so CVAT's interpolated boxes don't pollute GT)
- Keeps every box for `--dense`
- Maps `outside="1"` → `{visible: false}`
- Writes the eval-dataset label JSON in our schema

Spot-check the output:

```bash
jq '.frames | length, .frames[0], .frames[-1]' scripts/portrait-crop/eval-dataset/labels/veo_20260502_goal_01.json
```

You should see ~125 frames for sparse (25s × 5fps), ~625 frames for the hero clip (25s × 25fps).

---

## 6 · Update manifest.json frozen_holdout

Pick 3 clips that span the diversity range (1 goal, 1 passage, 1 edge or cursed) and add their IDs to `frozen_holdout` in `manifest.json`. These become the regression-pin clips — anything that degrades on them blocks the branch.

Suggested initial holdout:

- `veo_20260502_goal_01` (hero clip, dense GT)
- `veo_20260506_hb_cupfinal_passage_01`
- whichever cursed clip lands

---

## 7 · Re-pin the eval baseline

With dense GT now in place, the existing pin (`results/pin.json`) is stale because `ball_in_crop_pct` was measured against _detected_ positions, not GT. Re-run eval:

```bash
cd PLAYHUB/scripts/portrait-crop
npx tsx eval.ts --skip-detect --dataset eval-dataset
```

Then write a new `eval-dataset/results/pin.json` with the honest numbers, noting in `rationale` that this is the first GT-backed pin. Future regressions are measured against this.

If `--skip-detect` works but you want the full detection run too, drop `--skip-detect` (slow on CPU; uses cached `_raw.json` if present).

---

## 8 · Done — commit

```bash
git add scripts/portrait-crop/eval-dataset/labels/
git add scripts/portrait-crop/eval-dataset/manifest.json
git add scripts/portrait-crop/eval-dataset/results/pin.json
git commit -m "eval-dataset: dense ball ground truth for 15 clips, re-pin"
```

The `clips/` directory itself should stay gitignored (large binaries, mirrored from manifest URLs).

---

## Sanity-check checklist (do before claiming done)

- [ ] 13–15 `.mp4` files in `clips/`
- [ ] Matching `.json` files in `labels/` for every video that was actually labeled
- [ ] Each label file has `clip_id`, `label_fps`, `source_fps`, `frames` (non-empty)
- [ ] `manifest.json` `frozen_holdout` has 3 clip IDs
- [ ] `eval.ts --skip-detect --dataset eval-dataset` runs end-to-end without errors
- [ ] `results/<sha>.json` has non-null `detection_recall_at_p90` for at least the GT-labeled clips
- [ ] New `results/pin.json` written, rationale dated, prior pin preserved in `previous_pin`

## Budget reality-check

- 14 sparse clips × ~30–40 min each = ~7–9h
- 1 hero clip × 2–3h = ~2–3h
- Setup + leak audit + cursed picks + eval re-pin = ~1–2h
- **Total: 10–14h.** The README's 8–12h estimate is achievable but tight; plan two sessions.

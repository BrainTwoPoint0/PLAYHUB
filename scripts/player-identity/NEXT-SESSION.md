# Next session — Phase 2: turn the Veo corpus into labelled crops

Paste the block below. Everything it needs is already captured and running.

---

## The prompt

> Phase 2 of the Veo jersey corpus. Read `PLAYHUB/scripts/player-identity/NEXT-SESSION.md`
> first, then `veo-automations/VEO-API-REFERENCE.md` §"Player Moments" and the
> 2026-07-15 sections of the workspace `CLAUDE.md`.
>
> Goal: turn captured Veo panoramas + jersey labels into `(crop, jersey#)` training
> pairs for OUR jersey model. **Measure before building — this workstream falsified
> six confident inferences in one day, including four of mine.**
>
> Start with the gate, not the build: **does `solve_h.py` converge on Veo's
> geometry at all?** It was written for Spiideo's single panorama; Veo's is two
> 4K lenses. That is a research question, not a coding task. If it doesn't
> converge, stop and re-plan — do not force it.

---

## State (all live, nothing to set up)

| | |
|---|---|
| Captures | `playhub_veo_captures`, draining ~78/day, **oldest-first** (deadline queue) |
| Banked | ~50 GB and growing; `veo-panoramas/{match_slug}/` in `playhub-recordings-eu-west-2` |
| Per match | `panorama.ts` (2× 3840×2160 HEVC, ~6-9 GB), `tracking.json` (labels), `match-events.json`, `alignment.veo`, `camera_directions.det` |
| Labels | **97.4% jersey-labelled**, 2.5 Hz, metric on a **105×68** pitch |
| Deadline | Veo Glaciers the `.ts` at **~150d**. Confirmed: a 2026-02-16 match was already gone. |

`tracking.json` carries its own schema. Columns:
`[trackId, roleTeam, xNorm, yNorm, JERSEY, ?, speedKmh, team]`
- `roleTeam`: 0=left GK, 1=left outfield, 2=right GK, 3=right outfield, **6=ball**
- `JERSEY`: **−1 = not read**
- **`x_m = (xNorm − 0.5) × 105`, `y_m = (yNorm − 0.5) × 68`** — fitted at 100% match
- col5 unidentified (didn't need it)

## The plan

**Phase 2a — THE GATE (~2h). Do not skip.**
`solve_h.py` (`infrastructure/batch/player-tracklets/`) is production for Spiideo and its parts apply unchanged: `pitch_rect_metric`, `time_paired_sets`, `evaluate`, the per-region/held-out gates, the seed-rotation sweep. But Veo's panorama is **two lenses**, so:
- Solve **per lens**, not on the stacked frame. Extract with `-map 0:v:0` / `0:v:1`.
- YOLO the frame (`scripts/portrait-crop/yolov8x.pt`, tiled — small players die in a 640 letterbox), take foot points, Hungarian ICP against Veo's metric positions at the same instant.
- **Gate on `evaluate()`'s held-out rate + per-region signed bias**, exactly as the tracklets job does. Correct H ≈ 0.4-0.6 held-out rate; wrong H ≈ 0.01.
- `alignment.veo` (`{"calibration_version":"6.2","lens_left2camera":"..."}`) is an **independent cross-check** on our H — not a dependency. If our H and their calibration disagree, that's a finding.

**If it converges → Phase 2b.** If it doesn't, stop. Options then: use their calibration directly (build-time dependency, acceptable — the trained model is still ours), or reconsider.

**Phase 2b — crops.**
- **Build from the CLOSEST frames of each track.** Veo's 97.4% is *propagated along 65s tracks*, so a far-away crop carries a confident label the pixels can't support. Training on those teaches noise. Measured: median player 83px (digits ~12px, too small), **p75 151px → ~23px digits, usable**. Filter on crop size, not on the label.
- Free GT for validation: chain id ⇒ same player.
- Sanity-gate with the discipline that worked all day: a **null** (does a random *other* jersey's crop score as well?) and a held-out **venue/domain** — never held-out samples. See README §4 and `fit_correction2.py`'s spatial-leak lesson.

## Hard-won gotchas

- **`ffprobe` the artifact; don't do trigonometry on an assumed projection.** The 2048×2048 "panorama" is two lenses *stacked* (2048×1024 each), not a 180° equirect — my px/° estimate was 2× wrong.
- **`player-moments` is FILTERED** (~59% of frames, ~6.8s runs). `player-tracking` is the real thing (continuous, 65.6s tracks). Never measure with the former.
- **`periods` come from `step-events`'s `match_ongoing`** — never invent a window. An invented one returns **200** and silently merges both halves, and **teams swap ends at half time**, so `side` flips meaning mid-track.
- **NEVER run a bare `terraform apply`** in this workspace — pre-existing drift would replace the ball-detection GPU CE and delete `aws_iam_role.spot_fleet` (hardcoded ARN ⇒ no dependency edge warns you). Always `-target`.
- **Veo = labeller, never a runtime dependency.** Production must never call `/api/mes/v2/`.
- Data protection: Karim's position is **settled** ("PLAYBACK owns the footage and can do whatever it wants with it"). Don't re-raise it.

## Worth doing while in here (cheap now, impossible at 300 matches)

- **Prefix-driven deletion** (`veo-panoramas/{slug}/`) — the DB provably under-reports what's in S3, so a key-driven purge misses objects.
- **Corpus manifest** — which capture fed which model version.
- **S3 lifecycle**: `GLACIER_IR` at 60d **filtered to objects >100MB** so the labels stay hot. ~2.2 TB Standard ≈ $52/mo → ~$11/mo.
- The 5-sweep-old open item: a CloudWatch alarm on `"submit failed for"` → `sync_alerts`. Cheap, covers all classes, and this workstream is the one where silence costs data.

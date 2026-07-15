# Player identity / spotlight accuracy — research record (2026-07-15)

Investigation of two defects Karim reported after watching the spotlight on
the pilot game (`d9fee1fc`, Nazwa, 56 min):

1. rings drift off players toward the pitch **corners**
2. tracking **loses a player when they pass behind another**

Both were measured. The headline: **(1) is a real ~1 m effect at the pitch
edges caused by non-planarity, and (2) is the actual product blocker — and
appearance-based re-ID cannot fix it.**

These scripts are the record + the reusable method. They expect a local cache
(`cache/trk_items.json`, `cache/det_*.json`, `mesh/`, `prod-solve.json`)
built the way `extract_crops.py` / `produced_overlay.py` do it; they are
research tools, not production code (same status as `scripts/follow-re/`).

---

## 1. Produced-video overlay — `produced_overlay.py`

Renders spotlight rings onto Spiideo's **produced auto-follow mp4** by
projecting tracklet pan/tilt through the aim-track camera pose.

Camera model (verified symbolically against `VirtualPanoramaPlayer.tsx`):

```
dir(pan,tilt) = (-sin pan cos tilt, -sin tilt, cos pan cos tilt)
camera at origin looking along dir(aim_pan, aim_tilt), world up = (0,-1,0),
three.js lookAt basis, PerspectiveCamera.fov = VERTICAL degrees
```

**Validated** by also projecting Spiideo's own detections (green) — they land
on players, so the aim-track + projection chain is correct.

### ⚠️ This overlay is NOT accurate enough to judge the spotlight by

`time_align.py` + `fov_diag.py` quantified its own error against YOLO people
detected directly in the produced frames:

| | |
|---|---|
| best time offset | **dt = 0** (no time bug; ±3 s scan only worsens) |
| error vs fov | 43 px @ fov 15-25° → **72 px @ fov 45-70°** (corr +0.30) |
| error vs frame edge | 40 px centre → **96 px at r>0.75** (corr +0.44) |
| floor (narrow fov, central) | ~40 px |

Spiideo rendered the Play mp4 with **their** projection; this overlay assumes
a pinhole. It degrades exactly where a pinhole breaks down.
**The Explore player is immune** — it projects the ring through the *same*
camera that draws the pixels, so it is self-consistent by construction.
Only judge the artifact on raw frames (`tracklets-validate.png`) or in Explore.

## 2. The corner error — `residual_field.py`, `field_shape.py`

Measured in **metres on the grass** (rayn residual → metric via H⁻¹), on an
unbiased loose-gate (0.06) correspondence set. *Note: the 0.03 product gate
truncates exactly where error is worst, so it understates — always diagnose
at a loose gate.*

```
far end  y=-27.9 : |d| ~1.15 m,  dy = +0.79..+1.25   (points INWARD)
centre   y~0     : |d| ~0.05 m                        (essentially perfect)
near end y=+26.1 : |d| ~0.79 m,  dy = -0.69..-1.64   (points INWARD)
```

- **radial/isotropic**, not a uniform shift (`|mean unit vector| = 0.185`)
- vectors align to a nadir near the touchline/halfway (where the mast is) to
  within ~15-20°
- **NOT the lens/mesh**: `corr(|d|, |rayn|) = +0.006`, flat across every
  quartile (0.27/0.23/0.22/0.21 m). Clean null — the calibration is not the
  culprit (consistent with the "calibration is at the data floor" finding).

**Why this proves non-planarity:** a homography maps any *flat* plane exactly
— tilt and height are absorbed for free. A systematic residual is only
possible if the surface genuinely isn't planar. Candidate mechanisms (NOT
separable from one game): pitch camber, a range-dependent bias in Spiideo's
tracker, or foot-point bias in the detections at long range.
`height_model.py` attempts an explicit crown fit — **it did not converge**
(nadir ran to 850 m); do not claim "the pitch is crowned" as established.

### Correction attempts — `fit_correction2.py` — NOT SHIPPED

A polynomial residual field looked like it halved the corner error under a
30 s-block-alternating split (0.795 → 0.369 m at the ends). **That split
leaks spatially** — fit and val contain the same pitch locations. Under a
strict *whole-window-excluded* test the corner median did **not** improve
(1.18 → 1.25 m; only the within-0.30 m fraction rose 2% → 12%).

> **Rule:** when fit and eval can touch the same region of the underlying
> domain, "held-out" is a lie. Hold out the DOMAIN (a whole window / venue /
> corner), not the samples. This is the same class of mistake as the eval
> gate that let the sheared H ship twice.

Also note `fit_correction2.py` scores on a **fixed** correspondence set:
re-matching after correcting makes the median self-selecting (more far-field
points enter the gate and drag it up even as accuracy improves).

Centre-of-pitch error is **0.22 m** = the tracker + detection noise floor.
No registration fix can go below it.

## 3. Identity — `extract_crops.py`, `reid_bench.py` — **the real blocker**

Chain statistics on the pilot (56 min, ~16 players):

| | |
|---|---|
| chains | **2094** |
| median identity duration | **14 s** (max 366 s; only 4 > 300 s) |
| total tracked player-time | **101% of ideal** |
| chain deaths while another player is <1.5° away | **59%** (vs 36% at random; median separation at death 1.11° vs 3.41°) |

**We see every player the whole match; we just cannot keep their name.**
Detection is solved and free. Re-identification is not.

### The benchmark (free ground truth)

Within a chain Spiideo held identity → two crops from the same chain **are**
the same player. 844 crops, 5 windows across the match, **median crop 117 px
tall (99% ≥64 px)** — resolution is *not* the limit (Market-1501 uses 128×64).

Rank-1, "pick the right player out of the field at t+gap" (chance ≈12%):

| gap | POSITION (stitcher today) | COLOUR | ResNet50 | DINOv2 |
|-----|--------------------------|--------|----------|--------|
| 2 s | **91.8%** | 56.2% | 52.6% | 56.1% |
| 6 s | 74.6% | 36.3% | 36.3% | 43.0% |
| 10 s | 54.8% | 35.5% | 38.6% | 42.1% |

**HARD subset (position picked WRONG — the occlusion breaks): appearance
rescues only ~20%.** Naive position-gate + appearance-rank fusion was *worse*
than position alone.

### Why — the ceiling is the kit

Stratified by team (k-means on colour, per chain):

| gap | mixed field (chance 12%) | same-team only (chance 25%) |
|-----|--------------------------|-----------------------------|
| 2 s | COLOUR 56.2% / DINOv2 56.1% | COLOUR 62.5% / DINOv2 **66.4%** |
| 10 s | COLOUR 35.5% / DINOv2 42.1% | COLOUR 43.4% / DINOv2 **53.0%** |

Lift over chance: **3.5-4.7× in a mixed field, only 2.1-2.6× among
teammates**. Appearance reads the **kit**, not the player. DINOv2 beats
colour within-team (real per-person signal in body shape/hair) but would
still pick the wrong teammate ~half the time at 10 s — worse than honestly
reporting "lost" for a follow-my-kid product.

### Verdict

- **Do not build generic appearance re-ID.** Measured ceiling; the ceiling is
  the kit. `supervision` (Roboflow) is a utility lib (annotators + ByteTrack),
  not a detector — and detection isn't the bottleneck (101% coverage, free).
  ByteTrack associates on motion + IoU, the exact signal that vanishes in an
  occlusion.
- **Jersey number is the unlock** — and it is precisely what **both** Veo and
  Spiideo do. The Perform recon found Spiideo's identity comes from
  jersey-numbered **event tags**, not from their tracking stream. Neither
  competitor solved this with appearance; they sidestepped it. → Phase 5 kit
  detection; CFA's 11,366 team-labelled highlights are the corpus.
- **Narrow cheap win first:** `build_track.stitch`'s ambiguity gate *refuses*
  bridges precisely at occlusions (by design — "no-follow beats wrong-follow"),
  compounding Spiideo's breaks. There it is a **2-way** choice, not 1-in-8 —
  a far easier problem than full re-ID, and where the ~20% lives.
- **Karim's photo-glimpse "find yourself" picker** offloads identity to the
  *human*, who can recognise themselves at 117 px where every embedding
  fails. But it is downstream of chain length: at a 14 s median a user would
  identify themselves ~240× per match. Fix identity duration first.

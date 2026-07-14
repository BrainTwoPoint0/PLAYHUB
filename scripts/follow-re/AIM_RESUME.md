# Auto-Follow — RESUME / Handoff (2026-07-12)

## 0r. NON-PARAMETRIC PROJECT STARTED — Phase 0 DECODED Spiideo's mesh as SYNTHETIC (arbiter retracted), Phase A re-scoped, Phase B next (2026-07-13 late night)

Karim greenlit the non-parametric residual-correction project (plan:
`~/.claude/plans/wobbly-launching-backus.md` — prior-art: mrcal splined models, RBF/B-spline
field, Devernay-Faugeras for the line-driven variant). Phase 0 (decode their mesh) COMPLETED
same night with a decisive negative:

- ★ **Spiideo's fetched Nazwa "calibration" mesh is SYNTHETIC — zero lens information.** It
  decodes EXACTLY (median 0.1% rel err) as a pure function of scene.json's window: vertex
  layout `[posX, posY, gridU, gridV, alpha]` where (gridU,gridV) is a REGULAR 360×180 lattice,
  `posX = tan((gridU−½)·180°)`, `posY = tan((gridV−½)·90°)/cos((gridU−½)·180°)` — a gnomonic of
  WINDOW-FRACTION angles (the window's ±122.75°×118.77° anisotropically squished into
  ±90°×±45°). Texture coords = the window-fraction lattice itself ⇒ the mesh textures a
  **pre-rectified window-equirect video**, not the raw fisheye. Their LENS calibration lives
  upstream (raw→equirect stage — wasm/server LUT, NOT in the variants; only 1 variant exists on
  the VP stream and autofollow_render_segments carries the same synthetic mesh). Eliminated en
  route (probe pipeline validated 0.00 mrad on our own meshes): pure 3×3 ray map (62 mrad),
  azimuthal radial lift, positioned-camera unit(Mg−c). This ALSO resolves §0k's dangling
  "3.98° after 3×3 alignment" mystery — there was never a lens map to align.
- ⚠️ **RETRACTION: `line_check_spiideo.py`'s absolute verdicts are void for Nazwa** (it paired
  raw pixels with window fractions). §0o's "fence bows 15 mrad under THEIR calibration" and
  "goal_line_left 3.7 theirs vs 9.1 ours" are retracted as Spiideo-certified claims. WHAT
  SURVIVES: the fence-curvature conclusion (independent support — in OUR OWN pinhole render the
  painted touchline is straight (−0.5%) while the fence sags (+2.4%); pinholes render straight
  world lines straight), the fence-lines-were-never-paint data fix (§0q), and the shipped fit.
  The tool's docstring needs a synthetic-mesh guard (check for regular-lattice texture coords)
  — HCT-style meshes with REAL UVs remain valid render sources (that's why HCT works).
- **Phase A via Spiideo — CONFIRMED DEAD END (headless live-player capture, no browser needed).**
  Karim asked "can't you use veo-automations?" — yes: new `veo-automations/spiideo-vp-net-capture.mjs`
  (Playwright, SPIIDEO_PLAY_* creds, same pattern as spiideo-mesh-capture) drives play.spiideo.com
  → CloudControl → Nazwa scene → "Show calibrated area", hooking WebGL (shaders, uniforms,
  bufferData, texImage2D) + saving all network bodies. Findings:
  1. The GPU-uploaded mesh is BYTE-IDENTICAL to the fetched S3 synthetic mesh (wasm doesn't
     rewrite UVs). Texture = the raw 3840×2160 HLS video (stream 6ce44ded on CloudFront).
  2. Captured Spiideo's 34 live shaders incl. their EXACT dewarp (shader[28]):
     `gl_Position = projectionMatrix · (textureToWorld · vec3(vertexPosition,1)).xyzz` — the same
     `.xyzz` per-projection-mat3 form we already replicate (re-confirmed on the LIVE product).
  3. ★ **DECISIVE: the mesh contains NO lens information.** Its texture coords are a PERFECTLY
     uniform lattice (u-spacing std/mean = 0.0000) and its positions are the pure analytic
     `posX=tan((u−½)·180°)`, `posY=tan((v−½)·90°)/cos(...)`; the residual from that closed form
     is a 1-D smooth symmetric function of PAN ONLY (identical across all 180 tilt rows,
     neighbour-diff 0.0) — a window-projection refinement, categorically NOT lens distortion
     (which varies with both axes + is asymmetric). Their real lens calibration lives in the
     upstream raw→window-rectify capture stage, which is NOT exposed to the player in any form
     (mesh, shader, uniform, or fetchable video). No amount of player capture reaches it.
     → Phase A (dense vendor ground truth) is CLOSED. The fetchable video is just a raw feed like
     our own vp-raw-kuwait.mp4 — nothing Spiideo-better to learn. Capture script + shaders kept
     under `veo-automations/captured-vpnet-b923d40f/` for the record.
- **Phase B BUILT + RAN → NULL on kuwait (kill criterion met, ships OFF).** New standalone
  `vp-calibration/residual_field.py`: smooth 7×5 cubic B-spline tangent-offset field over the
  fisheye plane, fit against great-circle line straightness (reuses calibrate.py's stretch-
  invariant measure), gauge-anchored (parametric fit FROZEN; zero at principal point; radial-
  breathing penalty for the tan-scale trap). Train drives all 9 lines to 0.00 mrad (70 params,
  9 lines = overfit, as expected — train is meaningless). **Leave-one-LINE-out (the acceptance
  test): held-out RMS 6.27 → 21.58 mrad = −244% (WORSE).** Verdict NULL → ship OFF.
- **Interpretation (robust):** no GENERALIZABLE residual signal in kuwait's paint lines beyond
  what the radial fit already captures — the same conclusion as §0e's NULL anti_bow and the §0q
  no-fence re-solve (<0.3 mrad move). Caveat logged: the −244% is inflated by the LOO
  spatially-unique-line pathology calibrate.py warns about (hold out a touchline → nothing
  constrains the field over the frame width → it wanders to 63 mrad there; the co-located box
  lines hold each other up → ~0). So the honest claim is "no shippable signal on this line set,"
  not "method broken" — the machinery correctly REJECTS overfitting via LOO, which is the point.
- **★ PROJECT CONCLUSION — BOTH independent paths to beat the radial floor came up empty on our
  best-calibrated camera:** Phase A (vendor ground truth) is a dead end because Spiideo's
  fetchable artifacts carry no lens info; Phase B (line-driven) is null because the paint lines
  hold no coherent residual the parametric fit misses. Together they confirm the §0k fit is
  genuinely AT THE DATA FLOOR — the visible curves Karim flagged are real world geometry (the
  fence) or data artifacts (fence-as-goal-line §0q), never calibration deficiency. Non-parametric
  correction is the right TOOL but there is nothing here to correct. `residual_field.py` is kept
  (validated, ships-off default) for FUTURE cameras whose parametric fit is genuinely deficient
  (decentering/tangential lenses, or Veo) — run it, read the LOO verdict, ship only if ≥30%.
  Follow-up if ever revisited: denser/longer line coverage (esp. verticals) would de-contaminate
  the LOO and give the field a fair test; a synthetic decentered-lens unit test would prove the
  machinery detects real non-radial error (currently only proven to reject noise).

## 0q. FOLLOW-UPS EXECUTED: Nazwa fanout (267 games), vp-materialize image live, goal_line_left CLOSED as a data artifact (2026-07-13 night)

All three §0p follow-ups, Karim's go:

- **Nazwa fanout DONE**: the refit mesh is live on ALL 267 recordings of scene 131777a6 (not 22 —
  every recording folder had a mesh from the §0h backfill; 266 re-ingested + byte-verified,
  canary re-published, scene registry canonical → b923). Rollback: per-game backups (624MB) at
  `/tmp/mesh-backup-nazwa-refit-20260713/`.
- **vp-materialize image REBUILT + LIVE** (CodeBuild `playhub-vp-materialize-image`, S3 src zip
  refreshed, ECR :latest pushed): new captures now inherit tuning.json with the mesh copy.
  entrypoint.mjs + buildspec.yml (recovered from the old zip — was never in git) committed
  (`08e6a05`) and pushed. Deploy recipe: zip {Dockerfile,entrypoint.mjs,package.json,
  buildspec.yml} → s3://playhub-recordings-eu-west-2/codebuild/vp-materialize-src.zip →
  `aws codebuild start-build --project-name playhub-vp-materialize-image` (AWS_PROFILE=playhub).
- **goal_line_left "weak spot" CLOSED — it was a DATA ARTIFACT, no refit shipped.** Eyeballing
  the snapped points (§0k discipline) revealed the trap's hardest form: **this caged pitch has
  NO long painted goal lines** — both "goal_line_*" entries traced the TURF/FENCE BOUNDARY
  (paint-adjacent, genuinely curved; the left one reads 3.7 mrad under Spiideo's mesh = mildly
  curved, the right 6.2). The solver had been fed curved data labelled straight. A no-fence
  re-solve (far_touch 1.45→0.90 mrad, CX/CY moved ~30px) changed PAINT-line residuals <0.3 mrad
  — i.e. the fence lines were already soft-l1-discounted and the shipped fit is within noise of
  the cleaner one → NOT re-shipped (mesh regen + re-canary + 267-game re-fanout for an invisible
  change). On actual paint we are within ~1.5 mrad of Spiideo EVERYWHERE; the residual left-end
  gap lives on the unconstrainable fence path and would need non-parametric residual correction
  (the someday-big-project). **kuwait-lines.json corrected**: the two pseudo-lines moved to a
  `diagnostics_not_lines` key with the full story — never feed them to calibrate.py again.

Canonical state doc for the PLAYHUB auto-follow work. Two parts: **the flatten (dewarp)** —
DONE and proven — and **the aim (where to point)** — foundation built, blocked on one
precise-calibration last-mile. Read this first in a new session.

Scripts live in `PLAYHUB/scripts/follow-re/`. Working data cached in `/tmp/imitation/`
and `/tmp/follow-pair/` (regenerate via the fetch scripts if the tmp dirs are cleared).

---

## 0n. §0m FEEDBACK QUEUE EXECUTED: corner-"rotation" diagnosed+fixed, HCT colour match SHIPPED, §0j judge pack ready (2026-07-13 afternoon)

All three items from Karim's §0m queue. Working tree still holds the whole undeployed stack —
deploy remains gated on Karim's §0j eye-judgement (artifacts below).

**(2) Corner-zoom "rotation" — DIAGNOSED (Karim's hunch right: clampView, NOT projection) + fixed.**

- Analytic trace (`veo-automations/corner-zoom-trace.mjs`) + headless visual
  (`veo-automations/pano-corner-zoom.mjs`, HCT mesh + debug grid): zoom at a FIXED aim is pure
  magnification (zero roll possible) — ALL rotation comes from the fov-dependent clamp dragging a
  boundary-pinned aim diagonally (pan+tilt at once). Cumulative apparent roll ≈ **15° at HCT, 44°
  at kuwait** over a corner zoom-out sweep; the drift is also a RATCHET (zoom out slides the aim
  to centre, zoom back in does NOT return it).
- Root amplifier: `CURVED_FOV_MAX=127` was Nazwa's window height HARDCODED. At HCT (window only
  47° tall) fov 127 collapsed the pan clamp to ±1.3° (≈57° pan sweep while zooming) and rendered
  a letterboxed sliver at extreme pinhole stretch — also the item-(3) "bowl" at HCT.
- **FIX (shipped to code): scene-derived zoom-out cap** — `curvedFovMax(tiltMin, tiltMax)` in
  `projection.ts` (window tilt span, clamped [12, 127=CURVED_FOV_MAX_CEIL]), consumed via
  `curvedFovMaxRef` in clampView/zoom%/follow-fov (follow cap = min(62, scene cap)). Nazwa 127,
  FP 117, HCT 46.9. Residual bounded drift while pinned is INHERENT to frame-on-window clamping;
  if Karim still dislikes it, the candidate is fraction-preserving zoom semantics (aim stored as
  fraction of the reachable range — reversible, no ratchet) — a UX decision, not built.
- Also: **open-view tilt un-hardcoded** — `max(−20°, window vertical midpoint)`; Nazwa/FP open
  EXACTLY as before (mids ≈−26°), HCT now opens on its pitch band (+6°) instead of the floor
  (was: half the frame honest-black on open AND on zoom-out).
- **FOLLOW-UP (same day, after Karim's "still a tiny bit of rotation when I zoom in on the
  left or right"): wheel zoom is now CURSOR-ANCHORED** (map-style zoom-to-pointer in the wheel
  handler; `atan(n·tan(fov/2))` cursor-ray offset absorbed into pan/tilt, clamped after). The
  residual percept was centre-anchored zoom sliding off-centre content radially outward.
  Empirically verified (`veo-automations/pano-zoom-anchor-check.mjs` + template matching):
  patch under cursor drifts 33–77px at ×2.4 zoom vs ~350px un-anchored. Buttons/keyboard zoom
  stay centre-anchored (no pointer).

**(1) HCT per-camera colour match — SHIPPED end-to-end (inert in prod until player deploy).
UPGRADED TO A PER-CHANNEL TONE LUT after Karim's eye ("much better though the color change is
still quite clear"): the overlap pairs show a brightness-DEPENDENT ratio (~1.8 in shadows →
~1.1 in highlights; affine barely beats gain) — the cameras differ by a tone curve, so the tool
now ships histogram-spec LUTs (`colorLuts`: 256×RGB linear-out, sRGB-encoded index, monotonic,
endpoint-gain extrapolated) with colorGains left as the identity/simple path (`NOLUT=1` reverts).
Player: `buildLutTexture` (validated → HalfFloat DataTexture — half-float is core-filterable in
WebGL2, FloatType isn't) + `patchColorLut` fragment patch on the overlay material (applied to
the linear texel right after map_fragment, CHAINED after the blend vertex patch incl.
customProgramCacheKey). Note: away-from-seam left/right patches show DIFFERENT world content —
judge continuity AT the seam, not distant patches.**

- New `vp-calibration/color_match_overlap.py`: both cameras image the SAME world rays in the
  overlap band (co-located, rotation-only extrinsics) → bake per-projection UV maps
  (mesh_dewarp) at overlap-centred views, sample the stacked median frame, per-channel
  **median-of-ratios** on well-exposed pixels (median eats the near-field parallax step +
  speculars). 365k matched pixels → **proj0 (left cam) LINEAR RGB gains [1.368, 1.305, 1.182]**
  vs base proj1 (≈ +0.4 stop, warmer); normalised so the base (player's opaque layer) stays
  identity. ⚠️ **GAINS ARE LINEAR-LIGHT** (senior-review catch): the player's video texture is
  `SRGBColorSpace`, so the GPU decodes texels to linear BEFORE the vertex colour multiplies — an
  sRGB-domain gain g displays as g^(1/2.2) (half the correction silently lost; confirmed
  empirically — debug-grid on-screen ratio 1.08 for an sRGB gain 1.17). The tool measures
  through the sRGB EOTF and the proof render applies gains in linear then re-encodes, so proof
  and player agree. Proofs `/tmp/color-match/seam_{before,after}.jpg`; player-side seam step
  measured ≤5 8-bit levels after (was a hard ~15-20).
  ⚠️ mesh_dewarp gotcha burned 1 round: `_vaos` caches by `id(projs)` — per-call list slices die
  and the id gets REUSED, silently rendering the FIRST projection's geometry for both (symptom:
  bit-identical "pairs", gains exactly 1.0). Keep the single-projection lists alive for the run.
- Player: optional `tuning.json` (`{colorGains: [[r,g,b]/projection]}`) fetched next to the mesh
  (404/error → identity, never load-blocking); gains baked into the existing per-vertex colour
  rgb (was hardcoded 1,1,1) — only the seam-blend material reads vertexColors so the base is
  double-safe. Headless A/B verified: overlay zone brightens per-channel, base zone bit-identical.
- **Uploaded to prod storage** `panorama-meshes/4b4ecece…/tuning.json` (byte-verified readback) —
  inert until the player deploys. `ingest_scene_mesh.py`, `vp-materialize/entrypoint.mjs` and
  `fanout_scene_mesh.mjs` ALREADY carry tuning.json as optional (prior session) → future HCT
  captures inherit it. Local judge copy: `public/vp-mesh-hct` (converted Spiideo mesh + tuning).
- Regenerate after a daytime frame if the night gains drift (per-scene-lighting, same caveat
  as §0g).

**(3) Wide-fov "bowl" / §0j re-judgement — JUDGE PACK READY, deploy gate = Karim's eye.**

- Working tree defaults are ALREADY pure pinhole at every zoom (blend OFF: BLEND_FOV_LO=150 —
  the §0l Spiideo-parity call); the HCT bowl driver was the 127 cap (fixed above).
- Judge artifacts (`veo-automations/screenshots/`): kuwait raw pair `pano-flat_1_{1,3,5}.png`
  (pinhole open/mid/full zoom-out — full zoom-out reproduces Spiideo CloudControl: whole pitch,
  buildings, scallop, straight lines) vs `pano-blo_42_bhi_60_bmax_1_{3,5}.png` (the offline-
  approved blend ramp — at full zoom-out it's the flattened-cylinder fishbowl Karim rejected);
  HCT `pano-mesh_vp_mesh_hct_src_vp_still_hct_mp4{,_5}.png` (open + whole-pitch overview at the
  new 47° cap, colour-matched seam, window vertically centred); FP zoom-out
  `pano-mesh_vp_mesh_footballplus_src_vp_still_footballplus_mp4_5.png`. Still-frame judge videos
  `public/vp-still-{hct,footballplus}.mp4` (median frames; produced clips are never mesh input).
- **If Karim approves pinhole-at-every-zoom on these**: run /check-ready, deploy PLAYHUB, then
  §0j/§0k blockers close. If he wants the edge stretch relaxed instead: the blend is one URL
  param away (`/panorama-test?blo=42&bhi=60&bmax=0.3` for a mild ramp) — tune bmax by eye, then
  flip the defaults.

Validation: tsc clean, 797 tests green (48 panorama incl. new curvedFovMax suite), prod build OK.
Senior review: 1 critical FIXED (sRGB-vs-linear gain domain, above), 3 importants FIXED —
malformed tuning.json sanitised at the vertex-buffer write (`saneGain`: non-finite/≤0/≥4 → 1, so
a bad CDN deploy degrades to identity, not a NaN-black seam); mesh extents (which now feed the
zoom-out cap + open tilt) restricted to TRIANGLE-REFERENCED vertices in both the player and the
tool (the 2026-07-12 culled-garbage-vertices invariant); color_match_overlap.py hard-asserts
n==2 (its all-projection overlap intersection is wrong for strip meshes — never point it at
Nazwa/FP). Plus tuning fetch got `AbortSignal.timeout(3000)` (it sits in the load-blocking
Promise.all). Known-accepted residuals: the auto-follow UV lookup grid still bins garbage
vertices (pre-existing, untouched); base-projection gains ≠ [1,1,1] from a non-normalising
producer are silently ignored (base material has no vertexColors). Diff-at-commit note: the
accumulated working tree is >1000 additions → the multi-reviewer rule fires when this actually
commits.

## 0p. §0j PROJECTION JUDGEMENT CLOSED — Karim's verdict = MID-RANGE BLEND BUMP, shipped as default (2026-07-13 evening)

Karim's eye on the refit kuwait pair: pinhole "lines are pretty okay, especially further away";
near-camera byline/goal-corner curvature noted (= §0o data-floor/parity territory + the parked
goal_line_left refit); tried `blo=42&bhi=60&bmax=0.3` → **"when I zoom in [mid-range fovs],
nicer; when I zoom out, I'd rather have the default [pure pinhole]"**. Both preferences are now
ONE ramp: **blendFactor is a mid-range BUMP** — b = bmax·smoothstep(lo→hi)·(1−smoothstep(
downLo→downHi)), defaults **42→60 up, 85→105 down, bmax 0.3** (`BLEND_FOV_DOWN_LO/HI`,
`BLEND_MAX_DEFAULT` in projection.ts; page knobs `bdlo`/`bdhi` join `blo`/`bhi`/`bmax`;
props `blendFovDownLo/Hi`). So: fov<42 pure pinhole (line fidelity), ~46–85 mild edge-stretch
relief (b≈0.04 at the open fov 46, 0.3 on the plateau), ≥105 pure pinhole again — the
whole-window zoom-out stays EXACTLY the Spiideo-parity view (verified headlessly: bump vs
flat=1 at full zoom-out mean|diff| 0.02 on the debug grid; plateau at fov ~72 artifact-free).
799 tests, tsc, build green. **This closes the §0j re-judgement — and the DEPLOY SHIPPED (same
evening, Karim's go): /check-ready PASS + `npm run release` green → focused commit `d1bbe00`
(projection.ts + tests + player + test page only, +869 — calibration scripts/lambda/types
workstreams left uncommitted as before) → pushed to main, Netlify auto-deploy.** Committed state
build-verified in isolation via a stash round-trip. ⚠️ RECOVERY LESSON from that round-trip:
`git restore --source=<tree> --worktree -- .` MATCHES the worktree to the source tree — it
DELETED 590 tracked files absent from the stash's untracked-only tree; recovered byte-exact
from the stash (55-file diff + all 31,080 untracked verified) before pushing. For stash surgery
use `git stash apply`/`git stash pop` or targeted pathspecs — never `restore --source -- .`.
Follow-ups: vp-materialize Batch image rebuild whenever its tuning.json-copy change ships (file
still uncommitted); HCT's live tuning.json becomes ACTIVE with this player deploy.

## 0o. GOAL-VIEW "EDGES HIGH, CENTRE LOW" INVESTIGATED — it's REAL WORLD GEOMETRY, certified against Spiideo's own bytes (2026-07-13 evening)

Karim on the Nazwa right-goal view: "still quite curved. edges are high, center is low. i just
want the edges to be flat too." Full diagnosis, ending in a NO-CHANGE verdict:

- **Measured his screenshot**: the painted far-touchline is STRAIGHT (−0.44% sag). The sagging
  element is the TURF/FENCE BOUNDARY at the pitch end (+4.4% in his frame, +2.4% in our matched
  headless render) — the line at the top of goal views.
- **Per-line residual map exposed a fit tension**: under kuwait-fit, far_touch is 1.4 mrad but
  the ends run 5–9; solving WITHOUT far_touch slams CX/CY back to the disc centre (bound-
  limited) — far_touch and the other 10 lines disagree about the principal point under any
  radial model. Re-running SOLVE=full byte-reproduces the shipped fit (it IS the optimum).
- ★ **NEW INSTRUMENT that settled it: `line_check_spiideo.py`** — collinearity through the
  origin is invariant under any fixed 3×3, so testing coplanarity of Spiideo's real-mesh
  (gnx,gny,1) vectors asks whether THEIR calibration renders the same pixels straight, with NO
  vertex-convention decoding (sidesteps the §0k byte-cross-check blocker entirely). Readings:
  ours-high+theirs-low = our fit wrong there; both-high = junk points or the world line isn't
  straight.
- **Verdict line by line: the traced points bow nearly IDENTICALLY under Spiideo's own
  calibration** (near_touch 4.4 theirs vs 5.7 ours; halfway 5.6/6.5; boxes ~7/8; the END-FENCE
  boundary **15.0 theirs vs 16.2 ours** ≈ the +2.4% sag). So: (a) our pitch-line residuals are
  DATA noise (paint-edge snap bias, worn lines), not model deficiency — the radial fit is at the
  data floor; (b) **the end-fence boundary is genuinely curved in the world** (~45cm bulge over
  the run) — Spiideo's own render of this view bows the same. No calibration or projection
  change can flatten it without bending the genuinely straight painted lines (§0e "hill" and
  §0j keystone lessons repeating at the third venue). **Told Karim: parity-with-reality, not a
  defect.**
- ONE genuine our-fit weak spot found: **goal_line_left — 9.1 ours vs 3.7 theirs** (the only
  line where the calibrations disagree >2×). NUANCE (Karim pushback round): theirs reading 3.7
  means the traced POINTS are mostly fine (junk would bow under both — the both-high signature),
  so ~5-6 mrad of our 9.1 is genuine LOCAL fit error, i.e. a mild radial-model/weighting
  limitation in that region — NOT (only) snap quality. Spiideo escapes radial limits entirely
  (their calibration is a non-parametric mesh). Optional future improvement: dense re-snap +
  refit with per-line weight normalization (density rebalances the solve); if the region still
  won't come in, that's local non-radial structure and the answer is mesh-level residual
  correction, not more k's. Not done — regression risk to an approved fit for a region Karim
  didn't flag.
- Arbiter scope note (also in the tool docstring): verdicts are viewpoint-independent (position/
  re-mounts fine) but require the SAME sensor/lens + intrinsics epoch — a mesh from a different
  camera or pre-lens-change calibration makes every line read spuriously curved.

## 0m. VENUE #2 (FOOTBALL PLUS) REFIT SHIPPED-TO-CANARY + HCT TWO-CAM CRACKED (2026-07-13 day)

The §0k method ran at two more venues and the pipeline gaps got codified into repo tools.
Everything below lives in `PLAYHUB/scripts/vp-calibration/` unless noted.

**New pipeline tools (gap #1 partial + method codified):**

- `median_frame.py` — temporal median of N spaced frames straight off a presigned S3 URL
  (players/refs averaged away → clean lines; kills the player-on-the-line corridor problem).
- `fisheye_model.py` — shared KB forward/inverse projection + `mesh_world_rays()` (the
  textureToWorld reconstruction, triangle-referenced verts only).
- `solve_mount.py` — codified §0k mount solve. MODE=prior-mesh = Kabsch vs an approved mesh
  (validated on kuwait: reproduces the approved TILT/YAW/ROLL within ~0.5°, the spread being
  pitch-region choice); MODE=pitch consumes register_pitch output.
- `gates.py` — codified acceptance gates. A: rendered chord-bow per snapped line (weighted-
  median rms ≤8px + long-line rms ≤15px — thresholds calibrated so the APPROVED kuwait refit
  passes and the old disc-centre fit FAILS: 6.7px vs 11.5px + far-touch 18.8); B: raw-frame
  coverage (+ no-loss vs prior); C: per-projection world reconstruction (hemisphere flips, UV
  bounds); D: cross-camera seam ghosting (needs cameras[] fit). Exit 0 = PASS.
- `snap_lines.py` grew per-line `ridge: dark` (blackhat, wide kernel — steel columns against
  white walls) + per-line `half` corridor override.
- `register_pitch.py` — gap #2 (orientation WITHOUT a prior mesh): Manhattan vanishing bundle
  over line FAMILIES (vertical=poles, length=touch/kerb/lanes, width=halfway) with shared-line
  coupling between co-located cameras, pixel-scaled residuals (an unscaled angular objective
  rewards F→∞ — learned the hard way), SHARED_F / FIX_F modes. Rotations solve plausibly at
  HCT; F/centre from vanishing geometry needs LONGER verticals than HCT's night frame offers
  (2 short poles in cam A → K runs away unless anchored). Hardening = next-session item.

**FOOTBALL PLUS (scene b3595080) — full §0k recipe, canary LIVE:**

- Median frame from game f9d6898f's raw pano (now the repo `footballplus-fisheye.jpg`).
  14 usable lines: 9 paint + 5 dark steel columns (columns traced programmatically from the
  blackhat profile after my eyeballed x-positions proved ~190px off — trace, don't squint).
  §0k ridge trap hit AGAIN on far_touch (corridor latched wall-base skirting ~25px above the
  paint; resolved by tracing both ridges programmatically and guiding on the strong one).
  rbox_front flare-junk got 3.5σ-trimmed by the solver, then dropped from the line set.
- `SOLVE=full` → **F=1113.6 CX=1894.0 CY=1139.2, tiny k's (k1=−0.0035), train 2.49 mrad**.
  NOTE: no disc → F stays AT the lens-prior seed (plumb lines are gauge-blind in F for
  near-rectilinear-ish fits); fine for product (window/zoom semantics eye-judged), the metric
  anchor would come from pitch registration later. Old fit was garbage (train 53 mrad).
- Mount re-solve vs old approved mesh: TILT=33.78 YAW=1.43 ROLL=−0.12 (median residual 5.2° =
  the genuine correction, old fit was that wrong at the rim).
- **Spiideo's REAL Football Plus mesh fetched** (same variants route as Nazwa): window
  **pan ±122.98°, tilt −84.5..+32.5** — adopted (fit json PAN_DEG/TILT_HI), THETA_MAX=115 for
  this near-linear curve (frame edge sits at θ≈99°; kuwait's 100° cap starved the edges).
  Their principal point reads out at EXACTLY image centre (1920,1080); ours is 65px away —
  same health class as the kuwait cross-check (51px).
- **Gates: PASS** (weighted-median 2.1px — far_touch 1.0px rms, columns ≤3px; coverage 97.4%
  vs old 71.7%; clean reconstruction). Render proofs `/tmp/calib-fp/render_*.jpg` — halfway
  ruler-straight at fov46, whole-arena zoom-out level with capture scallop, fishbowl gone.
- **APPROVED + FANNED OUT (same day, ~13:20): Karim judged both venues "quite good" → all 4
  FP games re-ingested (byte-verified) + registry canonical f9d6898f re-registered.** Old
  meshes backed up `/tmp/calib-fp/mesh-backup-20260713/{4 game ids}`.

**HCT DUBAI (scene 315f936b, 2-cam) — Explore mode EXISTS now, via Spiideo's own mesh:**

- Raw format discovery: the "panorama" is **two 3840×1080 wide views STACKED** (top = left
  half of pitch, bottom = right, overlap at centre). No Spiideo pre-stitch of the halves.
- ★ **The halves are PRE-RECTIFIED pinhole tiles** (clean long world lines are straight in
  RAW half pixels — kerb sagitta 0.8px over a 2400px chord). Consequences: (a) plumb-line KB
  solving is STRUCTURALLY DEGENERATE on such tiles (straight stays straight under any pinhole
  K — that's why SOLVE=full returned seed-F and bound-hugging centres); (b) per-cam model =
  virtual pinhole K + R, identifiable only from vanishing geometry / provider ground truth.
- ★ **Spiideo's real HCT mesh** (fetched like Nazwa's): TWO projections, **SAME camera
  position — rotation-only relative extrinsics (their own model co-locates the lenses,
  validating our planned approximation)**, inter-camera angle **56.57°**, window pan ±75.66°
  tilt −26.5..+20.4, stacked-texture addressing via per-projection UV v-windows ([0,.5] /
  [.5,1]) with baked cross-cam feather alpha — texture_offset unused. Vertex layout = ours.
- ★ **Their calibration-bucket meshes are TRIANGLE STRIPS** (n_indices %3 ≠ 0 was the tell;
  rendering as lists = every-other-triangle checkerboard). `mesh_dewarp.py` now truncates
  tolerantly; the ingest path expands strip→list (with alternating winding + degenerate-stitch
  skip). After expansion their mesh renders PERFECTLY through our exact player semantics
  (mesh_dewarp proof `/tmp/hct-list-wide.png` — seamless 2-cam whole-pitch pano over OUR
  captured median frame; small near-field parallax step at the seam is in THEIR product too).
- No closed-form KB(+homography) fits their mesh below ~9px — the mesh itself is the
  calibration (likely includes non-parametric warp). Don't chase a parametric decode; consume
  the mesh.
- **APPROVED + SCENE REGISTERED (same day, ~13:20):** strip→list-converted Spiideo mesh live
  on game 4b4ecece (the one HCT game with a preserved raw panorama; the other 3 were purged
  > 30d) — pan ±75.7°, 2 projections, idx%3==0, byte-verified — and **scene 315f936b is now in
  > `playhub_panorama_scene_meshes`** (future HCT captures auto-inherit).
- **Karim's feedback → follow-up queue:** (1) the two HCT cameras have visibly different
  exposure/colour at the seam — fix = per-projection colour match measured on the OVERLAP band
  (histogram-spec like color_match.py, gains in tuning.json + small player uniform); (2)
  zooming into a window corner "rotates" the view — suspect fov-dependent clampView aim-drift
  (the reachable-aim envelope changes with fov, so the clamp moves a pinned aim during zoom);
  diagnose headlessly before touching projection; (3) the wide-fov "bowl" percept folds into
  the open §0j projection re-judgement (pinhole vs mild Panini on straight geometry) — which
  also still gates the PLAYHUB deploy (blend flag state in the working tree).
- Line data for our OWN eventual solve committed: `hct-{top,bottom}-{guides,lines}.json`,
  `hct-register.json`, halves as `hct-{top,bottom}-fisheye.jpg`. Guide gotcha logged: the
  aluminum BENCH RAIL sits exactly in laneA_1/laneB_1's corridors mid-frame (a second straight
  line = §0k mixture trap) — lanes restricted to bench-free x-ranges.

**Honest gap state after tonight:** gap #1 (line acquisition) — median frame + programmatic
ridge tracing shipped; auto line detection still open. Gap #2 (no-prior extrinsics) —
register_pitch.py built, rotations work, K anchoring needs better verticals (or a daytime
frame); for Spiideo scenes the fetched real mesh is both anchor and answer. Gap #3 (two-cam)
— render path + format + co-located model all PROVEN via the converted Spiideo mesh; our own
generator's cameras[] extension deferred until register_pitch hardens (needed only for
non-Spiideo 2-cam venues). Rollbacks: FP `/tmp/calib-fp/mesh-backup-20260713/`; HCT had no
prior mesh (delete the storage prefix to revert).

## 0l. ZOOM-OUT "VOID SHAPE" REVERSE-ENGINEERED from LIVE play.spiideo.com bundle (2026-07-13)

Karim asked to replicate the exact zoomed-out framing shape on the live site — the black void that
dips to frame-centre at top (Image #1, Nazwa) + the "flattened cylinder" calibrated-area (Image #7).
Reverse-engineered by pulling the live cloud-control webpack bundles (`/js/*.js`, chunk map in
`91cb12f1…js`; the CloudControl/GL chunk is `e06a6a15…js`). Cached in scratchpad.

- **The void curve is NOT a designed shape — it's the pinhole image of the mesh's `maxTilt`
  ceiling.** A constant-tilt line is a latitude circle on the view sphere; a pinhole images a
  circle as a CONIC → a smooth arc that dips deepest at pan=0 and rises at the edges. Analytic
  silhouette sim with Spiideo's own numbers reproduces Image #1 exactly
  (`scratchpad/void_shape_compare.png`).
- **Live shader = pure pinhole, byte-identical to our `.xyzz`** (re-confirms §1 on the LIVE
  product, not just captured Perform): `gl_Position = projectionMatrix *
(textureToWorld * vec3(vertexPosition,1.0)).xyzz`. Vertex attrs = vec2 vertexPosition (gnomonic
  plane), vec2 vertexTexCoord0, float vertexAlpha. Demo vertex format = [gnX, gnY, alpha, u, v].
- **Engine = Rust→wasm `pebble_wasm`** (hash `af712913360e44306ee9`, loaded as
  `{id}.module.wasm`), class `perspectivecamera` (`setPan/setTilt/setZoom`, `glProjectionMatrix`,
  `homographyFromReference`, `viewProjectionMatrix`). Zoom clamps to `[minRelativeZoom,
maxRelativeZoom]` (or `minZoom/1024 … maxZoom/1024`) in the JS `createCameraController`.
- **★ SPIIDEO'S REAL NAZWA MESH DOWNLOADED (ground truth, not the demo).** Found where the online
  player stores it: `stream.projectionParameters.variants[]` (pick `version==1`) carries direct
  signed URLs for `scene.json` / `indices.bin` / `vertices.bin` on
  **`s3-eu-west-1.amazonaws.com/calibrations.eu-west-1.prod.spiideo/…`** — no projection-download
  ORDER, no billing (§0's blocker was the wrong route). Fetcher: **`fetch_spiideo_mesh.mjs
<gameId>`** (signs in via SPIIDEO_PLAY_* → `/v1/streams?gameId=&type=source…` → Spd stream
  `2272691d…` for b923 → variant URLs → downloads). Saved to
  `scripts/follow-re/spiideo-real-mesh-b923d40f…/`.
  **Real Nazwa scene.json: pan ±122.75°, tilt −81.70°→+37.07°, minRelativeZoom 0.2,
  maxRelativeZoom 16; ONE projection, camera at WORLD pos [−20.32, 0.31, 9.86] (registered, not
  origin), 64798 verts / 129236 idx.** Vertex format [gnX, gnY, ?, u, v] with gnX/gnY ∈ ±318
  (single wide gnomonic tile, tan θ→~89.8°).
- **This CORRECTS the demo-based estimate above.** The demo camera (±84.87°/+19.66°) is NOT Nazwa.
  Real Nazwa (±122.75°/+37°) ≈ our kuwait fit (±135°/+30°) — we're slightly wider in pan, ceiling
  ~7° lower. So the big void in Karim's zoomed-out shot is the view **tilted UP toward/past the
  +37° ceiling** (sky above the buildings), NOT a wide-fov effect; both meshes fill ~100% at
  vfov≤100° looking level. Silhouette: `scratchpad/void_shape_REAL.png`.
- **STRUCTURAL diff worth noting:** Spiideo = 1 offset-registered projection; ours = 4 origin
  rotational strips+bowl. Both render the identical `.xyzz` pinhole and were validated to the same
  world-ray map (§0k landmark stamp 0.63px), but this is now checkable BYTE-LEVEL against their
  real mesh (the §0 "100%-identity route" — finally have their actual bytes, no order needed).
- **REPLICATION for the framing:** match `maxTilt` to +37° (or keep our +30° — near-identical) and
  keep `minRelativeZoom 0.2`; the "preserve distance / don't zoom in too much" lever is that
  zoom-out floor. §0k's `CURVED_FOV_MAX 62→92` should track the +37° ceiling, not a hardcoded 92.
- **NEXT (offered):** byte-level calibration cross-check — sample real-mesh pano-uv↔world-ray vs
  our kuwait fit to quantify agreement (finally closes §0's "our fit vs their bytes" question),
  and/or adopt their exact scene.json clamp for the Nazwa scene.

## 0k. CALIBRATION REFIT DONE — halfway bow + fishbowl killed at the source; CANARY LIVE, awaiting Karim's eye (2026-07-13)

The §0j mission executed end-to-end. **Root cause of the halfway bow: the manual disc-arc
principal point was ~290px wrong.** The 8-point "manual-left-arc" circle fit (kuwait-disc.json)
put CX/CY at (1821, 810); the plumb-line data puts it at **(1871, 1108) — near the image
centre** (a short arc extrapolates its centre wildly; rms 0.64px was fit residual, not centre
uncertainty). Corroboration: footballplus (which fell back to image centre) solved k1=-0.052;
kuwait now solves k1=-0.054. The old fit's far-touchline rays bowed ~13 mrad with apex exactly
at the halfway line — no view-side projection could ever have fixed it (§0j was right to stop).

**New kuwait fit (kuwait-fit.json): F=1160.7 CX=1871.0 CY=1107.7 k1=-0.05355 k2=0.00042
k3=0.00118 k4=0.00556** — solved by `calibrate.py SOLVE=full MANUAL_LINES=kuwait-lines.json`.

- **Line data:** 11 corridor-snapped plumb lines (~500 pts) via `snap_lines.py` — both
  touchlines, halfway, both goal lines, both penalty boxes. Guides + snapped points saved in
  repo: `kuwait-guides.json` / `kuwait-lines.json`. ⚠️ TRAP that cost the first 3 rounds: the
  far touchline has a parallel bright ridge (fence base-board edge) ~25-35px above it at the
  left end — HALF=22 corridors latch onto it and inject a fake smooth arc. far_touch was
  snapped at HALF=12 on dense guides. Junk data reads as a COHERENT bow, not noise — always
  eyeball `insp_*` crops of a suspect line before believing its residual.
- **Solver (calibrate.py SOLVE=full):** three hard-won design rules. (1) Residual =
  GREAT-CIRCLE plane distance on the unit ray sphere (mrad) — the tan-plane perp/std measure
  is GAMEABLE: a radial remap that inflates rim θ stretches the line and shrinks relative bow
  without straightening anything (first attempt rode k1 to −0.30 and moved a 53° pixel to 72°).
  (2) F is FIXED to the disc anchor (R·2/π) — plumb lines have a tan-scale gauge freedom
  (θ→atan(c·tanθ)); with F fixed the gauge only leaks through k's, and minimum-norm L2 regs
  pick the member nearest the certified curve. (3) LOO-CV structurally punishes spatially
  UNIQUE lines (hold out the only line in a region → nothing constrains that region) — it
  advises, it must not select; the model is k1..k4+cxy, acceptance is empirical (below).
- **Gates all passed:** (a) straightedge render (`/tmp/calib-refit/render_*.png`): far-touchline
  bow at explore centre fov46 **29.1px → 4.0px** (max, over ~1350px chord; rms 12.6 → 1.6);
  fov60 24.5 → 2.8px. (b) near-touchline rim arc (the tilt-down "fishbowl") **34.5 → 5.3 mrad**;
  tilt-down −48° render is straight and artifact-free. (c) `landmark_stamp.py` vs Spiideo on the
  NEW mesh: **median 0.63px** across pan −63..+62 (old fit: 0.82px), radial profile FLAT
  (edge/centre **0.90**, old 1.12) — absolute Spiideo parity IMPROVED, θ(r) deviation vs old
  curve <0.6° in the landmark-validated mid-range, corrections concentrated at the rim.
- **Mesh regenerated on the untouched v4 grid** (3 strips + bowl; generate_mesh.py unchanged);
  referenced-vertex world reconstruction verified (no hemisphere flips, 100% UVs in-frame).
  **Coverage note for the eye-judgement: raw-frame coverage 80% → 70.3%.** Gained a band at the
  TOP (tilt ceiling reaches higher after recentring); lost the extreme-pan strip ends (mesh now
  reaches ~±110° vs ±126°) and the behind-mast bowl corners (bowl pan ±100°, tilt floor −88.7°) —
  under the corrected centre those rays genuinely project OFF-SENSOR; the old mesh filled them
  with wrong-direction pixels (phantom coverage — §0h's "nadir ~100px left of centre" was
  model-derived from the bad disc centre, never observed; nadir is actually ~65px below the
  frame). All product framings survive: full pitch, corner-kick zones (pan ±~65°), the §0h notch
  region, run-off. scene.json still declares ±135° — extreme-pan explore may show more edge
  black than before; if Karim objects, clamp PAN_DEG to 110 or revisit.
- **MOUNT RE-SOLVE (same night, ~02:00 — Karim caught it in one look: "not capturing the full
  pitch anymore").** An intrinsics-only refit is NOT enough: moving CX/CY ~300px re-levels the
  whole (pan,tilt) datum, so with the old `TILT=32` the mesh's tilt window pointed ~15° into
  the ground — pitch content crushed against the maxTilt=+2 ceiling, zoom-out couldn't frame
  the pitch, strip ends showed garbage inside the declared ±135 clamp, and the "80→70%
  coverage loss" I'd rationalized as phantom coverage was really the mis-levelled window.
  Fix: **Kabsch rotation aligning the new model's directions to the OLD approved world frame**
  over the pitch region → **TILT=48.272 YAW=-2.585 ROLL=-0.554** (now in kuwait-fit.json;
  generate_mesh reads YAW/ROLL from the fit json too). Residual after rotation = the genuine
  calibration correction (median 2.8°, rim-max 8.8°). Coverage after: **80.5% vs old 80.0%**,
  strips ±122°, bowl full-wrap to −90° — nothing product-visible lost. Gates re-passed on the
  final mesh: far-touch bow 3.7px @ f46 / 2.6px @ f60; landmark stamp re-run below.
  **RULE: after ANY principal-point change, re-solve the mount rotation against the previous
  world frame (or a physical datum) BEFORE judging coverage or framing.**
- **PERFORM-STYLE FULL ZOOM-OUT SHIPPED (same night, ~02:45, Karim's ask: "zoom out completely
  → entire pitch, like Perform").** `VirtualPanoramaPlayer.tsx`: `CURVED_FOV_MAX` 62→**92**
  (≈ the mesh's tilt window; legacy motion-auto keeps a separate 62 ceiling,
  `CURVED_FOV_FOLLOW_MAX`). At the overview fov the blend rides to b=1 cylindrical, which is
  what makes it work — a planar pinhole loses vertical reach at side columns (the right goal
  clips even at huge fov), a cylinder keeps the full tilt window at EVERY column; both goals
  in frame (span ≈ ±61°), black beyond mesh ends like Perform. **Second shader lesson:** the
  dz≤0 guard collapsed behind-camera verts to clip-space CENTRE (0,0) — straddling triangles
  rasterize a sliver from their on-screen vertex to the collapse point, i.e. ACROSS the frame;
  invisible under the 62 cap, garish smear at 92 (Karim: "look at how it fills the corner").
  Fix: collapse to a far off-screen point on the vertex's OWN side (sign of camera-frame x/y)
  — the collapse point of a straddler must never be inside the frustum. Verified headless
  (`veo-automations/pano-smear-check.mjs` — zoom-out + hard-pan-right shots); tsc + 40
  panorama tests green. NOT judged yet: whether ±61° suffices or the overview should extend
  its horizontal extents to ±95-100° (true whole-pitch-in-one-frame; needs a deliberate
  blend-extents change re-passing the extent-invariance test + clamp).
- **REAL-NAZWA WINDOW APPLIED (~04:30).** The parallel session fetched **Spiideo's real Nazwa
  mesh** from their calibration S3 bucket (via `stream.projectionParameters.variants[version==1]`
  URLs in the stream metadata — no billing order; fetcher `follow-re/fetch_spiideo_mesh.mjs`).
  Ground-truth window: **pan ±122.75°, ceiling +37.07°, floor −81.70°, minRelativeZoom 0.2, ONE
  projection with a POSITIONED camera ([−20.3, 0.31, 9.86] world)** — the demo scene (±84.87/+19.66)
  was NOT representative. Applied to our mesh/window: `PAN_DEG=122.75, TILT_HI=37.07` in
  kuwait-fit.json (floor kept at −89.95 for the below-camera view — only adds downward freedom),
  `CURVED_FOV_MAX=127` (window height). Headless zoom-out now reproduces the CloudControl
  composition: whole pitch + buildings + capture-boundary scallop, straight lines
  (`/tmp/calib-refit/realwindow_zoomout.png`). Their pan ±122.75 ≈ exactly our frame-culling
  reach (±122) — independent confirmation both meshes end at the same capture boundary. NOTE
  their positioned-camera single-projection format ≠ our rotation-only 4-proj format — theirs
  stays validation-only per the locked strategy; a byte-level comparison of their Nazwa mesh vs
  our refit is now possible and is the definitive Layer-0 certification if wanted.
- **BYTE-LEVEL CROSS-CHECK vs THEIR REAL MESH — PARTIAL (~04:50).** Ran our-fit-vs-their-mesh
  comparisons on the fetched real Nazwa mesh. TWO SOLID RESULTS: (1) **their principal point
  reads out at (1922, 1082) — the exact image centre** (axis pixels where their gnomonic radius
  →0): our refit centre (1871, 1108) is ~51px from theirs; the old disc centre (1821, 810) was
  ~290px off — independent confirmation of the refit's core correction. (2) Under every decode
  attempted, the REFIT beats the OLD fit against their mesh (e.g. median 3.98° vs 6.67° after a
  general 3×3 ray alignment). UNRESOLVED: an absolute curve comparison still shows degrees-level
  residual that survives even a full projective (3×3) alignment — their positioned-camera,
  single-projection format ((f0,f1) spans ±318 ≈ a near-hemisphere gnomonic; camera at world
  [−20.3, 0.31, 9.86]) has vertex semantics I could not pin down from bytes alone (scalar plane
  distance d≈0.76 helps but doesn't close it; layout is [gnx, gny, u, v, alpha] — col4 alpha,
  NO v-flip). The session that extracted the player pipeline from the bundle (wasm camera,
  textureToWorld feed) should finish this — decode first, then the pairwise-angle test here
  (rotation-invariant) becomes the certification instrument. Do NOT read the 3.98° as our
  calibration error — landmark parity (0.63px, flat radial profile) bounds real within-view
  distortion far below that; the residual is dominated by the undecoded convention.]**
- **[SUPERSEDED ~04:00 by §0l — Karim judged the cylindrical overview "still quite fishbowl"
  vs CloudControl, and the parallel session's live-bundle reverse-engineering proved Spiideo is
  PURE PINHOLE at every zoom. Implemented accordingly: `CURVED_FOV_MAX` 92→**150** (wide pinhole
  to the window edges, ±81° horizontal at 16:9 — straight pitch at every zoom; the extreme edge
  stretch is exactly what Spiideo's own max zoom-out shows), blend defaults OFF
  (BLEND_FOV_LO/HI = 150/160, beyond the cap; machinery kept for `blo`/`bhi`/`bmax` tuning —
  the ±95 cylindrical widening below only engages if a tuner pushes b to 1). Also fixed:
  default open view must pass tilt in RADIANS (−20·DEG) — the un-converted `-20` pinned the
  open view to the tilt floor once tilt-down was freed. The capture-boundary mesh (TILT_HI=30,
  100% raw-frame) and free tilt-down stay; §0l's window-narrowing knobs (maxTilt≈+20, pan≈±85)
  remain available if the exact Spiideo void-arc aesthetic is preferred over full capture.]**
  **±95° CYLINDRICAL OVERVIEW + CAPTURE-BOUNDARY MESH (same night, ~03:20, Karim: "do the ±95
  extension" + "can't see straight below" + CloudControl screenshot "definitely a flattened
  cylinder — replicate it").** Three coordinated changes, all judged against Spiideo's own
  CloudControl "show calibrated area" view of THIS scene (their overview renders to the
  sensor's capture boundary in a flattened cylinder — the scalloped black arc IS the raw
  frame's top edge mapped through the cylinder):
  (1) **Overview widening** (`projection.ts`): at b≥0.999 and fov 70→92, the horizontal
  half-extent grows from the invariant pinhole hh to **OVERVIEW_PAN_HALF_DEG=95°**, and the
  vertical extent returns to tan(vfov/2) — the un-widened blend's y=x/aspect quietly
  under-spans the fov at b=1 (full zoom-out was only ~±31° vertical). Gated on FULL
  cylindricality because the pinhole term tan(θ) FOLDS past 90° — only the pure cylindrical
  map can express the wings. `blendPanHalfAngleDeg` is the clamp twin; clampView now uses it
  (with b from blendFactor) instead of the pinhole hh formula.
  (2) **Shader pure-cylindrical branch** (`CYL_PROJECT_GLSL`, uBlend≥0.999): same NDC as the
  dz-form at b=1 but multiplied through by **w = hyp** (never flips sign) instead of w = dz —
  rays past ±90° off-axis render; wrap-around (>149°) collapses same-side off-screen. The
  dz-form CANNOT render the overview wings (behind-camera plane).
  (3) **Mesh ceiling +2°→+30°** (`TILT_HI` now in kuwait-fit.json): raw-frame coverage
  **80.5%→100%** — everything the sensor captured is renderable; the scalloped boundary
  emerges from frame-edge culling exactly like Spiideo's. Default open view pinned to
  tilt −20 (the ceiling no longer forces the pitch aim). Tilt-down clamp freed to the window
  floor (aim at the nadir; honest black past it, like the pan ends).
  tsc clean, **45** panorama tests (5 new: overview law, continuity, clamp-twin match);
  headless proof `/tmp/calib-refit/{overview_zoomout,final_zoomout,final_tiltdown}.png` —
  whole pitch in one frame. Canary + local pair re-published (scene.json now declares tilt
  −90..+30). POLISH later: boundary staircase (whole-cell culling) vs Spiideo's smooth edge.
- **CANARY LIVE:** new mesh uploaded to `panorama-meshes/b923d40f-…` ONLY (the Nazwa dev game;
  NO SCENE_ID → registry untouched, NO fanout to the other 25). Local judge pair
  `public/vp-mesh-kuwait` also swapped to the refit mesh (old at
  `/tmp/imitation/mesh-backup-20260713-prerefit/`; staging copy `/tmp/calib-refit/mesh-new`).
  **AWAITING KARIM'S EYE on /panorama-test (raw pair) + /watch for b923** — then fan out:
  re-ingest remaining 21 Nazwa games (same mesh) and register scene 131777a6.
- **NOT DONE (deliberate):** footballplus refit — its centre is already image-centre but it's
  k1-only (the "fishbowl-ish" indoor verdict is the same rim disease); needs its own snap-line
  authoring session (indoor arena, harder ridges) → run the identical SOLVE=full flow. The 4
  Football Plus games still serve the old footballplus mesh. Also: follow-pipeline meshes
  (`/tmp/follow-pair/mesh-fixed`) NOT switched — offline follow artifacts still render through
  the old mesh until re-pointed. ⚠️ PLAYHUB working tree still has the fov-adaptive blend ON
  by default (§0j) — deploy remains BLOCKED until Karim re-judges the projection question on
  the straight mesh (pinhole may win now that the bow is gone).

## 0j. VIEW-PROJECTION A/B BUILT — judge-ready, awaiting Karim's eye (2026-07-12 night)

The "rounded feel" lever (§0h next-session ask) is now a judgeable A/B. `projection_ab.py`:
one knob spans the candidate family **pinhole (d=0, current) → Panini d=0.5 → Panini d=1 →
cylindrical (d→∞)** at MATCHED framing (same aim, same horizontal angular extent, same
centre scale — content at frame edges identical across panels).

- **Method: mesh untouched.** Bake the existing pinhole UV map once per view
  (`mesh_dewarp.bake_uv_map`, 4-proj mesh as-is, sized analytically to cover the candidate's
  ray footprint), compose with the candidate's pixel→ray map, ONE final `cv2.remap` (no
  double resample). NaN-poisoned sentinels keep coverage edges clean. **Self-check: composed
  pinhole == direct `MD.dewarp` at mean|diff| 0.032** — sign/scale conventions proven.
- **Artifacts (`/tmp/imitation/proj_ab/`):** `grid_*.png` 2×2 judge grids for 5 views
  (follow t=47 + t=80 at reg framing ×1.40; explore centre/left-goal fov46 = production
  open fov; explore fov60 stress), per-panel full-res PNGs, `flicker_t47.mp4`
  (pinhole↔Panini d=1), `motion_ab.mp4` (t=31–56 side-by-side pinhole | Panini d=1 —
  the feel is partly a motion percept).
- **What the A/B shows (geometry facts, verdict is Karim's):** at follow fov (~36°) the
  candidates differ only subtly; at explore fov 46–60 Panini/cylindrical visibly relax the
  edge/corner stretch (players keep proportions, ground stops "pulling") BUT genuinely
  straight far horizontal lines (fence rail, far touchline) pick up a real arc — the
  inherent tradeoff of any non-rectilinear view. Verticals stay straight in all candidates.
- **Competitive note:** Spiideo is plain pinhole everywhere — their captured Perform shader
  (§1 `.xyzz`) and our production player (three.js `PerspectiveCamera`, opens fov 46, whose
  own comment admits "a wide fov fisheyes the edges"). Adopting Panini/cyl would be a
  perceptual improvement OVER Spiideo, not parity — and must re-pass the Layer-0 gate.
- **If a winner emerges:** offline = pass the projection through `render_smooth`/
  `follow_render` (compose step is ~free); production = the three.js perspective camera
  can't express Panini — needs the vertex-shader projection generalized (same place the
  `.xyzz` divide lives) or a post-warp pass in `VirtualPanoramaPlayer.tsx`.
- **KARIM'S VERDICTS (same night): fov-dependent.** (1) At FOLLOW framing (t47 flicker,
  fov ~36°): "pinhole looks better than panini d=1.0" — line fidelity wins when there's
  little edge stretch; cylindrical eliminated there by dominance (same squeeze, stronger).
  (2) At EXPLORE wide (grid_explore_leftgoal_fov46): "cylindrical looks better" — edge
  stretch dominates at wide fov. Coherent synthesis = **fov-ADAPTIVE projection**: pinhole
  below ~40° vfov, blend d→cylindrical as fov widens (the game-engine Panini-blend trick;
  smooth d(fov) ramp so zooming never pops). Confirm instruments generated:
  `flicker_explore_{leftgoal,center}_cyl.mp4` (pinhole↔cyl at fov46) and
  `pan_sweep_cyl.mp4` (simulated explore drag, goal↔goal at fov46, side-by-side), plus
  `flicker_t47_d{0.5,0.25}.mp4` / `motion_ab_d0.5.mp4` if the mild-Panini follow check is
  wanted.
- **THE PROPOSAL, RENDERED: `zoom_sweep_adaptive.mp4`** — pure pinhole | fov-adaptive
  side-by-side, zooming 25°↔60° at the left goal. Adaptive = `blend` projection in
  `projection_ab.py::rays_for`: exact pinhole↔cylindrical interpolation (x = (1−b)·tanθ +
  b·θ, Newton-inverted; endpoints verified equal to pinhole/cyl at machine precision),
  b = smoothstep(vfov, 38→52). Identical to current render when zoomed in; relaxes to
  cylindrical zoomed out; no pop. **APPROVED by Karim ("fov 60 adaptive b=1.00 is very
  good") → implemented in production, below.**
- **PRODUCTION IMPLEMENTATION SHIPPED TO CODE (same night, plan-approved).** The curved
  product path in `VirtualPanoramaPlayer.tsx` now renders through the blend: an
  `onBeforeCompile` vertex-shader patch (`CYL_PROJECT_GLSL`, replaces three's
  `project_vertex` on BOTH the base and seam-blend materials; w=dz so b=0 is literally
  the stock pinhole clip coords AND Spiideo's own `.xyzz` form; dz-multiplied guard-free
  form per senior-code-reviewer). Pure math + tests in `src/lib/panorama/projection.ts`
  (`blendFactor` bmax-clamped to [0,1], `blendHalfExtents`, `blendProject` = GLSL's JS
  twin; extent-invariance test = the proof clampView needs no change). Ramp is
  **tunable**: props `flatProjection`/`blendFovLo`/`blendFovHi`/`blendMax`, defaults
  **42→60, bmax 1** (deliberately milder than the offline 38→52 — Karim flagged pure
  cylindrical "looks curved in the center" while PANNING at fov 46, so fov 46 now gets
  b≈0.13). `/panorama-test?flat=1|blo=|bhi=|bmax=` is the live tuning harness.
  786 tests green, tsc clean, build OK, senior-code-reviewer fixes applied.
- **TWO BUGS FOUND VIA HEADLESS BROWSER VERIFICATION (`pano-shot.mjs`), both fixed:**
  (1) Karim's "pixelated look" on /panorama-test = the page's default `/vp-mesh`
  (July 2 format, untracked local artifact) no longer renders with current
  `buildExactPanorama` — alternating-triangle checkerboard, PRE-EXISTING on main
  (proven by git-stash A/B), unrelated to the blend. Page defaults now point at the
  working pair `/vp-mesh-footballplus` + `/panorama-test.mp4`. Root cause of the old
  mesh's incompatibility left undiagnosed (stale artifact, not product surface).
  (2) **REAL blend bug at high b:** at b=1 fully zoomed out the frame smeared into
  giant triangles — the stock pinhole is a true projective map so the hardware
  clipper handles camera-plane-straddling triangles exactly, but the blended
  x = θ·dz term is NOT projective → garbage clip intersections (the mesh wraps
  ±135° + full-wrap bowl, so straddling triangles always exist; invisible offline
  because the sim ray-marches per-pixel — no rasterizer). FIX: collapse dz≤0
  vertices to a clipped degenerate point in the vertex shader (safe: visible
  content never beyond ~47° half-width at the fov-62 cap). b-sweep verified clean
  at fov 62 / b ∈ {0.6, 1.0}. **LESSON: a nonlinear vertex projection must handle
  behind-camera geometry EXPLICITLY — w-clipping only works for projective maps.**
  (3) **Karim caught a third: `/panorama-test.mp4` is a 1080p PRODUCED clip, not
  a raw VP** — meshing it double-warps (jagged source-frame edges). Test page now
  defaults to the TRUE raw pair: `public/vp-mesh-kuwait` (copy of
  `/tmp/follow-pair/mesh-fixed`, v4 Nazwa) + `public/vp-raw-kuwait.mp4` (copy of
  `raw_b923…_s900.mp4`, the same 4K fisheye every offline artifact used).
  Headless-verified: flat vs blend at fov 62 on the raw pair both render clean;
  the blend visibly relaxes the pinhole edge stretch. Only feed the player RAW
  VP + its own scene's mesh — produced/Play clips are never mesh input.
- **DIAGNOSIS THAT ENDS THE PROJECTION CHASE (2026-07-13 ~00:50): the "curved at the
  halfway point" Karim keeps seeing is REAL CALIBRATION BOW, not projection.**
  Straightedge-grid screenshots (`veo-automations/screenshots/diag-grid-*.png`) show the
  far rail/touchline arcing against reference lines IN THE PURE PINHOLE RENDER (flat=1),
  apex at the halfway line — a pinhole renders straight world lines straight, so this is
  residual error in OUR fisheye fit, visible because the explore view spans the full pan
  width (~1% normalized bow ≈ 15–20 px arc at 2000 px). Consistent with §0e's numbers
  (ours 0.6–1.1% vs Spiideo's 1.4–1.6% — we're flatter than Spiideo, but 1% is visible
  at this framing) and with the KNOWN calibration limitation (2026-07-05: single-k1 fit,
  principal point assumed dead-centre — "top suspect for asymmetric edge curvature").
  **No view-side projection can fix it** — pinhole preserves the arc, cylindrical adds
  bow, keystone (homography) preserves it exactly. §0e's "inherent ground-plane
  perspective" framing conflated the trapezoid PERCEPT with this measured line bow.
- **KEYSTONE knob added meanwhile** (same shader, `uKey`; prop `keystone`, page param
  `?ky=` ~0–0.35): pure homography (straight lines stay straight) that narrows the near
  side / widens the far side — the taste knob for the trapezoid splay. `applyKeystone`
  twin + collinearity test in projection.ts. 40 panorama tests green, tsc clean.
  **THE REAL FIX = the calibration workstream (§0i spike, now promoted):** refit the
  fisheye with solved principal point + k1..k4 (plumb-line constraints from
  touchlines/rails — `vp-calibration/calibrate.py`), regenerate meshes, revalidate vs
  Spiideo, re-ingest the 26 games. That removes the halfway bow at the source for BOTH
  pinhole and blend.
- **FINAL VERDICT OF THE NIGHT (Karim, ~01:00): keystone REJECTED** ("still curved and
  panning downwards makes it zoomed in too much. very fish bowl view") — the top-of-frame
  magnification reads as zoom-in when tilting down, and the halfway bow remains (as
  diagnosed — no projection knob can remove it). Projection levers are EXHAUSTED; blend
  stays available (defaults 42→60, keystone default 0), but nothing is eye-approved for
  ship. ⚠️ The working tree turns the blend ON by default for the production player —
  do NOT deploy until the Layer-0 gate passes (or the calibration refit lands and the
  whole question is re-judged on straight meshes).
  **NEXT SESSION HEADLINE = the calibration refit** (solve principal point + k1..k4 with
  plumb-line constraints from touchlines/rails in `vp-calibration/calibrate.py`;
  prior-art already scoped in §0i: PnLCalib / Double Sphere). That removes the halfway
  bow AND the tilt-down near-field fishbowl at the source (the bowl region inherits the
  same single-k1 fit, worst near nadir — same "fishbowl-ish" verdict as Football Plus
  indoor, 2026-07-08). Then regenerate meshes → revalidate vs Spiideo → re-ingest 26
  games → re-run the projection judgement on straight geometry.**

## 0h. COVERAGE SOLVED + DEPLOYED TO PRODUCTION (2026-07-12 evening) ✅ — next: FLATTEN the "rounded feel"

The bottom-centre coverage "notch" + missing near corners + off-centre nadir dimple are all
FIXED, root-caused three layers deep, and live in production:

1. **Root cause was OUR generator, not a seam and not a capture limit.** `vp-calibration/
generate_mesh.py` grid bounds (TILT_LO=−74, PAN=±90) cut a 16°-radius circle around the
   nadir (bottom-centre of frame at 32° mount tilt) and dropped the corners. Spiideo's own
   demo mesh has NO such hole.
2. **`cv2.fisheye.projectPoints` folds z<0 rays back inside the disc** (mirrored phantoms) —
   the lens actually captures >180° FOV. Generator now projects MANUALLY (arccos form, valid
   to 180°); validity = θ≤100° extrapolation cap + projected pixel in-frame.
3. **A gnomonic strip MIRRORS directions past 90° from its projection plane** (g_z<0 →
   world flips through origin). Full-wrap pan CANNOT live in strips — final geometry =
   **3 pan strips (±135°, tilt −55..+2) + ONE polar-cap "floor bowl" (ALL pans, tilt
   −89.95..−55, TILT_SPLIT=−55)**. After ANY grid-topology change, verify referenced-vertex
   world reconstruction (pan/tilt ranges per projection) — f0/f1 prints hide hemisphere flips.

Kuwait raw-frame coverage 56%→80%; only remaining black = true sensor crop (directions
projecting below the frame) + netting corners beyond θ100. Meshes: kuwait at
`/tmp/follow-pair/mesh-fixed` (follow pipeline repointed, drop-in verified: b923 +0.81/15.1/41.1),
footballplus at `PLAYHUB/public/vp-mesh-footballplus`.

**PRODUCTION: deployed + verified.** The /watch player loads `panorama-meshes/{spiideo_game_id}`
from Supabase Storage (`src/lib/panorama/mesh.ts`) — NOT public/vp-mesh-*. All 26 live games
(22 Nazwa scene `131777a6`, 4 Football Plus scene `b3595080`) upserted to v4 via
`ingest_scene_mesh.py`, byte-verified; both scene registries (`playhub_panorama_scene_meshes`)
point at v4 canonicals so new captures auto-inherit. Karim visually approved on the live page.
Rollback: old meshes at `/tmp/imitation/mesh-backup-20260712/`, re-ingest per game.

## 0i. LAYER-1 FOLLOW + PRODUCTION CLAMP (reverted) + CALIBRATION SPIKE (2026-07-12 eve, parallel session)

- **Layer-1 render BUILT** (`follow_render.py`): OUR autofollow (`ball_follow` antiteleport + gap-YOLO-fusion)
  driving OUR picture pipeline (fov **x1.40**, reverse-engineered Spiideo grade, edge-safe savgol,
  void-safe framing). Karim: "better than Spiideo" except the void (now fixed by §0h mesh work).
  Metrics b923 **+0.81 / 15.1° / p90 41.1°**. `ball_follow.py` + `render_smooth.py` now default
  `MESH=/tmp/follow-pair/mesh-fixed` (env `MESH=` overrides); `follow_render.py` inherits via `ball_follow`.
- **Production coverage-aware clampView: BUILT then REVERTED.** Added `clampViewToCoverage` /
  `sampleCoverage` / `CoverageProfile` to `src/lib/panorama/projection.ts` + wired into
  `VirtualPanoramaPlayer.tsx` `clampView`, then **`git checkout`-reverted all 3 files** — clamping
  only HIDES the void; the real fix was mesh coverage (§0h). ⚠️ **If ever rebuilt: bin ONLY
  triangle-referenced vertices** (the polar bowl's converging nadir ring poisons a naive all-vertex
  coverage bin). A verified divergence-proof envelope-clamp prototype (center-clamp + monotonic
  fov-shrink; corner-ray occupancy grid via robust `atan2` — NOT `atan(-X/Z)`, which breaks at ±90°)
  is at `/tmp/imitation/envelope_v2.png`, superseded by the mesh fix.
- **STRATEGIC — automated "calibrate ANY camera" workstream (scoped as a PARALLEL SPIKE, go/no-go).**
  We already have `vp-calibration/{calibrate.py (fisheye fit from field lines), generate_mesh.py}`.
  Prior-art landscape (full report in `~/Obsidian/.../daily/2026-07-12.md`): field-registration =
  **PnLCalib** (2024, maintained) or Sportlight (SoccerNet SOTA); 180° fisheye model = **Double Sphere**
  (`dscamera`); two-lens stitch = per-lens calib → **bundle adjustment** (Ceres/GTSAM) → multi-band
  blend — **NOT homography** (that's the seam-gap cause). Spike design: PnLCalib on a **virtual pinhole
  view** (NOT raw fisheye — chicken-and-egg, needs undistort first), compared to our mesh on
  known-good regions, with a KILL criterion. **Veo = assume STITCHED input** (no raw sensor feeds).
  Do NOT stall the auto-follow data/label work (Step-0 label layer built). Spiideo purges raw
  panoramas ~30 days → capture-on-publish for any calibration dataset.
- **Picture-layer recap** (details §0e–0g): `render_smooth` default fov **x1.40**; `GRADE=1` optional
  (`color_match.py` + `/tmp/imitation/spiideo_grade_lut.npy`); `anti_bow.py` default-off (k1=0 = Spiideo
  parity — no coherent radial residual to correct, verified).

**NEXT SESSION (Karim's ask): flatten the "rounded feel".** The explore view still reads as
curved at the edges and centre. Prior data (§0e) says line-bow is at/below Spiideo's and the
anti-bow radial correction was NULL — so this is NOT lens calibration; it's the **rendering
projection** of a wide fov on a ground plane (rectilinear wide crops bow the far touchline
perceptually). The lever is the view-side projection: evaluate cylindrical / Panini / Spiideo's
own wide-view behaviour at matched fov, and A/B against the current pinhole `.xyzz` render.
Constraint from §0/§1: any change must re-pass the Layer-0 user gate (split/flicker vs Spiideo).
Note the mesh now has 4 projections (3 strips + bowl) — per-strip debug tooling assuming 2 is stale.

---

## 0g. COLOR GRADE reverse-engineered + ZOOM locked x1.40 (2026-07-12 ~16:10)

- ZOOM: Karim found x1.17 (measured Spiideo-match) too tight → **locked FOVMUL=1.40** in
  `render_smooth.py`. Deliberate zoom-out vs Spiideo (more context + follow margin). Mesh coverage
  fine to x1.90/49° at this aim — clamp untouched. Zoom sweep artifact `/tmp/imitation/zoom_sweep.png`.
- COLOR: reverse-engineered Spiideo's grade EMPIRICALLY from paired frames (our raw dewarp vs their
  Play at same aim) — NO Perform access needed (grading isn't API-exposed anyway). Method =
  per-channel **histogram specification** (alignment-free). `color_match.py`
  (learn_luts/apply_luts/save/load/describe); LUT `/tmp/imitation/spiideo_grade_lut.npy`.
- **LESSON (repeat of the alignment trap):** first attempt sampled alignment-masked paired pixels →
  false NEAR-IDENTITY LUT (misaligned/moving-player pixels decorrelate the pairs, every luma bin
  regresses to the global mean). FIX = **FULL-FRAME histograms at MATCHED framing** (fov 1.17);
  histogram matching needs same scene composition, NOT pixel correspondence. Then the grade appeared.
- The grade = **gentle DARKEN + slight DESATURATE** (luma 86→82, sat .150→.142; mids pulled down a
  touch, highlights clip ~249). No real WB shift — the "warmer/greener" look was mostly our higher
  EXPOSURE. Visibly moves ours to Spiideo's muted broadcast look. Wired `GRADE=1` into render_smooth
  (default-off). Compare `/tmp/imitation/color_match_v2.png`.
- CAVEAT: LUT learned from ONE night-match clip → won't generalize to day/other venues. Production
  needs per-venue learn OR an adaptive auto-tone step (our own, since we won't have Spiideo to match).
- Render env flags now: `ANTIBOW=<k1>` (off), `GRADE=1` (off), `FOVMUL=1.40` (default).

## 0e. "HILL" CURVATURE — measured to Spiideo parity; anti-bow built but not needed (2026-07-12 ~15:30)

- Karim on smooth_still (fov 1.17): PLAYHUB pitch reads as an upward "hill" from left goal to
  halfway then down; asked to BEAT Spiideo on flatness with a cosmetic anti-bow warp.
- MEASURED FIRST (normalized bow-profile of a straight world line = fence rail, immune to
  pos/scale/roll): at t=80 centered OURS bows ~0.6–1.1% (near-flat) vs SPIIDEO ~1.4–1.6% (visible
  HILL). Far-touchline earlier agreed (ours 0.74% vs 0.81%). **Ours is equal-or-FLATTER than
  Spiideo on every clean line.** The "hill" is inherent ground-plane perspective of a wide
  rectilinear crop — Spiideo's own Play output shows it as much/more. NOT an ours-only defect.
- BUILT `anti_bow.py` anyway (per request): radial correction on the (u,v) map, single final
  remap (no double-resample), default k1=0 = no-op, |k1|≤0.06 cosmetic bound, reversible.
  `warp_uv(u,v,k1)` + `calibrate()`.
- Calibrated k1 vs line-straightness over 5 frames = **NULL** (mean|bow|~2% flat across sweep,
  k1=0 wins → no coherent radial residual). Eye sweep at t=47: k1=-0.05/-0.03/baseline
  indistinguishable. Strong k1=-0.18 visibly flattens BUT introduces barrel (straight fence/box
  lines bend) = worse. Artifacts: `/tmp/imitation/{antibow_sweep,antibow_strong,rail_hill_compare}.png`.
- **DECISION: keep k1=0 (Spiideo-match).** Can't beat Spiideo on flatness within safe bounds
  because we're already at/below it; beyond bounds it adds a worse artifact. Layer-0 CLOSED again.
  `anti_bow.py` stays available (default-off) if ever wanted. → move to Layer-1 (follow behaviour).

## 0d. MOTION-SMOOTHNESS + fov=1.17 correction (2026-07-12 ~05:40)

- Karim watching the render caught: (a) jerky START ("random point then moves in") + first-5s
  ZOOM BURSTS (in/out); (b) ours looks MORE CURVED than Spiideo.
- (b) ROOT CAUSE = **I over-widened to 1.35× (wider than Spiideo's actual 1.17×)** → more
  peripheral wide-angle perspective → reads more curved though lines are straight. **Corrected to
  fov = footw\*95 * 1.17 = EXACT Spiideo zoom** (matches their perspective/curve; not wider). The
  earlier "1.35× wider for follow margin" was wrong — margin isn't worth looking worse than the
  reference. `render_smooth.py`.
- (a) FIX: aim + fov smoothed with **savgol (mode=nearest, edge-safe)** — the box-filter 'same'
  convolution had biased the first frames (jerky start). fov pipeline: savgol(footw)*1.17 →
  per-frame coverage-clamp → `minimum(savgol(clamp), clamp)` (smooth AND coverage-safe = no
  bursts, no black). Warm-up 1s trimmed (compute trajectory from T0−2, render from T0).
  `/tmp/imitation/smooth_follow.mp4`.
- NOTE: this smoothing is on the RENDER driven by reg aim (picture quality). The AUTOFOLLOW's own
  aim needs the SAME savgol treatment applied to the ball track — next-session Layer-1 work.
- Framing default now: **fov = footw\*95 * 1.17** (was mistakenly 1.35). Awaiting Karim's motion verdict.

## 0c. BLACK-EDGE fix (2026-07-12 ~05:15) — off-mesh clip at wide fov

- Karim spotted a BLACK WEDGE (bottom-right) in our render at 1.35x. Cause: the flat virtual
  camera's rectangular frame extends past the CAPTURED fisheye panorama's coverage (u<0 sentinel
  → black); worse at wide fov near the pitch corners. Spiideo never shows it because its player
  CLAMPS the view (Perform `clampView`).
- FIX: coverage clamp — shrink fov (×0.97 loop) until frame is 100% inside the mesh. Worst frame
  t=34s: fov48/94.7% coverage → clamp fov37/100%, black gone (`black_fix.png`). Baked into
  `render_final.py`; the production `VirtualPanoramaPlayer.tsx::clampView` already does the pan/
  tilt-range + zoom cap version (shrink ranges by half the view angle) — wire our follow through
  it. Tradeoff: fov eases in near edges (not perfectly constant) = correct Spiideo-matching
  behaviour; alt = nudge aim inward (later refinement).

## 0b. LAYER-0 CLOSED via DIRECT TESTS + framing conclusions (2026-07-12 ~04:30)

- **Line-straightness test** (`straightness_proof.py`) — the honest instrument the point-metrics
  lacked. Far-touchline BOW: **OURS 0.74% vs SPIIDEO 0.81%** (t=47, exact frame Karim flagged) —
  ours is straighter than their production. Across pan range OURS 0.1–0.5% vs SPIIDEO 0.5–1.0%.
- **Radial-signature test** — the residual bow has NO consistent sign (+0.8,+1.8,−7.6,−5.6px;
  std>mean) → measurement noise, NOT a systematic distortion. **Nothing to correct** (a radial
  fix would fit noise → regression). Our dewarp is straight to the measurement floor, at/above
  Spiideo parity. True zero would need their exact mesh (partner ask), landing at the same floor.
- **"Tilted/not-flat feel" = FRAMING, not geometry.** Re-aiming (tilt up/down) does NOT flatten —
  it just moves the action off-frame. The lever is **fov**. Karim verdict: the fov-18 "flat" was
  TOO ZOOMED; **match Spiideo's fov (zoomed out)** — keeps flatness, and a WIDER fov makes the
  autofollow far more forgiving (action can't fall out of frame). Demos: `flat_fixed.mp4`,
  `there_wide.mp4` (ours@Spiideo-zoom | Spiideo Play, reg-aimed to isolate flatten quality).
- **NET: Layer 0 (flatten/mesh/dewarp) is SOUND — straight, flat, at/above Play parity, proven by
  direct tests Karim can judge (not point-metrics).** Remaining product gap = the FOLLOW (Layer 1
  aim/smoothness), to be run at ~Spiideo fov for robustness. Framing default LOCKED: **fov = (footw\*95) * 1.35** (my footw*95 estimate was 17% too tight vs
  Spiideo — measured via SIFT scale-to-Spiideo; 1.17x = exact match, Karim chose 1.35x for wider
  follow margin). Wider fov = the autofollow is far more forgiving (action can't leave frame).
  `render_final.py` renders the locked look; `/tmp/imitation/final_follow.mp4`.

## 0. LAYER-0 RE-OPENED (2026-07-12 ~02:00) — user gate; roll/fov were NEVER verified ⚠️

Karim rejected the outputs on sight ("rounded feel") and demanded 100% baseline certainty
before ANY aim/AI work. Investigation found he was right to:

- **Every prior "identical" proof used SIMILARITY (or homography) alignment — which is EXACTLY
  degenerate with camera fov (=image scale) and camera roll (=image rotation).** For a pinhole,
  focal change is pure image scale about the principal point; roll is pure image rotation. So
  the 0.82px landmark stamp and sub-pixel similarity residuals prove the image SHAPE (flatness,
  no bow, no stretch) matches Spiideo — but say NOTHING about fov/roll correspondence.
- **Measured at similarity-locked optima: leftover rotation +2.4°..+8.0°, ALL POSITIVE across
  two independent runs** (random drift would be sign-mixed) → suspected REAL roll difference
  between our `camera_basis` and Spiideo's render. A consistent view-dependent roll is a very
  plausible root of the "rounded/tilted feel" Karim keeps seeing.
- **Mesh provenance corrected:** the mesh we render is OUR OWN FIT (`vp-calibration/
generate_mesh.py` — output schema matches scene.json field-for-field), NOT Spiideo's bytes.
  Validated-against ≠ identical-to. The 100%-identity route: re-run `spiideo-perform-gl-recon.mjs`
  on this game with FULL buffer dumps → diff/ingest their actual mesh vertices. (Existing capture
  has only 8-float buffer samples; their big-buffer sizes ≠ ours, but capture was another game.)
- In flight: non-degenerate 4-param (pan,tilt,fov,ROLL) fit under TRANSLATION-ONLY alignment
  (pins fov+roll in-camera). Artifacts: `baseline_proof.py` → `/tmp/imitation/baseline_proof/`
  (flicker.mp4 + proof_sheet.png — v1/v3 NOT judge-ready; rebuild after roll verdict).
- **Dense-scan retraction (2026-07-12 ~02:10):** the 6-point "systematic roll +2..+8°" did NOT
  reproduce on 20 points (median +0.2°, spread ±2°, no trend, no seam step). Image-space roll
  measurement has hit its noise floor (±2°) — earlier "smoking gun" was overclaimed. fov/roll
  correspondence remains UNDETERMINED (bounded ≲2°); the decisive instrument is BYTE-LEVEL mesh
  comparison, not more image fitting.
- **Mesh-bytes route mapped (2026-07-12 ~02:30):** web-player GL capture BLOCKED — app.spiideo.net
  shows **"Account Paused — Playback Dubai — unpaid invoices"** (⚠️ BUSINESS: flagged to Karim;
  data APIs + CloudFront still working). The sanctioned mesh source (per 2026-07-04 recon):
  **`projection-download` ORDER** on a Nazwa game → signed S3 URLs for THEIR
  vertices/indices/scene.json. `POST /v1/orders` is LIVE (400 validation, not 403) and requires
  `paymentProvider` + `billingAccountId` + `userId` (= <SPIIDEO_PLAYBACK_ADMIN_USER_ID>, from
  JWT). billing-accounts API 403s for this user; NO pricing endpoint found → **order cost unknown,
  on an account paused for unpaid invoices** → escalated to Karim rather than fired. DB registry
  (`playhub_panorama_scene_meshes`): Nazwa scene 131777a6 mesh fanned out from game 2f847a02;
  no projection-download was ever placed ("user nod pending" July 4) → **our bucket mesh = our own
  fit, high confidence.** Capture tooling ready: `veo-automations/spiideo-mesh-capture.mjs`
  (full GL buffer dumps + network bodies; reusable the moment the account unpauses or on the demo
  account for renderer-format validation).
- **STRATEGY LOCKED (Karim, 2026-07-12 ~03:15): Perform-replica on Play-tier data.** The product:
  raw VP (Play tier, proven fetchable) + OUR calibration/dewarp + OUR auto-follow + OUR pannable
  player (+AI features) = what Spiideo charges ~€17k Perform money for, on Play recordings.
  Consequences: (a) **their mesh is validation-only, NEVER a runtime dependency** — the product
  requires OUR fit to be certifiable, and the certification GT is their Play follow-render
  (rendered through their calibration → reg-SIFT artifact tests our fit against it on ANY
  recording, no Perform access needed); (b) **quality bar = the PLAY follow** (Karim: Perform's
  own auto-follow toggle is MUCH WORSE than Play's) — which is exactly what reg-SIFT GT measures.
- **Their-mesh chase CLOSED for now:** demo mesh bytes downloaded (public S3, format=ours,
  `/tmp/imitation/spiideo-demo-mesh/`); ANALYTIC IDENTITY: captured textureToWorld ==
  transpose(R·MOUNT_S) to 0.000°/det+1.0000 using THEIR scene.json → our mesh→world math is
  exactly theirs. Captured projectionMatrices are identity-view (no pan info) → pan/tilt/roll
  composition still uncertified (bounded ≲2°). Perform web = org-paused (all 3 accounts);
  **play.spiideo.com login WORKS (product not paused!) but Play web renders NO WebGL** (server-
  rendered; pannable pano is Perform-only — the exact feature we build ourselves). Nazwa mesh
  routes if ever needed: projection-download order (billing unknowns) or ask Spiideo w/ invoices.
- **GATE: no aim/AI/controller work until Karim signs off Layer 0 on a judge-ready artifact**
  (full-frame split + A/B flicker at their framing — finish the fold-into-camera iteration; the
  similarity-degeneracy lesson means the artifact must pin fov/roll via translation-only checks).
- **NEXT SESSION ORDER: (1) judge-ready Layer-0 artifact → Karim sign-off; (2) follow polish
  toward Play-level (framing/zoom/damped controller, visual QA against Play render); (3) pan UI +
  AI features on top (the differentiated platform).**

## 1. THE DEWARP — shape PROVEN; fov/roll correspondence UNPROVEN (see §0) ⚠️

`mesh_dewarp.py` flattens the fisheye panorama exactly like Spiideo's VirtualPanorama.
Verified TWO independent ways — do not reopen this:

- **Math** (computer-vision-specialist, against Spiideo's real captured shader
  `veo-automations/captured-perform-gl.json` `shaders[19]`): the mesh→world matrices differ
  by a **pure rotation, det = +1.0000**; the bow-removing pinhole divide (`.xyzz`, w = ray
  camera-frame z) is line-identical. Aspect 16:9 (1.778) is correct for the 16:9 Play output
  (the captured 1.5425 was just the browser canvas aspect at capture time).
- **Empirical** (`landmark_stamp.py`): **0.82 px median** landmark reprojection vs Spiideo
  across the full pan range (−64°..+62°), **flat radial profile (edge/center 1.12 = no bow)**.

Residual pixel differences (fence wire mesh, bilinear resampling, color grade) are physical,
not geometry. Validators: `verify_flat2.py`, `fine_frame.py`, `landmark_stamp.py`,
`split_proof.py`, `coverage_check.py` (0% uncovered). **GL-leak bug fixed** in `mesh_dewarp.py`
(was recompiling program+buffers each call → Metal crash; now cached, ~3ms/bake, 10× faster).

`mesh_dewarp.dewarp(frame, projs, pan_rad, tilt_rad, fov_deg, W, H)` is the render call.
`projs,_ = MD.load_mesh("/tmp/follow-pair/mesh")`.

---

## 2. THE SPIIDEO DATA PIPELINE — all fetchable, PUBLIC CloudFront ✅

For every match recorded on Spiideo cams, these streams exist. Discover with
`probe_streams.mjs <gameId>`. **Item files are public** at
`https://d35u71x3nb8v2y.cloudfront.net/{gameId}/{streamId}/item-{00000000}` (no auth;
the `/v2/streams/{id}/playlist` API needs JWT and throttles if hammered).

This session's game: **`b923d40f-e5bc-4803-901b-d7412ba77043`** (Nazwa), window s900 =
game 900–1020s. **All streams startTime = `1783537924240000` (game t0).** Raw VP frame 0
(our `--start 900` fetch) = game 900s = abs `1783538824240000`.

| stream                   | id                                   | format                                                      | notes                                                                                        |
| ------------------------ | ------------------------------------ | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| raw VP (fisheye)         | `2272691d-…`                         | HLS `spd`                                                   | the panorama; `fetch_spiideo_pair.mjs`                                                       |
| Play (AutoFollow render) | `756a591b-…` (mp4)                   | flat                                                        | Spiideo's rendered follow                                                                    |
| **tracklets**            | `87852c5e-…`                         | `{uuid:[{timeOffset,x,y,z}]}`                               | player+ball METRIC (m); **10s items**, abs = START + item·10e6 + timeOffset                  |
| **viewports_v2**         | `39e8a228-…`                         | `{viewportsPointCloud:[{timestamp(ABS),points:[[x,y,z]]}]}` | Spiideo's exact AutoFollow frustum (z=0 ground + z=3 top), METRIC, 10s items                 |
| viewports_football_v2    | `a2fa8dd4-…`                         | viewport                                                    | second viewport variant                                                                      |
| **object-detections**    | `fc1fcd67-…`                         | boxes, **label 1=person, 0=ball-ish**                       | per-result **ABSOLUTE timestamp** (use directly!); ~5s items but ignore item#, use timestamp |
| mesh                     | Supabase `panorama-meshes/{gameId}/` | scene.json+bins                                             | camera at ORIGIN (rotational)                                                                |

**KEY ASSET — detections land PERFECTLY on players' feet in the raw fisheye** (foot =
box bottom-center, normalized coords), _once time-matched by absolute timestamp_. My earlier
"detections don't match" was a time-base bug (I'd fetched det item 90 = game 475s, not 900s).
Gotchas: `label 1` = ~24/frame **including spectators/benches**; `label 0` is NOT a clean ball
(0–3/frame, conf 0.25).

---

## 3. THE MESH GEOMETRY BRIDGE (how pano ↔ ray works)

Mesh vertices give **raw-pano UV (f2,f3) ↔ world ray (via transpose(R·MOUNT_S))**. Define
`rayn = ray.xy / ray.z` (ray-plane). Then:

- pano pixel → ray: `RAYN[cKDTree(UV).query(uv)]`
- ray → pano pixel: `UV[cKDTree(RAYN).query(rn)]`
- **metric ground (z=0) → rayn IS a homography** (pinhole imaging a plane). This is the
  calibration `H` we need. `pano_x → mesh_pan` via `mesh_pan = -(px*W−CX)/F`, W=3840 CX=1820.72 F=1158.15.

---

## 4. THE AIM — viewport streams are NOT Spiideo's camera path (2026-07-11 session 2)

⚠️ **CORRECTION of an earlier "aim solved" claim.** The closed-form viewport follow LOOKS right
at midfield but **points at the OPPOSITE (look-alike) goal on committed plays** — I was fooled
because both goalmouths share the same fence/parking backdrop. Rigorous eval against ground
truth exposed it. Net: **calibration & dewarp & the closed-form inversion are all correct; the
viewport DATA is the wrong signal.**

**What was actually established (with proof):**

1. **`reg_b923d40f.json` (SIFT render↔raw, 100% coverage) IS reliable ground truth of Spiideo's
   aim.** Proof (`reg_vs_play.png`): dewarping the RAW frame at reg's `pano_x/y` reproduces the
   Play render **exactly** (same goal, players, jerseys) at t=48 & t=96.
2. **Neither viewport stream tracks that aim.** `viewports_v2` (39e8a228, cached in `vp/`, 5 Hz)
   AND `viewports_football_v2` (a2fa8dd4, `vpfb/`, 2 Hz) both give a ROI-centroid pano_u of only
   **~0.41–0.71** while Spiideo's true crop spans **0.22–0.78**, and both **correlate ≈0 / negative
   with reg at every lag** (v2 −0.10, fb +0.09). The `viewportsPointCloud` is a **damped central
   activity region, NOT the AutoFollow crop** — its centroid stays near midfield while Spiideo
   commits to the ball at the extremes. `roi_vs_truth.png` shows the ROI polygon sitting on the
   opposite side of the pitch from Spiideo's true aim at t=48/96.
3. **The closed-form inversion & dewarp are correct.** From `mesh_dewarp.camera_basis`,
   `z(pan,tilt)=(-sin pan cos tilt,-sin tilt,cos pan cos tilt)` ⇒ for ray `(rn_x,rn_y,1)=H@metric`:
   `pan=atan2(-rn_x,1)`, `tilt=-asin(rn_y/|·|)` (`viewport_follow2.py::ray_to_pantilt`). At
   midfield (t=24, t=72) our aim matches reg to a few px. The machinery is fine; feed it a real
   aim signal and it works.

**H refinement (SOLID, keep):** `calibrate_refine.py` (seed `H_precise`, spectator pre-mask,
shrinking-gate Hungarian ICP + grid-cell spatial balancing) → **0.056 → 0.0073 rayn, bias-free**
(left≈right, far≈near). Use **`H_metric_to_rayn_refined.npy`**; `_robust` OVERFITS — don't use.

**Root cause = the SAME ball-signal ceiling the project already hit.** Reproducing Spiideo's aim
INDEPENDENTLY needs the ball / decisive-action point. The viewport data was hoped to bypass that
and doesn't. Options in §5.

**What produces a correct follow TODAY (but NOT Spiideo-independent):** `framing_from_reg.py`
(uses reg = requires Spiideo's Play render) + our flat dewarp → `flat3_b923d40f.mp4`. This
re-renders the pitch flat, framed like Spiideo, from the raw panorama — a legit product IF we
always fetch their render (we do). It is NOT an independent AutoFollow reimplementation.

**Eval/diagnostic scripts (this session):** `aim_diag.py` (viewport→pano overlay), `aim_eval.py`
(viewport aim vs reg GT, |pan err|), `reg_vs_play.png`/`roi_vs_truth.png` generators inline.
`viewport_follow2.py` (closed-form, ROI centroid), `viewport_follow3.py` (action-weighted — in-ROI
tracklet density centroid; doesn't help, the ROI itself is the wrong region).

---

## 4b. BALL-FUSION FOLLOW — BUILT, +0.70 corr, render-independent (2026-07-11 session 2)

Path (1) from below, executed. `ball_follow.py` follows the **actual ball** by fusing Spiideo's
two weak DATA signals (no render, no reg at runtime):

- Per frame: conf-weighted centroid of label-0 boxes (conf ≥ 0.40), soft outlier gate (0.20) vs
  the last estimate. NaN when no label-0 (~51% of frames).
- Gap-aware fill (edge-hold → interp) then **Savitzky-Golay(15,2)** on pano_x/pano_y.
- pano → closed-form `ray_to_pantilt` (no H needed — ball is already in pano).

**Scored vs reg ground truth (`aim_eval` axis):** **pan corr +0.70, |pan err| median 16.8°,
p90 47.0°** — vs the viewport baseline's −0.10 / 25.3°. Clears the specialist's accept bar
(corr ≥ 0.65, med ≤ 20°) on b923. Visual QA (`ball_follow_frames.png`): the t=48 frame that
viewport put on the WRONG goal is now correct — we track the real ball. Output
`/tmp/imitation/ball_follow.mp4`.

**Design credit + guardrails (computer-vision-specialist):** the naive conf-weighted centroid is
90% of the gain; a CV-Kalman with velocity coast makes it WORSE (holds/coasts into drift) — HOLD,
don't extrapolate; cross-vote (label-0-near-tracklet) is a soft prior only, not a hard ball-tracklet
selector (short fragments score 1.0 spuriously); global Viterbi TIES greedy → association is not the
bottleneck, **signal availability is**. Track in pano, keep H out of the loop.

**Ceiling (honest):** p90 47° = wrong-goalmouth misses on committed plays, where label-0 vanishes
for 1–3 s (crowded/tiny ball on grassroots night footage). Robust filtering gave ZERO p90 gain —
it's a sustained data gap, not per-frame outliers. Good enough for a **wide overview follow**; NOT
goal-moment parity. The only fix is a trained ball detector on the raw VP in the attacking thirds
(WASB-SBDT — we have experience — or TrackNetV3), the same [[bball-wasb-ball-detection]] data
bottleneck. fov is a placeholder (fixed 34°); tune separately.

**Next:** validate on the other 4 cached `reg_*.json` clips (SAME camera; need each clip's label-0
det stream fetched into `det/`) — accept if corr ≥ 0.65 & med ≤ 20° on ≥4/5. Then decide: ship the
wide ball-follow, or invest in the raw-VP ball detector for goal-moments.

## 4c. GOAL-MOMENTS — anti-teleport shipped; detector + real GOAL-HOLD need data (2026-07-11 s2)

User pushed to close the goal-moment p90 tail. Two levers explored:

**(i) Ball detector transfer test (`phase0_yolo_test.py`) — NEGATIVE.** Ran the existing
`yolov8m_veo_finetuned.pt` (local; ultralytics+sahi local, NO Modal) on the Nazwa raw panorama via
two fixed FLAT tiles (aim-independent, imgsz 1536) + SAHI. Detection rate **midfield 21% / goalmouth
26% / goalmouth-where-label0-absent (the gap) only 18%**, localization ~0.07. **The Veo-daytime-
broadcast detector does NOT transfer to the night raw fisheye** (same domain gap that killed WASB
zero-shot). Closing the tail by detection ⇒ **train a raw-panorama-native detector** (fusion tracker
auto-labels the easy frames + Veo corpus pretraining + some manual goalmouth labels). Multi-session,
GPU. The prior YOLO+SAHI+OC-SORT plan (WASB retired) is in `portrait-crop/wasb/RESUME.md`.

**(ii) GOAL-HOLD — generic form REGRESSES; anti-teleport piece WINS.** Goal zones from reg dwell:
pano_x **L≈0.26, R≈0.73**. p90-tail analysis (`goalhold_analysis.py`): of frames >30° err, 62% reg-
at-goal, 30% we're opposite-side (wrong-goal drift), 35% in a detection gap. Generic goal-zone HOLD
(3 variants: unbounded / bounded / persistence-armed, in `ball_follow.py::track_goalhold`) halves the
TARGET-frame median (13.5→7–10°) but LEAKS to non-target (18→23–27°) and regresses the aggregate —
because it can't tell a goal from a goalmouth attack that bounces out. **Confirms Karim's design was
right: real GOAL-HOLD needs a goal-EVENT trigger** (GT timestamps). Spiideo grassroots publishes NO
goal-event tag (probe: only viewports + object-detections), and no cached clip contains a goal with
ground truth → real GOAL-HOLD needs a vision goal/net-event detector + a goal-containing raw-panorama
validation clip (neither exists yet).
BUT the SAFE sub-piece — **anti-teleport** (`track_antiteleport`, now the DEFAULT): keep the winning
centroid tracker, but when only FAR detections exist (would yank across the pitch to the other goal),
HOLD and require the far cluster to persist TELE_K=4 frames before accepting. **Clean win vs reg:
corr +0.69→+0.76, p90 45.3→41.9° (goal-frames p90 60.9→46.6°, −14°), median unchanged (no leak).**
Output `/tmp/imitation/ball_follow.mp4` (MODE=antiteleport default).

**Goal-moment bottom line:** the wrong-goal-teleport part of the tail is closed cheaply (anti-
teleport). The REST (genuine detection gaps + true ball-in-net occlusion) needs the data/training
investment — a raw-panorama ball detector and/or a goal/net-event detector for real GOAL-HOLD. Same
ball-signal ceiling the project keeps hitting; no free lunch.

**(iii-RESULT) DOMAIN ADAPTATION WORKS — validated on a held-out clip (2026-07-11 s2).**
Fetched 2 more Nazwa clips (same camera, `fetch_spiideo_pair.mjs` + CloudFront det items),
auto-labeled all 3 (`make_ballset.py`, flat-tile crops + fusion ball boxes): b923 414 + 22776d6c
737 (train) + 424e420a 310 (HELD-OUT test). Finetuned `yolov8m_veo_finetuned.pt` on the 1,151
night/fisheye labels (`train_balldet.py`, local MPS, 90/10 split, clip3 untouched). Killed at
epoch 3/15 (MPS is SLOW: ~11 min/epoch → 15ep ≈ 3h; val mAP50 still climbing 0.41→0.48→0.54).
Even at 3 epochs, on the **held-out** clip 424e420a, HONEST **localized** (<0.06 of true ball)
detection vs the Veo baseline (`phase0_yolo_test.py`, now reports any-pick AND localized):

| stratum                        | baseline loc | adapted-3ep loc |
| ------------------------------ | ------------ | --------------- |
| midfield                       | 29%          | 35%             |
| goalmouth                      | 10%          | **39%**         |
| goalmouth GAP (label-0 absent) | **5%**       | **25%**         |

Goalmouth 10→39%, the goal-moment GAP 5→25% (5×) on unseen data — the thesis holds. CAVEATS
(honest): the any-pick rate (50% gap) was FP-inflated — localized is 25%, so ~half the gap picks
are false (`adapt_verify.png` visual confirmed sparse on-ball dets) → an FP tail a tracker must
filter; and this is 3 epochs on 2 clips. **NEXT: (1) full 15-ep run on MODAL GPU (MPS too slow) on
all available clips; (2) wire detector into `ball_follow` as a fused/primary ball source + OC-SORT

- the anti-teleport gate → measure the actual FOLLOW p90 drop (the real deliverable, not detection
  rate); (3) validate on the remaining clips (48e16a16, 986c7896 — fetch raw VP + det).** Adapted
  weights `/tmp/imitation/yolov8m_nazwa_adapt.pt`; dataset `/tmp/imitation/ballset/`.

**(iii-b) SCALE + INTEGRATION round (2026-07-11 s2 late).** Data 2×: fetched clips 4+5
(48e16a16 START=1783098124784000, 986c7896 START=1783527004801000; same camera) → ballsets 618+573
→ **2,342 train labels over 4 clips**, clip3 still pure. Modal training (`train_balldet_modal.py`,
A10G, Volume `nazwa-ballset`, 15ep) → `yolov8m_nazwa_adapt_v2.pt`. Integration
(`precompute_yolo_ball.py` → `ball_follow.py` FUSE_YOLO): measured on the FOLLOW metric:

- **clip3's tail is NOT availability-driven** (only 17% gap; 83% label-0-present-but-wrong,
  midfield) → fusion can't and doesn't move it (33.5°→32.9° p90). Every clip has a different
  bottleneck; b923's tail IS gap/goalmouth-driven.
- **Naive candidate-pool fusion HURTS** (b923 antiteleport +0.76→+0.66): 82% of YOLO picks land
  on frames label-0 already covers, and 3-ep gap precision ~25% injects 75%-wrong cands.
- **Gap-fill-only + temporal consistency (`FUSE_YOLO=gapc`, R=0.05 K=2/4 neighbors) is the SAFE
  fusion** — removes all harm (b923 back to +0.75/44.7), neutral with the weak 3-ep detector
  (~40 surviving cands). The injection threshold: gap precision must beat hold+smooth (~50%+).
- **Lead hypothesis REJECTED** (clip3): corr(signed err, ball vel) = −0.27 — Spiideo does NOT
  lead our ball estimate; adding lead worsens. Don't revisit.
- **v2 RESULT (15ep A10G, 2,342 labels, ~$1): held-out clip3 localized detection
  midfield 57% / goalmouth 44% / GAP 35%** (vs Veo-base 29/10/5 and 3-ep 35/39/25) — scaling holds,
  7× on the gap vs baseline. Final val P .75 R .75 mAP50 .77 (vs .54 @3ep). Gap firing precision
  ≈41% (any 85% vs loc 35%). Weights `/tmp/imitation/yolov8m_nazwa_adapt_v2.pt` (3-ep JSONs kept
  as `*_3ep.json`).
- **v2 FOLLOW VERDICT (`fusion_matrix.sh`, antiteleport):**
  - **b923 (gap-driven tail; detector train-tainted = upper bound): +0.76/16.1/44.7 →
    gap@0.45 **+0.82/14.8/40.8** — all three metrics improve (corr +.06, med −1.3°, p90 −3.9°).
  - **clip3 (honest held-out; tail NOT gap-driven): +0.71/11.6/33.5 → gap@0.30 +0.73/10.6/34.1;
    gapc@0.60 +0.75/11.0/34.8** — corr+median improve, p90 flat (as its tail is 83% wrong-pick,
    not gaps — fusion has nothing to fill).
  - Day's full b923 arc: viewport −0.10/25.3°/87° → fusion +0.70/16.8/47 → antiteleport
    +0.76/16.1/44.7 → **+v2 fusion +0.82/14.8/40.8**.
  - **THE HONEST PROOF — DONE (clip6 d9fee1fc, same session).** Enumerated Nazwa games from
    `playhub_match_recordings` (same `spiideo_scene_id` as b923; ~30 available). Picked
    d9fee1fc (2026-07-10 night), **chose the gap-richest 150s window by scanning det items
    BEFORE downloading video** (677–827s, 41% label-0 presence — lowest in the match; det scan
    items cached `det_scan_d9fee1fc/`). START=1783703644213000, WOFF=677. Same-camera verified
    (`camcheck6.png`). reg GT via `register_render.py`: 94% coverage, 47 median inliers, heavy
    right-goal dwell (445/736 frames) = a real goal-siege window. **Never seen by training or
    any tuning. Result (antiteleport): label-0-only +0.44/21.3°/p90 61.7° → +v2 `gap@0.30`
    fusion **+0.49/18.5°/p90 49.7°** — p90 −12.0° (−20%), median −2.8°, corr +0.05.** The
    gap-fill thesis reproduces honestly, gains concentrated exactly in the goal-moment tail.
  - **`gap` now BEATS `gapc` with v2** (gapc 62.9 vs gap 49.7 p90 on clip6): the temporal filter
    was the safety net for the WEAK 3-ep detector; with v2's precision it over-prunes true
    cands. Production setting: **FUSE_YOLO=gap, YOLO_CONF≈0.30–0.45, MODE=antiteleport.**
  - Clip6 detection stratification (2nd held-out point, n=57 gap frames): baseline Veo weights
    localized-gap **0%** → v2 **19%** (harder clip than clip3's 35% — real goal siege). v2
    any-pick 96% = high FP rate on hard clips; gap-only fusion + tracker absorb it, but raw
    precision is the growth axis → the retrain loop (more auto-labeled clips) raises it directly.
  - Productionize next: wire v2 + gap-fusion as the follow signal (per-clip precompute →
    `ball_follow` → closed-form aim → mesh dewarp render); periodically re-train as more
    auto-labeled clips accumulate (`make_ballset.py` + `train_balldet_modal.py` are turnkey).

**(iii) Raw-panorama detector — auto-labeler BUILT (`make_ballset.py`), started.** Generates a
YOLO-format ball dataset by rendering the flat tile around each CONFIDENT fusion detection (label-0
present, not held) + a ball box. b923: **414 labels** (240 goalmouth / 174 midfield), 54% frame
coverage. Purpose = domain-adapt `yolov8m_veo_finetuned.pt` to the night/fisheye ball APPEARANCE
(label-0 gives _where_, YOLO learns _what_ to generalize). **Caveats (honest):** (a) labels are
label-0-quality — `labeled_montage.png` shows plausible-but-faint 8-12px balls, some ambiguous →
noisy training target; (b) auto-labels ONLY cover easy frames (the goalmouth-occlusion gap has no
labels by construction) → domain adaptation lifts detection broadly but can't manufacture signal
where the ball is invisible; (c) **needs SCALE + a held-out clip**: b923 is one camera/night/120s —
valid training needs the other Nazwa clips' RAW VP + det streams FETCHED (only b923's are cached),
then a Modal finetune, then re-run `phase0_yolo_test.py` with adapted weights (target: goalmouth
detection > the 18% baseline). Realistic ceiling given label noise: incremental, not a full fix.
The truly-occluded frames still route to GOAL-HOLD (needs the event trigger). Prior full pipeline
(CVAT, 147k Veo corpus, train harnesses) in `portrait-crop/wasb/RESUME.md` — reuse for scale/manual
goalmouth labels.

## 5. WHAT TO DO IN A NEW SESSION (the real decision)

The wide-follow-parity problem reduces to the **ball / decisive-action signal** — the exact
ceiling the project already named (see [[follow-camera-imitation-and-mesh-dewarp]] memory:
"Spiideo commits to the ball; our features track the centroid"). The viewport data does NOT
bypass it. Three honest paths:

1. **Ball proxy → drive aim from the ball (independent, hard).** Extract a ball position per
   frame: (a) `label 0` detections filtered by motion coherence + nearest-to-previous, (b) MOG2
   blob on the raw VP, or (c) fastest-moving metric tracklet cluster. Map ball→pano via the
   refined H → closed-form `ray_to_pantilt`. The machinery (§4.3) is ready; the ball signal is
   the whole game and is data-starved on grassroots. This is the only route to true independent
   AutoFollow parity.
2. **Ship the reg-SIFT follow (works today, NOT independent).** `framing_from_reg.py` re-renders
   the pitch flat, framed like Spiideo, using their Play render as the framing guide. Legit
   product ("flat broadcast render from the raw panorama") if we always fetch their render.
3. **Accept a damped-centroid overview follow.** `viewport_follow2/3` give a smooth, watchable
   follow that's right at midfield but occasionally frames the wrong group on committed plays.
   Fine for a casual "wide overview", NOT for highlight/goal moments.

**Strategic note (from the memory):** the prior recommendation was to STOP chasing Spiideo-parity
on the wide follow (commodity; they have a multi-year ball-signal lead) and redirect to per-player
coach-confirmed highlights (the defensible gap). This session's negative result reinforces that.

### Reusable assets that ARE solid

- **Dewarp** (`mesh_dewarp.py`) — proven identical to Spiideo (§1).
- **Refined H** (`H_metric_to_rayn_refined.npy`) — 0.0073 rayn, bias-free, validated on feet.
- **Closed-form ray→pan/tilt** (`viewport_follow2.py::ray_to_pantilt`) — correct; just needs a
  real aim signal (the ball) instead of the viewport ROI.
- **reg-SIFT ground truth** (`reg_b923d40f.json`) — reliable Spiideo aim, for evaluating any
  future aim signal (`aim_eval.py` is the harness).

### Gotchas to remember

- **Neither viewport stream is the camera path** — don't retry viewport-follow expecting parity.
- **Validate against reg ground truth, not eyeballing** — two look-alike goalmouths fooled the
  eye for a whole session. `aim_eval.py` / `reg_vs_play.png` catch it in one shot.
- Use **`H_metric_to_rayn_refined.npy`** (bias-free); the `_robust` file overfits.
- Detection time = ABSOLUTE `timestamp`; tracklet/viewport = 10 s items from game t0
  (abs = START + item·10e6 + offset). START = 1783537924240000; RAWABS0 = START + 900e6.
- CloudFront items are public (`d35u71x3nb8v2y.cloudfront.net/{game}/{stream}/item-XXXXXXXX`).

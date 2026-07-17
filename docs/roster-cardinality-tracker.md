# Roster-cardinality player tracking — design

**Status:** design (Tier 1 shipped; Tier 2 not built). 2026-07-17.
**Owner ask (Karim, after the Tier 1b lock eyes-on):** "as soon as you see the first image of
the pitch, count how many players, and you can't have more trackers than players." Standardize the
tracker count.
**Scope:** the player-spotlight / player-locked camera on the Explore de-warp (`/watch`), fed by the
offline tracklets job. Related: [player-identity-reid-negative], [playhub-spotlight-player-follow-direction],
[stitcher-measured-ceiling-and-demotion-bug] (auto-memory); `infrastructure/batch/player-tracklets/`.

---

## 1. Context — what we saw, and why this is the identity layer

On the shipped locked follow, three artifacts were observed on real footage:
- **(a)** a locked player is lost and the camera **drifts to the pitch edge tracking nobody**, then goes "lost";
- **(b)** a **new tracker id lands on that same player** a moment later;
- **(c)** sometimes **two trackers sit on one player**.

All three are symptoms of the one hard problem this workstream has measured to death: **we SEE every
player (~101% coverage) but we cannot keep their NAME.** Spiideo's tracklets fragment every ~14–22s
and are never re-linked past ~2s; appearance re-ID is a measured dead end (it reads the *kit*, not
the player); geometric stitching tops out ~20–28s at high purity. The owner's "cap the trackers"
instinct is the right *structural* move — it is **fixed-cardinality multi-object tracking** — but a
cap is a **cardinality** bound, not an **identity** solution. This doc draws that line precisely.

## 2. The load-bearing framing (do not lose this)

**The roster is the substrate the parked jersey path plugs into.** The entire argument for jersey
numbers in our re-ID work was: *stop chaining fragments; assign fragments to a fixed roster of N
slots, so errors become independent against a label instead of compounding to ~0 over ~150 breaks a
match.* That N-slot roster is exactly what "never more trackers than players" builds. So the slot
layer is **not** duplicate-dot polish — it is the scaffolding Tier 2 (identity) fills:

> **the cap creates the slots; jersey OCR (or a human re-pick) labels them.**

That is why the slot-assignment layer belongs **deliberately in the offline batch job** that builds
`tracklets.json` (with the metric data, non-causal, versioned with the pipeline), not as a quick
client-side dedup. Build it as load-bearing infrastructure for the prize, and document it (this doc).

## 3. THE invariant — an empty slot beats a wrong slot

**A slot layer can trade *visible* fragmentation for *invisible* slot-swaps.** When two players cross
and occlude, a naive assignment keeps the count at N and looks clean, but slot #7 can silently become
player B after the crossing — rendered as a confident, solid slot-track gliding A→B. That is the
**same failure mode as every wrong-follow we've hit** (the coach read as "4", the wrong-kid camera, a
bridged gap rendering as a confident ring). For a follow-my-kid product, **confidently-wrong is worse
than honestly-lost.**

> **The slot optimizer MUST prefer to leave a slot UNFILLED (or the followed selection to go honestly
> "lost") over guessing an assignment it isn't sure of.** This is the single most important line in
> this design. Bake it into the cost/gating of the optimizer (an explicit "no-assignment" option per
> slot with a finite cost, and a confidence gate on the *followed* slot). If that principle holds,
> the rest is tuning.

## 4. Estimating N — robustly, across the match (not one frame)

"Count from the first frame" is fragile at exactly that frame (kickoff clusters occlude at centre; a
keeper can be at the far post / behind the mast / outside the crop). And N is **not** a constant.

- **N = p95 of the DEDUPLICATED simultaneous on-pitch cluster count over a stable window.** Not the
  median, not a single frame. (`median_concurrency` in `entrypoint.py` is ≈ N × fragment-coverage ≈
  N/2 — it undercounts by construction; that's why its gate is 8 for a ~16-player game. Do not use it
  as N.)
- **Deduplicate before counting** (in metric xy, before the homography): cluster at ~1.5–2 m and
  count clusters, not fragments — otherwise duplicate fragments (artifact c) inflate the count.
- **Per-format, derived per match, never hardcoded:** 5-a-side (Nazwa, Football Plus) = 6/side incl.
  GK; 11-a-side (CFA, HCT) = 11/side. Hardcoding 16/10 is the same n=1→constant trap that produced
  the wrong 105×68 pitch constant.
- **Re-estimable over the match:** subs are 1-for-1 (N stable) but red cards / injuries drop N — do
  not freeze N match-wide from minute 1; re-estimate per half (or allow it to step down).
- **Referees are on-pitch** and the field-of-play polygon does NOT remove them. Accept
  `N_effective = players + on-field officials` (a cap loose by 1–3 still kills the gross
  duplicates/phantoms); do not build a ref classifier. Flag `officialsIncluded: true` in `meta`.

## 5. The plan — four tiers

### Tier 1 — display fixes (SHIPPED, client-only, no new data)
Directly fixes the three observed artifacts at the render layer; keeps the honest-loss contract.
Commit `7a53850` on `feat/tier1b-player-lock-camera`.
- **(a)** post-loss **coast is decayed + capped** at the re-assoc radius (`SPOT_COAST_*` in
  `VirtualPanoramaPlayer.tsx`) — the aim eases to a stop where the player vanished instead of
  projecting terminal velocity to the frame edge.
- **(c)** the **dot overlay de-duplicates** in pixel space (`SPOT_DOT_MERGE_PX`) against placed dots
  and the followed ring.
- **(b)** re-association **adopts a co-located (<0.5°) pickup** immediately without spending an
  identity-hop (a tracker re-index in place = the same player).

### Tier 2a — publish N + cap the count (cheap; ship next)
- In the batch job `main` (`entrypoint.py`), compute **N** per §4 beside `median_concurrency`, and
  publish `meta.rosterN` (+ `meta.concurrencyP95`, `meta.officialsIncluded`) in
  `build_track.build_payload`. `tracklets.ts` reads it.
- Client: the Tier-1c dot loop additionally **stops after N placed dots** (surplus = duplicates /
  phantoms by construction). Delivers the owner's literal ask with no change to the follow logic.

### Tier 2b — offline N-slot global assignment (the real layer)
Replace the ~2000-fragment artifact with **N slot-tracks**. After `stitch`/`filter_chains_on_pitch`,
solve a **fixed-cardinality assignment** of active fragments → N slots at each 5 Hz step, 1:1, on
world distance + motion prediction, then run the existing `smooth_and_resample` → `build_payload`.
- **Belongs offline** (not the client): it can be **non-causal** (use future frames, like the RTS
  smoother already does) — strictly better than the client's one-shot greedy re-assoc — and lives
  with the metric data.
- **Enforce §3:** the optimizer carries a per-slot **"leave unfilled" option** with finite cost and a
  **confidence gate on the followed slot**; it must prefer empty/lost over a low-confidence guess.
- **Algorithm** (from prior art): start with **Hungarian per-frame + "only the N most-confident
  tracks are active"** as the fast baseline; the principled global version is **min-cost network
  flow** with a cardinality constraint (Zhang, Li & Nevatia 2008 — proven, polynomial, exact; ref
  impl `muSSP`) or **lifted multicut** (LMGP, validated on SoccerNet — partitions *fragments* into
  exactly N chains, so it consumes our input directly). Skip CPHD / JPDA / MHT (over-engineered:
  CPHD is for unknown cardinality under clutter; MHT is O(N!)).
- **What 2b buys:** kills duplicates (1:1), kills phantoms (no seat when all N are claimed by better
  candidates), bounds the count to exactly N, flicker-free overlay.
- **What 2b CANNOT do (say it plainly):** a slot is a **seat, not a name.** Across an occlusion the
  seat can swap occupants — count stays N and duplicate-free, but slot #7 is a different player. §3 is
  the whole point. **Ship 2b for the OVERLAY/count-bounding only; keep the *followed* selection on
  honest-loss** (drop to "lost", human re-anchors) until identity (Tier 3) lands.

### Tier 3 — identity (the prize; still gated)
Label the slots with a **chain-independent anchor** — **jersey number OCR** (what Veo, Second
Spectrum, SkillCorner, TRACAB all do; never appearance) or a **human re-pick**. This is what makes
"keep my kid all match, unattended" possible and unlocks the auto per-player reel. Parked; corpus =
Veo's per-jersey tracks + CFA's team-labelled highlights ([veo-jersey-corpus-facing-not-size],
[phase-5-kit-detection]).

## 6. Validation — on MOVING footage, holding out a DOMAIN (the recurring trap)

Green unit tests and a static `tracklets-validate.png` have repeatedly passed while a motion feature
was visibly broken (twitch saga ×2, the eval that scored a branch production doesn't run). Score the
**shipped** decision function by **calling it**, and hold out a **domain** (a venue / a match
segment), never random samples.

Extend `veo-automations/spotlight-motion-verify.mjs` to log per frame
`{clock, nDotsDrawn, nDupPairs, selIndex, lostSince, coastDeg, aimEdgeDistDeg}` → JSON, and measure:
1. **tracker-count vs N** — ≤ N always; p95 sits *at* N (chronically under ⇒ estimator too high).
2. **duplicate-on-one-player rate** — pairs within the merge threshold; ~0 post-dedup (artifact c).
3. **edge-drift per loss** — coast ≤ `SPOT_COAST_MAX_DEG`, aim never rests at the frame edge (a).
4. **co-located re-pickup rate** — fraction adopted vs dropped-to-lost when a fresh fragment sits in
   place (b); ~100%.
5. **follow purity (the one that matters)** — P(ring still on the person you clicked at T=5/15/30/60s).
   Eyeball on recorded clips; **median chain/slot duration CANNOT referee this** — a wrong bridge /
   slot-swap makes tracks *longer*, so duration rises under the failure mode being risked.
- **Render a VIDEO overlay, not a still**, on clips chosen where the artifacts live: goalmouth
  scramble (occlusion → c + cap), fast counter (a), throw-in/sub (roster count), keeper-behind-mast
  (N undercount).
- **Null-test N + hold out a venue:** hand-count a stable frame across 2–3 games spanning **both
  formats** (5-a-side vs 11-a-side) and confirm the p95-deduped estimate matches (± refs).

**To pressure-test before build (offered by the strategy seat):** the N-estimator and the
slot-swap-vs-lost policy against everything measured in [player-identity-reid-negative] and
[stitcher-measured-ceiling-and-demotion-bug].

## 7. Change points (from the feasibility review)

- **Tier 2a (offline):** compute N in `infrastructure/batch/player-tracklets/entrypoint.py` `main`
  (beside `median_concurrency`); publish `meta.rosterN`/`concurrencyP95`/`officialsIncluded` in
  `build_track.build_payload`; client caps the dot count in the Tier-1c loop
  (`VirtualPanoramaPlayer.tsx` `updateSpotlightOverlay`) and `tracklets.ts` parses the new `meta`.
- **Tier 2b (offline, pilot-flagged):** new N-slot global-assignment stage after
  `stitch`/`filter_chains_on_pitch` in `entrypoint.py`, emitting N slot-tracks through the existing
  `smooth_and_resample` → `build_payload` path — overlay/count only; the followed selection stays
  honest-loss until jersey lands.

## 8. References
- Zhang, Li & Nevatia 2008, *Global data association via min-cost network flow* — the proven exact
  fixed-cardinality formulation. Ref impl: `muSSP` (github.com/yu-lab-vt/muSSP).
- *LMGP: Lifted Multicut Meets Geometry Projections* (arXiv 2111.11892) — partitions tracklets into N
  chains; validated on SoccerNet.
- *Basketball-SORT* (arXiv 2406.19655) — dynamic cardinality cap (top-K longest-lived = the N players).
- SoccerNet Tracking / Re-ID challenge (github.com/SoccerNet/sn-tracking); MOTChallenge.
- Commercial identity anchors are jersey/roster, never appearance: Veo Player Spotlight (jersey OCR),
  Second Spectrum / TRACAB (multi-cam 3D), SkillCorner All-22.
- `scipy.optimize.linear_sum_assignment` (Hungarian baseline).

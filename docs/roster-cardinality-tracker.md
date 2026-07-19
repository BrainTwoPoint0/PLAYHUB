# Roster-cardinality player tracking — design

**Status:** Tier 1 + Tier 2a SHIPPED (rosterN live, N=15 eyes-on validated). **Tier 2b
fully explored 2026-07-17 → geometry is EXHAUSTED; both defects need Tier 3 (jersey).**
Full trail: `scripts/player-identity/tier2b/RECORD.md`; B handoff: `tier2b/NEXT-SESSION-B.md`.
Findings: (1) point-level per-frame Hungarian scatters identity — DEAD; (2) fragment-level
bridging for the FOLLOW is 8-22% swap (venue-dependent; the FP holdout broke the Nazwa
optimism), and min-cost flow does NOT beat the greedy (§3 ambiguity-refusal > global
optimality); (3) the "cheap safe overlay dedup" (Option A) does NOT exist cleanly —
Spiideo's duplicate fragments sit 1-1.7m apart, the same regime as close-marking players,
so no safe radius separates them and motion only weakly does. **Both the duplicate dot (c)
and the follow-drop (b) converge on Tier 3 (jersey): one number → one dot + a persistent
follow.** `dedup_concurrent` (+11 tests, 2 specialist reviews) is kept dormant (not wired).
Next = Tier 3, and its FIRST move is a gate: can a jersey be read off a SPIIDEO raw-VP crop
at all? (the reader is Veo-trained; /watch is Spiideo). 2026-07-17.
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
and are never re-linked past ~2s; appearance re-ID is a measured dead end (it reads the _kit_, not
the player); geometric stitching tops out ~20–28s at high purity. The owner's "cap the trackers"
instinct is the right _structural_ move — it is **fixed-cardinality multi-object tracking** — but a
cap is a **cardinality** bound, not an **identity** solution. This doc draws that line precisely.

### 1.1 Concrete eyes-on frame (2026-07-19) — why distance can't fix it

Captured on the shipped Spotlight during the display-honesty eyes-on. Reproduce:
`/watch/435be371-3a89-4e5e-b17a-7287639b65f8` (Nazwa, game `afb81f5f…`, scene `131777a6…`),
Explore → Spotlight, **462 % zoom**, t ≈ 0:17. A central 5-a-side scrum: a referee, a white-shirt
player, and a yellow-bib player all within **~2 m** of each other carry **4 dots for 3 bodies** —
one duplicate fragment (artifact **c**) sitting **2–3 m** off its body — plus a **4th isolated dot
drifting onto empty grass** below the cluster (artifact **a**: a fragment that "got lost while
tracking").

This frame is the proof that **no distance threshold can separate a duplicate from a distinct
player**:

- The duplicate sits **above** both dedup radii the pipeline already uses — the producer's
  `DEDUP_MERGE_M = 0.9 m` (metric, pre-homography) and the client's `SPOT_DOT_MERGE_DEG = 0.5°`
  (≈ sub-metre near-side). Both are deliberately duplicate-grade.
- Yet **three genuinely distinct players are within ~2 m** in the very same frame. Any radius wide
  enough to merge the 2–3 m duplicate would collapse the scrum's real players into one dot —
  swallowing a real body (the exact loss §3 forbids).
- So the ambiguous 0.9–3 m band contains **both** duplicates and distinct-in-a-scrum players, and
  distance alone cannot tell them apart. **Only identity can** — assign each fragment to a fixed
  slot, and the duplicate shares the followed body's slot (→ one dot) while the grass-phantom
  matches **no** reachable slot and is left **unfilled** rather than drawn (§3, in the wild).

The shipped display fixes (angular zoom-stable dedup + dashed bridged spans) were only ever the
_honesty_ layer: they stop close duplicates splitting on zoom and stop a bridged glide masquerading
as tracked. They **cannot** and were never meant to remove this frame's duplicate or phantom — that
is precisely Tier-2b's job.

**Frame 2 (same session, 384 % zoom, Football Plus-style scrimmage) — the lock drop that proves the
point.** A white-shirt player carried **two dots** (a duplicate). The viewer was locked on one; that
fragment **ended**, and the lock went **"lost"** — even though the twin dot was **still visible on
the very same player**. This is artifact **(a)/(b)** in its purest form, and it is not a bug in the
re-association to be "tuned away":

- On fragment death the follow tries geometry re-association within `SPOT_REASSOC_DEG` (2.5°), but
  with a **deliberate ambiguity refusal** — if any rival sits within ~`d+0.8°` of the lost spot it
  **refuses** rather than risk following a stranger (`VirtualPanoramaPlayer.tsx`, the `ambiguous`
  gate). In a scrimmage the twin is a **different fragment id 2–3 m away**, and geometry alone
  **cannot distinguish "my player's duplicate" from "a different player who wandered close."** So it
  correctly refuses — **honest-lost, which §3 says beats confidently-wrong.** The frustration ("the
  right body was RIGHT THERE") is exactly the cost the identity layer is meant to remove, and it is
  the reason a distance heuristic is the wrong tool.
- **Tier-2b dissolves it:** the twin would carry the **same slot**, and the slot hand-off adopts a
  slot-mate **at any distance with no ambiguity gate** (already wired: the `sel.slot` → `slotMate`
  path). One slot = one dot also means the duplicate never renders as a second dot in the first
  place. The follow survives the fragment death because it is riding a **label**, not chasing
  geometry.

So the two frames together are the whole argument: **Frame 1** — distance can't separate duplicate
from distinct; **Frame 2** — distance can't hand a lock across a fragment death without risking a
stranger. Both need a per-fragment **identity/slot**, assigned offline (§5, Tier-2b), preferring an
**unfilled slot / honest-lost** over a guess (§3).

## 2. The load-bearing framing (do not lose this)

**The roster is the substrate the parked jersey path plugs into.** The entire argument for jersey
numbers in our re-ID work was: _stop chaining fragments; assign fragments to a fixed roster of N
slots, so errors become independent against a label instead of compounding to ~0 over ~150 breaks a
match._ That N-slot roster is exactly what "never more trackers than players" builds. So the slot
layer is **not** duplicate-dot polish — it is the scaffolding Tier 2 (identity) fills:

> **the cap creates the slots; jersey OCR (or a human re-pick) labels them.**

That is why the slot-assignment layer belongs **deliberately in the offline batch job** that builds
`tracklets.json` (with the metric data, non-causal, versioned with the pipeline), not as a quick
client-side dedup. Build it as load-bearing infrastructure for the prize, and document it (this doc).

## 3. THE invariant — an empty slot beats a wrong slot

**A slot layer can trade _visible_ fragmentation for _invisible_ slot-swaps.** When two players cross
and occlude, a naive assignment keeps the count at N and looks clean, but slot #7 can silently become
player B after the crossing — rendered as a confident, solid slot-track gliding A→B. That is the
**same failure mode as every wrong-follow we've hit** (the coach read as "4", the wrong-kid camera, a
bridged gap rendering as a confident ring). For a follow-my-kid product, **confidently-wrong is worse
than honestly-lost.**

> **The slot optimizer MUST prefer to leave a slot UNFILLED (or the followed selection to go honestly
> "lost") over guessing an assignment it isn't sure of.** This is the single most important line in
> this design. Bake it into the cost/gating of the optimizer (an explicit "no-assignment" option per
> slot with a finite cost, and a confidence gate on the _followed_ slot). If that principle holds,
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

### Tier 2a — publish N + cap the count (SHIPPED, commit `1b3f3fd`)

- `build_track.estimate_roster_n(chains)` = the **p95 of the de-duplicated (~1.7 m) concurrent
  on-pitch body count** over the tracked span (`ROSTER_*` consts); published as `meta.rosterN` +
  `meta.officialsIncluded` in `build_payload`. `tracklets.ts` parses the optional `rosterN` (absent →
  no cap; backward-compat with pre-Tier-2a artifacts).
- Client: the dot overlay **stops after `rosterN` placed dots** (the followed ring is one of N, so its
  budget is N−1). Delivers the owner's literal ask with no change to the follow logic.
- **Pending to make it live:** the tracklets Batch job must be **redeployed (CodeBuild→ECR) and the
  artifacts re-run** to populate `meta.rosterN`; until then the cap is inert. Do NOT `terraform apply`
  bare in this workspace (drift replaces the ball-detection CE — see the veo-capture decision).

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
  impl `muSSP`) or **lifted multicut** (LMGP, validated on SoccerNet — partitions _fragments_ into
  exactly N chains, so it consumes our input directly). Skip CPHD / JPDA / MHT (over-engineered:
  CPHD is for unknown cardinality under clutter; MHT is O(N!)).
- **What 2b buys:** kills duplicates (1:1), kills phantoms (no seat when all N are claimed by better
  candidates), bounds the count to exactly N, flicker-free overlay.
- **What 2b CANNOT do (say it plainly):** a slot is a **seat, not a name.** Across an occlusion the
  seat can swap occupants — count stays N and duplicate-free, but slot #7 is a different player. §3 is
  the whole point. **Ship 2b for the OVERLAY/count-bounding only; keep the _followed_ selection on
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

1. **tracker-count vs N** — ≤ N always; p95 sits _at_ N (chronically under ⇒ estimator too high).
2. **duplicate-on-one-player rate** — pairs within the merge threshold; ~0 post-dedup (artifact c).
3. **edge-drift per loss** — coast ≤ `SPOT_COAST_MAX_DEG`, aim never rests at the frame edge (a).
4. **co-located re-pickup rate** — fraction adopted vs dropped-to-lost when a fresh fragment sits in
   place (b); ~100%.
5. **follow purity (the one that matters)** — P(ring still on the person you clicked at T=5/15/30/60s).
   Eyeball on recorded clips; **median chain/slot duration CANNOT referee this** — a wrong bridge /
   slot-swap makes tracks _longer_, so duration rises under the failure mode being risked.

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

- Zhang, Li & Nevatia 2008, _Global data association via min-cost network flow_ — the proven exact
  fixed-cardinality formulation. Ref impl: `muSSP` (github.com/yu-lab-vt/muSSP).
- _LMGP: Lifted Multicut Meets Geometry Projections_ (arXiv 2111.11892) — partitions tracklets into N
  chains; validated on SoccerNet.
- _Basketball-SORT_ (arXiv 2406.19655) — dynamic cardinality cap (top-K longest-lived = the N players).
- SoccerNet Tracking / Re-ID challenge (github.com/SoccerNet/sn-tracking); MOTChallenge.
- Commercial identity anchors are jersey/roster, never appearance: Veo Player Spotlight (jersey OCR),
  Second Spectrum / TRACAB (multi-cam 3D), SkillCorner All-22.
- `scipy.optimize.linear_sum_assignment` (Hungarian baseline).

## Eval harness — Tier-2b's OPENING MOVE (contract locked 2026-07-18, build in a fresh session, plan-first)

Before any slot-assignment code: a standard identity-eval harness, because median
chain duration provably cannot see identity errors (wrong bridges LENGTHEN chains)
and every measurement so far has been bespoke. Base = `roboflow/trackers`'
TrackEval-aligned evaluator (HOTA/IDF1/MOTA) + its Optuna tuner; GT = the Veo
capture corpus (tracking.json, 97.4% jersey-labelled, per-match camera model).

Three constraints are LOAD-BEARING — carrying them in is the whole point of this
section:

1. **Regime split.** Dev on Veo GT, but Veo's fragmentation regime (2.5 Hz,
   65.6s median tracks) is NOT what we ship into (Spiideo 5 Hz, ~16s). Final
   sign-off for anything Tier-2b ships = Spiideo data scored against HCT jersey
   GT (and successors). A number earned only on Veo describes a friendlier world
   — the "scored a branch production doesn't use" failure class.
2. **Crossing-correlated cuts.** When synthesizing Spiideo-like fragmentation on
   Veo tracks, cut where inter-player distance collapses — 59% of real chain
   deaths happen with another player <1.5° away (2026-07-15 measurement).
   Uniform-random cuts produce isolated-player gaps and inflate every score.
   Match the synthetic gap-length distribution to the measured one (~22s uuid
   lifetime, gaps 1.5-5s dominant) and keep identity truth across cuts via the
   jersey labels.
3. **Per-T curve on top.** The product metric is P(ring on the right player at
   T = 5/15/30/60s) — a time-conditioned curve. Stock HOTA/IDF1 collapse time
   to a scalar; budget the small custom layer that emits the per-T curve, since
   that is the number eyes-on actually correlates with.

Baselines to score on day one: the shipped stitcher, the 2.5s-ceiling variant,
and no-stitch (raw fragments) — then Tier-2b candidates against all three.

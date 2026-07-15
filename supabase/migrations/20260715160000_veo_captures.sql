-- Veo panorama capture: preserve the pixels + the jersey labels before Veo
-- archives the native panorama to Glacier.
--
-- WHY. Veo is the free LABELLER for our own jersey model, not a data source for
-- the product (we must stay Veo- and Spiideo-AI independent). Their
-- /api/mes/v2/player-tracking serves jersey-labelled metric player tracks — a
-- 92.1% jersey read rate on a 105x68 pitch — which is the training corpus we
-- would otherwise pay to hand-label. But the corpus only exists while the PIXELS
-- do, and the pixels expire: measured 2026-07-15, the native .ts panorama is
-- `available` at <=40d and Glacier'd by ~150d. Same shape as the Spiideo raw-VP
-- purge that cost us 234/268 panoramas before capture-on-publish.
--
-- WHY A NEW TABLE, not columns on playhub_veo_recordings_cache. That table is a
-- CACHE and it is PRUNED: infrastructure/lambda/veo-sync/cache-writer.ts:306-315
-- deletes any row whose match_slug drops out of Veo's listing. Capture state is
-- durable provenance — losing it would orphan a ~9.5GB S3 object with no record
-- of its key. match_date is denormalised here for exactly that reason: the
-- capture window must still be computable, and orphans discoverable, after the
-- cache row is gone.
--
-- Lifecycle (mirrors the proven panorama_capture_* / tracklets_* state machine):
--   NULL/absent → never attempted
--   pending     → a capture job is in flight (heartbeats started_at every 2 min)
--   ready       → panorama_s3_key + tracking_s3_key are populated; TERMINAL
--   error       → last run failed (redacted message); retried until attempts cap

set local lock_timeout = '3s';

create table if not exists public.playhub_veo_captures (
  id uuid primary key default gen_random_uuid(),
  veo_club_slug text not null,
  match_slug text not null,
  match_date timestamptz,
  capture_status text,
  capture_started_at timestamptz,
  capture_attempts integer not null default 0,
  capture_error text,
  panorama_s3_key text,
  tracking_s3_key text,
  panorama_bytes bigint,
  created_at timestamptz not null default now(),
  unique (veo_club_slug, match_slug)
);

-- The sweep scans newest-first inside the capture window and skips terminal rows.
create index if not exists playhub_veo_captures_sweep_idx
  on public.playhub_veo_captures (match_date desc nulls last)
  where capture_status is distinct from 'ready';

comment on table public.playhub_veo_captures is
  'Durable record of Veo native-panorama (.ts) + player-tracking captures. Deliberately NOT on playhub_veo_recordings_cache, which is pruned when a match leaves Veo''s listing (cache-writer.ts:306) — that would orphan a ~9.5GB S3 object.';
comment on column public.playhub_veo_captures.match_date is
  'Denormalised from the cache: the capture window (panorama is Glacier''d by ~150d) must remain computable, and orphans discoverable, after the cache row is pruned.';
comment on column public.playhub_veo_captures.capture_status is
  'NULL/absent | pending | ready | error. Drives the atomic claim that stops two jobs downloading the same ~9.5GB object.';
comment on column public.playhub_veo_captures.capture_started_at is
  'Claim time, heartbeated every 2 min by the job so a stuck pending can be expired without double-spending a multi-GB transfer.';
comment on column public.playhub_veo_captures.capture_error is
  'Redacted, truncated last-run error — never carries the Veo password or a bearer. "panorama already archived" marks a match that aged out before we reached it.';
comment on column public.playhub_veo_captures.panorama_s3_key is
  'The NATIVE .ts (2x 3840x2160 HEVC, ~9.5GB). Measured: median player 83px vs 54px in the 2048 transcode and 58px in the follow-cam — the only render with legible jerseys at range, and the only one that archives.';
comment on column public.playhub_veo_captures.tracking_s3_key is
  'player-tracking JSON: every object, jersey-labelled, 2.5Hz, with the pitch + column schema embedded so it stays decodable independently of this codebase.';

-- Service-role only. This is provenance for minors' footage: no anon/authenticated
-- policy is defined, so RLS denies everything the service role does not do.
alter table public.playhub_veo_captures enable row level security;

-- Candidate matches for the capture sweep: Veo matches still inside the window
-- where the panorama exists, that we have not captured. A view keeps the
-- cache-LEFT-JOIN-captures in SQL (PostgREST can't express the join), consumed
-- service-role-only by the sync-recordings Lambda sweep — same shape as
-- playhub_portrait_render_candidates.
--
-- SETTLEMENT MUST STAY IN LOCKSTEP WITH THE SWEEP. Three artifacts encode the
-- same predicate — this view, isVeoCaptureClaimable(), and the CAS .or() — and a
-- row that falls between them is lost silently. This view has already been wrong
-- twice (see the migrations that follow this file):
--   * a TAUTOLOGICAL processing guard (`not in ('processing','failed')` — strings
--     Veo never emits; it only ever sends '{}' or '{"status":"uploading",...}',
--     per src/lib/veo/processing-status.ts). It excluded nothing, so the sweep
--     grabbed still-rendering matches, the job found no .ts, and 3 attempts burned
--     in ~45 min — settling the FRESHEST matches at error forever.
--   * a MISSING NULL BRANCH, so an operator reset (capture_status = null) produced
--     a row the view never offered — making the documented recovery a no-op.
-- Also: `pending` must carry the attempts cap, or a SIGKILLed job leaks a slot at
-- the top of a newest-first LIMIT 25 forever (the portrait-render livelock class).
--
-- The window is deliberately generous (150d ~= the measured Glacier boundary):
-- the job checks `availability` before transferring a byte, so being generous
-- costs one cheap API call, while being stingy silently forfeits a capturable
-- match — and that is irreversible.
create or replace view public.playhub_veo_capture_candidates
with (security_invoker = true) as
select
  r.veo_club_slug,
  r.match_slug,
  r.match_date,
  r.title,
  c.id as capture_id,
  c.capture_status,
  c.capture_attempts,
  c.capture_started_at
from public.playhub_veo_recordings_cache r
left join public.playhub_veo_captures c
  on c.veo_club_slug = r.veo_club_slug and c.match_slug = r.match_slug
where r.match_date is not null
  and r.match_date > now() - interval '150 days'
  -- still rendering => no panorama to fetch yet. Permissive by design: an
  -- unrecognised form falls through, and the job neither transfers nor burns an
  -- attempt when the render simply is not ready.
  and coalesce(r.processing_status, '{}') not like '%"status":"uploading"%'
  and (
    c.id is null                                                  -- never attempted
    or c.capture_status is null                                   -- reset by an operator
    or (c.capture_status = 'error' and c.capture_attempts < 3)
    or (c.capture_status = 'pending' and c.capture_attempts < 3)  -- may be stuck; the sweep arbitrates
  )
  and coalesce(c.capture_status, '') <> 'ready';

revoke all on public.playhub_veo_capture_candidates from anon, authenticated;

comment on view public.playhub_veo_capture_candidates is
  'Sweep feed for the veo-capture Batch job: Veo matches inside the ~150d panorama window with no settled capture. Service-role only. Its settlement predicate MUST match the sweep''s isVeoCaptureClaimable() AND the CAS .or().';

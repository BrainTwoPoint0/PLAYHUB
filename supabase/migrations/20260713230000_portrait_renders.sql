-- System-generated portrait highlight renders (roadmap item 2, CFA pilot):
-- the portrait-render Batch job turns each tagged Veo goal into a 9:16 draft
-- in the portrait-crops bucket; club admins review on the academy content page
-- (publish to TikTok / fix in editor / reject). Review-first by design — the
-- GT-backed detector metrics (recall@0.9 ~16% on airborne goal moments) rule
-- out unattended auto-publishing at current quality; the `quality` metadata is
-- recorded from day one so auto-publish can later become a threshold flip.
--
-- Access model matches the academy surface: RLS ENABLED with NO client
-- policies (deny-all for anon/authenticated; service-role bypasses). All reads
-- and status changes go through club-gated API routes that check
-- organization_members roles in code — the same pattern as the goal-events
-- read path, and it avoids duplicating the club->organization mapping (which
-- partially lives in app config) inside SQL policies.

set local lock_timeout = '3s';

create table if not exists public.playhub_portrait_renders (
  id uuid primary key default gen_random_uuid(),
  -- Plain UUID reference, NOT a foreign key: the events table must stay
  -- independently mutable/deletable (the 2026-07-07 audit-log FK lesson).
  recording_event_id uuid not null,
  provider_event_id text not null,   -- Veo highlight id (the ~25s goal clip)
  provider_recording_id text not null, -- Veo match slug
  club_slug text not null,
  storage_path text not null,        -- portrait-crops bucket, system/{club}/{event}.mp4
  status text not null default 'draft', -- draft | published | rejected | error
  quality jsonb,                     -- detection coverage, goal-moment density, modal versions
  error text,                        -- self-authored messages only (never raw exception dumps)
  published_at timestamptz,
  published_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One render per goal event: the job upserts on this, re-renders replace.
  constraint playhub_portrait_renders_event_unique unique (provider_event_id)
);

alter table public.playhub_portrait_renders enable row level security;

-- The listing query shape: all renders for a club's match.
create index if not exists idx_portrait_renders_club_match
  on public.playhub_portrait_renders (club_slug, provider_recording_id);

comment on table public.playhub_portrait_renders is
  'System-generated 9:16 portrait renders of tagged goal events (draft-first review flow). Written by the portrait-render Batch job; read/updated via club-gated academy API routes (service role — RLS is deny-all for clients).';
comment on column public.playhub_portrait_renders.quality is
  'Detection/render quality signals (ball coverage, goal-moment candidate density, modal_app_version, codec fingerprint) — the future auto-publish gate.';

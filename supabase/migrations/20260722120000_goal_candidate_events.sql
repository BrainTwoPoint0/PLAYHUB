-- Within-episode multi-goal markers: one goal-detect candidate can carry N
-- approved goal events. Merged episodes hold flurries — measured 7.6% of
-- recovered goals (94/1234 on the freeze record) lose their marker to
-- episode collapse; the pilot's 18:54 episode holds 3 goals / 1 marker.
--
-- Link table (NOT uuid[] on the candidate row): candidate <-> event, with
-- the stamp's provenance. event_id is a PLAIN uuid, deliberately NOT an FK
-- into playhub_recording_events (2026-07-07 audit-log lesson: FKs into rows
-- with independent lifecycles make deletes fail in surprising places).
-- approved_event_id on playhub_goal_candidates stays as the PRIMARY/first
-- stamp for repair-state compatibility (approved + NULL primary = the
-- mid-flight repair state; a live approved candidate must always have it
-- pointing at a linked event).
--
-- The approve/add_goal routes write the LINK ROW FIRST, then the event with
-- id = provider_event_id = the link's event_id: a mid-flight failure leaves
-- a link with no event (no public marker, discoverable for repair) — never
-- a public marker with no link (an orphan unapprove could not find).

set local lock_timeout = '3s';

create table public.playhub_goal_candidate_events (
  candidate_id uuid not null
    references public.playhub_goal_candidates(id) on delete cascade,
  event_id uuid not null,
  stamp_source text not null
    check (stamp_source in ('anchor_offset', 'human_scrub')),
  stamp_seconds numeric,
  created_at timestamptz not null default now(),
  created_by uuid,
  primary key (candidate_id, event_id)
);

alter table public.playhub_goal_candidate_events enable row level security;
-- deny-all: no policies. Service-role, platform-admin-gated API routes are
-- the only access path (same posture as playhub_goal_candidates).

comment on table public.playhub_goal_candidate_events is
  'Links a goal-detect candidate to its approved goal events (N per candidate: merged episodes hold multi-goal flurries). event_id is a plain uuid, NOT an FK. RLS deny-all; service-role routes only.';
comment on column public.playhub_goal_candidate_events.stamp_source is
  'anchor_offset = the default anchor-20s estimate; human_scrub = the reviewer stamped the moment from the playing clip.';
comment on column public.playhub_goal_candidate_events.stamp_seconds is
  'Match clock (s, produced-video time base) written to the event at stamp time.';

-- Backfill: every already-approved candidate's event becomes its first link.
-- stamp_seconds comes from the live event row when it exists (the repair
-- state has approved_event_id NULL and is skipped — the route repairs it).
insert into public.playhub_goal_candidate_events
  (candidate_id, event_id, stamp_source, stamp_seconds, created_at, created_by)
select
  c.id,
  c.approved_event_id,
  'anchor_offset',
  e.timestamp_seconds,
  coalesce(c.reviewed_at, c.updated_at, now()),
  c.reviewed_by
from public.playhub_goal_candidates c
left join public.playhub_recording_events e on e.id = c.approved_event_id
where c.approved_event_id is not null
on conflict (candidate_id, event_id) do nothing;

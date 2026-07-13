-- Candidate matches for the portrait-render sweep: club-mapped Veo matches
-- whose tagged goals aren't all settled yet. A view keeps the three-table
-- NOT-ALL-RENDERED join in SQL (PostgREST can't express it), consumed
-- service-role-only by the sync-recordings Lambda sweep.
-- (Amended in 20260714000500: NULL-id exclusion + retry-aware settlement.)

set local lock_timeout = '3s';

create or replace view public.playhub_portrait_render_candidates
with (security_invoker = true) as
select
  c.club_slug,
  e.provider_recording_id as match_slug,
  count(e.id)::int as goal_events,
  count(r.id)::int as renders,
  max(e.created_at) as latest_event_at
from public.playhub_recording_events e
join public.playhub_veo_recordings_cache c
  on c.match_slug = e.provider_recording_id
left join public.playhub_portrait_renders r
  on r.provider_event_id = e.provider_event_id
  -- A row settles its event when it succeeded, was decided by an admin, or
  -- exhausted its retry budget; live 'error' rows below the cap keep the
  -- match a candidate so the sweep retries them.
  and (r.status <> 'error' or r.attempts >= 3)
where e.provider = 'veo' and e.event_type = 'goal'
  -- NULL-id events can never be rendered (no highlight to fetch); counting
  -- them would make their match a PERMANENT candidate (sweep livelock).
  and e.provider_event_id is not null
group by c.club_slug, e.provider_recording_id
having count(r.id) < count(e.id);

revoke all on public.playhub_portrait_render_candidates from anon, authenticated;

comment on view public.playhub_portrait_render_candidates is
  'Sweep feed for the portrait-render Batch job: matches with unsettled tagged goals, per club. Service-role only.';

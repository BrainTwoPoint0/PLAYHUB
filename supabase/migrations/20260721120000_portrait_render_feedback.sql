-- Human corrections to system-generated portrait drafts — the training/QA signal.
--
-- Why a new table rather than reusing playhub_crop_feedback: that table's
-- job_id is NOT NULL REFERENCES playhub_crop_jobs, and its INSERT policy
-- ("Users create own feedback on own jobs") IS the anti-poisoning control.
-- Reusing it would mean fabricating shadow crop-jobs and writing through the
-- service role, which bypasses that policy — keeping the SQL while losing the
-- guarantee. It is also the wrong tenancy: crop jobs are user/recording-scoped,
-- portrait renders are club/event-scoped. Columns below deliberately mirror
-- playhub_crop_feedback so a union view stays trivial.
--
-- The label semantics (Karim, 2026-07-21): a draft marked "good enough" is
-- UNEDITED by definition; the moment an admin edits anything, that itself is
-- the negative label. So action='accepted' == auto-detection passed, and
-- action='edited' == auto-detection failed (with the diff saying how).

set local lock_timeout = '3s';

create table if not exists public.playhub_portrait_render_feedback (
  id uuid primary key default gen_random_uuid(),
  -- Plain UUID, NOT a foreign key: the sweep re-creates render rows and the
  -- training signal must outlive them (the 2026-07-07 audit-log FK lesson —
  -- an FK into renders made the parent undeletable).
  render_id uuid not null,
  provider_event_id text not null,      -- stable join key across re-renders
  club_slug text not null,
  user_id uuid not null,                -- who judged; no FK (matches published_by)
  action text not null,
  reason text,                          -- closed enum on reject; free text is a PII vector
  note text,
  keyframes_before jsonb,               -- what the pipeline produced
  keyframes_after jsonb,                -- what the human kept (null for accept/reject)
  diff jsonb,                           -- server-computed {counts, maxAbsDx, ...}
  -- Whether keyframes_before is the FACT the draft was rendered with
  -- (render_row) or a re-derived session detection (session_detect). The
  -- detection cache drifts — it was invalidated and re-run for 167 clips on
  -- 2026-07-21 — so without this you cannot tell trustworthy rows from
  -- re-derived ones after the baseline column lands.
  baseline_origin text not null default 'session_detect',
  scene_changes jsonb,
  trim jsonb,                           -- {start,end} when the clip was trimmed
  created_at timestamptz not null default now(),

  constraint valid_prf_action check (action in ('accepted', 'rejected', 'edited', 'exported')),
  constraint valid_prf_baseline check (baseline_origin in ('render_row', 'session_detect'))
);

create index if not exists idx_prf_render_created
  on public.playhub_portrait_render_feedback (render_id, created_at desc);
create index if not exists idx_prf_club_created
  on public.playhub_portrait_render_feedback (club_slug, created_at desc);
create index if not exists idx_prf_action_created
  on public.playhub_portrait_render_feedback (action, created_at desc);

alter table public.playhub_portrait_render_feedback enable row level security;

-- No client policies: deny-all for anon/authenticated, exactly like
-- playhub_portrait_renders. The club-gated academy route is the authorization
-- boundary. Append-only by design — no UPDATE/DELETE path exists.
revoke all on public.playhub_portrait_render_feedback from anon, authenticated;
grant all on public.playhub_portrait_render_feedback to service_role;

comment on table public.playhub_portrait_render_feedback is
  'Human corrections to system-generated portrait drafts (training/QA signal). Stores crop GEOMETRY ONLY — times and x-pixels — never imagery, URLs or player identity; the route builds the insert explicitly rather than spreading the request body. accepted = auto-detection passed (unedited); edited = it failed.';

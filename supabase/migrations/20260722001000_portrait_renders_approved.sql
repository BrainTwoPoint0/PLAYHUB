-- "Good enough" replaces publish-to-TikTok as the terminal review action.
--
-- Quality approval and distribution are now separate acts: approving is cheap and
-- reversible, posting is a deliberate later step. These are minors' clips, so a single
-- button that both judged and distributed was the wrong shape.
--
-- The status vocabulary is final and ZERO rows have ever been published (published_at
-- is null across all 1,996), so the CHECK this table never had is safe to add now.
-- 'published' stays in the list as a legacy value.
set local lock_timeout = '3s';

alter table public.playhub_portrait_renders
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by uuid;

alter table public.playhub_portrait_renders
  drop constraint if exists playhub_portrait_renders_status_check;
alter table public.playhub_portrait_renders
  add constraint playhub_portrait_renders_status_check
  check (status in ('draft', 'approved', 'rejected', 'error', 'published'));

-- The library view: approved clips for a club, newest first.
create index if not exists idx_portrait_renders_club_approved
  on public.playhub_portrait_renders (club_slug, approved_at desc)
  where status = 'approved';

comment on column public.playhub_portrait_renders.approved_at is
  'When an admin marked this draft "good enough". Approved rows are frozen: the Batch writer only touches draft/error, so a future pipeline run will not silently re-render an approved clip. unapprove is the escape hatch.';

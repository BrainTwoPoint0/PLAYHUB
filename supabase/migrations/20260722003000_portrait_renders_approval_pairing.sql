-- Pair the approval stamp to the approved status.
--
-- Without this, an approve → reject (or → restore) leaves `approved_at`/`approved_by`
-- populated on a row nobody currently approves: the listing endpoint would report an
-- approver for a clip its reviewer threw out, and the library index
-- (`(club_slug, approved_at desc) where status = 'approved'`) sorts DESC = NULLS FIRST,
-- so an approved row with a null stamp would sort to the TOP of "newest approved first".
--
-- The transition route now nulls the stamp on every non-approve path; this constraint is
-- the schema-level guarantee that a future writer cannot reintroduce the drift.
--
-- Verified before applying: 0 rows violate this (0 approved, 0 stale stamps of 1,996).
-- Validates under ACCESS EXCLUSIVE, but at this row count the scan is sub-millisecond.
set local lock_timeout = '3s';

alter table public.playhub_portrait_renders
  drop constraint if exists playhub_portrait_renders_approval_pairing;

alter table public.playhub_portrait_renders
  add constraint playhub_portrait_renders_approval_pairing
  check ((status = 'approved') = (approved_at is not null));

comment on column public.playhub_portrait_renders.approved_at is
  'Set iff status = ''approved'' (enforced by playhub_portrait_renders_approval_pairing). '
  'Filter the library on status, never on this column alone.';

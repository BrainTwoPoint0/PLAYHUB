-- One row per (user, recording) — the API treats this as a position
-- cursor, not per-session history. Per-session granularity, if ever
-- needed, lives in a future playhub_view_sessions table rather than
-- this row.
--
-- The dedupe step uses (timestamp, id) tie-breaking so two rows with
-- identical timestamps don't BOTH survive (which would make the
-- subsequent unique-constraint addition fail).
DELETE FROM public.playhub_view_history a
USING public.playhub_view_history b
WHERE a.user_id IS NOT NULL
  AND a.match_recording_id IS NOT NULL
  AND a.user_id = b.user_id
  AND a.match_recording_id = b.match_recording_id
  AND (
    COALESCE(a.last_position_at, a.started_at, '-infinity'::timestamptz),
    a.id
  ) < (
    COALESCE(b.last_position_at, b.started_at, '-infinity'::timestamptz),
    b.id
  );

ALTER TABLE public.playhub_view_history
  ADD CONSTRAINT playhub_view_history_user_match_uniq
  UNIQUE (user_id, match_recording_id);

-- started_at populates on insert and is never touched on upsert. The
-- API omits it from the upsert payload to preserve the original session
-- start; this default is what fills it on the very first insert.
ALTER TABLE public.playhub_view_history
  ALTER COLUMN started_at SET DEFAULT NOW();

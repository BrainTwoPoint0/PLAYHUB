-- Weekly LYL Veo sync — persistence tables (Stage A)
--
-- Two tables to support the cron-driven LYL recording assignment job:
--
--   1. playhub_recording_assignments  — one row per (league, recording).
--      Tracks parse result (rules / llm / manual), team assignments
--      (home + away), share-accept state, and current status. Source of
--      truth for the admin UI. Idempotency keyed on
--      (league_club_slug, recording_slug). Share-accepted copies are
--      filtered out at the orchestrator layer (by slug prefix) and never
--      get a row here — only the originals do.
--
--   2. playhub_recording_sync_runs    — one row per cron / manual run.
--      Holds the run summary (counts, LLM cost, errors_jsonb), used by
--      the admin UI's run-history view and post-run email.
--
-- Access model: RLS enabled, NO policies. Reads + writes happen only via
-- service-role from server-side API routes / Lambda — admin UI never
-- queries these tables directly from a browser session. The orchestrator
-- caps free-text fields (parse_reasoning ≤ 4KB, errors_jsonb error
-- strings ≤ 2KB each) before insert to bound prompt-injection / runaway-
-- response exposure even though no anon role can read them.

-- ============================================================================
-- playhub_recording_assignments
-- ============================================================================

CREATE TABLE public.playhub_recording_assignments (
    id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),

    -- Subject identification. (league_club_slug, recording_slug) is the
    -- natural idempotency key.
    league_club_slug text NOT NULL REFERENCES public.playhub_academy_config(club_slug) ON DELETE RESTRICT,
    recording_slug text NOT NULL,
    -- Veo's match UUID — required for PATCH ops. The orchestrator fetches
    -- it via getMatchDetails before inserting, so it's always available.
    recording_uuid text NOT NULL,
    recording_title text NOT NULL,
    match_date timestamptz,
    duration_seconds integer,

    -- Parser output. NULL when status='too_long' or 'unparseable' (no teams
    -- to record). Both age groups are stored so mixed-age fixtures like
    -- "U10 vs U11" land in each side's own age folder.
    parsed_home_subclub_slug text,
    parsed_away_subclub_slug text,
    parsed_home_age_group text,
    parsed_away_age_group text,
    parse_method text CHECK (parse_method IN ('rules', 'llm', 'manual')),
    -- LLM confidence in [0, 1]. NULL for rules/manual parses.
    parse_confidence numeric(4, 3) CHECK (parse_confidence IS NULL OR (parse_confidence >= 0 AND parse_confidence <= 1)),
    -- LLM free-text justification. Capped to 4KB by the orchestrator
    -- before insert (prompt-injection echo guard). Rendered as plain text
    -- only in the admin UI (no HTML, no markdown).
    parse_reasoning text,
    -- Set when we kick off an LLM call so a retry can see "already tried,
    -- already paid for the tokens" and not re-bill. NULL for non-LLM paths.
    llm_attempted_at timestamptz,

    -- Veo team assignment state.
    home_team_uuid text,
    home_team_slug text,
    home_assigned_at timestamptz,
    away_team_uuid text,
    away_team_slug text,
    away_assigned_at timestamptz,
    -- Share-flow bookkeeping. away_share_key is the invitation key returned
    -- by createShareInvitation; away_accepted_recording_uuid is the new
    -- match UUID returned by acceptShareInvitation.
    away_share_key text,
    away_accepted_recording_uuid text,

    -- Lifecycle status. The orchestrator transitions through these as it
    -- processes the recording across runs. `operator_locked` (was
    -- `manual_override` in v1 of this migration) is named distinctly from
    -- parse_method='manual' so reviewers don't confuse the two concepts:
    -- one is a STATUS (cron skips this row), the other is parse PROVENANCE.
    status text NOT NULL CHECK (status IN (
        'pending',           -- discovered, not yet parsed
        'parsed',            -- parser produced (home, away); nothing assigned yet
        'home_assigned',     -- home team patched in Veo; away share/accept pending
        'fully_assigned',    -- both home + away assigned (or accepted via share)
        'operator_locked',   -- operator edited via admin UI; cron skips on next run
        'unparseable',       -- parser couldn't extract teams (rules + LLM both failed)
        'too_long',          -- >60min — multi-match dump, skipped
        'intra_team',        -- home == away (e.g. ELA U11 C vs ELA U11 B); single assignment
        'failed'             -- Veo write failed; check failure_stage + last_error
    )),
    -- When status='failed', which step blew up. Lets the orchestrator's
    -- retry logic decide what to re-run (Veo PATCH? share create? accept?)
    -- without parsing last_error text. NULL when status != 'failed'.
    failure_stage text CHECK (failure_stage IS NULL OR failure_stage IN (
        'parse', 'home_patch', 'share_create', 'share_accept', 'cleanup'
    )),
    last_error text,
    last_processed_at timestamptz,
    -- Weak FK (intentionally no constraint) so the orchestrator can upsert
    -- assignments without ordering against sync_runs inserts. If sync_runs
    -- are ever pruned, these pointers dangle — display-only data, treated
    -- as best-effort by the admin UI.
    last_sync_run_id uuid,

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    UNIQUE(league_club_slug, recording_slug),

    -- ── Invariants enforced at the DB layer ──────────────────────────────
    -- Once parsing has resolved to a team-bearing status, parse_method
    -- must be set. Statuses where the parser legitimately produced NO
    -- method (unparseable / too_long / failed) are exempt. Prevents
    -- accidental "fully_assigned with NULL method" rows from a buggy
    -- orchestrator path, without blocking the error-path upserts.
    -- (Earlier draft required parse_method for ANY non-pending status;
    -- broke the unparseable/too_long/failed paths on 2026-05-17 smoke
    -- run because those upserts deliberately don't pass parse data.)
    CONSTRAINT chk_parse_method_when_parsed CHECK (
        status IN ('pending', 'unparseable', 'too_long', 'failed')
        OR parse_method IS NOT NULL
    ),
    -- LLM parses must record their confidence (so we can filter the
    -- "low confidence" rows in the admin UI without a NULL = bug ambiguity).
    CONSTRAINT chk_llm_confidence_required CHECK (
        parse_method IS DISTINCT FROM 'llm' OR parse_confidence IS NOT NULL
    ),
    -- Status / timestamp invariants — keep the lifecycle columns in sync
    -- so the admin UI never has to defend against "status says assigned
    -- but timestamp is NULL".
    CONSTRAINT chk_home_assigned_at_required CHECK (
        status NOT IN ('home_assigned', 'fully_assigned') OR home_assigned_at IS NOT NULL
    ),
    CONSTRAINT chk_away_assigned_at_required CHECK (
        status <> 'fully_assigned' OR away_assigned_at IS NOT NULL
    ),
    -- failure_stage required precisely when status='failed', NULL otherwise.
    CONSTRAINT chk_failure_stage_only_on_failed CHECK (
        (status = 'failed' AND failure_stage IS NOT NULL)
        OR (status <> 'failed' AND failure_stage IS NULL)
    )
);

-- Filter by status (e.g. admin UI "show only unparseable").
CREATE INDEX idx_playhub_recording_assignments_league_status
    ON public.playhub_recording_assignments (league_club_slug, status);

-- Admin UI sorts most-recent-first. DESC NULLS LAST on match_date so rows
-- with NULL match_date (rare — usually too_long entries) sink to bottom.
CREATE INDEX idx_playhub_recording_assignments_match_date
    ON public.playhub_recording_assignments (league_club_slug, match_date DESC NULLS LAST);

ALTER TABLE public.playhub_recording_assignments ENABLE ROW LEVEL SECURITY;
-- Intentionally no policies; service-role only. Anon/authenticated roles
-- get zero rows by deny-by-default.

CREATE TRIGGER update_playhub_recording_assignments_updated_at
    BEFORE UPDATE ON public.playhub_recording_assignments
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Column documentation surfaces in psql `\d+` and Supabase Studio.
COMMENT ON TABLE public.playhub_recording_assignments IS
    'Source-of-truth for per-recording parse + Veo team-assignment state. Updated by the LYL sync orchestrator (cron + admin overrides). Read by the admin UI via service-role API routes only.';
COMMENT ON COLUMN public.playhub_recording_assignments.recording_uuid IS
    'Veo match UUID required for PATCH operations. Resolved by getMatchDetails before insert; NOT NULL by invariant.';
COMMENT ON COLUMN public.playhub_recording_assignments.parse_confidence IS
    'LLM confidence in [0,1]. NULL for rules-based or manual parses. Required when parse_method = ''llm''.';
COMMENT ON COLUMN public.playhub_recording_assignments.parse_reasoning IS
    'Capped to 4KB by orchestrator before insert. Render as plain text in UI — never as HTML or markdown.';
COMMENT ON COLUMN public.playhub_recording_assignments.last_sync_run_id IS
    'Weak FK (no constraint) so upserts don''t need to order against sync_runs inserts. May dangle if sync_runs is pruned — display-only.';
COMMENT ON COLUMN public.playhub_recording_assignments.status IS
    'Lifecycle. operator_locked = admin UI override; cron skips on next run. Distinct from parse_method=''manual'' (that''s provenance, not lifecycle).';

-- ============================================================================
-- playhub_recording_sync_runs
-- ============================================================================

CREATE TABLE public.playhub_recording_sync_runs (
    id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    league_club_slug text NOT NULL REFERENCES public.playhub_academy_config(club_slug) ON DELETE RESTRICT,
    -- How the run started. Distinguishes scheduled noise from operator
    -- triggers when reading the history. `lambda` was rejected by code
    -- review (collides with `cron` — Lambda IS what cron triggers) — keep
    -- just the 3 source-of-truth values.
    trigger_source text NOT NULL CHECK (trigger_source IN ('cron', 'manual', 'api')),
    started_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    status text NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),

    -- Counts. NULL on a still-running row; filled at completion.
    veo_recordings_seen integer,
    new_recordings integer,
    rules_parsed integer,
    llm_parsed integer,
    unparseable integer,
    home_assignments integer,
    share_accepts integer,
    auto_corrections integer,
    failures integer,

    -- LLM accounting. numeric(12, 6) gives 6 decimal places + max $999,999
    -- — generous headroom if pricing or call volume jumps an order of
    -- magnitude. numeric(10, 4) (the original) would silently truncate
    -- past $999,999.9999.
    llm_total_input_tokens integer,
    llm_total_output_tokens integer,
    llm_cost_usd numeric(12, 6),

    -- Per-recording error detail snapshot for the post-run email. Immutable
    -- by convention after completed_at is set (the orchestrator never
    -- updates a completed run). Error strings inside the jsonb are capped
    -- to 2KB each by the orchestrator before insert.
    errors_jsonb jsonb,

    -- Attribution: set when an admin manually triggers a run from the UI.
    -- NULL for cron runs (no user). Trigger-source CHECK below enforces:
    -- if trigger is manual or api, created_by must be set.
    created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,

    CONSTRAINT chk_created_by_when_human_trigger CHECK (
        trigger_source = 'cron' OR created_by IS NOT NULL
    )
);

CREATE INDEX idx_playhub_recording_sync_runs_league_started
    ON public.playhub_recording_sync_runs (league_club_slug, started_at DESC);

ALTER TABLE public.playhub_recording_sync_runs ENABLE ROW LEVEL SECURITY;
-- Intentionally no policies; service-role only (same posture as assignments).

-- Sync runs mutate during their lifecycle (running → succeeded/partial/
-- failed, counts filled at completion). We lean on `started_at` and
-- `completed_at` as the two real time signals — no `updated_at` column,
-- so no trigger needed. (Earlier draft wired the generic
-- update_updated_at_column() trigger here; it errored on every UPDATE
-- with `record "new" has no field "updated_at"` because the function
-- sets NEW.updated_at and this table doesn't have that column. Dropped
-- empirically on 2026-05-17 after the Lambda smoke test surfaced it.)

COMMENT ON TABLE public.playhub_recording_sync_runs IS
    'One row per cron / manual sync run. Reads via service-role API routes only; admin UI renders the run-history view from these.';
COMMENT ON COLUMN public.playhub_recording_sync_runs.errors_jsonb IS
    'Per-recording error detail. Immutable by convention after completed_at is set. Individual error strings capped to 2KB each at orchestrator layer.';
COMMENT ON COLUMN public.playhub_recording_sync_runs.created_by IS
    'Required for trigger_source IN (manual, api); NULL for cron. Drops to NULL if the auth user is deleted (RTBF compliance).';

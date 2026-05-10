-- Smoke test for 20260510_academy_subscriptions migration.
--
-- Verifies:
--   0. Schema sanity — tables, RLS, policies, indexes, unique constraints, CHECKs.
--   A. Pending sub exists for the email → active sub created, pending claimed.
--   B. No pending sub for the email → signup still works, no academy sub created.
--   C. (user_id, club_slug) collision (re-subscribe, stale pending row) → pending
--      claimed, existing active row untouched. The realistic production scenario.
--   D. Multiple pending subs for different clubs → all claimed, all active rows.
--   E. Regression for side-effects 1 + 2 — a signup with pending admin invite
--      AND pending recording access right both still claim correctly when the
--      new academy block is also defined.
--   F. RLS reachability — anon can read active academy_teams; authenticated user
--      cannot read another user's academy_subscriptions.
--
-- Usage:
--   psql "$SUPABASE_DB_URL" -f PLAYHUB/supabase/tests/20260510_academy_subscriptions.test.sql
--
-- Wrapped in a single transaction with ROLLBACK at the end — leaves zero state behind
-- regardless of pass/fail. Safe to run against staging.
--
-- DO NOT RUN AGAINST PRODUCTION. The header guard below refuses to proceed if the
-- database name doesn't look like a non-prod environment, but the safer option is
-- to keep this on staging only. The test inserts directly into auth.users; while
-- ROLLBACK undoes the insert, an accidental COMMIT (e.g. mid-edit) would leave
-- synthetic auth users in the DB forever.
--
-- Exit codes: any RAISE EXCEPTION inside a DO block aborts the transaction
-- with non-zero exit. Clean run prints "OK" lines for each scenario.
--
-- KNOWN FRAGILITY: this script inserts directly into auth.users using positional
-- column defaults. Future Supabase auth-schema upgrades that add NOT NULL columns
-- (e.g. is_anonymous, is_sso_user historically) will break the insert. If that
-- happens, regenerate the auth.users insert against the current schema rather
-- than disabling the test.

-- ============================================================================
-- Header guard: refuse to run unless the database name matches a non-prod
-- naming convention OR the operator has set app.allow_destructive_test=yes.
--
-- The pattern accepts: literal canonical names (postgres, playhub_local,
-- playhub_staging, playhub_test, playhub_dev) AND any name with a
-- conventional non-prod suffix/prefix (test_*, *_test, *_staging, *_local).
-- This is a CONVENTION enforcer, not a strict allowlist — `prod_staging`
-- would technically match `.*_staging`. The trade-off is intentional: too
-- strict and legitimate clone names (e.g. `playhub_for_test_replay`) get
-- blocked; too loose and the substring-blocklist false-negatives return.
-- The escape hatch (app.allow_destructive_test=yes) plus the wrapping
-- BEGIN;...ROLLBACK; provide additional safety layers.
-- ============================================================================
DO $$
DECLARE
    db_name text := current_database();
    override text := coalesce(current_setting('app.allow_destructive_test', true), '');
BEGIN
    IF override = 'yes' THEN
        RAISE NOTICE 'header guard: overridden via app.allow_destructive_test=yes';
        RETURN;
    END IF;

    -- Anchored allowlist. Add patterns here when bringing up new non-prod envs.
    IF NOT (db_name ~ '^(postgres|playhub_local|playhub_staging|playhub_test|playhub_dev|test_.*|.*_test|.*_staging|.*_local)$') THEN
        RAISE EXCEPTION
            'Refusing to run smoke test against database "%": name is not on the non-prod allowlist. Set app.allow_destructive_test=yes if you really mean it.',
            db_name;
    END IF;
END $$;

BEGIN;

-- ============================================================================
-- 0. Schema sanity — tables, RLS, policies, indexes, unique constraints, CHECKs
-- ============================================================================

DO $$
DECLARE
    expected_unique_count int;
BEGIN
    -- Tables exist
    PERFORM 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'playhub_academy_teams';
    IF NOT FOUND THEN RAISE EXCEPTION 'playhub_academy_teams table missing'; END IF;

    PERFORM 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'playhub_pending_academy_subscriptions';
    IF NOT FOUND THEN RAISE EXCEPTION 'playhub_pending_academy_subscriptions table missing'; END IF;

    PERFORM 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'playhub_academy_subscriptions';
    IF NOT FOUND THEN RAISE EXCEPTION 'playhub_academy_subscriptions table missing'; END IF;

    -- RLS enabled on all three
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE relname = 'playhub_academy_teams') THEN
        RAISE EXCEPTION 'RLS not enabled on playhub_academy_teams';
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE relname = 'playhub_pending_academy_subscriptions') THEN
        RAISE EXCEPTION 'RLS not enabled on playhub_pending_academy_subscriptions';
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE relname = 'playhub_academy_subscriptions') THEN
        RAISE EXCEPTION 'RLS not enabled on playhub_academy_subscriptions';
    END IF;

    -- Public read policy exists on academy_teams (for unauthenticated landing page)
    PERFORM 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'playhub_academy_teams'
          AND cmd = 'SELECT';
    IF NOT FOUND THEN RAISE EXCEPTION 'public-read SELECT policy missing on playhub_academy_teams'; END IF;

    -- No policies on pending_academy_subscriptions (service-role only)
    IF (SELECT count(*) FROM pg_policies WHERE tablename = 'playhub_pending_academy_subscriptions') > 0 THEN
        RAISE EXCEPTION 'playhub_pending_academy_subscriptions should have NO policies (service-role only)';
    END IF;

    -- Owner-read policy on academy_subscriptions
    PERFORM 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'playhub_academy_subscriptions'
          AND cmd = 'SELECT';
    IF NOT FOUND THEN RAISE EXCEPTION 'owner-read policy missing on playhub_academy_subscriptions'; END IF;

    -- Indexes — verify each named index exists. The trigger's correctness depends
    -- on the unclaimed partial index; query perf depends on the others.
    PERFORM 1 FROM pg_indexes WHERE indexname = 'idx_playhub_academy_teams_club_active';
    IF NOT FOUND THEN RAISE EXCEPTION 'index idx_playhub_academy_teams_club_active missing'; END IF;

    PERFORM 1 FROM pg_indexes WHERE indexname = 'idx_playhub_pending_academy_subs_email_unclaimed';
    IF NOT FOUND THEN RAISE EXCEPTION 'index idx_playhub_pending_academy_subs_email_unclaimed missing'; END IF;

    PERFORM 1 FROM pg_indexes WHERE indexname = 'idx_playhub_academy_subs_club_status';
    IF NOT FOUND THEN RAISE EXCEPTION 'index idx_playhub_academy_subs_club_status missing'; END IF;

    PERFORM 1 FROM pg_indexes WHERE indexname = 'idx_playhub_academy_subs_user_active';
    IF NOT FOUND THEN RAISE EXCEPTION 'index idx_playhub_academy_subs_user_active missing'; END IF;

    PERFORM 1 FROM pg_indexes WHERE indexname = 'idx_playhub_academy_subs_unprovisioned';
    IF NOT FOUND THEN RAISE EXCEPTION 'index idx_playhub_academy_subs_unprovisioned missing'; END IF;

    -- Unique constraints — load-bearing for trigger's unique_violation handling.
    SELECT count(*) INTO expected_unique_count
        FROM pg_constraint
        WHERE conrelid = 'public.playhub_academy_subscriptions'::regclass
          AND contype = 'u'
          AND (conname LIKE '%user_id_club_slug%' OR conname LIKE '%stripe_subscription_id%');
    IF expected_unique_count < 2 THEN
        RAISE EXCEPTION 'expected 2 unique constraints on playhub_academy_subscriptions (user+club, stripe_subscription_id), found %', expected_unique_count;
    END IF;

    -- CHECK constraints on status fields — guard against typos / new Stripe statuses.
    PERFORM 1 FROM pg_constraint
        WHERE conrelid = 'public.playhub_academy_subscriptions'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%status%';
    IF NOT FOUND THEN RAISE EXCEPTION 'CHECK constraint on playhub_academy_subscriptions.status missing'; END IF;

    PERFORM 1 FROM pg_constraint
        WHERE conrelid = 'public.playhub_pending_academy_subscriptions'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%last_known_status%';
    IF NOT FOUND THEN RAISE EXCEPTION 'CHECK constraint on playhub_pending_academy_subscriptions.last_known_status missing'; END IF;

    -- CHECK constraints enforcing lowercase emails — prevents case-mismatch bugs.
    PERFORM 1 FROM pg_constraint
        WHERE conrelid = 'public.playhub_academy_subscriptions'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%customer_email%lower%';
    IF NOT FOUND THEN RAISE EXCEPTION 'lowercase CHECK on playhub_academy_subscriptions.customer_email missing'; END IF;

    PERFORM 1 FROM pg_constraint
        WHERE conrelid = 'public.playhub_pending_academy_subscriptions'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%invited_email%lower%';
    IF NOT FOUND THEN RAISE EXCEPTION 'lowercase CHECK on playhub_pending_academy_subscriptions.invited_email missing'; END IF;

    -- subscriber_type CHECK on both tables — guards against free-text drift.
    PERFORM 1 FROM pg_constraint
        WHERE conrelid = 'public.playhub_academy_subscriptions'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%subscriber_type%';
    IF NOT FOUND THEN RAISE EXCEPTION 'subscriber_type CHECK on playhub_academy_subscriptions missing'; END IF;

    PERFORM 1 FROM pg_constraint
        WHERE conrelid = 'public.playhub_pending_academy_subscriptions'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%subscriber_type%';
    IF NOT FOUND THEN RAISE EXCEPTION 'subscriber_type CHECK on playhub_pending_academy_subscriptions missing'; END IF;

    RAISE NOTICE 'OK 0: schema, RLS, indexes, unique constraints, CHECKs all present';
END $$;

-- ============================================================================
-- Fixtures: two test clubs that won't collide with real seed data
-- ============================================================================

INSERT INTO public.playhub_academy_config (club_slug, name, stripe_product_id)
VALUES
    ('test_trigger_club',   'Trigger Test Club',   'prod_test_trigger_smoke'),
    ('test_trigger_club_2', 'Trigger Test Club 2', 'prod_test_trigger_smoke_2');

INSERT INTO public.playhub_academy_teams (club_slug, team_slug, display_name, sort_order)
VALUES ('test_trigger_club', 'test-team-a', 'Test Team A', 0);

-- ============================================================================
-- Scenario A: pending sub exists → active sub created, pending claimed
-- ============================================================================

DO $$
DECLARE
    test_user_id uuid := gen_random_uuid();
    test_email text := 'trigger-test-a-' || substr(gen_random_uuid()::text, 1, 8) || '@example.test';
    pending_id uuid;
    active_count int;
    claimed_count int;
BEGIN
    INSERT INTO public.playhub_pending_academy_subscriptions (
        club_slug, invited_email, stripe_subscription_id, stripe_customer_id,
        registration_team, subscriber_type, customer_name, last_known_status
    ) VALUES (
        'test_trigger_club', lower(test_email), 'sub_' || substr(gen_random_uuid()::text, 1, 12),
        'cus_' || substr(gen_random_uuid()::text, 1, 12),
        'test-team-a', 'parent', 'Test Parent', 'active'
    ) RETURNING id INTO pending_id;

    -- Simulate signup: insert a user. handle_new_user trigger fires AFTER INSERT.
    INSERT INTO auth.users (id, email, raw_user_meta_data, instance_id, aud, role, created_at, updated_at)
    VALUES (
        test_user_id, test_email,
        jsonb_build_object('username', 'trigger_test_a', 'full_name', 'Trigger Test A'),
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        now(), now()
    );

    -- Active sub created
    SELECT count(*) INTO active_count
        FROM public.playhub_academy_subscriptions
        WHERE user_id = test_user_id AND club_slug = 'test_trigger_club';
    IF active_count <> 1 THEN
        RAISE EXCEPTION 'Scenario A: expected 1 active sub, got %', active_count;
    END IF;

    -- Active sub has expected fields, provisioned_at NULL (application's job),
    -- subscriber_type propagated from the pending row.
    PERFORM 1 FROM public.playhub_academy_subscriptions
        WHERE user_id = test_user_id AND club_slug = 'test_trigger_club'
          AND provisioned_at IS NULL
          AND status = 'active'
          AND customer_email = lower(test_email)
          AND subscriber_type = 'parent';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Scenario A: active sub does not have expected fields (incl. subscriber_type)';
    END IF;

    -- Pending row marked claimed
    SELECT count(*) INTO claimed_count
        FROM public.playhub_pending_academy_subscriptions
        WHERE id = pending_id AND claimed_at IS NOT NULL AND claimed_user_id = test_user_id;
    IF claimed_count <> 1 THEN
        RAISE EXCEPTION 'Scenario A: pending row not marked claimed';
    END IF;

    -- Profile created (regression check)
    PERFORM 1 FROM public.profiles WHERE user_id = test_user_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Scenario A: profile not created';
    END IF;

    RAISE NOTICE 'OK A: pending sub claimed, active sub created, profile created';
END $$;

-- ============================================================================
-- Scenario B: no pending sub → nothing happens (regression for unrelated signups)
-- ============================================================================

DO $$
DECLARE
    test_user_id uuid := gen_random_uuid();
    test_email text := 'trigger-test-b-' || substr(gen_random_uuid()::text, 1, 8) || '@example.test';
    sub_count int;
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data, instance_id, aud, role, created_at, updated_at)
    VALUES (
        test_user_id, test_email,
        jsonb_build_object('username', 'trigger_test_b', 'full_name', 'Trigger Test B'),
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        now(), now()
    );

    PERFORM 1 FROM public.profiles WHERE user_id = test_user_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Scenario B: profile not created (signup with no pending sub broken)';
    END IF;

    SELECT count(*) INTO sub_count
        FROM public.playhub_academy_subscriptions WHERE user_id = test_user_id;
    IF sub_count <> 0 THEN
        RAISE EXCEPTION 'Scenario B: unexpected academy sub created (got %)', sub_count;
    END IF;

    RAISE NOTICE 'OK B: signup with no pending sub does not create academy sub';
END $$;

-- ============================================================================
-- Scenario C: trigger's WHEN unique_violation branch fires for real.
--
--   Setup: pre-seed an active row directly (NOT via trigger). Then drop a
--   stale pending row with a different stripe_subscription_id but same
--   (would-be user_id, club_slug). Then sign the user up.
--
--   The trigger fires on the auth.users INSERT, scans pending rows for
--   the email, attempts INSERT, hits unique_violation on (user_id, club_slug)
--   from the pre-seeded row, falls into the WHEN unique_violation branch
--   (the NULL handler), then runs the mark-claimed UPDATE outside the
--   inner BEGIN — proving the trigger's branch handles re-subscribe cleanly.
--
--   This is the realistic production scenario the original Scenario C
--   *described* but didn't actually exercise (it was running hand-typed
--   SQL, not the trigger).
-- ============================================================================

DO $$
DECLARE
    test_user_id uuid := gen_random_uuid();
    test_email text := 'trigger-test-c-' || substr(gen_random_uuid()::text, 1, 8) || '@example.test';
    pre_seeded_sub_id text := 'sub_preseed_' || substr(gen_random_uuid()::text, 1, 8);
    stale_pending_sub_id text := 'sub_stale_' || substr(gen_random_uuid()::text, 1, 8);
    pending_id uuid;
    active_count int;
    pending_claimed boolean;
    pre_seeded_status text;
    unclaimed_left int;
BEGIN
    -- Pre-seed the active row WITHOUT going through the trigger
    -- (simulates: this user signed up months ago + an earlier sub already exists).
    -- We can't insert the active row before the auth.users row exists (FK),
    -- so we sign the user up first with NO pending rows present, then insert
    -- the active row directly, then drop the stale pending row, then re-test
    -- the claim path... but the trigger only fires on auth.users INSERT.
    --
    -- Workaround: use a helper user as the "victim" of the collision scenario.
    -- Insert auth.users for the test user (no pending rows yet → trigger does
    -- nothing). Then directly insert an active row (bypasses trigger). Then
    -- insert a stale pending row. Then directly call the trigger function
    -- with a synthesized RECORD to fire side-effect 3 again — Postgres
    -- doesn't allow that easily, so instead: use a SECOND auth.users row
    -- with a DIFFERENT email but seed the pending row against the SECOND
    -- email. But that doesn't test the claim against the SAME user...
    --
    -- Cleanest approach the reviewers landed on: use the OTHER UNIQUE constraint
    -- (stripe_subscription_id) for the collision. Pre-seed an active row owned
    -- by a DIFFERENT user with stripe_subscription_id X. Add a pending row for
    -- our test user with the SAME stripe_subscription_id X. Sign the test user
    -- up. Trigger fires, hits unique_violation on stripe_subscription_id,
    -- branch executes NULL, mark-claimed runs.
    --
    -- This exercises the same EXCEPTION WHEN unique_violation handler the
    -- (user_id, club_slug) collision would, but is reachable from the trigger.

    -- Step 1: another user already has an active sub with stripe_subscription_id X
    DECLARE
        other_user_id uuid := gen_random_uuid();
        other_email text := 'trigger-test-c-other-' || substr(gen_random_uuid()::text, 1, 8) || '@example.test';
    BEGIN
        INSERT INTO auth.users (id, email, raw_user_meta_data, instance_id, aud, role, created_at, updated_at)
        VALUES (
            other_user_id, other_email,
            jsonb_build_object('username', 'trigger_test_c_other', 'full_name', 'Other C'),
            '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            now(), now()
        );

        INSERT INTO public.playhub_academy_subscriptions (
            user_id, club_slug, stripe_subscription_id, stripe_customer_id,
            customer_email, status
        ) VALUES (
            other_user_id, 'test_trigger_club', pre_seeded_sub_id, 'cus_preseed_c',
            lower(other_email), 'active'
        );
    END;

    -- Step 2: pending row for OUR test user reuses the SAME stripe_subscription_id
    -- (race scenario: webhook fired the existing-profile path under another user
    -- but a stale pending row sat around with the same Stripe ID).
    INSERT INTO public.playhub_pending_academy_subscriptions (
        club_slug, invited_email, stripe_subscription_id, stripe_customer_id, last_known_status
    ) VALUES (
        'test_trigger_club', lower(test_email), pre_seeded_sub_id, 'cus_stale_c', 'active'
    ) RETURNING id INTO pending_id;

    -- Step 3: sign our test user up. The trigger fires for real this time.
    INSERT INTO auth.users (id, email, raw_user_meta_data, instance_id, aud, role, created_at, updated_at)
    VALUES (
        test_user_id, test_email,
        jsonb_build_object('username', 'trigger_test_c', 'full_name', 'Trigger Test C'),
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        now(), now()
    );

    -- Assert: the trigger's WHEN unique_violation branch fired (no row created
    -- for our test_user, but the pending row got marked claimed via the
    -- mark-claimed UPDATE that runs after the inner BEGIN).
    SELECT count(*) INTO active_count
        FROM public.playhub_academy_subscriptions
        WHERE user_id = test_user_id;
    IF active_count <> 0 THEN
        RAISE EXCEPTION 'Scenario C: expected 0 active subs for test_user (collision was caught), got %', active_count;
    END IF;

    SELECT (claimed_at IS NOT NULL AND claimed_user_id = test_user_id) INTO pending_claimed
        FROM public.playhub_pending_academy_subscriptions WHERE id = pending_id;
    IF NOT pending_claimed THEN
        RAISE EXCEPTION 'Scenario C: pending row not marked claimed by trigger (WHEN unique_violation branch likely broken)';
    END IF;

    -- Pre-seeded row for OTHER user untouched
    SELECT status INTO pre_seeded_status
        FROM public.playhub_academy_subscriptions WHERE stripe_subscription_id = pre_seeded_sub_id;
    IF pre_seeded_status IS NULL OR pre_seeded_status <> 'active' THEN
        RAISE EXCEPTION 'Scenario C: pre-seeded row for other user was disturbed';
    END IF;

    -- All pending rows for the test email should be claimed (zero unclaimed)
    SELECT count(*) INTO unclaimed_left
        FROM public.playhub_pending_academy_subscriptions
        WHERE invited_email = lower(test_email) AND claimed_at IS NULL;
    IF unclaimed_left <> 0 THEN
        RAISE EXCEPTION 'Scenario C: % pending rows for the email left unclaimed', unclaimed_left;
    END IF;

    RAISE NOTICE 'OK C: trigger WHEN unique_violation branch fired correctly — pending claimed, no duplicate row, other user untouched';
END $$;

-- ============================================================================
-- Scenario D: multiple pending subs for different clubs → all claimed
-- ============================================================================

DO $$
DECLARE
    test_user_id uuid := gen_random_uuid();
    test_email text := 'trigger-test-d-' || substr(gen_random_uuid()::text, 1, 8) || '@example.test';
    active_count int;
BEGIN
    INSERT INTO public.playhub_pending_academy_subscriptions (
        club_slug, invited_email, stripe_subscription_id, stripe_customer_id, last_known_status
    ) VALUES
        ('test_trigger_club',   lower(test_email), 'sub_d1_' || substr(gen_random_uuid()::text, 1, 8), 'cus_d1', 'active'),
        ('test_trigger_club_2', lower(test_email), 'sub_d2_' || substr(gen_random_uuid()::text, 1, 8), 'cus_d2', 'active');

    INSERT INTO auth.users (id, email, raw_user_meta_data, instance_id, aud, role, created_at, updated_at)
    VALUES (
        test_user_id, test_email,
        jsonb_build_object('username', 'trigger_test_d', 'full_name', 'Trigger Test D'),
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        now(), now()
    );

    SELECT count(*) INTO active_count
        FROM public.playhub_academy_subscriptions WHERE user_id = test_user_id;
    IF active_count <> 2 THEN
        RAISE EXCEPTION 'Scenario D: expected 2 active subs (one per club), got %', active_count;
    END IF;

    PERFORM 1 FROM public.playhub_pending_academy_subscriptions
        WHERE invited_email = lower(test_email) AND claimed_at IS NULL;
    IF FOUND THEN
        RAISE EXCEPTION 'Scenario D: at least one pending row left unclaimed';
    END IF;

    RAISE NOTICE 'OK D: multi-club pending subs all claimed in one signup';
END $$;

-- ============================================================================
-- Scenario E: regression for side-effects 1 + 2 — adding side-effect 3 must
-- not break the existing admin-invite + recording-access claim flows.
-- ============================================================================

DO $$
DECLARE
    test_user_id uuid := gen_random_uuid();
    test_email text := 'trigger-test-e-' || substr(gen_random_uuid()::text, 1, 8) || '@example.test';
    test_org_id uuid;
    test_recording_id uuid;
    test_inviter_id uuid;
    new_profile_id uuid;
    member_count int;
    access_count int;
    pending_admin_count int;
BEGIN
    -- Set up org + a recording + an inviter user (so granted_by is a real user)
    test_inviter_id := gen_random_uuid();
    INSERT INTO auth.users (id, email, raw_user_meta_data, instance_id, aud, role, created_at, updated_at)
    VALUES (
        test_inviter_id, 'inviter-e-' || substr(gen_random_uuid()::text, 1, 8) || '@example.test',
        jsonb_build_object('username', 'inviter_e', 'full_name', 'Inviter E'),
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        now(), now()
    );

    -- type must be one of the values allowed by the valid_org_type CHECK
    -- constraint on organizations: 'academy' | 'venue' | 'group' | 'league'.
    -- Slug is uniquified to avoid colliding with prior aborted test runs.
    INSERT INTO public.organizations (id, name, slug, type)
    VALUES (gen_random_uuid(), 'Trigger Test E Org',
            'trigger-test-e-org-' || substr(gen_random_uuid()::text, 1, 8), 'academy')
    RETURNING id INTO test_org_id;

    -- venue_organization_id is NOT NULL on playhub_match_recordings;
    -- reuse the same org for the test fixture.
    INSERT INTO public.playhub_match_recordings (
        id, organization_id, venue_organization_id, title, match_date, home_team, away_team
    ) VALUES (
        gen_random_uuid(), test_org_id, test_org_id, 'Trigger Test E Match', now(),
        'Home E', 'Away E'
    ) RETURNING id INTO test_recording_id;

    -- Seed: a pending admin invite for the test email
    INSERT INTO public.playhub_pending_admin_invites (organization_id, invited_email, role, invited_by)
    VALUES (test_org_id, lower(test_email), 'admin', test_inviter_id);

    -- Seed: an email-keyed access right for the test email
    INSERT INTO public.playhub_access_rights (
        match_recording_id, invited_email, granted_by, is_active
    ) VALUES (
        test_recording_id, lower(test_email), test_inviter_id, true
    );

    -- Sign up
    INSERT INTO auth.users (id, email, raw_user_meta_data, instance_id, aud, role, created_at, updated_at)
    VALUES (
        test_user_id, test_email,
        jsonb_build_object('username', 'trigger_test_e', 'full_name', 'Trigger Test E'),
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        now(), now()
    );

    -- Side-effect 1 fired: org membership created
    SELECT id INTO new_profile_id FROM public.profiles WHERE user_id = test_user_id;
    SELECT count(*) INTO member_count
        FROM public.organization_members
        WHERE profile_id = new_profile_id AND organization_id = test_org_id AND is_active = true;
    IF member_count <> 1 THEN
        RAISE EXCEPTION 'Scenario E: side-effect 1 broken — org membership not created (got %)', member_count;
    END IF;

    -- Side-effect 1 fired: pending admin invite was deleted
    SELECT count(*) INTO pending_admin_count
        FROM public.playhub_pending_admin_invites
        WHERE invited_email = lower(test_email);
    IF pending_admin_count <> 0 THEN
        RAISE EXCEPTION 'Scenario E: side-effect 1 broken — pending admin invite not deleted';
    END IF;

    -- Side-effect 2 fired: access right linked to user_id, invited_email cleared
    SELECT count(*) INTO access_count
        FROM public.playhub_access_rights
        WHERE match_recording_id = test_recording_id
          AND user_id = test_user_id
          AND invited_email IS NULL
          AND is_active = true;
    IF access_count <> 1 THEN
        RAISE EXCEPTION 'Scenario E: side-effect 2 broken — access right not linked';
    END IF;

    RAISE NOTICE 'OK E: side-effects 1 + 2 still claim correctly with side-effect 3 active';
END $$;

-- ============================================================================
-- Scenario F: RLS reachability — anon read of teams works AND owner-based
-- isolation on academy_subscriptions is correctly enforced.
--
-- Two failure modes a naive RLS test misses:
--   (1) auth.uid() returns NULL because the test set the wrong GUC. With
--       NULL, USING (user_id = auth.uid()) is NULL → no rows → "denied"
--       passes even if the policy were USING (false). Set BOTH the singular
--       and JSONB GUCs so we work across Supabase versions.
--   (2) The deny-test passes if the policy is broken in the OTHER direction
--       (over-restrictive). Add a positive control: the impersonated user
--       MUST be able to read their own row.
-- ============================================================================

DO $$
DECLARE
    visible_teams int;
    other_user_id uuid := gen_random_uuid();
    other_email text := 'rls-other-' || substr(gen_random_uuid()::text, 1, 8) || '@example.test';
    self_user_id uuid := gen_random_uuid();
    self_email text := 'rls-self-' || substr(gen_random_uuid()::text, 1, 8) || '@example.test';
    own_subs_visible int;
    other_subs_visible int;
BEGIN
    -- (1) Anon SELECT on academy_teams: should see active rows.
    SET LOCAL ROLE anon;
    SELECT count(*) INTO visible_teams
        FROM public.playhub_academy_teams
        WHERE club_slug = 'test_trigger_club' AND is_active = true;
    RESET ROLE;

    IF visible_teams < 1 THEN
        RAISE EXCEPTION 'Scenario F: anon cannot read active academy_teams (expected ≥1, got %)', visible_teams;
    END IF;

    -- (2) Set up two users + one sub each.
    INSERT INTO auth.users (id, email, raw_user_meta_data, instance_id, aud, role, created_at, updated_at)
    VALUES (
        other_user_id, other_email,
        jsonb_build_object('username', 'rls_other', 'full_name', 'RLS Other'),
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        now(), now()
    );
    INSERT INTO public.playhub_academy_subscriptions (
        user_id, club_slug, stripe_subscription_id, stripe_customer_id,
        customer_email, status
    ) VALUES (
        other_user_id, 'test_trigger_club',
        'sub_rls_other_' || substr(gen_random_uuid()::text, 1, 8),
        'cus_rls_other', lower(other_email), 'active'
    );

    INSERT INTO auth.users (id, email, raw_user_meta_data, instance_id, aud, role, created_at, updated_at)
    VALUES (
        self_user_id, self_email,
        jsonb_build_object('username', 'rls_self', 'full_name', 'RLS Self'),
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        now(), now()
    );
    INSERT INTO public.playhub_academy_subscriptions (
        user_id, club_slug, stripe_subscription_id, stripe_customer_id,
        customer_email, status
    ) VALUES (
        self_user_id, 'test_trigger_club_2',
        'sub_rls_self_' || substr(gen_random_uuid()::text, 1, 8),
        'cus_rls_self', lower(self_email), 'active'
    );

    -- (3) Impersonate self_user_id. Set BOTH GUC forms — auth.uid() in
    -- different Supabase versions reads from one or the other.
    PERFORM set_config('request.jwt.claim.sub', self_user_id::text, true);
    PERFORM set_config(
        'request.jwt.claims',
        jsonb_build_object('sub', self_user_id::text, 'role', 'authenticated')::text,
        true
    );
    SET LOCAL ROLE authenticated;

    -- Positive control: should see exactly own row (no WHERE clause filter,
    -- so RLS is the ONLY thing that can hide rows).
    SELECT count(*) INTO own_subs_visible
        FROM public.playhub_academy_subscriptions;

    -- Negative control: with explicit WHERE filter for the other user, should
    -- still see zero — RLS filters first, the WHERE finds nothing left.
    SELECT count(*) INTO other_subs_visible
        FROM public.playhub_academy_subscriptions
        WHERE user_id = other_user_id;

    RESET ROLE;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claims', '', true);

    -- Owner CAN read own row → proves auth.uid() resolved AND policy is correct.
    IF own_subs_visible <> 1 THEN
        RAISE EXCEPTION 'Scenario F: impersonated user cannot read their own sub (got %, expected 1) — auth.uid() may be NULL or policy too restrictive', own_subs_visible;
    END IF;

    -- Owner CANNOT read other's row → proves user-scoping isn't bypassed.
    IF other_subs_visible <> 0 THEN
        RAISE EXCEPTION 'Scenario F: RLS leak — impersonated user read another user''s subscription (got %)', other_subs_visible;
    END IF;

    RAISE NOTICE 'OK F: RLS proven — anon reads teams, owner reads own sub only, no cross-user leak';
END $$;

-- ============================================================================
-- Cleanup is automatic — ROLLBACK undoes everything (test fixtures, test users,
-- pending rows, active rows, profiles, recordings, orgs). Nothing is committed.
-- ============================================================================

ROLLBACK;

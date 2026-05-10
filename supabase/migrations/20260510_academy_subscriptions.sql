-- Unified academy subscriptions — Checkpoint A
--
-- Adds the data model + trigger plumbing for self-serve parent subscriptions
-- against academy clubs. No application code consumes these tables yet — that
-- arrives in Checkpoint B (provisioning lib + Stripe webhook handlers).
--
-- Three new tables:
--   1. playhub_academy_teams                — public, drives the team picker UI
--   2. playhub_pending_academy_subscriptions — service-role, pre-signup state
--   3. playhub_academy_subscriptions         — user-scoped, post-claim state
--
-- One trigger extension:
--   handle_new_user() gains a third nested EXCEPTION block that promotes any
--   pending academy subs for the new user's email into active subscriptions.
--   Mirrors the existing admin-invite + access-rights claim logic
--   (20260423_fix_handle_new_user_robustness.sql) including the per-row
--   unique_violation handling.
--
-- Soft-delete convention: the existing playhub_* tables use is_active flags
-- rather than physical deletes. The FK ON DELETE RESTRICT clauses below
-- enforce that — physical deletes against playhub_academy_config are blocked
-- if any sub references the club, by design.

-- ============================================================================
-- 1. Team list per academy club (drives PLAYBACK landing page team picker)
-- ============================================================================

CREATE TABLE public.playhub_academy_teams (
    id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    club_slug text NOT NULL REFERENCES public.playhub_academy_config(club_slug) ON DELETE RESTRICT,
    team_slug text NOT NULL,
    display_name text NOT NULL,
    logo_url text,
    veo_team_slug text,                  -- public team slug used by invitePlayer(); not a credential
    sort_order integer NOT NULL DEFAULT 0,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(club_slug, team_slug)
);

CREATE INDEX idx_playhub_academy_teams_club_active
    ON public.playhub_academy_teams (club_slug, is_active, sort_order);

ALTER TABLE public.playhub_academy_teams ENABLE ROW LEVEL SECURITY;

-- Public read of active teams — needed so the un-authenticated PLAYBACK landing
-- page can render the team picker before checkout.
CREATE POLICY "Public can read active academy teams"
    ON public.playhub_academy_teams
    FOR SELECT
    TO anon, authenticated
    USING (is_active = true);

-- ============================================================================
-- 2. Pending academy subscriptions (pre-signup, email-keyed)
-- ============================================================================
-- Created by the Stripe webhook handler when a checkout completes for an
-- email that has no PLAYBACK profile yet. Cleared by the handle_new_user
-- trigger when that email subsequently registers.
--
-- SECURITY NOTE: invited_email is an authoritative grant key. Whoever can
-- insert here (currently: only the service-role Stripe webhook, signature-
-- verified) can effectively grant academy access to any email that later
-- registers. Checkpoint B's webhook handler is responsible for the
-- post-claim verification step (see provisioned_at note below).

CREATE TABLE public.playhub_pending_academy_subscriptions (
    id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    club_slug text NOT NULL REFERENCES public.playhub_academy_config(club_slug) ON DELETE RESTRICT,
    invited_email text NOT NULL CHECK (invited_email = lower(invited_email)),
    stripe_subscription_id text NOT NULL UNIQUE,
    stripe_customer_id text NOT NULL,
    registration_team text,              -- team_slug parent picked at checkout
    subscriber_type text CHECK (subscriber_type IS NULL OR subscriber_type IN ('parent', 'player')),
    player_name text,
    customer_name text,
    last_known_status text NOT NULL CHECK (
        last_known_status IN ('active', 'past_due', 'canceled', 'trialing', 'unpaid', 'incomplete', 'paused')
    ),
    invited_at timestamptz NOT NULL DEFAULT now(),
    claimed_at timestamptz,
    claimed_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    UNIQUE(club_slug, invited_email)
);
-- Note: no updated_at on this table by design — pending rows are write-once
-- + claim-once, never mutated otherwise. The claimed_at column is the only
-- mutation, set exactly once when the matching auth.users row is created.

-- Partial: trigger only ever queries unclaimed rows. Once claimed, rows are
-- dead weight in the index and never match the lookup again.
CREATE INDEX idx_playhub_pending_academy_subs_email_unclaimed
    ON public.playhub_pending_academy_subscriptions (invited_email)
    WHERE claimed_at IS NULL;

ALTER TABLE public.playhub_pending_academy_subscriptions ENABLE ROW LEVEL SECURITY;
-- Intentionally no policies: only service_role (which bypasses RLS) reads/
-- writes this table. Contains email + stripe_customer_id, treat as PII.

-- ============================================================================
-- 3. Active academy subscriptions (post-claim, user-scoped)
-- ============================================================================
-- One row per (user, club). Source of truth for whether a parent currently
-- has access to a club's recordings. Populated by either:
--   - Stripe webhook directly (existing-profile path)
--   - handle_new_user trigger claiming a pending row (new-signup path)
--
-- Stripe stays canonical for the *subscription itself* (next charge, dunning,
-- cancellation). This table mirrors enough state to drive product surfaces
-- (RLS joins on recordings, "my academies" lists, provisioning status) without
-- a Stripe roundtrip on every read.
--
-- Denormalisation deliberately kept thin:
--   - profile_id is NOT stored: profiles.user_id is unique, derive via JOIN.
--   - organization_id is NOT stored: derive via JOIN on playhub_academy_config
--     so a config re-point is reflected immediately, no historical drift.
--   - customer_email IS stored (cached) so the provisioning Lambda doesn't need
--     auth.users read access. Keeps the privileged-read surface small.

CREATE TABLE public.playhub_academy_subscriptions (
    id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    club_slug text NOT NULL REFERENCES public.playhub_academy_config(club_slug) ON DELETE RESTRICT,
    stripe_subscription_id text NOT NULL UNIQUE,
    stripe_customer_id text NOT NULL,
    registration_team text,
    subscriber_type text CHECK (subscriber_type IS NULL OR subscriber_type IN ('parent', 'player')),
    player_name text,
    customer_email text NOT NULL CHECK (customer_email = lower(customer_email)),
    customer_name text,
    status text NOT NULL CHECK (
        status IN ('active', 'past_due', 'canceled', 'trialing', 'unpaid', 'incomplete', 'paused')
    ),
    current_period_end timestamptz,
    -- Salted-account contract (see SECURITY NOTE on the pending table):
    -- provisioned_at MUST remain NULL until the application layer has both
    --   (a) verified the stripe_customer_id↔user.email match against Stripe
    --       (an attacker can run a real checkout for victim@example.com), AND
    --   (b) successfully fired the external provisioning (Veo invite).
    -- The provisioning lib in Checkpoint B owns this contract.
    provisioned_at timestamptz,
    provisioning_error text,              -- last failure message — NULL once provisioned
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(user_id, club_slug)
);

CREATE INDEX idx_playhub_academy_subs_club_status
    ON public.playhub_academy_subscriptions (club_slug, status);

-- Partial: parent dashboard "do I have access" lookup. Predicate must match
-- the WHERE in the application query verbatim or the planner skips the index.
CREATE INDEX idx_playhub_academy_subs_user_active
    ON public.playhub_academy_subscriptions (user_id)
    WHERE status IN ('active', 'trialing', 'past_due');

-- Partial: provisioning worker scan target. Stays small (rows leave the index
-- the moment provisioned_at is set).
CREATE INDEX idx_playhub_academy_subs_unprovisioned
    ON public.playhub_academy_subscriptions (created_at)
    WHERE provisioned_at IS NULL;

ALTER TABLE public.playhub_academy_subscriptions ENABLE ROW LEVEL SECURITY;

-- Parent reads their own subscriptions.
CREATE POLICY "Users can read their own academy subscriptions"
    ON public.playhub_academy_subscriptions
    FOR SELECT
    TO authenticated
    USING (user_id = auth.uid());

-- Writes are service_role only (webhook handler + trigger). No INSERT/UPDATE/
-- DELETE policy for `authenticated` — parents cannot self-grant access.

-- ============================================================================
-- 4. Extend handle_new_user to claim pending academy subscriptions
-- ============================================================================
-- Mirrors the structure of the previous fix (20260423): each side-effect is
-- wrapped in its own nested EXCEPTION block so a failure here can never roll
-- back the primary profile INSERT. Per-row unique_violation handling matches
-- the access-rights pattern.
--
-- Note: this only creates the active subscription row. Provisioning the
-- external system (Veo invite) cannot happen from a trigger — that's the
-- application layer's job, driven by the unprovisioned-rows index above.
--
-- Side-effect 3 depends on the outer `NEW.email IS NOT NULL` guard for the
-- customer_email NOT NULL constraint to be satisfied.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    new_profile_id uuid;
    invite RECORD;
    access_row RECORD;
    pending_sub RECORD;
BEGIN
    -- Primary purpose: create the profile row.
    INSERT INTO public.profiles (user_id, username, email, full_name)
    VALUES (
        NEW.id,
        COALESCE(
            NEW.raw_user_meta_data ->> 'username',
            'user_' || substring(NEW.id::text, 1, 8)
        ),
        NEW.email,
        COALESCE(
            NEW.raw_user_meta_data ->> 'full_name',
            'New User'
        )
    )
    ON CONFLICT (user_id) DO NOTHING
    RETURNING id INTO new_profile_id;

    IF new_profile_id IS NOT NULL AND NEW.email IS NOT NULL THEN
        -- Side-effect 1: promote pending admin invites into memberships.
        BEGIN
            FOR invite IN
                SELECT id, organization_id, role
                FROM public.playhub_pending_admin_invites
                WHERE invited_email = lower(NEW.email)
            LOOP
                INSERT INTO public.organization_members (organization_id, profile_id, role, is_active)
                VALUES (
                    invite.organization_id,
                    new_profile_id,
                    invite.role::public.profile_variant_type,
                    true
                )
                ON CONFLICT (organization_id, profile_id) DO NOTHING;

                DELETE FROM public.playhub_pending_admin_invites WHERE id = invite.id;
            END LOOP;
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING 'handle_new_user: invite processing failed for %: % (%)',
                NEW.email, SQLERRM, SQLSTATE;
        END;

        -- Side-effect 2: link pending recording access grants.
        BEGIN
            FOR access_row IN
                SELECT id
                FROM public.playhub_access_rights
                WHERE invited_email = lower(NEW.email)
                  AND user_id IS NULL
            LOOP
                BEGIN
                    UPDATE public.playhub_access_rights
                       SET user_id = NEW.id, invited_email = NULL
                     WHERE id = access_row.id;
                EXCEPTION WHEN unique_violation THEN
                    -- A user_id-based grant already exists for this recording;
                    -- the invited-email row is redundant. Drop it.
                    DELETE FROM public.playhub_access_rights WHERE id = access_row.id;
                END;
            END LOOP;
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING 'handle_new_user: access-rights linking failed for %: % (%)',
                NEW.email, SQLERRM, SQLSTATE;
        END;

        -- Side-effect 3: claim pending academy subscriptions.
        BEGIN
            FOR pending_sub IN
                SELECT
                    id,
                    club_slug,
                    stripe_subscription_id,
                    stripe_customer_id,
                    registration_team,
                    subscriber_type,
                    player_name,
                    customer_name,
                    last_known_status
                FROM public.playhub_pending_academy_subscriptions
                WHERE invited_email = lower(NEW.email)
                  AND claimed_at IS NULL
            LOOP
                BEGIN
                    INSERT INTO public.playhub_academy_subscriptions (
                        user_id,
                        club_slug,
                        stripe_subscription_id,
                        stripe_customer_id,
                        registration_team,
                        subscriber_type,
                        player_name,
                        customer_email,
                        customer_name,
                        status
                    )
                    VALUES (
                        NEW.id,
                        pending_sub.club_slug,
                        pending_sub.stripe_subscription_id,
                        pending_sub.stripe_customer_id,
                        pending_sub.registration_team,
                        pending_sub.subscriber_type,
                        pending_sub.player_name,
                        lower(NEW.email),
                        pending_sub.customer_name,
                        pending_sub.last_known_status
                    );
                EXCEPTION
                    WHEN unique_violation THEN
                        -- Either (user_id, club_slug) or stripe_subscription_id
                        -- already has an active row. Existing active row is
                        -- canonical; just mark the pending row claimed below
                        -- so it stops being re-attempted.
                        NULL;
                    WHEN foreign_key_violation THEN
                        -- The referenced club was deleted between webhook and signup.
                        -- Surface louder than the outer block — this is recoverable
                        -- only by ops re-creating the academy_config row.
                        RAISE WARNING 'handle_new_user: academy sub for % references missing club %: % (%)',
                            NEW.email, pending_sub.club_slug, SQLERRM, SQLSTATE;
                        CONTINUE;  -- skip the mark-claimed below; ops needs to see this row
                END;

                UPDATE public.playhub_pending_academy_subscriptions
                   SET claimed_at = now(),
                       claimed_user_id = NEW.id
                 WHERE id = pending_sub.id;
            END LOOP;
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING 'handle_new_user: academy sub claim failed for %: % (%)',
                NEW.email, SQLERRM, SQLSTATE;
        END;
    END IF;

    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Failed to create profile for user %: % (%)', NEW.id, SQLERRM, SQLSTATE;
    RETURN NEW;
END;
$function$;

-- ============================================================================
-- 5. updated_at maintenance — reuse existing public.update_updated_at_column()
-- ============================================================================

CREATE TRIGGER update_playhub_academy_teams_updated_at
    BEFORE UPDATE ON public.playhub_academy_teams
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_playhub_academy_subscriptions_updated_at
    BEFORE UPDATE ON public.playhub_academy_subscriptions
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================================
-- 6. Cross-repo trigger coordination — bump canonical version marker
-- ============================================================================
-- Protocol: PLAYBACK/supabase/migrations/20260505103000_handle_new_user_canonical_marker.sql
-- Mirror:   PLAYBACK/supabase/migrations/20260510100000_handle_new_user_claim_academy_subs.sql
-- Bump on every change to handle_new_user. CI asserts both repos return the
-- same version string against the live remote.

CREATE OR REPLACE FUNCTION public._handle_new_user_version()
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT '20260510-01'::text
$$;

-- Re-assert ACL (CREATE OR REPLACE preserves grants, but be explicit so a
-- future DROP+CREATE doesn't silently fall through to public-execute).
REVOKE EXECUTE ON FUNCTION public._handle_new_user_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._handle_new_user_version() TO postgres, service_role;

-- Hierarchical academies — Checkpoint E.2
--
-- Adds a middle layer between `playhub_academy_config` (the league /
-- federation) and `playhub_academy_teams` (the age-group teams). The new
-- `playhub_academy_subclubs` table represents a club within a league —
-- e.g. for LYL: 16 subclubs (Barnes Eagles, Champs FC, ...) each with
-- their own logo, Veo club, and age-group teams.
--
-- Backward-compat: nullable `subclub_slug` columns. Existing CFA/SEFA flat
-- configs continue working with NULL throughout. Only LYL-shaped clubs
-- (where playhub_academy_subclubs has rows for that club) trigger the
-- two-step picker UX.
--
-- handle_new_user trigger update mirrors the new column through to active
-- subscriptions. Per the cross-repo coordination protocol established in
-- 20260505103000, the function body is byte-identical with PLAYBACK's
-- mirror migration and _handle_new_user_version() is bumped to '20260515-01'.

-- ============================================================================
-- 1. New table: playhub_academy_subclubs
-- ============================================================================

CREATE TABLE public.playhub_academy_subclubs (
    id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    club_slug text NOT NULL REFERENCES public.playhub_academy_config(club_slug) ON DELETE RESTRICT,
    subclub_slug text NOT NULL,
    display_name text NOT NULL,
    logo_url text,
    -- Each subclub gets its own Veo club. Nullable so we can seed the LYL
    -- subclubs ahead of Veo setup; provisioning fail-soft (config_no_veo_club)
    -- on rows where this is still NULL.
    veo_club_slug text,
    sort_order integer NOT NULL DEFAULT 0,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(club_slug, subclub_slug)
);

-- No secondary index. The UNIQUE(club_slug, subclub_slug) covers
-- provisioning lookups by leading prefix; subclub list queries (16 rows
-- for LYL, ~50 lifetime) will seq-scan and that's correct at this size.
-- Revisit only if a single league grows past a few hundred subclubs.

ALTER TABLE public.playhub_academy_subclubs ENABLE ROW LEVEL SECURITY;

-- Public read of active subclubs — needed for the unauthenticated PLAYBACK
-- landing page that renders the subclub picker for hierarchical clubs.
CREATE POLICY "Public can read active academy subclubs"
    ON public.playhub_academy_subclubs
    FOR SELECT
    TO anon, authenticated
    USING (is_active = true);

CREATE TRIGGER update_playhub_academy_subclubs_updated_at
    BEFORE UPDATE ON public.playhub_academy_subclubs
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================================
-- 2. Hierarchy column on playhub_academy_teams
-- ============================================================================
-- Nullable: CFA/SEFA-style flat configs leave this NULL. Hierarchical
-- configs (LYL) populate it on every age-group team row.

ALTER TABLE public.playhub_academy_teams
    ADD COLUMN subclub_slug text;

-- Composite FK so a team can only point at a (club, subclub) pair that
-- actually exists. NULL subclub_slug values are permitted (CFA/SEFA flat).
ALTER TABLE public.playhub_academy_teams
    ADD CONSTRAINT playhub_academy_teams_subclub_fk
    FOREIGN KEY (club_slug, subclub_slug)
    REFERENCES public.playhub_academy_subclubs (club_slug, subclub_slug)
    ON DELETE RESTRICT;

-- Drop the old (club_slug, team_slug) UNIQUE — replaced by a pair of
-- partial unique indexes that handle the flat-config and hierarchical-
-- config cases separately. Postgres' UNIQUE treats NULLs as distinct,
-- so a single wide UNIQUE on (club_slug, subclub_slug, team_slug) would
-- silently allow duplicate flat rows like ('cfa', NULL, 'u11') — losing
-- the duplicate-team protection the original constraint provided.
ALTER TABLE public.playhub_academy_teams
    DROP CONSTRAINT IF EXISTS playhub_academy_teams_club_slug_team_slug_key;

-- Hierarchical case: every column is non-NULL, regular UNIQUE works.
CREATE UNIQUE INDEX playhub_academy_teams_hier_team_key
    ON public.playhub_academy_teams (club_slug, subclub_slug, team_slug)
    WHERE subclub_slug IS NOT NULL;

-- Flat case (CFA, SEFA, anything pre-LYL): partial index restores the
-- original "no duplicate teams within a club" invariant for NULL subclub.
CREATE UNIQUE INDEX playhub_academy_teams_flat_team_key
    ON public.playhub_academy_teams (club_slug, team_slug)
    WHERE subclub_slug IS NULL;

-- No secondary (non-unique) index for the listing query — the partial
-- UNIQUE above + leading-prefix scans on (club_slug, subclub_slug) are
-- sufficient at ~500 lifetime rows. Add one when query plans actually
-- show seq scans hurting (~5K+ rows).

-- ============================================================================
-- 3. Hierarchy column on subscription tables
-- ============================================================================
-- Both pending and active rows store the chosen subclub so the operator
-- dashboards + provisioning logic can look up the right Veo club.

ALTER TABLE public.playhub_pending_academy_subscriptions
    ADD COLUMN registration_subclub text;

ALTER TABLE public.playhub_academy_subscriptions
    ADD COLUMN registration_subclub text;

-- ============================================================================
-- 4. Extend handle_new_user to carry registration_subclub through the claim
-- ============================================================================
-- See: PLAYBACK/supabase/migrations/<this-date>_handle_new_user_carry_subclub.sql
-- for the byte-identical mirror. Bumps _handle_new_user_version() to '20260515-01'.

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
                    DELETE FROM public.playhub_access_rights WHERE id = access_row.id;
                END;
            END LOOP;
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING 'handle_new_user: access-rights linking failed for %: % (%)',
                NEW.email, SQLERRM, SQLSTATE;
        END;

        BEGIN
            FOR pending_sub IN
                SELECT
                    id,
                    club_slug,
                    stripe_subscription_id,
                    stripe_customer_id,
                    registration_team,
                    registration_subclub,
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
                        registration_subclub,
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
                        pending_sub.registration_subclub,
                        pending_sub.subscriber_type,
                        pending_sub.player_name,
                        lower(NEW.email),
                        pending_sub.customer_name,
                        pending_sub.last_known_status
                    );
                EXCEPTION
                    WHEN unique_violation THEN
                        NULL;
                    WHEN foreign_key_violation THEN
                        RAISE WARNING 'handle_new_user: academy sub for % references missing club %: % (%)',
                            NEW.email, pending_sub.club_slug, SQLERRM, SQLSTATE;
                        CONTINUE;
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

CREATE OR REPLACE FUNCTION public._handle_new_user_version()
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT '20260515-01'::text
$$;

REVOKE EXECUTE ON FUNCTION public._handle_new_user_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._handle_new_user_version() TO postgres, service_role;

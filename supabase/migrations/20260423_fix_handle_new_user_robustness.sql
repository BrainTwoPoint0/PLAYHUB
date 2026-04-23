-- Make handle_new_user robust against secondary-side-effect failures
--
-- Two bugs in the previous version silently killed signups for invited admins:
--
--   1) invite.role was passed as text into organization_members.role
--      (profile_variant_type enum) → SQLSTATE 42804. Because the whole
--      trigger body was wrapped in a single BEGIN / EXCEPTION WHEN OTHERS,
--      the failure rolled back the profile INSERT too. auth.users row
--      stayed, public.profiles row never existed.
--
--   2) playhub_access_rights UPDATE collided with existing user_id grants
--      → SQLSTATE 23505 for any user who already had a direct grant for
--      the same recording, killing the same way.
--
-- Fix:
--   - Cast invite.role::profile_variant_type.
--   - Wrap each secondary side-effect (invite promotion, access-rights
--     linking) in its own nested EXCEPTION block so a failure there logs
--     a warning but never rolls back the primary profile INSERT.
--   - Loop per-row on the access-rights link, catching unique_violation
--     and deleting the redundant invited-email row instead of failing.
--   - Log SQLSTATE + SQLERRM on every warning for faster future triage.

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
    END IF;

    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Failed to create profile for user %: % (%)', NEW.id, SQLERRM, SQLSTATE;
    RETURN NEW;
END;
$function$;
